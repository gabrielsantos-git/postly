import { getDb, nowIso } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import * as ig from './instagram/client.js';

const PUBLIC_FIELDS = `id, ig_user_id, username, name, profile_picture_url, account_type,
  token_expires_at, token_refreshed_at, status, status_message, created_at, updated_at`;

export function listAccounts() {
  return getDb().prepare(`SELECT ${PUBLIC_FIELDS} FROM accounts ORDER BY username`).all();
}

export function getAccount(id) {
  return getDb().prepare(`SELECT ${PUBLIC_FIELDS} FROM accounts WHERE id = ?`).get(id);
}

export function getAccountToken(id) {
  const row = getDb().prepare('SELECT access_token_enc FROM accounts WHERE id = ?').get(id);
  if (!row) throw new Error('Conta não encontrada');
  return decrypt(row.access_token_enc);
}

export function deleteAccount(id) {
  return getDb().prepare('DELETE FROM accounts WHERE id = ?').run(id).changes > 0;
}

export function markNeedsReauth(id, message) {
  getDb()
    .prepare(`UPDATE accounts SET status = 'needs_reauth', status_message = ?, updated_at = ? WHERE id = ?`)
    .run(message, nowIso(), id);
}

const expiryFrom = (expiresIn) =>
  expiresIn ? new Date(Date.now() + Number(expiresIn) * 1000).toISOString() : null;

// Salva (ou atualiza) uma conta a partir de um token válido.
export async function saveAccountFromToken(token, expiresIn) {
  const me = await ig.getMe(token);
  // user_id = ID da conta profissional do Instagram (usado na publicação).
  const igUserId = String(me.user_id || me.id);
  const db = getDb();
  const now = nowIso();
  db.prepare(
    `INSERT INTO accounts (ig_user_id, username, name, profile_picture_url, account_type,
        access_token_enc, token_expires_at, token_refreshed_at, status, status_message, updated_at)
     VALUES (@igUserId, @username, @name, @pic, @type, @tok, @exp, @now, 'active', NULL, @now)
     ON CONFLICT(ig_user_id) DO UPDATE SET
        username = excluded.username, name = excluded.name,
        profile_picture_url = excluded.profile_picture_url, account_type = excluded.account_type,
        access_token_enc = excluded.access_token_enc, token_expires_at = excluded.token_expires_at,
        token_refreshed_at = excluded.token_refreshed_at, status = 'active', status_message = NULL,
        updated_at = excluded.updated_at`,
  ).run({
    igUserId,
    username: me.username,
    name: me.name ?? null,
    pic: me.profile_picture_url ?? null,
    type: me.account_type ?? null,
    tok: encrypt(token),
    exp: expiryFrom(expiresIn),
    now,
  });
  return db.prepare(`SELECT ${PUBLIC_FIELDS} FROM accounts WHERE ig_user_id = ?`).get(igUserId);
}

// Fluxo completo do OAuth: code -> token curto -> token longo -> conta salva.
export async function connectWithOAuthCode(code) {
  const short = await ig.exchangeCodeForToken(code);
  const long = await ig.exchangeForLongLivedToken(short.access_token);
  return saveAccountFromToken(long.access_token, long.expires_in);
}

// Adiciona uma conta colando um token (ex.: gerado no painel do app da Meta).
// Se for um token de curta duração, tenta convertê-lo em um de longa duração.
export async function connectWithManualToken(token) {
  try {
    const long = await ig.exchangeForLongLivedToken(token);
    if (long?.access_token) return saveAccountFromToken(long.access_token, long.expires_in);
  } catch {
    // Provavelmente já é um token de longa duração (ou o app secret não foi configurado).
  }
  return saveAccountFromToken(token, null);
}

export async function refreshAccountToken(id) {
  const token = getAccountToken(id);
  const res = await ig.refreshLongLivedToken(token);
  const now = nowIso();
  getDb()
    .prepare(
      `UPDATE accounts SET access_token_enc = ?, token_expires_at = ?, token_refreshed_at = ?,
         status = 'active', status_message = NULL, updated_at = ? WHERE id = ?`,
    )
    .run(encrypt(res.access_token), expiryFrom(res.expires_in), now, now, id);
  return getAccount(id);
}

// Renova tokens com mais de 7 dias desde a última renovação (tokens duram 60 dias).
export async function refreshStaleTokens(logger = console) {
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const rows = getDb()
    .prepare(
      `SELECT id, username FROM accounts
       WHERE status = 'active' AND (token_refreshed_at IS NULL OR token_refreshed_at < ?)`,
    )
    .all(cutoff);
  for (const row of rows) {
    try {
      await refreshAccountToken(row.id);
      logger.info?.(`[tokens] Token de @${row.username} renovado`);
    } catch (err) {
      if (err instanceof ig.GraphApiError && err.isAuthError) {
        markNeedsReauth(row.id, `Token inválido: ${err.describe()}`);
      }
      logger.warn?.(`[tokens] Falha ao renovar token de @${row.username}: ${err.message}`);
    }
  }
}
