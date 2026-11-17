import { configured, isLoggedIn, passwordRequired, repo, sendJson } from './_lib.js';

export default function handler(req, res) {
  sendJson(res, 200, { authenticated: isLoggedIn(req), passwordRequired: passwordRequired(), configured: configured(), ...repo() });
}
