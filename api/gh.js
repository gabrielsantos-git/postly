// Repassa as chamadas do site para a API do GitHub usando o token guardado na Vercel.
// Só permite o repositório do Postly e a API GraphQL.
import { github, readBody, repo, requireLogin, sendJson } from './_lib.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export default async function handler(req, res) {
  if (!requireLogin(req, res)) return;
  if (!process.env.GITHUB_TOKEN) return sendJson(res, 503, { message: 'Defina a variável GITHUB_TOKEN na Vercel.' });

  const url = new URL(req.url, 'http://x');
  const path = url.searchParams.get('path') || '';
  const { owner, repo: name } = repo();
  const base = `/repos/${owner}/${name}`;
  const allowed =
    path === '/graphql' ||
    path === base ||
    (path.startsWith(`${base}/`) && !path.includes('..') && !path.startsWith(`${base}/collaborators`) && !path.startsWith(`${base}/keys`));
  if (!allowed || !METHODS.includes(req.method)) return sendJson(res, 403, { message: 'Caminho não permitido.' });

  const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await readBody(req).catch(() => undefined);
  const gh = await github(req.method, path, body);
  const text = await gh.text();
  if (gh.status === 401) {
    // Não confundir com "sessão do painel expirada": aqui o problema é o token na Vercel.
    return sendJson(res, 502, { message: 'O GITHUB_TOKEN configurado na Vercel é inválido ou expirou.' });
  }
  res.statusCode = gh.status;
  res.setHeader('content-type', gh.headers.get('content-type') || 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}
