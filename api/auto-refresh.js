// Salva o GITHUB_TOKEN da Vercel como secret POSTLY_GH_TOKEN do repositório, para o publicador
// (GitHub Actions) conseguir renovar sozinho os tokens do Instagram.
import { createRequire } from 'node:module';
import { github, repo, requireLogin, sendJson } from './_lib.js';

export default async function handler(req, res) {
  if (!requireLogin(req, res)) return;
  if (req.method !== 'POST') return sendJson(res, 405, { message: 'Use POST.' });
  const { owner, repo: name } = repo();
  const keyRes = await github('GET', `/repos/${owner}/${name}/actions/secrets/public-key`);
  if (!keyRes.ok) return sendJson(res, keyRes.status, { message: 'Não foi possível ler a chave do repositório.' });
  const key = await keyRes.json();
  // A versão ESM do pacote está quebrada no Node; usa a CommonJS.
  const sodium = createRequire(import.meta.url)('libsodium-wrappers');
  await sodium.ready;
  const sealed = sodium.crypto_box_seal(
    sodium.from_string(process.env.GITHUB_TOKEN),
    sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL),
  );
  const put = await github('PUT', `/repos/${owner}/${name}/actions/secrets/POSTLY_GH_TOKEN`, {
    encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL),
    key_id: key.key_id,
  });
  sendJson(res, put.ok ? 200 : put.status, put.ok ? { ok: true } : { message: 'Não foi possível salvar o secret.' });
}
