import { config } from './config.js';
import { sign, verify, safeEqual } from './crypto.js';

const COOKIE = 'postly_session';
const SESSION_DAYS = 7;

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const secureCookie = () => config.publicBaseUrl.startsWith('https://');

export function isAuthenticated(req) {
  const session = verify(parseCookies(req.headers.cookie)[COOKIE]);
  return session?.sub === 'admin';
}

export function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  if (req.path.startsWith('/api/') || req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ error: 'Faça login para continuar.' });
  }
  return res.redirect('/login.html');
}

// Limite simples de tentativas de login por IP (10 a cada 15 minutos).
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const entry = attempts.get(ip) || { count: 0, since: now };
  if (now - entry.since > 15 * 60 * 1000) {
    entry.count = 0;
    entry.since = now;
  }
  entry.count += 1;
  attempts.set(ip, entry);
  return entry.count > 10;
}

export function login(req, res) {
  if (tooManyAttempts(req.ip)) {
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
  }
  const password = req.body?.password ?? '';
  if (!safeEqual(password, config.adminPassword)) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }
  attempts.delete(req.ip);
  const exp = Date.now() + SESSION_DAYS * 24 * 3600 * 1000;
  res.cookie(COOKIE, sign({ sub: 'admin', exp }), {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookie(),
    maxAge: SESSION_DAYS * 24 * 3600 * 1000,
    path: '/',
  });
  res.json({ ok: true });
}

export function logout(req, res) {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
}
