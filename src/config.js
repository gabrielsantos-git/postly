import fs from 'node:fs';
import path from 'node:path';

// Carrega o .env (se existir) sem dependências externas.
const envFile = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

function env(name, fallback = undefined) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

const dataDir = path.resolve(env('DATA_DIR', './data'));

export const config = {
  port: Number(env('PORT', 3000)),
  // URL pública do site. O Instagram baixa as mídias a partir dela,
  // então precisa ser acessível pela internet (ex.: https://postly.seudominio.com).
  publicBaseUrl: env('PUBLIC_BASE_URL', `http://localhost:${env('PORT', 3000)}`).replace(/\/+$/, ''),
  appSecret: env('APP_SECRET'),
  adminPassword: env('ADMIN_PASSWORD'),

  instagram: {
    appId: env('INSTAGRAM_APP_ID'),
    appSecret: env('INSTAGRAM_APP_SECRET'),
    apiVersion: env('GRAPH_API_VERSION', 'v24.0'),
    graphHost: env('INSTAGRAM_GRAPH_HOST', 'https://graph.instagram.com'),
    oauthHost: env('INSTAGRAM_OAUTH_HOST', 'https://api.instagram.com'),
    authorizeUrl: env('INSTAGRAM_AUTHORIZE_URL', 'https://www.instagram.com/oauth/authorize'),
    scopes: env('INSTAGRAM_SCOPES', 'instagram_business_basic,instagram_business_content_publish'),
  },

  dataDir,
  uploadsDir: path.join(dataDir, 'uploads'),
  dbFile: path.join(dataDir, 'postly.db'),

  schedulerIntervalMs: Number(env('SCHEDULER_INTERVAL_SECONDS', 15)) * 1000,
  schedulerEnabled: env('SCHEDULER_ENABLED', 'true') !== 'false',
  // Quantas vezes tentar de novo uma publicação que falhou por erro temporário.
  maxAttempts: Number(env('PUBLISH_MAX_ATTEMPTS', 3)),
};

export function redirectUri() {
  return `${config.publicBaseUrl}/auth/instagram/callback`;
}

export function validateConfig() {
  const problems = [];
  if (!config.appSecret || config.appSecret.length < 32) {
    problems.push('APP_SECRET precisa ter pelo menos 32 caracteres (gere com: openssl rand -hex 32).');
  }
  if (!config.adminPassword) {
    problems.push('ADMIN_PASSWORD não definido.');
  }
  return problems;
}

export function instagramOAuthConfigured() {
  return Boolean(config.instagram.appId && config.instagram.appSecret);
}
