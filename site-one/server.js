'use strict';

const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const db = require('./lib/database');
const { hashPassword, verifyPassword } = require('./lib/passwords');

const PORT = parseInteger(process.env.PORT, 3000, 1, 65535);
const PRODUCTION = process.env.NODE_ENV === 'production';
const COOKIE_SECURE = process.env.COOKIE_SECURE === undefined ? PRODUCTION : process.env.COOKIE_SECURE === 'true';
const TRUST_PROXY_HOPS = parseInteger(process.env.TRUST_PROXY_HOPS, 0, 0, 5);
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const BLOCK_DURATION_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_BODY_BYTES = 24 * 1024;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PRIVATE_DIR = path.join(__dirname, 'private');
const SERVERS = Object.freeze(['61', '62', '63', '64', '65']);
const SHEETS = Object.freeze([
  { key: 'house_exchange', label: 'Обмен дом на дом' },
  { key: 'car_exchange', label: 'Авто на Авто' },
  { key: 'pay', label: '/pay' },
  { key: 'unique', label: 'Уникальная' },
  { key: 'levels_3_4_5', label: 'Уровень 3,4,5' },
  { key: 'works', label: 'Работы' },
  { key: 'marketplace', label: 'Маркетплейс' },
  { key: 'trades', label: 'Трейды' },
  { key: 'statistics', label: 'Статистика' },
]);
const DATA_SHEET_KEYS = new Set(SHEETS.filter((sheet) => sheet.key !== 'statistics').map((sheet) => sheet.key));
const ROLE_RANK = Object.freeze({ user: 1, admin: 2, superadmin: 3, developer: 4 });
const VALID_STATUSES = new Set(['pending', 'violation', 'clear', 'help', 'processed']);
const sessions = new Map();
const attempts = new Map();
const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(24).toString('hex'));

const publicRoutes = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/workspace.css': ['workspace.css', 'text/css; charset=utf-8'],
  '/workspace.js': ['workspace.js', 'text/javascript; charset=utf-8'],
  '/admin.css': ['admin.css', 'text/css; charset=utf-8'],
  '/admin.js': ['admin.js', 'text/javascript; charset=utf-8'],
};

const server = http.createServer(async (req, res) => {
  setSecurityHeaders(res);
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && publicRoutes[url.pathname]) {
      const [file, contentType] = publicRoutes[url.pathname];
      return sendFile(res, path.join(PUBLIC_DIR, file), contentType);
    }
    if (req.method === 'POST' && url.pathname === '/api/login') return handleLogin(req, res);
    if (req.method === 'POST' && url.pathname === '/api/logout') return handleLogout(req, res);

    const session = await getSession(req);
    if (req.method === 'GET' && url.pathname === '/api/me') {
      return session ? sendJson(res, 200, publicUser(session)) : sendUnauthorized(res);
    }
    if (req.method === 'GET' && url.pathname === '/app') {
      if (!session) return redirect(res, '/');
      return sendFile(res, path.join(PRIVATE_DIR, 'app.html'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/admin') {
      if (!session) return redirect(res, '/');
      if (!canAdminister(session.role)) return redirect(res, '/app');
      return sendFile(res, path.join(PRIVATE_DIR, 'admin.html'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/workspace') return handleWorkspace(res, session, url);
    const statusMatch = url.pathname.match(/^\/api\/rows\/(\d+)\/status$/);
    if (statusMatch && req.method === 'PATCH') return handleRowStatus(req, res, session, statusMatch[1]);
    if (url.pathname === '/api/users' && req.method === 'GET') return handleListUsers(res, session);
    if (url.pathname === '/api/users' && req.method === 'POST') return handleCreateUser(req, res, session);
    const userMatch = url.pathname.match(/^\/api\/users\/(\d+)$/);
    if (userMatch && req.method === 'PATCH') return handleUpdateUser(req, res, session, userMatch[1]);
    if (userMatch && req.method === 'DELETE') return handleDeleteUser(req, res, session, userMatch[1]);
    if (url.pathname === '/api/admin/overview' && req.method === 'GET') return handleAdminOverview(res, session);
    return sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: 'internal_error' });
  }
});

async function start() {
  await db.initializeDatabase();
  server.listen(PORT, '0.0.0.0', () => console.log(`Массовая выгрузка запущена: http://localhost:${PORT}`));
}

start().catch((error) => {
  console.error('Не удалось запустить приложение:', error.message);
  process.exit(1);
});
setInterval(cleanup, 10 * 60 * 1000).unref();

async function handleLogin(req, res) {
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'invalid_origin' });
  const ip = getClientIp(req);
  const state = getAttemptState(ip);
  if (state.blockedUntil > Date.now()) {
    const retryAfter = Math.ceil((state.blockedUntil - Date.now()) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    return sendJson(res, 429, { error: 'too_many_attempts', retryAfter });
  }
  const body = await getRequestBody(req, res);
  if (!body) return;
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const user = username ? await db.findUserByUsername(username) : null;
  const valid = user ? verifyPassword(password, user.password_hash) : verifyPassword(password, DUMMY_PASSWORD_HASH);
  if (!user || !valid) {
    registerFailure(ip, state);
    await db.addAuditLog({ actorUsername: username || null, action: 'login_failed', ipAddress: ip });
    await delay(300 + Math.floor(Math.random() * 250));
    return sendJson(res, 401, { error: 'invalid_credentials' });
  }
  attempts.delete(ip);
  const rawToken = randomBytes(32).toString('base64url');
  const session = {
    userId: String(user.id), username: user.username, role: user.role,
    serverId: user.server_id ? String(user.server_id) : null,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  sessions.set(hashToken(rawToken), session);
  await audit(session, 'login_success', { ipAddress: ip, serverId: session.serverId });
  res.setHeader('Set-Cookie', makeSessionCookie(rawToken, SESSION_TTL_MS));
  return sendJson(res, 200, { ok: true });
}

async function handleLogout(req, res) {
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'invalid_origin' });
  const session = await getSession(req);
  if (session) await audit(session, 'logout', { ipAddress: getClientIp(req), serverId: session.serverId });
  const rawToken = getCookie(req, 'mass_session');
  if (rawToken) sessions.delete(hashToken(rawToken));
  res.setHeader('Set-Cookie', makeSessionCookie('', 0));
  return sendJson(res, 200, { ok: true });
}

async function handleWorkspace(res, session, url) {
  if (!session) return sendUnauthorized(res);
  const serverId = resolveServer(session, url.searchParams.get('server'));
  if (!serverId) return sendJson(res, 400, { error: 'invalid_server' });
  const sheetKey = url.searchParams.get('sheet') || SHEETS[0].key;
  if (!SHEETS.some((sheet) => sheet.key === sheetKey)) return sendJson(res, 400, { error: 'invalid_sheet' });
  const statistics = normalizeStatistics(await db.listStatistics(serverId));
  if (sheetKey === 'statistics') {
    return sendJson(res, 200, { serverId, sheetKey, sheets: SHEETS, rows: [], statistics });
  }
  const rows = await db.listWorkRows({
    serverId, sheetKey, userId: session.userId, restrictToAssigned: session.role === 'user',
  });
  return sendJson(res, 200, {
    serverId, sheetKey, sheets: SHEETS, statistics,
    rows: rows.map(serializeWorkRow),
  });
}

async function handleRowStatus(req, res, session, rowId) {
  if (!session) return sendUnauthorized(res);
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'invalid_origin' });
  const body = await getRequestBody(req, res);
  if (!body) return;
  const status = typeof body.status === 'string' ? body.status : '';
  if (!VALID_STATUSES.has(status)) return sendJson(res, 400, { error: 'invalid_status' });
  const row = await db.findWorkRow(rowId);
  if (!row) return sendJson(res, 404, { error: 'row_not_found' });
  if (session.role === 'user') {
    const wrongServer = String(row.server_id) !== String(session.serverId);
    const assignedElsewhere = row.assigned_user_id && String(row.assigned_user_id) !== String(session.userId);
    if (wrongServer || assignedElsewhere) return sendJson(res, 403, { error: 'forbidden' });
  }
  const previousStatus = row.status;
  await db.updateWorkRowStatus(rowId, status, session.userId);
  await audit(session, 'row_status_changed', {
    targetType: 'work_row', targetId: String(rowId), serverId: String(row.server_id),
    ipAddress: getClientIp(req), details: { sheetKey: row.sheet_key, rowKey: row.row_key, from: previousStatus, to: status },
  });
  return sendJson(res, 200, { ok: true, status });
}

async function handleListUsers(res, session) {
  if (!session) return sendUnauthorized(res);
  if (!canAdminister(session.role)) return sendJson(res, 403, { error: 'forbidden' });
  const users = await db.listUsers();
  return sendJson(res, 200, { users: users.map((user) => ({
    id: String(user.id), username: user.username, role: user.role,
    serverId: user.server_id ? String(user.server_id) : null,
    createdAt: user.created_at, createdBy: user.created_by_username,
    canEdit: String(user.id) !== String(session.userId) && canManageExistingRole(session.role, user.role),
    canDelete: String(user.id) !== String(session.userId) && canManageExistingRole(session.role, user.role),
  })) });
}

async function handleCreateUser(req, res, session) {
  if (!session) return sendUnauthorized(res);
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'invalid_origin' });
  if (!canAdminister(session.role)) return sendJson(res, 403, { error: 'forbidden' });
  const body = await getRequestBody(req, res);
  if (!body) return;
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const role = typeof body.role === 'string' ? body.role : '';
  const serverId = normalizeUserServer(role, body.serverId);
  if (!isValidUsername(username)) return sendJson(res, 400, { error: 'invalid_username' });
  if (password.length < 12 || password.length > 256) return sendJson(res, 400, { error: 'weak_password' });
  if (!canAssignRole(session.role, role)) return sendJson(res, 403, { error: 'invalid_role' });
  if (role === 'user' && !serverId) return sendJson(res, 400, { error: 'server_required' });
  try {
    const id = await db.createUser({ username, passwordHash: hashPassword(password), role, serverId, createdBy: session.userId });
    await audit(session, 'user_created', {
      targetType: 'user', targetId: String(id), serverId,
      ipAddress: getClientIp(req), details: { username, role },
    });
    return sendJson(res, 201, { id: String(id), username, role, serverId });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return sendJson(res, 409, { error: 'username_exists' });
    throw error;
  }
}

async function handleUpdateUser(req, res, session, targetId) {
  if (!session) return sendUnauthorized(res);
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'invalid_origin' });
  if (String(session.userId) === String(targetId)) return sendJson(res, 403, { error: 'cannot_edit_self' });
  const target = await db.findUserById(targetId);
  if (!target) return sendJson(res, 404, { error: 'user_not_found' });
  if (!canManageExistingRole(session.role, target.role)) return sendJson(res, 403, { error: 'cannot_manage_role' });
  const body = await getRequestBody(req, res);
  if (!body) return;
  const role = typeof body.role === 'string' ? body.role : '';
  const serverId = normalizeUserServer(role, body.serverId);
  if (!canAssignRole(session.role, role)) return sendJson(res, 403, { error: 'invalid_role' });
  if (role === 'user' && !serverId) return sendJson(res, 400, { error: 'server_required' });
  await db.updateUser(targetId, { role, serverId });
  invalidateUserSessions(targetId);
  await audit(session, 'user_updated', {
    targetType: 'user', targetId: String(targetId), serverId,
    ipAddress: getClientIp(req), details: { username: target.username, fromRole: target.role, toRole: role, serverId },
  });
  return sendJson(res, 200, { ok: true });
}

async function handleDeleteUser(req, res, session, targetId) {
  if (!session) return sendUnauthorized(res);
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'invalid_origin' });
  if (String(session.userId) === String(targetId)) return sendJson(res, 403, { error: 'cannot_delete_self' });
  const target = await db.findUserById(targetId);
  if (!target) return sendJson(res, 404, { error: 'user_not_found' });
  if (!canManageExistingRole(session.role, target.role)) return sendJson(res, 403, { error: 'cannot_manage_role' });
  await db.deleteUser(targetId);
  invalidateUserSessions(targetId);
  await audit(session, 'user_deleted', {
    targetType: 'user', targetId: String(targetId), serverId: target.server_id ? String(target.server_id) : null,
    ipAddress: getClientIp(req), details: { username: target.username, role: target.role },
  });
  return sendJson(res, 200, { ok: true });
}

async function handleAdminOverview(res, session) {
  if (!session) return sendUnauthorized(res);
  if (!canAdminister(session.role)) return sendJson(res, 403, { error: 'forbidden' });
  const [statistics, helpRequests, logs] = await Promise.all([
    db.listStatistics(), db.listHelpRequests(), db.listAuditLogs(500),
  ]);
  return sendJson(res, 200, {
    statistics: normalizeStatistics(statistics),
    helpRequests: helpRequests.map((row) => ({
      id: String(row.id), serverId: String(row.server_id), sheetKey: row.sheet_key,
      rowKey: row.row_key, data: parseJson(row.data_json), assignedUsername: row.assigned_username,
      statusByUsername: row.status_by_username, statusUpdatedAt: row.status_updated_at,
    })),
    logs: logs.map((log) => ({
      id: String(log.id), actorUsername: log.actor_username, action: log.action,
      targetType: log.target_type, targetId: log.target_id,
      serverId: log.server_id ? String(log.server_id) : null, ipAddress: log.ip_address,
      details: parseJson(log.details_json), createdAt: log.created_at,
    })),
  });
}

async function getSession(req) {
  const rawToken = getCookie(req, 'mass_session');
  if (!rawToken) return null;
  const tokenHash = hashToken(rawToken);
  const session = sessions.get(tokenHash);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) { sessions.delete(tokenHash); return null; }
  const user = await db.findUserById(session.userId);
  if (!user) { sessions.delete(tokenHash); return null; }
  session.username = user.username;
  session.role = user.role;
  session.serverId = user.server_id ? String(user.server_id) : null;
  return session;
}

function resolveServer(session, requested) {
  if (session.role === 'user') return SERVERS.includes(session.serverId) ? session.serverId : null;
  return SERVERS.includes(String(requested)) ? String(requested) : SERVERS[0];
}
function normalizeUserServer(role, value) {
  if (role !== 'user') return null;
  return SERVERS.includes(String(value)) ? String(value) : null;
}
function canAdminister(role) { return role !== 'user' && Boolean(ROLE_RANK[role]); }
function canAssignRole(actorRole, targetRole) {
  if (!ROLE_RANK[targetRole]) return false;
  if (actorRole === 'developer') return true;
  return Boolean(ROLE_RANK[actorRole] && ROLE_RANK[actorRole] > ROLE_RANK[targetRole]);
}
function canManageExistingRole(actorRole, targetRole) {
  if (actorRole === 'developer') return true;
  return Boolean(ROLE_RANK[actorRole] && ROLE_RANK[targetRole] && ROLE_RANK[actorRole] > ROLE_RANK[targetRole]);
}
function publicUser(session) {
  return { authenticated: true, id: session.userId, username: session.username, role: session.role,
    serverId: session.serverId, canAdminister: canAdminister(session.role), globalServerAccess: session.role !== 'user' };
}
function serializeWorkRow(row) {
  return { id: String(row.id), rowKey: row.row_key, data: parseJson(row.data_json), status: row.status,
    assignedUserId: row.assigned_user_id ? String(row.assigned_user_id) : null,
    assignedUsername: row.assigned_username, statusByUsername: row.status_by_username,
    statusUpdatedAt: row.status_updated_at, createdAt: row.created_at };
}
function normalizeStatistics(rows) {
  const map = new Map(rows.map((row) => [String(row.server_id), row]));
  return SERVERS.map((serverId) => {
    const row = map.get(serverId) || {};
    return { serverId, total: Number(row.total || 0), completed: Number(row.completed || 0),
      pending: Number(row.pending || 0), violation: Number(row.violation || 0),
      clear: Number(row.clear_count || 0), help: Number(row.help_count || 0), processed: Number(row.processed || 0) };
  });
}
function isValidUsername(username) { return username.length >= 3 && username.length <= 80 && /^[\p{L}\p{N}_.-]+$/u.test(username); }
function invalidateUserSessions(userId) {
  for (const [token, session] of sessions) if (String(session.userId) === String(userId)) sessions.delete(token);
}
async function audit(session, action, fields = {}) {
  await db.addAuditLog({ actorUserId: session.userId, actorUsername: session.username, action, ...fields });
}
function parseJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}
async function getRequestBody(req, res) {
  try { return await readJsonBody(req); }
  catch (error) { sendJson(res, error.statusCode || 400, { error: 'invalid_request' }); return null; }
}
function getAttemptState(ip) {
  const now = Date.now();
  const state = attempts.get(ip);
  if (!state || (state.windowStarted + ATTEMPT_WINDOW_MS < now && state.blockedUntil <= now)) {
    const fresh = { count: 0, windowStarted: now, blockedUntil: 0 };
    attempts.set(ip, fresh); return fresh;
  }
  return state;
}
function registerFailure(ip, state) { state.count += 1; if (state.count >= MAX_ATTEMPTS) state.blockedUntil = Date.now() + BLOCK_DURATION_MS; attempts.set(ip, state); }
function getClientIp(req) {
  if (TRUST_PROXY_HOPS > 0) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((value) => value.trim()).filter(Boolean);
    const index = Math.max(0, forwarded.length - TRUST_PROXY_HOPS);
    if (forwarded[index]) return forwarded[index].slice(0, 128);
  }
  return req.socket.remoteAddress || 'unknown';
}
function sameOrigin(req) { const origin = req.headers.origin; if (!origin) return true; try { return new URL(origin).host === req.headers.host; } catch { return false; } }
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []; let settled = false;
    req.on('data', (chunk) => {
      if (settled) return; size += chunk.length;
      if (size > MAX_BODY_BYTES) { settled = true; const error = new Error('Body too large'); error.statusCode = 413; reject(error); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (settled) return; try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function getCookie(req, name) {
  for (const cookie of String(req.headers.cookie || '').split(';')) {
    const separator = cookie.indexOf('=');
    if (separator !== -1 && cookie.slice(0, separator).trim() === name) return decodeURIComponent(cookie.slice(separator + 1).trim());
  }
  return '';
}
function makeSessionCookie(value, maxAgeMs) {
  const secure = COOKIE_SECURE ? '; Secure' : '';
  return `mass_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`;
}
function setSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cache-Control', 'no-store'); if (PRODUCTION) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
async function sendFile(res, file, contentType) { const contents = await readFile(file); res.writeHead(200, { 'Content-Type': contentType }); res.end(contents); }
function sendUnauthorized(res) {
  res.setHeader('Set-Cookie', makeSessionCookie('', 0));
  return sendJson(res, 401, { error: 'session_expired' });
}
function sendJson(res, statusCode, payload) { res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(payload)); }
function redirect(res, location) { res.writeHead(303, { Location: location }); res.end(); }
function hashToken(token) { return createHash('sha256').update(token).digest('hex'); }
function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function cleanup() {
  const now = Date.now();
  for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token);
  for (const [ip, state] of attempts) if (state.blockedUntil <= now && state.windowStarted + ATTEMPT_WINDOW_MS <= now) attempts.delete(ip);
}
function parseInteger(value, fallback, min, max) { const parsed = Number.parseInt(value, 10); return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback; }
async function shutdown() { server.close(); await db.closeDatabase(); process.exit(0); }
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
