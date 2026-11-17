import { checkPassword, configured, readBody, sendJson, setSessionCookie } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { message: 'Use POST.' });
  if (!configured().password) return sendJson(res, 200, { ok: true }); // painel sem senha
  const body = (await readBody(req).catch(() => null)) || {};
  if (!checkPassword(body.password)) {
    await new Promise((r) => setTimeout(r, 800)); // dificulta tentativas em massa
    return sendJson(res, 401, { message: 'Senha incorreta.' });
  }
  setSessionCookie(req, res);
  sendJson(res, 200, { ok: true });
}
