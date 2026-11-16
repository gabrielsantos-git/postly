import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'postly-api-'));
process.env.DATA_DIR = tmp;
process.env.APP_SECRET = 'y'.repeat(64);
process.env.ADMIN_PASSWORD = 'senha-teste';
process.env.PUBLIC_BASE_URL = 'https://postly.example.com';
process.env.SCHEDULER_ENABLED = 'false';

const { createApp } = await import('../src/server.js');
const { getDb, closeDb } = await import('../src/db.js');
const { encrypt } = await import('../src/crypto.js');

let server;
let base;
let cookie = '';

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const req = (p, init = {}) => fetch(base + p, { ...init, headers: { cookie, ...(init.headers || {}) }, redirect: 'manual' });
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('exige login', async () => {
  assert.equal((await req('/api/posts')).status, 401);
  const home = await req('/');
  assert.equal(home.status, 302);
  assert.equal(home.headers.get('location'), '/login.html');
});

test('senha errada é recusada e a certa cria sessão', async () => {
  assert.equal((await req('/api/login', json({ password: 'errada' }))).status, 401);
  const ok = await req('/api/login', json({ password: 'senha-teste' }));
  assert.equal(ok.status, 200);
  cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.equal((await req('/api/posts')).status, 200);
});

test('upload converte PNG para JPEG e agenda um post', async () => {
  const accountId = getDb()
    .prepare(`INSERT INTO accounts (ig_user_id, username, access_token_enc) VALUES ('1', 'loja', ?)`)
    .run(encrypt('t')).lastInsertRowid;

  const png = await sharp({ create: { width: 1200, height: 1500, channels: 4, background: '#ff0066' } }).png().toBuffer();
  const fd = new FormData();
  fd.append('files', new Blob([png], { type: 'image/png' }), 'arte.png');
  const up = await req('/api/media', { method: 'POST', body: fd });
  assert.equal(up.status, 201);
  const [media] = await up.json();
  assert.equal(media.mime_type, 'image/jpeg');
  assert.equal(media.width, 1200);
  assert.equal(media.height, 1500);
  assert.match(media.url, /^https:\/\/postly\.example\.com\/media\/[a-f0-9]+\.jpg$/);

  // A mídia é pública (o Instagram precisa baixá-la sem login).
  const pub = await fetch(`${base}/media/${media.filename}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get('content-type'), 'image/jpeg');

  const when = new Date(Date.now() + 3600e3).toISOString();
  const created = await req('/api/posts', json({ accountIds: [accountId], type: 'feed', caption: 'Oi', mediaIds: [media.id], scheduledAt: when }));
  assert.equal(created.status, 201);
  const [post] = await created.json();
  assert.equal(post.status, 'scheduled');
  assert.equal(post.scheduled_at, when);

  const bad = await req('/api/posts', json({ accountIds: [accountId], type: 'reel', mediaIds: [media.id], scheduledAt: when }));
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /vídeo/);
});
