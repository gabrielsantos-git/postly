// Máquina de estados da publicação. advance() faz UM passo e altera o objeto do post;
// o chamador salva o arquivo. Assim a publicação continua de onde parou entre execuções.
//
//  scheduled ─(mídia no ar? cria containers)─▶ processing ─(FINISHED)─▶ media_publish ─▶ published
//                                                  └── ERROR / EXPIRED / timeout / erro definitivo ──▶ failed
import { addEvent } from '../../assets/rules.js';
import { GraphApiError } from './instagram.mjs';

const PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;
const MEDIA_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_IMAGE_MS = 3_000;
const POLL_VIDEO_MS = 10_000;

export function isDue(post, now = Date.now()) {
  const checkOk = !post.nextCheckAt || new Date(post.nextCheckAt).getTime() <= now;
  if (post.status === 'scheduled') return Boolean(post.scheduledAt) && new Date(post.scheduledAt).getTime() <= now && checkOk;
  if (post.status === 'processing') return checkOk;
  return false;
}

export function buildContainerParams(post, mediaUrl) {
  const item = post.media[0];
  const url = mediaUrl(item);
  const caption = post.caption || undefined;
  if (post.type === 'story') {
    return item.kind === 'video' ? { media_type: 'STORIES', video_url: url } : { media_type: 'STORIES', image_url: url };
  }
  if (post.type === 'reel' || (post.type === 'feed' && item.kind === 'video')) {
    // Vídeo no feed é publicado como Reels (a API não usa mais VIDEO para o feed).
    return {
      media_type: 'REELS',
      video_url: url,
      caption,
      share_to_feed: post.type === 'feed' || post.shareToFeed !== false ? 'true' : 'false',
    };
  }
  return { image_url: url, caption };
}

export function buildCarouselChildParams(item, mediaUrl) {
  return item.kind === 'video'
    ? { media_type: 'VIDEO', video_url: mediaUrl(item), is_carousel_item: 'true' }
    : { image_url: mediaUrl(item), is_carousel_item: 'true' };
}

export function createPublisher({ ig, mediaUrl, isMediaReady = async () => true, maxAttempts = 3, now = () => Date.now() }) {
  const iso = (ms = 0) => new Date(now() + ms).toISOString();
  const hasVideo = (post) => post.media.some((m) => m.kind === 'video');
  const isCarousel = (post) => post.type === 'feed' && post.media.length > 1;

  function fail(post, message) {
    Object.assign(post, { status: 'failed', lastError: message, nextCheckAt: null });
    addEvent(post, 'error', message, iso());
  }

  const statusError = (st) =>
    `O Instagram não conseguiu processar a mídia (${st.status_code}${st.status ? `: ${st.status}` : ''}).`;

  async function start(post, account, token) {
    // O GitHub Pages leva ~1 min para publicar arquivos novos; o Instagram precisa deles no ar.
    for (const m of post.media) {
      if (!(await isMediaReady(m))) {
        if (!post.waitingMediaSince) {
          post.waitingMediaSince = iso();
          addEvent(post, 'info', 'Aguardando o GitHub Pages disponibilizar a mídia…', iso());
        } else if (now() - new Date(post.waitingMediaSince).getTime() > MEDIA_WAIT_TIMEOUT_MS) {
          return fail(post, `A mídia não ficou disponível em ${mediaUrl(m)}. Verifique se o GitHub Pages está ativo.`);
        }
        post.nextCheckAt = iso(30_000);
        return;
      }
    }

    Object.assign(post, {
      status: 'processing',
      processingStartedAt: iso(),
      attempts: (post.attempts || 0) + 1,
      lastError: null,
      containerId: null,
      childrenIds: null,
      waitingMediaSince: null,
    });
    addEvent(post, 'info', `Iniciando publicação (tentativa ${post.attempts}) em @${account.username}`, iso());

    if (isCarousel(post)) {
      const ids = [];
      for (const item of post.media) ids.push((await ig.createContainer(account.id, token, buildCarouselChildParams(item, mediaUrl))).id);
      post.childrenIds = ids;
      post.nextCheckAt = iso(hasVideo(post) ? POLL_VIDEO_MS : POLL_IMAGE_MS);
      addEvent(post, 'info', `${ids.length} itens do carrossel enviados ao Instagram`, iso());
      return;
    }
    post.containerId = (await ig.createContainer(account.id, token, buildContainerParams(post, mediaUrl))).id;
    post.nextCheckAt = iso(hasVideo(post) ? POLL_VIDEO_MS : POLL_IMAGE_MS);
    addEvent(post, 'info', 'Mídia enviada ao Instagram, aguardando processamento', iso());
  }

  async function proceed(post, account, token) {
    if (now() - new Date(post.processingStartedAt).getTime() > PROCESSING_TIMEOUT_MS) {
      return fail(post, 'Tempo esgotado aguardando o Instagram processar a mídia (30 min).');
    }
    const pollMs = hasVideo(post) ? POLL_VIDEO_MS : POLL_IMAGE_MS;

    if (!post.containerId && post.childrenIds?.length) {
      for (const childId of post.childrenIds) {
        const st = await ig.getContainerStatus(childId, token);
        if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') return fail(post, statusError(st));
        if (st.status_code !== 'FINISHED') {
          post.nextCheckAt = iso(pollMs);
          return;
        }
      }
      const parent = await ig.createContainer(account.id, token, {
        media_type: 'CAROUSEL',
        children: post.childrenIds.join(','),
        caption: post.caption || undefined,
      });
      post.containerId = parent.id;
      post.nextCheckAt = iso(POLL_IMAGE_MS);
      addEvent(post, 'info', 'Carrossel montado, aguardando processamento', iso());
      return;
    }

    const st = await ig.getContainerStatus(post.containerId, token);
    if (st.status_code === 'IN_PROGRESS') {
      post.nextCheckAt = iso(pollMs);
      return;
    }
    if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') return fail(post, statusError(st));
    if (st.status_code === 'PUBLISHED') {
      // Já publicado (a resposta do media_publish se perdeu numa execução anterior).
      Object.assign(post, { status: 'published', publishedAt: iso(), nextCheckAt: null });
      addEvent(post, 'info', 'Publicado', iso());
      return;
    }

    const published = await ig.publishContainer(account.id, token, post.containerId);
    let permalink = null;
    try {
      permalink = (await ig.getMedia(published.id, token)).permalink ?? null;
    } catch {
      // O link é só um extra; o post já foi publicado.
    }
    Object.assign(post, { status: 'published', igMediaId: published.id, permalink, publishedAt: iso(), nextCheckAt: null });
    addEvent(post, 'info', permalink ? `Publicado: ${permalink}` : 'Publicado', iso());
  }

  // Avança o post um passo. Nunca lança erro. Retorna { reauth?: mensagem } se a conta precisa ser reconectada.
  async function advance(post, account, token) {
    if (!['scheduled', 'processing'].includes(post.status)) return {};
    if (!account) {
      fail(post, 'A conta deste post foi removida do Postly.');
      return {};
    }
    if (account.status !== 'active') {
      fail(post, `A conta @${account.username} precisa ser reconectada. ${account.statusMessage ?? ''}`.trim());
      return {};
    }
    if (!token) {
      fail(post, `O token da conta @${account.username} não foi encontrado nos secrets do repositório. Reconecte a conta.`);
      return { reauth: 'Token não encontrado nos secrets do repositório.' };
    }
    if (!post.media?.length) {
      fail(post, 'O post não tem mídias.');
      return {};
    }

    try {
      if (post.status === 'scheduled') await start(post, account, token);
      else await proceed(post, account, token);
      return {};
    } catch (err) {
      return handleError(post, account, err);
    }
  }

  function handleError(post, account, err) {
    const message = err instanceof GraphApiError ? err.describe() : err.message;

    if (err instanceof GraphApiError && err.isAuthError) {
      fail(post, `O acesso à conta @${account.username} expirou ou foi revogado. Reconecte a conta. ${message}`);
      return { reauth: message };
    }
    if (err instanceof GraphApiError && err.isTransient) {
      if (post.status === 'processing' && (post.containerId || post.childrenIds?.length)) {
        addEvent(post, 'error', `Erro temporário, tentando de novo: ${message}`, iso());
        post.nextCheckAt = iso(30_000);
        return {};
      }
      if ((post.attempts || 0) < maxAttempts) {
        const backoff = Math.max(1, post.attempts || 0) * 2 * 60_000;
        addEvent(post, 'error', `Erro temporário, nova tentativa em ${backoff / 60_000} min: ${message}`, iso());
        Object.assign(post, { status: 'scheduled', nextCheckAt: iso(backoff), lastError: message });
        return {};
      }
    }
    fail(post, message);
    return {};
  }

  return { advance };
}
