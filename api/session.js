import { configured, isLoggedIn, repo, sendJson } from './_lib.js';

export default function handler(req, res) {
  sendJson(res, 200, { authenticated: isLoggedIn(req), configured: configured(), ...repo() });
}
