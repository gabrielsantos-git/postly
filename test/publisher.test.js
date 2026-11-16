import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'postly-test-'));
process.env.DATA_DIR = tmp;
process.env.APP_SECRET = 'x'.repeat(64);
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.PUBLIC_BASE_URL = 'https://postly.example.com';
process.env.INSTAGRAM_APP_ID = 'app123';
process.env.INSTAGRAM_APP_SECRET = 'appsecret';
process.env.SCHEDULER_ENABLED = 'false';

const { getDb, closeDb } = await import('../src/db.js');
const { encrypt } = await import('../src/crypto.js');
const { createPosts, getPost } = await import('../src/posts.js');
const { advancePost } = await import('../src/instagram/publisher.js');

// ---------- API do Instagram simulada ----------
let calls = [];
let handler = () => ({});
const realFetch = globalThis.fetch;

function mockFetch(fn) {
  handler = fn;
}

before(() => {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const params = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : Object.fromEntries(u.searchParams);
    const call = { method: init.method || 'GET', path: u.pathname, params };
    calls.push(call);
    const out = handler(call);
    const status = out?.__status ?? 200;
    delete out?.__status;
    return new Response(JSON.stringify(out ?? {}), { status, headers: { 'content-type': 'application/json' } });
  };
});

after(() => {
  globalThis.fetch = realFetch;
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let accountId;
beforeEach(() => {
  calls = [];
  const db = getDb();
  db.exec('DELETE FROM post_media; DELETE FROM post_events; DELETE FROM posts; DELETE FROM media; DELETE FROM accounts;');
  accountId = db
    .prepare(
      `INSERT INTO accounts (ig_user_id, username, access_token_enc, token_refreshed_at)
       VALUES ('17841400000000001', 'minhaloja', ?, ?)`,
    )
    .run(encrypt('TOKEN-ABC'), new Date().toISOString()).lastInsertRowid;
});

function addMedia(kind, { width = 1080, height = 1350 } = {}) {
  const filename = `${Math.random().toString(16).slice(2)}.${kind === 'video' ? 'mp4' : 'jpg'}`;
  return getDb()
    .prepare(
      `INSERT INTO media (filename, original_name, mime_type, kind, size_bytes, width, height)
       VALUES (?, ?, ?, ?, 1000, ?, ?)`,
    )
    .run(filename, filename, kind === 'video' ? 'video/mp4' : 'image/jpeg', kind, kind === 'image' ? width : null, kind === 'image' ? height : null)
    .lastInsertRowid;
}

function schedule(type, mediaIds, extra = {}) {
  const [post] = createPosts({
    accountIds: [accountId],
    type,
    caption: 'Promoção de hoje! #oferta',
    mediaIds,
    scheduledAt: new Date().toISOString(),
    ...extra,
  });
  return post.id;
}

// Roda o agendador até o post sair de scheduled/processing (ignorando os intervalos de espera).
async function runToEnd(postId, maxSteps = 20) {
  for (let i = 0; i < maxSteps; i++) {
    const p = getDb().prepare('SELECT status FROM posts WHERE id = ?').get(postId);
    if (!['scheduled', 'processing'].includes(p.status)) break;
    await advancePost(postId);
  }
  return getPost(postId);
}

const happyApi = ({ statuses = {} } = {}) => {
  let n = 0;
  const polls = {};
  return (call) => {
    if (call.method === 'POST' && call.path.endsWith('/media')) return { id: `container-${++n}` };
    if (call.method === 'POST' && call.path.endsWith('/media_publish')) return { id: 'ig-media-999' };
    if (call.path.endsWith('/ig-media-999')) return { id: 'ig-media-999', permalink: 'https://www.instagram.com/p/ABC/' };
    const id = call.path.split('/').pop();
    if (call.params.fields?.includes('status_code')) {
      const seq = statuses[id] || ['FINISHED'];
      polls[id] = (polls[id] ?? -1) + 1;
      return { id, status_code: seq[Math.min(polls[id], seq.length - 1)] };
    }
    return {};
  };
};

const creates = () => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/media'));

test('publica uma foto no feed', async () => {
  mockFetch(happyApi());
  const id = schedule('feed', [addMedia('image')]);
  const post = await runToEnd(id);

  assert.equal(post.status, 'published');
  assert.equal(post.permalink, 'https://www.instagram.com/p/ABC/');
  assert.equal(post.ig_media_id, 'ig-media-999');

  const [create] = creates();
  assert.equal(create.path, '/v24.0/17841400000000001/media');
  assert.match(create.params.image_url, /^https:\/\/postly\.example\.com\/media\/.+\.jpg$/);
  assert.equal(create.params.caption, 'Promoção de hoje! #oferta');
  assert.equal(create.params.access_token, 'TOKEN-ABC');
  assert.equal(create.params.media_type, undefined);

  const publish = calls.find((c) => c.path.endsWith('/media_publish'));
  assert.equal(publish.params.creation_id, 'container-1');
});

test('publica um carrossel com foto e vídeo', async () => {
  mockFetch(happyApi({ statuses: { 'container-2': ['IN_PROGRESS', 'FINISHED'] } }));
  const id = schedule('feed', [addMedia('image'), addMedia('video'), addMedia('image')]);
  const post = await runToEnd(id);
  assert.equal(post.status, 'published');

  const c = creates();
  assert.equal(c.length, 4);
  assert.equal(c[0].params.is_carousel_item, 'true');
  assert.ok(c[0].params.image_url);
  assert.equal(c[0].params.caption, undefined);
  assert.equal(c[1].params.media_type, 'VIDEO');
  assert.ok(c[1].params.video_url.endsWith('.mp4'));
  assert.equal(c[3].params.media_type, 'CAROUSEL');
  assert.equal(c[3].params.children, 'container-1,container-2,container-3');
  assert.equal(c[3].params.caption, 'Promoção de hoje! #oferta');

  const publish = calls.find((x) => x.path.endsWith('/media_publish'));
  assert.equal(publish.params.creation_id, 'container-4');
});

test('publica um Reels esperando o processamento do vídeo', async () => {
  mockFetch(happyApi({ statuses: { 'container-1': ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'] } }));
  const id = schedule('reel', [addMedia('video')], { shareToFeed: false });
  const post = await runToEnd(id);
  assert.equal(post.status, 'published');

  const [create] = creates();
  assert.equal(create.params.media_type, 'REELS');
  assert.equal(create.params.share_to_feed, 'false');
  assert.ok(create.params.video_url);
  const statusChecks = calls.filter((c) => c.params.fields?.includes('status_code'));
  assert.equal(statusChecks.length, 3);
});

test('publica um story sem legenda', async () => {
  mockFetch(happyApi());
  const id = schedule('story', [addMedia('image', { width: 1080, height: 1920 })]);
  const post = await runToEnd(id);
  assert.equal(post.status, 'published');
  assert.equal(post.caption, '');
  const [create] = creates();
  assert.equal(create.params.media_type, 'STORIES');
  assert.ok(create.params.image_url);
  assert.equal(create.params.caption, undefined);
});

test('marca falha quando o Instagram não processa a mídia', async () => {
  mockFetch(happyApi({ statuses: { 'container-1': ['ERROR'] } }));
  const id = schedule('reel', [addMedia('video')]);
  const post = await runToEnd(id);
  assert.equal(post.status, 'failed');
  assert.match(post.last_error, /ERROR/);
  assert.equal(calls.some((c) => c.path.endsWith('/media_publish')), false);
});

test('token inválido marca a conta para reconexão', async () => {
  mockFetch(() => ({ __status: 400, error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } }));
  const id = schedule('feed', [addMedia('image')]);
  const post = await runToEnd(id);
  assert.equal(post.status, 'failed');
  const acc = getDb().prepare('SELECT status FROM accounts WHERE id = ?').get(accountId);
  assert.equal(acc.status, 'needs_reauth');
});

test('erro temporário reagenda com nova tentativa', async () => {
  mockFetch(() => ({ __status: 500, error: { message: 'An unexpected error has occurred', code: 2 } }));
  const id = schedule('feed', [addMedia('image')]);
  await advancePost(id);
  const row = getDb().prepare('SELECT * FROM posts WHERE id = ?').get(id);
  assert.equal(row.status, 'scheduled');
  assert.equal(row.attempts, 1);
  assert.ok(new Date(row.next_run_at) > new Date());

  // Depois de esgotar as tentativas, falha de vez.
  for (let i = 0; i < 5; i++) await advancePost(id);
  assert.equal(getPost(id).status, 'failed');
  assert.equal(getPost(id).attempts, 3);
});

test('valida formatos antes de agendar', () => {
  assert.throws(() => schedule('reel', [addMedia('image')]), /exatamente 1 vídeo/);
  assert.throws(() => schedule('feed', [addMedia('image', { width: 1080, height: 1920 })]), /proporção/);
  assert.throws(() => schedule('story', [addMedia('image'), addMedia('image')]), /exatamente 1/);
  assert.throws(
    () => schedule('feed', Array.from({ length: 11 }, () => addMedia('image'))),
    /no máximo 10/,
  );
  assert.throws(
    () => schedule('feed', [addMedia('image')], { scheduledAt: '2020-01-01T00:00:00Z' }),
    /já passou/,
  );
});
