import { clearSessionCookie, sendJson } from './_lib.js';

export default function handler(req, res) {
  clearSessionCookie(req, res);
  sendJson(res, 200, { ok: true });
}
