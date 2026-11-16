import { getDb, nowIso } from './db.js';
import { getMediaByIds, serializeMedia, UserError } from './media.js';
import { getAccount } from './accounts.js';

export const POST_TYPES = ['feed', 'reel', 'story'];
const EDITABLE_STATUSES = ['draft', 'scheduled', 'failed', 'canceled'];

export const LIMITS = {
  captionChars: 2200,
  hashtags: 30,
  mentions: 20,
  carouselItems: 10,
  // Proporções aceitas no feed: de 4:5 (retrato) a 1.91:1 (paisagem).
  feedMinRatio: 4 / 5,
  feedMaxRatio: 1.91,
};

export function logEvent(postId, level, message) {
  getDb().prepare('INSERT INTO post_events (post_id, level, message) VALUES (?, ?, ?)').run(postId, level, message);
}

// Valida a combinação tipo + mídias + legenda. Lança UserError com mensagem amigável.
export function validatePostInput({ type, caption = '', media }) {
  if (!POST_TYPES.includes(type)) throw new UserError('Tipo de post inválido.');
  if (!media.length) throw new UserError('Adicione pelo menos uma mídia.');

  if (type === 'feed') {
    if (media.length > LIMITS.carouselItems) {
      throw new UserError(`Um carrossel aceita no máximo ${LIMITS.carouselItems} mídias.`);
    }
    for (const m of media) {
      if (m.kind === 'image' && m.width && m.height) {
        const ratio = m.width / m.height;
        if (ratio < LIMITS.feedMinRatio - 0.01 || ratio > LIMITS.feedMaxRatio + 0.01) {
          throw new UserError(
            `A imagem "${m.original_name}" tem proporção ${m.width}x${m.height}. ` +
              'No feed o Instagram aceita de 4:5 (retrato) até 1.91:1 (paisagem).',
          );
        }
      }
    }
  }
  if (type === 'reel') {
    if (media.length !== 1 || media[0].kind !== 'video') throw new UserError('Reels precisam de exatamente 1 vídeo.');
  }
  if (type === 'story') {
    if (media.length !== 1) throw new UserError('Um story tem exatamente 1 imagem ou vídeo.');
  }

  if (caption.length > LIMITS.captionChars) {
    throw new UserError(`A legenda passa de ${LIMITS.captionChars} caracteres.`);
  }
  const hashtags = caption.match(/(^|\s)#[\p{L}\p{N}_]+/gu) || [];
  if (hashtags.length > LIMITS.hashtags) throw new UserError(`Máximo de ${LIMITS.hashtags} hashtags por post.`);
  const mentions = caption.match(/(^|\s)@[\w.]+/g) || [];
  if (mentions.length > LIMITS.mentions) throw new UserError(`Máximo de ${LIMITS.mentions} menções por post.`);
}

function parseSchedule(status, scheduledAt) {
  if (status === 'draft') return scheduledAt ? new Date(scheduledAt).toISOString() : null;
  if (!scheduledAt) throw new UserError('Escolha a data e hora da publicação.');
  const d = new Date(scheduledAt);
  if (Number.isNaN(d.getTime())) throw new UserError('Data de agendamento inválida.');
  // Pequena tolerância para "publicar agora".
  if (d.getTime() < Date.now() - 5 * 60 * 1000) throw new UserError('A data de agendamento já passou.');
  return d.toISOString();
}

function loadPostMedia(postId) {
  return getDb()
    .prepare(
      `SELECT m.* FROM post_media pm JOIN media m ON m.id = pm.media_id
       WHERE pm.post_id = ? ORDER BY pm.position`,
    )
    .all(postId)
    .map(serializeMedia);
}

export function serializePost(row) {
  if (!row) return row;
  return {
    ...row,
    share_to_feed: Boolean(row.share_to_feed),
    children_ids: undefined,
    media: loadPostMedia(row.id),
    account: getAccount(row.account_id) ?? null,
  };
}

export function getPost(id) {
  return serializePost(getDb().prepare('SELECT * FROM posts WHERE id = ?').get(id));
}

export function getPostEvents(id) {
  return getDb().prepare('SELECT * FROM post_events WHERE post_id = ? ORDER BY id').all(id);
}

export function listPosts({ status, accountId, from, to } = {}) {
  const where = [];
  const params = [];
  if (status) {
    const list = String(status).split(',');
    where.push(`status IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (accountId) {
    where.push('account_id = ?');
    params.push(Number(accountId));
  }
  if (from) {
    where.push('COALESCE(published_at, scheduled_at) >= ?');
    params.push(new Date(from).toISOString());
  }
  if (to) {
    where.push('COALESCE(published_at, scheduled_at) < ?');
    params.push(new Date(to).toISOString());
  }
  const sql = `SELECT * FROM posts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY COALESCE(scheduled_at, created_at) ASC`;
  return getDb().prepare(sql).all(...params).map(serializePost);
}

export function getStats() {
  const rows = getDb().prepare('SELECT status, COUNT(*) AS n FROM posts GROUP BY status').all();
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

function normalizeInput(input) {
  const type = input.type;
  const caption = type === 'story' ? '' : String(input.caption ?? '').trim();
  const mediaIds = (input.mediaIds || []).map(Number).filter(Boolean);
  const media = getMediaByIds(mediaIds);
  if (media.length !== mediaIds.length) throw new UserError('Alguma mídia não foi encontrada. Envie de novo.');
  const status = input.status === 'draft' ? 'draft' : 'scheduled';
  const scheduledAt = parseSchedule(status, input.scheduledAt);
  validatePostInput({ type, caption, media });
  return {
    type,
    caption,
    media,
    status,
    scheduledAt,
    shareToFeed: input.shareToFeed === false ? 0 : 1,
  };
}

// Cria um post para cada conta selecionada.
export function createPosts(input) {
  const accountIds = [...new Set((input.accountIds || []).map(Number).filter(Boolean))];
  if (!accountIds.length) throw new UserError('Selecione pelo menos uma conta.');
  for (const id of accountIds) if (!getAccount(id)) throw new UserError('Conta não encontrada.');
  const data = normalizeInput(input);

  const db = getDb();
  const insertPost = db.prepare(
    `INSERT INTO posts (account_id, type, caption, share_to_feed, scheduled_at, status, next_run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMedia = db.prepare('INSERT INTO post_media (post_id, media_id, position) VALUES (?, ?, ?)');

  const ids = db.transaction(() =>
    accountIds.map((accountId) => {
      const r = insertPost.run(
        accountId,
        data.type,
        data.caption,
        data.shareToFeed,
        data.scheduledAt,
        data.status,
        data.status === 'scheduled' ? data.scheduledAt : null,
      );
      data.media.forEach((m, i) => insertMedia.run(r.lastInsertRowid, m.id, i));
      return r.lastInsertRowid;
    }),
  )();

  for (const id of ids) {
    logEvent(id, 'info', data.status === 'draft' ? 'Rascunho criado' : `Agendado para ${data.scheduledAt}`);
  }
  return ids.map(getPost);
}

export function updatePost(id, input) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  if (!existing) throw new UserError('Post não encontrado.', 404);
  if (!EDITABLE_STATUSES.includes(existing.status)) {
    throw new UserError('Este post já está sendo publicado ou foi publicado e não pode ser editado.', 409);
  }
  const accountId = input.accountIds?.[0] ? Number(input.accountIds[0]) : existing.account_id;
  if (!getAccount(accountId)) throw new UserError('Conta não encontrada.');
  const data = normalizeInput(input);

  db.transaction(() => {
    db.prepare(
      `UPDATE posts SET account_id = ?, type = ?, caption = ?, share_to_feed = ?, scheduled_at = ?, status = ?,
         next_run_at = ?, attempts = 0, last_error = NULL, container_id = NULL, children_ids = NULL,
         processing_started_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(
      accountId,
      data.type,
      data.caption,
      data.shareToFeed,
      data.scheduledAt,
      data.status,
      data.status === 'scheduled' ? data.scheduledAt : null,
      nowIso(),
      id,
    );
    db.prepare('DELETE FROM post_media WHERE post_id = ?').run(id);
    const ins = db.prepare('INSERT INTO post_media (post_id, media_id, position) VALUES (?, ?, ?)');
    data.media.forEach((m, i) => ins.run(id, m.id, i));
  })();
  logEvent(id, 'info', data.status === 'draft' ? 'Rascunho atualizado' : `Reagendado para ${data.scheduledAt}`);
  return getPost(id);
}

// Coloca o post na fila para publicar já (usado em "Publicar agora" e "Tentar de novo").
export function publishNow(id) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  if (!existing) throw new UserError('Post não encontrado.', 404);
  if (!EDITABLE_STATUSES.includes(existing.status)) throw new UserError('Este post não pode ser publicado agora.', 409);
  const now = nowIso();
  db.prepare(
    `UPDATE posts SET status = 'scheduled', scheduled_at = ?, next_run_at = ?, attempts = 0, last_error = NULL,
       container_id = NULL, children_ids = NULL, processing_started_at = NULL, updated_at = ? WHERE id = ?`,
  ).run(now, now, now, id);
  logEvent(id, 'info', 'Enviado para publicação imediata');
  return getPost(id);
}

export function cancelPost(id) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  if (!existing) throw new UserError('Post não encontrado.', 404);
  if (existing.status !== 'scheduled' && existing.status !== 'failed') {
    throw new UserError('Só é possível cancelar posts agendados ou com falha.', 409);
  }
  db.prepare(`UPDATE posts SET status = 'canceled', next_run_at = NULL, updated_at = ? WHERE id = ?`).run(nowIso(), id);
  logEvent(id, 'info', 'Agendamento cancelado');
  return getPost(id);
}

export function deletePost(id) {
  const db = getDb();
  const existing = db.prepare('SELECT status FROM posts WHERE id = ?').get(id);
  if (!existing) throw new UserError('Post não encontrado.', 404);
  if (existing.status === 'processing') throw new UserError('Aguarde a publicação terminar para excluir.', 409);
  db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  return true;
}
