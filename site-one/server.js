'use strict';

const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const {
  initializeDatabase, findUserByUsername, findUserById, listUsers,
  createUser, deleteUser, closeDatabase,
} = require('./lib/database');
const { hashPassword, verifyPassword } = require('./lib/passwords');

const PORT = parseInteger(process.env.PORT, 3000, 1, 65535);
const PRODUCTION = process.env.NODE_ENV === 'production';
const COOKIE_SECURE = process.env.COOKIE_SECURE === undefined
  ? PRODUCTION
  : process.env.COOKIE_SECURE === 'true';
const TRUST_PROXY_HOPS = parseInteger(process.env.TRUST_PROXY_HOPS, 0, 0, 5);
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const BLOCK_DURATION_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_BODY_BYTES = 16 * 1024;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PRIVATE_DIR = path.join(__dirname, 'private');
const ROLE_RANK = Object.freeze({ user: 1, admin: 2, superadmin: 3 });
const sessions = new Map();
const attempts = new Map();
const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(24).toString('hex'));

const publicRoutes = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/private.css': ['private.css', 'text/css; charset=utf-8'],
  '/protected.js': ['protected.js', 'text/javascript; charset=utf-8'],
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
      return session ? sendJson(res, 200, publicUser(session)) : sendJson(res, 401, { error: 'unauthorized' });
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
    if (url.pathname === '/api/users' && req.method === 'GET') {
      if (!session) return sendJson(res, 401, { error: 'unauthorized' });
      if (!canAdminister(session.role)) return sendJson(res, 403, { error: 'forbidden' });
      const users = await listUsers();
      return sendJson(res, 200, { users: users.map((user) => ({
        id: String(user.id), username: user.username, role: user.role,
        createdAt: user.created_at, createdBy: user.created_by_username,
        canDelete: canManageRole(session.role, user.role) && String(user.id) !== String(session.userId),
      })) });
    }
    if (url.pathname === '/api/users' && req.method === 'POST') return handleCreateUser(req, res, session);
    const deleteMatch = url.pathname.match(/^\/api\/users\/(\d+)$/);
    if (deleteMatch && req.method === 'DELETE') return handleDeleteUser(req, res, session, deleteMatch[1]);
    return sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: 'internal_error' });
  }
});

async function start() {
  await initializeDatabase();
  server.listen(PORT, '0.0.0.0', () => console.log(`PhpMyTech запущен: http://localhost:${PORT}`));
}

start().catch((error) => {
  console.error('Не удалось запустить PhpMyTech:', error.message);
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
  const user = username ? await findUserByUsername(username) : null;
  const valid = user ? verifyPassword(password, user.password_hash) : verifyPassword(password, DUMMY_PASSWORD_HASH);
  if (!user || !valid) {
    registerFailure(ip, state);
    await delay(300 + Math.floor(Math.random() * 250));
    return sendJson(res, 401, { error: 'invalid_credentials' });
  }
  attempts.delete(ip);
  const rawToken = randomBytes(32).toString('base64url');
  sessions.set(hashToken(rawToken), {
    userId: String(user.id), username: user.username, role: user.role,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  res.setHeader('Set-Cookie', makeSessionCookie(rawToken, SESSION_TTL_MS));
  return sendJson(res, 200, { ok: true });
}

async function handleCreateUser(req, res, session) {
  if (!session) return sendJson(res, 401, { error: 'unauthorized' });
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'invalid_origin' });
  if (!canAdminister(session.role)) return sendJson(res, 403, { error: 'forbidden' });
  const body = await getRequestBody(req, res);
  if (!body) return;
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const role = typeof body.role === 'string' ? body.role : '';
  if (!isValidUsername(username)) return sendJson(res, 400, { error: 'invalid_username' });
  if (password.length < 12 || password.length > 256) return sendJson(res, 400, { error: 'weak_password' });
  if (!canManageRole(session.role, role)) return sendJson(res, 403, { error: 'invalid_role' });
  try {
    const id = await createUser({ username, passwordHash: hashPassword(password), role, createdBy: session.userId });
    return sendJson(res, 201, { id: String(id), username, role });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return sendJson(res, 409, { error: 'username_exists' });
    throw error;
  }
}

async function handleDeleteUser(req, res, session, targetId) {
  if (!session) return sendJson(res, 401, { error: 'unauthorized' });
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'invalid_origin' });
  if (!canAdminister(session.role)) return sendJson(res, 403, { error: 'forbidden' });
  if (String(session.userId) === String(targetId)) return sendJson(res, 403, { error: 'cannot_delete_self' });
  const target = await findUserById(targetId);
  if (!target) return sendJson(res, 404, { error: 'user_not_found' });
  if (!canManageRole(session.role, target.role)) return sendJson(res, 403, { error: 'cannot_manage_role' });
  await deleteUser(targetId);
  invalidateUserSessions(targetId);
  return sendJson(res, 200, { ok: true });
}

function handleLogout(req, res) {
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'invalid_origin' });
  const rawToken = getCookie(req, 'pmt_session');
  if (rawToken) sessions.delete(hashToken(rawToken));
  res.setHeader('Set-Cookie', makeSessionCookie('', 0));
  return sendJson(res, 200, { ok: true });
}

async function getSession(req) {
  const rawToken = getCookie(req, 'pmt_session');
  if (!rawToken) return null;
  const tokenHash = hashToken(rawToken);
  const session = sessions.get(tokenHash);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(tokenHash);
    return null;
  }
  const currentUser = await findUserById(session.userId);
  if (!currentUser) {
    sessions.delete(tokenHash);
    return null;
  }
  session.username = currentUser.username;
  session.role = currentUser.role;
  return session;
}

function canAdminister(role) { return role === 'admin' || role === 'superadmin'; }
function canManageRole(actorRole, targetRole) {
  return Boolean(ROLE_RANK[actorRole] && ROLE_RANK[targetRole] && ROLE_RANK[actorRole] > ROLE_RANK[targetRole]);
}
function publicUser(session) {
  return { authenticated: true, id: session.userId, username: session.username, role: session.role, canAdminister: canAdminister(session.role) };
}
function isValidUsername(username) {
  return username.length >= 3 && username.length <= 80 && /^[\p{L}\p{N}_.-]+$/u.test(username);
}
function invalidateUserSessions(userId) {
  for (const [token, session] of sessions) if (String(session.userId) === String(userId)) sessions.delete(token);
}
async function getRequestBody(req, res) {
  try { return await readJsonBody(req); }
  catch (error) {
    sendJson(res, error.statusCode || 400, { error: 'invalid_request' });
    return null;
  }
}
function getAttemptState(ip) {
  const now = Date.now();
  const state = attempts.get(ip);
  if (!state || (state.windowStarted + ATTEMPT_WINDOW_MS < now && state.blockedUntil <= now)) {
    const fresh = { count: 0, windowStarted: now, blockedUntil: 0 };
    attempts.set(ip, fresh);
    return fresh;
  }
  return state;
}
function registerFailure(ip, state) {
  state.count += 1;
  if (state.count >= MAX_ATTEMPTS) state.blockedUntil = Date.now() + BLOCK_DURATION_MS;
  attempts.set(ip, state);
}
function getClientIp(req) {
  if (TRUST_PROXY_HOPS > 0) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((value) => value.trim()).filter(Boolean);
    const index = Math.max(0, forwarded.length - TRUST_PROXY_HOPS);
    if (forwarded[index]) return forwarded[index].slice(0, 128);
  }
  return req.socket.remoteAddress || 'unknown';
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; }
  catch { return false; }
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        const error = new Error('Body too large');
        error.statusCode = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function getCookie(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    if (separator === -1) continue;
    if (cookie.slice(0, separator).trim() === name) return decodeURIComponent(cookie.slice(separator + 1).trim());
  }
  return '';
}
function makeSessionCookie(value, maxAgeMs) {
  const secure = COOKIE_SECURE ? '; Secure' : '';
  return `pmt_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`;
}
function setSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cache-Control', 'no-store');
  if (PRODUCTION) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
async function sendFile(res, file, contentType) {
  const contents = await readFile(file);
  res.writeHead(200, { 'Content-Type': contentType });
  res.end(contents);
}
function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}
function redirect(res, location) { res.writeHead(303, { Location: location }); res.end(); }
function hashToken(token) { return createHash('sha256').update(token).digest('hex'); }
function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function cleanup() {
  const now = Date.now();
  for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token);
  for (const [ip, state] of attempts) if (state.blockedUntil <= now && state.windowStarted + ATTEMPT_WINDOW_MS <= now) attempts.delete(ip);
}
function parseInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
async function shutdown() {
  server.close();
  await closeDatabase();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
