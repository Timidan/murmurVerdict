import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';

const MAX_BODY_BYTES = 2048;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 5;
const MAX_RATE_ENTRIES = 10_000;
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, body, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(body));
}

function securityHeaders(res) {
  res.setHeader('content-security-policy', "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'");
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
}

function readJsonBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(new Error('too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function isPrivateOrLoopback(ip = '') {
  const value = ip.replace(/^::ffff:/, '').toLowerCase();
  if (value === '::1' || value.startsWith('127.') || value.startsWith('10.') || value.startsWith('192.168.')) return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true;
  const parts = value.split('.');
  return parts.length === 4 && parts[0] === '172' && Number(parts[1]) >= 16 && Number(parts[1]) <= 31;
}

function clientIp(req, trustProxy) {
  const socketIp = req.socket.remoteAddress || 'unknown';
  const forwarded = req.headers['x-forwarded-for'];
  if (trustProxy && isPrivateOrLoopback(socketIp) && typeof forwarded === 'string' && !forwarded.includes(',')) {
    const value = forwarded.trim();
    if (value.length > 0 && value.length <= 64) return value;
  }
  return socketIp;
}

export function createWaitlistServer({
  dbPath = process.env.WAITLIST_DB || resolve('data', 'waitlist.sqlite'),
  publicDir = resolve('public'),
  publicOrigin = process.env.PUBLIC_ORIGIN || '',
  trustProxy = process.env.TRUST_PROXY === '1',
} = {}) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS waitlist_subscribers (email TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);');
  const insert = db.prepare('INSERT INTO waitlist_subscribers (email) VALUES (?) ON CONFLICT(email) DO NOTHING');
  const countSubscribers = db.prepare('SELECT count(*) AS count FROM waitlist_subscribers');
  const rateLimits = new Map();

  function takeRateLimit(ip) {
    const now = Date.now();
    for (const [key, entry] of rateLimits) if (entry.resetAt <= now) rateLimits.delete(key);
    let entry = rateLimits.get(ip);
    if (!entry) {
      if (rateLimits.size >= MAX_RATE_ENTRIES) return Math.ceil(RATE_WINDOW_MS / 1000);
      entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
      rateLimits.set(ip, entry);
    }
    entry.count += 1;
    return entry.count > RATE_LIMIT ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) : 0;
  }

  const server = createServer(async (req, res) => {
    securityHeaders(res);
    req.setTimeout(15_000, () => {
      if (!res.headersSent) sendJson(res, 408, { ok: false, error: 'Please try again.' });
      req.destroy();
    });
    const method = req.method || 'GET';
    let pathname;
    try { pathname = new URL(req.url || '/', 'http://local').pathname; }
    catch { sendJson(res, 400, { ok: false, error: 'That request could not be read.' }); return; }

    if (method === 'GET' && pathname === '/healthz') { sendJson(res, 200, { ok: true }); return; }

    if (method === 'GET' && pathname === '/api/waitlist/count') {
      try {
        const count = countSubscribers.get().count;
        sendJson(res, 200, { count });
      } catch (error) {
        console.error('waitlist count error', error?.name || 'Error');
        sendJson(res, 503, { ok: false, error: 'Waitlist count unavailable.' });
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/waitlist') {
      if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) { sendJson(res, 413, { ok: false, error: 'Please submit a shorter response.' }); return; }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { sendJson(res, 415, { ok: false, error: 'Please submit the form again.' }); return; }
      const origin = req.headers.origin;
      const expectedOrigin = publicOrigin || `http://${req.headers.host}`;
      if (origin && origin !== expectedOrigin) { sendJson(res, 403, { ok: false, error: 'Please submit this form from murmurapp.live.' }); return; }
      const retryAfter = takeRateLimit(clientIp(req, trustProxy));
      if (retryAfter) { sendJson(res, 429, { ok: false, error: 'Please wait a moment before trying again.' }, { 'retry-after': retryAfter }); return; }
      try {
        const input = await readJsonBody(req);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid json');
        if (typeof input.website === 'string' && input.website.trim()) { sendJson(res, 200, { ok: true }); return; }
        const email = normalizeEmail(input.email);
        if (!email) { sendJson(res, 400, { ok: false, error: 'Enter a valid email address.' }); return; }
        insert.run(email);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        if (error.message === 'too large') sendJson(res, 413, { ok: false, error: 'Please submit a shorter response.' });
        else if (error.message === 'invalid json') sendJson(res, 400, { ok: false, error: 'Enter a valid email address.' });
        else { console.error('waitlist database error', error?.name || 'Error'); sendJson(res, 503, { ok: false, error: 'We could not save your email. Please try again shortly.' }); }
      }
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') { sendJson(res, 404, { ok: false, error: 'Not found.' }); return; }
    let requestedPath;
    try { requestedPath = decodeURIComponent(pathname); }
    catch { sendJson(res, 400, { ok: false, error: 'Not found.' }); return; }
    const relativePath = requestedPath === '/' ? 'index.html' : requestedPath === '/privacy.html' ? 'privacy.html' : requestedPath.replace(/^\/+/, '');
    const filePath = resolve(publicDir, relativePath);
    const publicRoot = resolve(publicDir);
    if (!filePath.startsWith(publicRoot + sep)) { sendJson(res, 404, { ok: false, error: 'Not found.' }); return; }
    try {
      if (!statSync(filePath).isFile()) throw new Error('not file');
      if (!realpathSync(filePath).startsWith(realpathSync(publicRoot) + sep)) throw new Error('outside public');
      const bytes = readFileSync(filePath);
      res.writeHead(200, { 'content-type': MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream', 'cache-control': 'public, max-age=300' });
      if (method === 'GET') res.end(bytes); else res.end();
    } catch { sendJson(res, 404, { ok: false, error: 'Not found.' }); }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  return { server, close: () => { rateLimits.clear(); db.close(); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createWaitlistServer();
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3187);
  app.server.listen(port, host, () => console.log(`Murmur waitlist listening on ${host}:${port}`));
  const shutdown = () => app.server.close(() => { app.close(); process.exit(0); });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
