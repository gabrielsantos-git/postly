// Publicador do Postly — roda no GitHub Actions (.github/workflows/publish.yml).
//
//   node scripts/publish.mjs            publica os posts cujo horário chegou
//   node scripts/publish.mjs connect    valida o token salvo no secret CONNECT_SECRET e cadastra a conta
//
// Variáveis de ambiente:
//   SECRETS_JSON         todos os secrets do repositório (toJSON(secrets)); os tokens do Instagram vêm daqui
//   POSTLY_GH_TOKEN      (opcional) token do GitHub com permissão de escrever secrets — ativa a renovação automática dos tokens
//   GITHUB_REPOSITORY    dono/repositório (definido pelo Actions)
//   POSTLY_PUBLIC_URL    (opcional) URL do site no GitHub Pages, se for diferente da padrão
//   RUN_BUDGET_SECONDS   (opcional) quanto tempo esta execução pode ficar esperando posts (padrão 540)
//   POSTLY_NO_GIT=1      não faz git pull/commit/push (testes)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInstagramClient, GraphApiError } from './lib/instagram.mjs';
import { createPublisher, isDue } from './lib/publisher.mjs';

const ROOT = process.env.POSTLY_ROOT || process.cwd();
const DATA = path.join(ROOT, 'data');
const POSTS_DIR = path.join(DATA, 'posts');
const CONNECT_DIR = path.join(DATA, 'connect');
const ACCOUNTS_FILE = path.join(DATA, 'accounts.json');
const NO_GIT = process.env.POSTLY_NO_GIT === '1';
const DAY = 24 * 3600 * 1000;

const secrets = JSON.parse(process.env.SECRETS_JSON || '{}');
const ig = createInstagramClient({ apiVersion: process.env.GRAPH_API_VERSION || 'v24.0' });

export function publicBaseUrl() {
  if (process.env.POSTLY_PUBLIC_URL) return process.env.POSTLY_PUBLIC_URL.replace(/\/+$/, '');
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '/').split('/');
  const host = `${owner.toLowerCase()}.github.io`;
  return repo.toLowerCase() === host ? `https://${host}` : `https://${host}/${repo}`;
}
const mediaUrl = (m) => `${publicBaseUrl()}/${m.path}`;

// ---------------------------------------------------------------- arquivos
const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};
const readAccounts = () => readJson(ACCOUNTS_FILE, []);
const writeAccounts = (a) => writeJson(ACCOUNTS_FILE, a);
function readPosts() {
  if (!fs.existsSync(POSTS_DIR)) return [];
  return fs
    .readdirSync(POSTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(POSTS_DIR, f), null))
    .filter(Boolean);
}
const writePost = (p) => writeJson(path.join(POSTS_DIR, `${p.id}.json`), p);

// ---------------------------------------------------------------- git
function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}
function gitPull() {
  if (NO_GIT) return;
  try {
    git('pull', '--rebase', '-X', 'theirs', '--quiet');
  } catch (err) {
    console.warn('[git] pull falhou:', err.stderr?.toString() || err.message);
  }
}
function gitCommit(message) {
  if (NO_GIT) return;
  git('add', '-A', 'data');
  try {
    git('diff', '--cached', '--quiet');
    return; // nada mudou
  } catch {
    // há mudanças
  }
  git('commit', '--quiet', '-m', message);
  for (let i = 0; i < 5; i++) {
    try {
      git('push', '--quiet');
      return;
    } catch {
      git('pull', '--rebase', '-X', 'theirs', '--quiet');
    }
  }
  throw new Error('Não foi possível enviar as alterações para o repositório.');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- secrets (renovação de token)
async function updateRepoSecret(name, value) {
  const ghToken = process.env.POSTLY_GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const headers = { authorization: `Bearer ${ghToken}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  const keyRes = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/public-key`, { headers });
  if (!keyRes.ok) throw new Error(`GitHub: não foi possível ler a chave pública (${keyRes.status})`);
  const key = await keyRes.json();
  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL));
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/${name}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL), key_id: key.key_id }),
  });
  if (!res.ok) throw new Error(`GitHub: não foi possível salvar o secret ${name} (${res.status})`);
}

async function refreshTokens(accounts) {
  if (!process.env.POSTLY_GH_TOKEN) return false;
  let changed = false;
  for (const acc of accounts) {
    if (acc.status !== 'active') continue;
    if (acc.tokenUpdatedAt && Date.now() - new Date(acc.tokenUpdatedAt).getTime() < 7 * DAY) continue;
    const token = secrets[acc.secretName];
    if (!token) continue;
    try {
      const res = await ig.refreshToken(token);
      await updateRepoSecret(acc.secretName, res.access_token);
      acc.tokenUpdatedAt = new Date().toISOString();
      acc.tokenExpiresAt = res.expires_in ? new Date(Date.now() + res.expires_in * 1000).toISOString() : acc.tokenExpiresAt;
      acc.expiryEstimated = !res.expires_in;
      secrets[acc.secretName] = res.access_token;
      console.log(`[tokens] token de @${acc.username} renovado`);
      changed = true;
    } catch (err) {
      if (err instanceof GraphApiError && err.isAuthError) {
        acc.status = 'needs_reauth';
        acc.statusMessage = `Token inválido: ${err.describe()}`;
        changed = true;
      }
      console.warn(`[tokens] falha ao renovar @${acc.username}: ${err.message}`);
    }
  }
  return changed;
}

// ---------------------------------------------------------------- limpeza
function cleanup(posts) {
  let changed = false;
  // Remove mídias de posts publicados há mais de 7 dias (o site do Pages tem limite de 1 GB).
  const inUse = new Set();
  const removable = new Set();
  for (const p of posts) {
    const old = p.status === 'published' && p.publishedAt && Date.now() - new Date(p.publishedAt).getTime() > 7 * DAY;
    for (const m of p.media || []) (old ? removable : inUse).add(m.path);
    if (old && !p.mediaRemoved) {
      p.mediaRemoved = true;
      writePost(p);
      changed = true;
    }
  }
  for (const file of removable) {
    if (!inUse.has(file) && file.startsWith('data/media/') && fs.existsSync(path.join(ROOT, file))) {
      fs.rmSync(path.join(ROOT, file));
      changed = true;
    }
  }
  // Resultados antigos de conexão de conta.
  if (fs.existsSync(CONNECT_DIR)) {
    for (const f of fs.readdirSync(CONNECT_DIR)) {
      const full = path.join(CONNECT_DIR, f);
      if (Date.now() - fs.statSync(full).mtimeMs > DAY) {
        fs.rmSync(full);
        changed = true;
      }
    }
  }
  return changed;
}

// Pede um novo deploy do site (workflow pages.yml) — no máximo uma vez por execução.
let deployRequested = false;
async function requestPagesDeploy() {
  if (deployRequested || !process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) return;
  deployRequested = true;
  try {
    const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/pages.yml/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ref: process.env.GITHUB_REF_NAME || 'main' }),
    });
    console.log(res.ok ? '[pages] novo deploy do site solicitado' : `[pages] não foi possível pedir o deploy (${res.status})`);
  } catch (err) {
    console.warn('[pages] falha ao pedir deploy:', err.message);
  }
}

async function isMediaReady(m) {
  try {
    const res = await fetch(mediaUrl(m), { method: 'HEAD', cache: 'no-store' });
    if (res.ok) return true;
  } catch {
    // trata como indisponível
  }
  await requestPagesDeploy();
  return false;
}

// ---------------------------------------------------------------- publicar
export async function runPublish({ budgetMs = Number(process.env.RUN_BUDGET_SECONDS || 540) * 1000, mediaCheck = isMediaReady } = {}) {
  const deadline = Date.now() + budgetMs;
  const publisher = createPublisher({ ig, mediaUrl, isMediaReady: mediaCheck });

  gitPull();
  {
    const accounts = readAccounts();
    const changedAccounts = await refreshTokens(accounts);
    if (changedAccounts) writeAccounts(accounts);
    const changedFiles = cleanup(readPosts());
    if (changedAccounts || changedFiles) gitCommit('Postly: manutenção (tokens/mídias)');
  }

  for (let round = 0; ; round++) {
    if (round > 0) gitPull();
    const accounts = readAccounts();
    const posts = readPosts();
    const byId = new Map(accounts.map((a) => [a.id, a]));
    let changed = false;
    let accountsChanged = false;
    const published = [];

    for (const post of posts.filter((p) => isDue(p))) {
      const account = byId.get(post.accountId);
      const before = JSON.stringify(post);
      const result = await publisher.advance(post, account, account && secrets[account.secretName]);
      if (result.reauth && account) {
        account.status = 'needs_reauth';
        account.statusMessage = result.reauth;
        accountsChanged = true;
      }
      if (JSON.stringify(post) !== before) {
        writePost(post);
        changed = true;
        if (post.status === 'published') published.push(`@${account?.username}`);
        console.log(`[post ${post.id}] ${post.status}${post.lastError ? ` — ${post.lastError}` : ''}`);
      }
    }
    if (accountsChanged) writeAccounts(accounts);
    if (changed || accountsChanged) {
      gitCommit(published.length ? `Postly: publicado em ${published.join(', ')}` : 'Postly: atualiza status das publicações');
    }

    // Espera só por posts em andamento ou que vencem nos próximos minutos.
    const now = Date.now();
    const horizon = Math.min(deadline - 30_000, now + 4 * 60_000);
    const upcoming = readPosts()
      .map((p) => {
        if (p.status === 'processing') return new Date(p.nextCheckAt || now).getTime();
        if (p.status === 'scheduled') return Math.max(new Date(p.scheduledAt).getTime(), new Date(p.nextCheckAt || 0).getTime());
        return Infinity;
      })
      .filter((t) => t <= horizon);
    if (!upcoming.length || Date.now() > deadline) break;
    await sleep(Math.max(1000, Math.min(15_000, Math.min(...upcoming) - Date.now())));
  }
}

// ---------------------------------------------------------------- conectar conta
export async function runConnect(secretName = process.env.CONNECT_SECRET) {
  gitPull();
  const resultFile = path.join(CONNECT_DIR, `${secretName}.json`);
  const token = secrets[secretName];
  let result;
  if (!/^IG_TOKEN_[A-Z0-9_]+$/.test(secretName || '')) {
    result = { ok: false, error: 'Nome de secret inválido.' };
  } else if (!token) {
    result = { ok: false, error: `O secret ${secretName} não foi encontrado no repositório.` };
  } else {
    try {
      const me = await ig.getMe(token);
      const accounts = readAccounts();
      const id = String(me.user_id || me.id);
      const now = new Date().toISOString();
      const existing = accounts.find((a) => a.id === id);
      const replacedSecret = existing && existing.secretName !== secretName ? existing.secretName : null;
      const data = {
        id,
        username: me.username,
        name: me.name ?? null,
        profilePictureUrl: me.profile_picture_url ?? null,
        accountType: me.account_type ?? null,
        secretName,
        tokenUpdatedAt: now,
        tokenExpiresAt: new Date(Date.now() + 60 * DAY).toISOString(),
        expiryEstimated: true,
        status: 'active',
        statusMessage: null,
        createdAt: existing?.createdAt ?? now,
      };
      if (existing) Object.assign(existing, data);
      else accounts.push(data);
      writeAccounts(accounts);
      result = { ok: true, accountId: id, username: me.username, replacedSecret };
    } catch (err) {
      result = { ok: false, error: err instanceof GraphApiError ? err.describe() : err.message };
    }
  }
  writeJson(resultFile, { ...result, at: new Date().toISOString() });
  gitCommit(result.ok ? `Postly: conta @${result.username} conectada` : 'Postly: falha ao conectar conta');
  console.log(result.ok ? `Conta @${result.username} conectada` : `Falha: ${result.error}`);
  return result;
}

// ---------------------------------------------------------------- main
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const mode = process.argv[2] || process.env.POSTLY_MODE || 'publish';
  (mode === 'connect' ? runConnect() : runPublish()).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { readPosts, readAccounts, writeAccounts, writePost };
