// Utilidades das funções da Vercel. Arquivos que começam com "_" não viram rotas.
//
// Variáveis de ambiente (Vercel › Settings › Environment Variables):
//   POSTLY_PASSWORD        senha do painel
//   GITHUB_TOKEN           token do GitHub (fine-grained) com Contents, Actions e Secrets: Read and write
//   BLOB_READ_WRITE_TOKEN  criado automaticamente ao conectar um Blob Store ao projeto
//   POSTLY_REPO            (opcional) "dono/repositorio"; padrão: o repositório ligado à Vercel
import crypto from 'node:crypto';

const COOKIE = 'postly_session';
const SESSION_DAYS = 30;

export function repo() {
  const [owner, name] = (process.env.POSTLY_REPO || '').split('/');
  if (owner && name) return { owner, repo: name };
  if (process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG) {
    return { owner: process.env.VERCEL_GIT_REPO_OWNER, repo: process.env.VERCEL_GIT_REPO_SLUG };
  }
  return { owner: 'gabrielsantos-git', repo: 'postly' };
}

export const githubApi = () => (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');

export function configured() {
  return {
    password: Boolean(process.env.POSTLY_PASSWORD),
    github: Boolean(process.env.GITHUB_TOKEN),
    blob: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
  };
}

const key = () =>
  crypto
    .createHash('sha256')
    .update(`postly-session:${process.env.POSTLY_PASSWORD}:${process.env.GITHUB_TOKEN}`)
    .digest();

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', key()).update(body).digest('base64url')}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', key()).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isLoggedIn(req) {
  if (!process.env.POSTLY_PASSWORD) return false;
  return verify(cookies(req)[COOKIE])?.sub === 'postly';
}

export function checkPassword(password) {
  const a = crypto.createHash('sha256').update(String(password ?? '')).digest();
  const b = crypto.createHash('sha256').update(String(process.env.POSTLY_PASSWORD ?? '')).digest();
  return Boolean(process.env.POSTLY_PASSWORD) && crypto.timingSafeEqual(a, b);
}

const secure = (req) => (req.headers['x-forwarded-proto'] || '').includes('https');

export function setSessionCookie(req, res) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  res.setHeader(
    'set-cookie',
    `${COOKIE}=${sign({ sub: 'postly', exp })}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure(req) ? '; Secure' : ''}`,
  );
}

export function clearSessionCookie(req, res) {
  res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(req) ? '; Secure' : ''}`);
}

export function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(data === undefined ? '' : JSON.stringify(data));
}

// Garante que a requisição veio do próprio site (proteção contra CSRF) e que há sessão.
export function requireLogin(req, res) {
  if (req.method !== 'GET' && req.headers['x-postly'] !== '1') {
    sendJson(res, 403, { message: 'Requisição recusada.' });
    return false;
  }
  if (!isLoggedIn(req)) {
    sendJson(res, 401, { message: 'Faça login para continuar.' });
    return false;
  }
  return true;
}

export async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body || 'null') : req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : null;
}

export async function github(method, path, body) {
  const res = await fetch(githubApi() + path, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'postly',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}
