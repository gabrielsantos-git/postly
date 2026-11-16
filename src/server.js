import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { config, validateConfig, instagramOAuthConfigured } from './config.js';
import { getDb } from './db.js';
import { sign, verify } from './crypto.js';
import { requireAuth, isAuthenticated, login, logout } from './auth.js';
import { apiRouter } from './routes/api.js';
import { buildAuthorizeUrl, GraphApiError } from './instagram/client.js';
import { connectWithOAuthCode } from './accounts.js';
import { UserError } from './media.js';
import { startScheduler } from './scheduler.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp() {
  getDb();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  // Mídias precisam ser públicas: o Instagram as baixa no momento da publicação.
  app.use(
    '/media',
    express.static(config.uploadsDir, { index: false, fallthrough: false, maxAge: '7d', immutable: true }),
  );

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // ---------- Login do painel ----------
  app.post('/api/login', login);
  app.post('/api/logout', logout);
  app.get('/api/session', (req, res) => res.json({ authenticated: isAuthenticated(req) }));

  // ---------- OAuth do Instagram ----------
  app.get('/auth/instagram/start', requireAuth, (req, res) => {
    if (!instagramOAuthConfigured()) {
      return res.redirect('/#/contas?erro=' + encodeURIComponent('Configure INSTAGRAM_APP_ID e INSTAGRAM_APP_SECRET no .env.'));
    }
    const state = sign({ purpose: 'ig-oauth', exp: Date.now() + 15 * 60 * 1000 });
    res.redirect(buildAuthorizeUrl(state));
  });

  app.get('/auth/instagram/callback', requireAuth, async (req, res) => {
    const back = (key, msg) => res.redirect(`/#/contas?${key}=${encodeURIComponent(msg)}`);
    const { code, state, error_description: errorDescription, error_reason: errorReason } = req.query;
    if (errorDescription || errorReason) return back('erro', String(errorDescription || errorReason));
    if (verify(state)?.purpose !== 'ig-oauth') return back('erro', 'Sessão de conexão expirada. Tente novamente.');
    if (!code) return back('erro', 'O Instagram não retornou o código de autorização.');
    try {
      const account = await connectWithOAuthCode(code);
      return back('conectada', account.username);
    } catch (err) {
      return back('erro', err instanceof GraphApiError ? err.describe() : err.message);
    }
  });

  // ---------- API do painel ----------
  app.use('/api', requireAuth, apiRouter());

  // ---------- Front-end ----------
  app.get('/', (req, res, next) => (isAuthenticated(req) ? next() : res.redirect('/login.html')));
  app.use(express.static(publicDir, { extensions: ['html'] }));

  // ---------- Erros ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof UserError) return res.status(err.status).json({ error: err.message });
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo muito grande.' : `Erro no upload: ${err.message}`;
      return res.status(400).json({ error: msg });
    }
    if (err instanceof GraphApiError) return res.status(502).json({ error: `Instagram: ${err.describe()}` });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
    if (err.status === 404 || err.statusCode === 404) return res.status(404).json({ error: 'Não encontrado.' });
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  });

  return app;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const problems = validateConfig();
  if (problems.length) {
    console.error('Configuração incompleta:\n - ' + problems.join('\n - ') + '\nVeja o arquivo .env.example.');
    process.exit(1);
  }
  createApp().listen(config.port, () => {
    console.log(`Postly rodando em http://localhost:${config.port}`);
    console.log(`URL pública (usada pelo Instagram para baixar mídias): ${config.publicBaseUrl}`);
    if (!instagramOAuthConfigured()) {
      console.log('Aviso: INSTAGRAM_APP_ID/INSTAGRAM_APP_SECRET não definidos — só será possível adicionar contas por token.');
    }
    startScheduler();
  });
}
