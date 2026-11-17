import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postly-test-'));
process.env.POSTLY_ROOT = root;
process.env.POSTLY_NO_GIT = '1';
process.env.GITHUB_REPOSITORY = 'Gabriel-Santos/postly';
process.env.SECRETS_JSON = JSON.stringify({ IG_TOKEN_ABC: 'TOKEN-ABC', IG_TOKEN_NEW: 'TOKEN-NEW', GITHUB_TOKEN: 'x' });

const { runPublish, runConnect, readPosts, readAccounts, writeAccounts, writePost, publicBaseUrl } = await import('../scripts/publish.mjs');
const { validatePost } = await import('../assets/rules.js');

// ---------- API do Instagram simulada ----------
let calls = [];
let handler = () => ({});
const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const isJson = typeof init.body === 'string' && init.body.startsWith('{');
    const params = init.body && !isJson ? Object.fromEntries(new URLSearchParams(init.body)) : Object.fromEntries(u.searchParams);
    const call = { method: init.method || 'GET', host: u.host, path: u.pathname, params, body: isJson ? JSON.parse(init.body) : null };
    calls.push(call);
    const out = handler(call) ?? {};
    const status = out.__status ?? 200;
    delete out.__status;
    return new Response(init.method === 'HEAD' ? null : JSON.stringify(out), { status });
  };
});
after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(root, { recursive: true, force: true });
});

const ACCOUNT = { id: '17841400000000001', username: 'minhaloja', secretName: 'IG_TOKEN_ABC', status: 'active' };

beforeEach(() => {
  calls = [];
  fs.rmSync(path.join(root, 'data'), { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'data/posts'), { recursive: true });
  writeAccounts([{ ...ACCOUNT, tokenUpdatedAt: new Date().toISOString() }]);
});

let seq = 0;
const img = (w = 1080, h = 1350) => ({ path: `data/media/i${++seq}.jpg`, kind: 'image', width: w, height: h, name: `foto${seq}.jpg` });
const vid = () => ({ path: `data/media/v${++seq}.mp4`, kind: 'video', name: `video${seq}.mp4` });

function schedule(type, media, extra = {}) {
  const post = {
    id: `p${++seq}`,
    accountId: ACCOUNT.id,
    type,
    caption: type === 'story' ? '' : 'Promoção de hoje! #oferta',
    media,
    shareToFeed: true,
    status: 'scheduled',
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
    attempts: 0,
    events: [],
    ...extra,
  };
  writePost(post);
  return post.id;
}
const getPost = (id) => readPosts().find((p) => p.id === id);

const happyApi = ({ statuses = {} } = {}) => {
  let n = 0;
  const polls = {};
  return (call) => {
    if (call.method === 'HEAD') return {};
    if (call.method === 'POST' && call.path.endsWith('/media')) return { id: `container-${++n}` };
    if (call.method === 'POST' && call.path.endsWith('/media_publish')) return { id: 'ig-media-999' };
    if (call.path.endsWith('/ig-media-999')) return { id: 'ig-media-999', permalink: 'https://www.instagram.com/p/ABC/' };
    const id = call.path.split('/').pop();
    if (call.params.fields?.includes('status_code')) {
      const s = statuses[id] || ['FINISHED'];
      polls[id] = (polls[id] ?? -1) + 1;
      return { id, status_code: s[Math.min(polls[id], s.length - 1)] };
    }
    return {};
  };
};
const creates = () => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/media'));
const run = () => runPublish({ budgetMs: 60_000 });

test('URL pública padrão do GitHub Pages', () => {
  assert.equal(publicBaseUrl(), 'https://gabriel-santos.github.io/postly');
});

test('publica uma foto no feed', async () => {
  handler = happyApi();
  const id = schedule('feed', [img()]);
  await run();
  const post = getPost(id);

  assert.equal(post.status, 'published');
  assert.equal(post.permalink, 'https://www.instagram.com/p/ABC/');
  const [create] = creates();
  assert.equal(create.host, 'graph.instagram.com');
  assert.equal(create.path, '/v24.0/17841400000000001/media');
  assert.match(create.params.image_url, /^https:\/\/gabriel-santos\.github\.io\/postly\/data\/media\/i\d+\.jpg$/);
  assert.equal(create.params.caption, 'Promoção de hoje! #oferta');
  assert.equal(create.params.access_token, 'TOKEN-ABC');
  assert.equal(calls.find((c) => c.path.endsWith('/media_publish')).params.creation_id, 'container-1');
  assert.ok(post.events.some((e) => e.message.startsWith('Publicado')));
});

test('publica um carrossel com foto e vídeo', async () => {
  handler = happyApi({ statuses: { 'container-2': ['IN_PROGRESS', 'FINISHED'] } });
  const id = schedule('feed', [img(), vid(), img()]);
  await run();
  assert.equal(getPost(id).status, 'published');

  const c = creates();
  assert.equal(c.length, 4);
  assert.equal(c[0].params.is_carousel_item, 'true');
  assert.equal(c[0].params.caption, undefined);
  assert.equal(c[1].params.media_type, 'VIDEO');
  assert.equal(c[3].params.media_type, 'CAROUSEL');
  assert.equal(c[3].params.children, 'container-1,container-2,container-3');
  assert.equal(c[3].params.caption, 'Promoção de hoje! #oferta');
  assert.equal(calls.find((x) => x.path.endsWith('/media_publish')).params.creation_id, 'container-4');
});

test('publica um Reels esperando o processamento do vídeo', async () => {
  handler = happyApi({ statuses: { 'container-1': ['IN_PROGRESS', 'FINISHED'] } });
  const id = schedule('reel', [vid()], { shareToFeed: false });
  await run();
  assert.equal(getPost(id).status, 'published');
  const [create] = creates();
  assert.equal(create.params.media_type, 'REELS');
  assert.equal(create.params.share_to_feed, 'false');
  assert.match(create.params.video_url, /\.mp4$/);
});

test('publica um story sem legenda', async () => {
  handler = happyApi();
  const id = schedule('story', [img(1080, 1920)]);
  await run();
  assert.equal(getPost(id).status, 'published');
  const [create] = creates();
  assert.equal(create.params.media_type, 'STORIES');
  assert.equal(create.params.caption, undefined);
});

test('não mexe em posts futuros, rascunhos ou cancelados', async () => {
  handler = happyApi();
  const future = schedule('feed', [img()], { scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
  const draft = schedule('feed', [img()], { status: 'draft' });
  const canceled = schedule('feed', [img()], { status: 'canceled' });
  await run();
  assert.equal(getPost(future).status, 'scheduled');
  assert.equal(getPost(draft).status, 'draft');
  assert.equal(getPost(canceled).status, 'canceled');
  assert.equal(creates().length, 0);
});

test('espera a mídia ficar disponível no GitHub Pages', async () => {
  handler = (call) => (call.method === 'HEAD' ? { __status: 404 } : happyApi()(call));
  const id = schedule('feed', [img()]);
  await runPublish({ budgetMs: 0 });
  const post = getPost(id);
  assert.equal(post.status, 'scheduled');
  assert.ok(post.waitingMediaSince);
  assert.equal(creates().length, 0);
});

test('marca falha quando o Instagram não processa a mídia', async () => {
  handler = happyApi({ statuses: { 'container-1': ['ERROR'] } });
  const id = schedule('reel', [vid()]);
  await run();
  const post = getPost(id);
  assert.equal(post.status, 'failed');
  assert.match(post.lastError, /ERROR/);
});

test('token inválido marca a conta para reconexão', async () => {
  handler = (call) =>
    call.method === 'HEAD' ? {} : { __status: 400, error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } };
  const id = schedule('feed', [img()]);
  await run();
  assert.equal(getPost(id).status, 'failed');
  assert.equal(readAccounts()[0].status, 'needs_reauth');
});

test('erro temporário reagenda com nova tentativa', async () => {
  handler = (call) => (call.method === 'HEAD' ? {} : { __status: 500, error: { message: 'Unexpected error', code: 2 } });
  const id = schedule('feed', [img()]);
  await runPublish({ budgetMs: 0 });
  const post = getPost(id);
  assert.equal(post.status, 'scheduled');
  assert.equal(post.attempts, 1);
  assert.ok(new Date(post.nextCheckAt) > new Date());
});

test('conectar conta valida o token e salva a conta', async () => {
  handler = (call) =>
    call.path.endsWith('/me') ? { id: 'app-scoped', user_id: '17841499999999999', username: 'nova.loja', account_type: 'BUSINESS' } : {};
  const res = await runConnect('IG_TOKEN_NEW');
  assert.equal(res.ok, true);
  assert.equal(calls[0].params.access_token, 'TOKEN-NEW');
  const acc = readAccounts().find((a) => a.id === '17841499999999999');
  assert.equal(acc.username, 'nova.loja');
  assert.equal(acc.secretName, 'IG_TOKEN_NEW');
  const file = JSON.parse(fs.readFileSync(path.join(root, 'data/connect/IG_TOKEN_NEW.json'), 'utf8'));
  assert.equal(file.ok, true);
});

test('conectar conta com token inválido grava o erro', async () => {
  handler = () => ({ __status: 400, error: { message: 'Invalid OAuth access token', code: 190 } });
  const res = await runConnect('IG_TOKEN_ABC');
  assert.equal(res.ok, false);
  assert.match(res.error, /Invalid OAuth/);
  assert.equal(readAccounts().length, 1);
});

test('regras de validação', () => {
  assert.match(validatePost({ type: 'reel', media: [img()] }).join(), /exatamente 1 vídeo/);
  assert.match(validatePost({ type: 'feed', media: [img(1080, 1920)] }).join(), /proporção/);
  assert.match(validatePost({ type: 'story', media: [img(), img()] }).join(), /exatamente 1/);
  assert.match(validatePost({ type: 'feed', media: Array.from({ length: 11 }, () => img()) }).join(), /no máximo 10/);
  assert.match(validatePost({ type: 'feed', caption: 'x'.repeat(2201), media: [img()] }).join(), /2200/);
  assert.deepEqual(validatePost({ type: 'feed', caption: 'ok', media: [img(), vid()] }), []);
});

test('criptografia dos secrets no navegador (libsodium incluído no site)', async () => {
  const { default: sodium } = await import('../assets/vendor/libsodium-wrappers.mjs');
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const sealed = sodium.crypto_box_seal(sodium.from_string('IGAA-token'), kp.publicKey);
  assert.equal(sodium.to_string(sodium.crypto_box_seal_open(sealed, kp.publicKey, kp.privateKey)), 'IGAA-token');
});

test('renova o token do Instagram e atualiza o secret no GitHub', async () => {
  const { createRequire } = await import('node:module');
  const sodium = createRequire(import.meta.url)('libsodium-wrappers');
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  let saved = null;
  writeAccounts([{ ...ACCOUNT, tokenUpdatedAt: '2020-01-01T00:00:00Z' }]);
  handler = (call) => {
    if (call.path.endsWith('/refresh_access_token')) return { access_token: 'TOKEN-RENOVADO', expires_in: 5184000 };
    if (call.path.endsWith('/secrets/public-key')) return { key_id: 'k1', key: sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL) };
    if (call.method === 'PUT' && call.path.endsWith('/secrets/IG_TOKEN_ABC')) {
      saved = call;
      return { __status: 201 };
    }
    return {};
  };
  process.env.POSTLY_GH_TOKEN = 'gh-token';
  try {
    await runPublish({ budgetMs: 0 });
  } finally {
    delete process.env.POSTLY_GH_TOKEN;
  }
  assert.ok(saved, 'o secret deveria ter sido atualizado');
  assert.equal(saved.host, 'api.github.com');
  const body = saved.body;
  const plain = sodium.to_string(sodium.crypto_box_seal_open(sodium.from_base64(body.encrypted_value, sodium.base64_variants.ORIGINAL), kp.publicKey, kp.privateKey));
  assert.equal(plain, 'TOKEN-RENOVADO');
  const acc = readAccounts()[0];
  assert.ok(new Date(acc.tokenUpdatedAt) > new Date('2025-01-01'));
  assert.equal(acc.expiryEstimated, false);
});
