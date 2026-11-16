// Máquina de estados da publicação. Cada chamada de advancePost() faz um passo e
// grava o progresso no banco, então a publicação sobrevive a reinícios do servidor.
//
//  scheduled ──(cria containers)──▶ processing ──(container FINISHED)──▶ media_publish ──▶ published
//                                        │
//                                        └── ERROR / EXPIRED / timeout / erro definitivo ──▶ failed
import { config } from '../config.js';
import { getDb, nowIso } from '../db.js';
import { mediaUrl } from '../media.js';
import { getAccountToken, markNeedsReauth } from '../accounts.js';
import { logEvent } from '../posts.js';
import * as ig from './client.js';

const PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_IMAGE_MS = 3_000;
const POLL_VIDEO_MS = 10_000;

const later = (ms) => new Date(Date.now() + ms).toISOString();

function loadMedia(postId) {
  return getDb()
    .prepare(
      `SELECT m.* FROM post_media pm JOIN media m ON m.id = pm.media_id
       WHERE pm.post_id = ? ORDER BY pm.position`,
    )
    .all(postId);
}

function update(postId, fields) {
  const keys = Object.keys(fields);
  getDb()
    .prepare(`UPDATE posts SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...fields, updated_at: nowIso(), id: postId });
}

// Parâmetros do container principal de acordo com o tipo de post.
export function buildContainerParams(post, media) {
  const caption = post.caption || undefined;
  const item = media[0];
  const shareToFeed = post.share_to_feed ? 'true' : 'false';

  if (post.type === 'story') {
    return item.kind === 'video'
      ? { media_type: 'STORIES', video_url: mediaUrl(item.filename) }
      : { media_type: 'STORIES', image_url: mediaUrl(item.filename) };
  }
  if (post.type === 'reel' || (post.type === 'feed' && item.kind === 'video')) {
    // Vídeos no feed são publicados como Reels (a API não usa mais VIDEO para o feed).
    return {
      media_type: 'REELS',
      video_url: mediaUrl(item.filename),
      caption,
      share_to_feed: post.type === 'feed' ? 'true' : shareToFeed,
    };
  }
  return { image_url: mediaUrl(item.filename), caption };
}

export function buildCarouselChildParams(item) {
  return item.kind === 'video'
    ? { media_type: 'VIDEO', video_url: mediaUrl(item.filename), is_carousel_item: 'true' }
    : { image_url: mediaUrl(item.filename), is_carousel_item: 'true' };
}

const isCarousel = (post, media) => post.type === 'feed' && media.length > 1;
const hasVideo = (media) => media.some((m) => m.kind === 'video');

function fail(post, message) {
  update(post.id, { status: 'failed', last_error: message, next_run_at: null });
  logEvent(post.id, 'error', message);
}

// Etapa 1: cria os containers no Instagram.
async function start(post, account, token, media) {
  update(post.id, {
    status: 'processing',
    processing_started_at: nowIso(),
    attempts: post.attempts + 1,
    last_error: null,
    container_id: null,
    children_ids: null,
  });
  logEvent(post.id, 'info', `Iniciando publicação (tentativa ${post.attempts + 1}) em @${account.username}`);

  if (isCarousel(post, media)) {
    const ids = [];
    for (const item of media) {
      const res = await ig.createContainer(account.ig_user_id, token, buildCarouselChildParams(item));
      ids.push(res.id);
    }
    update(post.id, { children_ids: JSON.stringify(ids), next_run_at: later(hasVideo(media) ? POLL_VIDEO_MS : POLL_IMAGE_MS) });
    logEvent(post.id, 'info', `${ids.length} itens do carrossel enviados ao Instagram`);
    return;
  }

  const res = await ig.createContainer(account.ig_user_id, token, buildContainerParams(post, media));
  update(post.id, { container_id: res.id, next_run_at: later(hasVideo(media) ? POLL_VIDEO_MS : POLL_IMAGE_MS) });
  logEvent(post.id, 'info', 'Mídia enviada ao Instagram, aguardando processamento');
}

function statusError(status) {
  return `O Instagram não conseguiu processar a mídia (${status.status_code}${status.status ? `: ${status.status}` : ''}).`;
}

// Etapa 2: acompanha o processamento e publica.
async function proceed(post, account, token, media) {
  if (Date.now() - new Date(post.processing_started_at).getTime() > PROCESSING_TIMEOUT_MS) {
    return fail(post, 'Tempo esgotado aguardando o Instagram processar a mídia (30 min).');
  }
  const pollMs = hasVideo(media) ? POLL_VIDEO_MS : POLL_IMAGE_MS;

  // Carrossel: espera os itens ficarem prontos para criar o container pai.
  if (!post.container_id && post.children_ids) {
    const children = JSON.parse(post.children_ids);
    for (const childId of children) {
      const st = await ig.getContainerStatus(childId, token);
      if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') return fail(post, statusError(st));
      if (st.status_code !== 'FINISHED') return update(post.id, { next_run_at: later(pollMs) });
    }
    const parent = await ig.createContainer(account.ig_user_id, token, {
      media_type: 'CAROUSEL',
      children: children.join(','),
      caption: post.caption || undefined,
    });
    update(post.id, { container_id: parent.id, next_run_at: later(POLL_IMAGE_MS) });
    logEvent(post.id, 'info', 'Carrossel montado, aguardando processamento');
    return;
  }

  const st = await ig.getContainerStatus(post.container_id, token);
  if (st.status_code === 'IN_PROGRESS') return update(post.id, { next_run_at: later(pollMs) });
  if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') return fail(post, statusError(st));
  if (st.status_code === 'PUBLISHED') {
    // Já publicado (ex.: a resposta do media_publish se perdeu numa tentativa anterior).
    update(post.id, { status: 'published', published_at: nowIso(), next_run_at: null });
    logEvent(post.id, 'info', 'Publicado');
    return;
  }

  // FINISHED: pronto para publicar.
  const published = await ig.publishContainer(account.ig_user_id, token, post.container_id);
  let permalink = null;
  try {
    permalink = (await ig.getMedia(published.id, token)).permalink ?? null;
  } catch {
    // O permalink é só um extra; o post já foi publicado.
  }
  update(post.id, {
    status: 'published',
    ig_media_id: published.id,
    permalink,
    published_at: nowIso(),
    next_run_at: null,
  });
  logEvent(post.id, 'info', permalink ? `Publicado: ${permalink}` : 'Publicado');
}

// Avança um post em um passo. Nunca lança erro: falhas ficam registradas no post.
export async function advancePost(postId) {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post || !['scheduled', 'processing'].includes(post.status)) return;

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(post.account_id);
  if (!account) return fail(post, 'A conta deste post foi removida.');
  if (account.status !== 'active') {
    return fail(post, `A conta @${account.username} precisa ser reconectada. ${account.status_message ?? ''}`.trim());
  }
  const media = loadMedia(post.id);
  if (!media.length) return fail(post, 'O post não tem mídias.');

  try {
    const token = getAccountToken(account.id);
    if (post.status === 'scheduled') await start(post, account, token, media);
    else await proceed(post, account, token, media);
  } catch (err) {
    handleError(post, account, err);
  }
}

function handleError(post, account, err) {
  const fresh = getDb().prepare('SELECT * FROM posts WHERE id = ?').get(post.id);
  const message = err instanceof ig.GraphApiError ? err.describe() : err.message;

  if (err instanceof ig.GraphApiError && err.isAuthError) {
    markNeedsReauth(account.id, message);
    return fail(fresh, `Acesso à conta @${account.username} expirou ou foi revogado. Reconecte a conta. ${message}`);
  }

  if (err instanceof ig.GraphApiError && err.isTransient) {
    // Durante o acompanhamento: só tenta de novo mais tarde (o timeout de 30 min limita).
    if (fresh.status === 'processing' && (fresh.container_id || fresh.children_ids)) {
      logEvent(post.id, 'error', `Erro temporário, tentando de novo: ${message}`);
      return update(post.id, { next_run_at: later(30_000) });
    }
    if (fresh.attempts < config.maxAttempts) {
      const backoff = fresh.attempts * 2 * 60_000;
      logEvent(post.id, 'error', `Erro temporário, nova tentativa em ${backoff / 60_000} min: ${message}`);
      return update(post.id, { status: 'scheduled', next_run_at: later(backoff), last_error: message });
    }
  }

  fail(fresh, message);
}
