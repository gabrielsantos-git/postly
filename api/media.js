// Apaga mídias do Vercel Blob que não são mais usadas por nenhum post.
import { del } from '@vercel/blob';
import { readBody, requireLogin, sendJson } from './_lib.js';

export default async function handler(req, res) {
  if (!requireLogin(req, res)) return;
  if (req.method !== 'DELETE') return sendJson(res, 405, { message: 'Use DELETE.' });
  const { urls } = (await readBody(req).catch(() => null)) || {};
  const list = (Array.isArray(urls) ? urls : []).filter((u) => /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i.test(u));
  if (list.length && process.env.BLOB_READ_WRITE_TOKEN) await del(list);
  sendJson(res, 200, { deleted: list.length });
}
