'use strict';

const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} = require('node:crypto');

const PORT = parseInteger(process.env.PORT, 3000, 1, 65535);
const PRODUCTION = process.env.NODE_ENV === 'production';
const TRUST_PROXY_HOPS = parseInteger(process.env.TRUST_PROXY_HOPS, 0, 0, 5);
const USERNAME = process.env.APP_USERNAME || '';
const PASSWORD_HASH = resolvePasswordHash();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const BLOCK_DURATION_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_BODY_BYTES = 8 * 1024;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PRIVATE_DIR = path.join(__dirname, 'private');
const sessions = new Map();
const attempts = new Map();

if (!USERNAME || !PASSWORD_HASH) {
  console.error('Не заданы APP_USERNAME и APP_PASSWORD_HASH (или APP_PASSWORD для локальной разработки).');
  process.exit(1);
}

const routes = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/private.css': ['private.css', 'text/css; charset=utf-8'],
  '/protected.js': ['protected.js', 'text/javascript; charset=utf-8'],
};

const server = http.createServer(async (req, res) => {
  setSecurityHeaders(res);

  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && routes[url.pathname]) {
      const [file, contentType] = routes[url.pathname];
      return sendFile(res, path.join(PUBLIC_DIR, file), contentType);
    }

    if (req.method === 'POST' && url.pathname === '/api/login') {
      return handleLogin(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
      return handleLogout(req, res);
    }

    if (req.method === 'GET' && url.pathname === '/api/me') {
      const session = getSession(req);
      return session
        ? sendJson(res, 200, { authenticated: true, username: session.username })
        : sendJson(res, 401, { authenticated: false });
    }

    if (req.method === 'GET' && url.pathname === '/app') {
      if (!getSession(req)) return redirect(res, '/');
      return sendFile(res, path.join(PRIVATE_DIR, 'app.html'), 'text/html; charset=utf-8');
    }

    return sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: 'internal_error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`PhpMyTech запущен: http://localhost:${PORT}`);
  if (!PRODUCTION && process.env.APP_PASSWORD) {
    console.warn('Для production используйте APP_PASSWORD_HASH вместо APP_PASSWORD.');
  }
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

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, error.statusCode || 400, { error: 'invalid_request' });
  }

  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const valid = safeTextEqual(username, USERNAME) && verifyPassword(password, PASSWORD_HASH);

  if (!valid) {
    registerFailure(ip, state);
    await delay(350 + Math.floor(Math.random() * 250));
    return sendJson(res, 401, { error: 'invalid_credentials' });
  }

  attempts.delete(ip);
  const rawToken = randomBytes(32).toString('base64url');
  sessions.set(hashToken(rawToken), {
    username: USERNAME,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });

  res.setHeader('Set-Cookie', makeSessionCookie(rawToken, SESSION_TTL_MS));
  return sendJson(res, 200, { ok: true });
}

function handleLogout(req, res) {
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'invalid_origin' });
  const rawToken = getCookie(req, 'pmt_session');
  if (rawToken) sessions.delete(hashToken(rawToken));
  res.setHeader('Set-Cookie', makeSessionCookie('', 0));
  return sendJson(res, 200, { ok: true });
}

function getSession(req) {
  const rawToken = getCookie(req, 'pmt_session');
  if (!rawToken) return null;
  const tokenHash = hashToken(rawToken);
  const session = sessions.get(tokenHash);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(tokenHash);
    return null;
  }
  return session;
}

function resolvePasswordHash() {
  if (process.env.APP_PASSWORD_HASH) return process.env.APP_PASSWORD_HASH;
  if (!process.env.APP_PASSWORD) return '';
  const salt = randomBytes(16);
  const derived = scryptSync(process.env.APP_PASSWORD, salt, 64);
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

function verifyPassword(password, encodedHash) {
  const parts = encodedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    if (salt.length !== 16 || expected.length !== 64) return false;
    const actual = scryptSync(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function safeTextEqual(left, right) {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
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
    const forwarded = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const index = Math.max(0, forwarded.length - TRUST_PROXY_HOPS);
    if (forwarded[index]) return forwarded[index].slice(0, 128);
  }
  return req.socket.remoteAddress || 'unknown';
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error('Body too large');
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(value);
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function getCookie(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    if (separator === -1) continue;
    if (cookie.slice(0, separator).trim() === name) {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    }
  }
  return '';
}

function makeSessionCookie(value, maxAgeMs) {
  const secure = PRODUCTION ? '; Secure' : '';
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

function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function cleanup() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
  for (const [ip, state] of attempts) {
    if (state.blockedUntil <= now && state.windowStarted + ATTEMPT_WINDOW_MS <= now) attempts.delete(ip);
  }
}

function parseInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
