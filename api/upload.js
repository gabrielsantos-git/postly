// Gera a autorização para o navegador enviar fotos/vídeos direto ao Vercel Blob.
import { handleUpload } from '@vercel/blob/client';
import { readBody, requireLogin, sendJson } from './_lib.js';

export default async function handler(req, res) {
  if (!requireLogin(req, res)) return;
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return sendJson(res, 503, { error: 'Conecte um Blob Store ao projeto na Vercel (Storage › Blob).' });
  }
  try {
    const body = await readBody(req);
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith('postly/')) throw new Error('Caminho inválido.');
        return {
          allowedContentTypes: ['image/jpeg', 'video/mp4', 'video/quicktime'],
          maximumSizeInBytes: 300 * 1024 * 1024, // limite do Instagram para Reels
          addRandomSuffix: true,
        };
      },
    });
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}
