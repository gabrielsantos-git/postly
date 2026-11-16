import os from 'node:os';
import express from 'express';
import multer from 'multer';
import { config, instagramOAuthConfigured, redirectUri } from '../config.js';
import * as accounts from '../accounts.js';
import * as posts from '../posts.js';
import { ingestUpload, VIDEO_MAX_BYTES, UserError } from '../media.js';
import { getPublishingLimit } from '../instagram/client.js';
import { tick } from '../scheduler.js';

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: VIDEO_MAX_BYTES, files: 10 },
});

const id = (req) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) throw new UserError('ID inválido.');
  return n;
};

export function apiRouter() {
  const r = express.Router();

  r.get('/config', (req, res) => {
    const local = /\/\/(localhost|127\.|0\.0\.0\.0|192\.168\.|10\.)/.test(config.publicBaseUrl);
    res.json({
      oauthConfigured: instagramOAuthConfigured(),
      publicBaseUrl: config.publicBaseUrl,
      publicUrlIsLocal: local,
      redirectUri: redirectUri(),
      apiVersion: config.instagram.apiVersion,
      limits: posts.LIMITS,
    });
  });

  // ---------- Contas ----------
  r.get('/accounts', (req, res) => res.json(accounts.listAccounts()));

  r.post('/accounts/manual', async (req, res) => {
    const token = String(req.body?.accessToken ?? '').trim();
    if (!token) throw new UserError('Cole o token de acesso.');
    res.status(201).json(await accounts.connectWithManualToken(token));
  });

  r.post('/accounts/:id/refresh', async (req, res) => {
    res.json(await accounts.refreshAccountToken(id(req)));
  });

  r.get('/accounts/:id/limit', async (req, res) => {
    const account = accounts.getAccount(id(req));
    if (!account) throw new UserError('Conta não encontrada.', 404);
    res.json(await getPublishingLimit(account.ig_user_id, accounts.getAccountToken(account.id)));
  });

  r.delete('/accounts/:id', (req, res) => {
    if (!accounts.deleteAccount(id(req))) throw new UserError('Conta não encontrada.', 404);
    res.status(204).end();
  });

  // ---------- Mídia ----------
  r.post('/media', upload.array('files', 10), async (req, res) => {
    if (!req.files?.length) throw new UserError('Nenhum arquivo enviado.');
    const out = [];
    for (const file of req.files) out.push(await ingestUpload(file));
    res.status(201).json(out);
  });

  // ---------- Posts ----------
  r.get('/stats', (req, res) => res.json(posts.getStats()));

  r.get('/posts', (req, res) => {
    const { status, accountId, from, to } = req.query;
    res.json(posts.listPosts({ status, accountId, from, to }));
  });

  r.get('/posts/:id', (req, res) => {
    const post = posts.getPost(id(req));
    if (!post) throw new UserError('Post não encontrado.', 404);
    res.json({ ...post, events: posts.getPostEvents(post.id) });
  });

  r.post('/posts', (req, res) => {
    const created = posts.createPosts(req.body ?? {});
    if (created.some((p) => p.status === 'scheduled' && new Date(p.scheduled_at) <= new Date())) tick();
    res.status(201).json(created);
  });

  r.put('/posts/:id', (req, res) => {
    res.json(posts.updatePost(id(req), req.body ?? {}));
  });

  r.post('/posts/:id/publish-now', (req, res) => {
    const post = posts.publishNow(id(req));
    tick();
    res.json(post);
  });

  r.post('/posts/:id/cancel', (req, res) => res.json(posts.cancelPost(id(req))));

  r.delete('/posts/:id', (req, res) => {
    posts.deletePost(id(req));
    res.status(204).end();
  });

  return r;
}
