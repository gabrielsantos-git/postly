// Regras compartilhadas entre o site (navegador) e o publicador (GitHub Actions).
// Sem dependências do navegador ou do Node.

export const POST_TYPES = ['feed', 'reel', 'story'];

export const LIMITS = {
  captionChars: 2200,
  hashtags: 30,
  mentions: 20,
  carouselItems: 10,
  // Proporções aceitas no feed: de 4:5 (retrato) a 1.91:1 (paisagem).
  feedMinRatio: 4 / 5,
  feedMaxRatio: 1.91,
  // Limite de arquivo da API de blobs do GitHub é 100 MB; deixamos margem.
  videoMaxBytes: 95 * 1024 * 1024,
};

export const STATUS_LABELS = {
  draft: 'Rascunho',
  scheduled: 'Agendado',
  processing: 'Publicando…',
  published: 'Publicado',
  failed: 'Falhou',
  canceled: 'Cancelado',
};

export const EDITABLE_STATUSES = ['draft', 'scheduled', 'failed', 'canceled'];

export const countHashtags = (s = '') => (s.match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).length;
export const countMentions = (s = '') => (s.match(/(^|\s)@[\w.]+/g) || []).length;

export function ratioOutOfFeedRange(m) {
  if (m.kind !== 'image' || !m.width || !m.height) return false;
  const r = m.width / m.height;
  return r < LIMITS.feedMinRatio - 0.01 || r > LIMITS.feedMaxRatio + 0.01;
}

// Retorna a lista de erros (vazia = válido).
export function validatePost({ type, caption = '', media = [] }) {
  const errors = [];
  if (!POST_TYPES.includes(type)) errors.push('Tipo de post inválido.');
  if (!media.length) errors.push('Adicione pelo menos uma mídia.');

  if (type === 'feed') {
    if (media.length > LIMITS.carouselItems) errors.push(`Um carrossel aceita no máximo ${LIMITS.carouselItems} mídias.`);
    for (const m of media) {
      if (ratioOutOfFeedRange(m)) {
        errors.push(
          `A imagem "${m.name || 'sem nome'}" (${m.width}×${m.height}) está fora da proporção do feed: ` +
            'de 4:5 (retrato) até 1.91:1 (paisagem).',
        );
      }
    }
  }
  if (type === 'reel' && (media.length !== 1 || media[0].kind !== 'video')) {
    errors.push('Reels precisam de exatamente 1 vídeo.');
  }
  if (type === 'story' && media.length > 1) errors.push('Um story tem exatamente 1 imagem ou vídeo.');

  if (type !== 'story') {
    if (caption.length > LIMITS.captionChars) errors.push(`A legenda passa de ${LIMITS.captionChars} caracteres.`);
    if (countHashtags(caption) > LIMITS.hashtags) errors.push(`Máximo de ${LIMITS.hashtags} hashtags por post.`);
    if (countMentions(caption) > LIMITS.mentions) errors.push(`Máximo de ${LIMITS.mentions} menções por post.`);
  }
  return errors;
}

export function newId(prefix = '') {
  const rand = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}${Date.now().toString(36)}-${rand}`;
}

export function addEvent(post, level, message, at = new Date().toISOString()) {
  post.events = [...(post.events || []), { at, level, message }].slice(-40);
}
