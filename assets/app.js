// Postly — site estático (GitHub Pages). Os dados ficam no repositório e a publicação
// é feita pelo GitHub Actions (.github/workflows/publish.yml).
import { createGitHub } from './github.js';
import { LIMITS, STATUS_LABELS, EDITABLE_STATUSES, validatePost, countHashtags, ratioOutOfFeedRange, newId, addEvent } from './rules.js';

// ---------------------------------------------------------------- utilidades
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeKey = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const fmtDateTime = (iso) =>
  new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function relTime(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 60000;
  if (diff < 1) return 'agora há pouco';
  if (diff < 60) return `há ${Math.round(diff)} min`;
  if (diff < 1440) return `há ${Math.round(diff / 60)} h`;
  return fmtDateTime(iso);
}

function dayLabel(d) {
  const k = dateKey(d);
  if (k === dateKey(new Date())) return 'Hoje';
  if (k === dateKey(new Date(Date.now() + 864e5))) return 'Amanhã';
  if (k === dateKey(new Date(Date.now() - 864e5))) return 'Ontem';
  return d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
}

const TYPES = { feed: 'Feed', reel: 'Reels', story: 'Story' };
const ICONS = {
  feed: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 21V9"/></svg>',
  reel: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M3 8h18M8 3l3 5M14 3l3 5"/><path d="M10 12v5l4-2.5z" fill="currentColor"/></svg>',
  story: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9" stroke-dasharray="4 2.5"/><path d="M12 8v8M8 12h8"/></svg>',
  left: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 18l-6-6 6-6"/></svg>',
  right: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>',
  x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  upload: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>',
};

function toast(message, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 8000 : 4000);
}

function readStorage(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || sessionStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}
function writeStorage(key, value, persist = true) {
  try {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
    if (value !== null) (persist ? localStorage : sessionStorage).setItem(key, JSON.stringify(value));
  } catch {
    /* armazenamento bloqueado */
  }
}

// ---------------------------------------------------------------- sessão e repositório
const dev = readStorage('postly.dev') || {}; // permite apontar para uma API de testes
let session = readStorage('postly.session');
let gh = null;
const store = { accounts: [], posts: [] };

function detectRepo() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  if (!m) return null;
  const first = location.pathname.split('/').filter(Boolean)[0];
  return { owner: m[1], repo: first || `${m[1]}.github.io` };
}

function pagesBase() {
  if (dev.pagesBase) return dev.pagesBase;
  const owner = gh.owner.toLowerCase();
  return gh.repo.toLowerCase() === `${owner}.github.io` ? `https://${owner}.github.io` : `https://${owner}.github.io/${gh.repo}`;
}
function mediaSrc(m) {
  if (m.previewUrl) return m.previewUrl;
  // Imagens: raw.githubusercontent.com (fica disponível na hora). Vídeos: GitHub Pages.
  if (m.kind === 'image') {
    return dev.rawBase ? `${dev.rawBase}/${m.path}` : `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${gh.branch}/${m.path}`;
  }
  return `${pagesBase()}/${m.path}`;
}

async function reload() {
  const data = await gh.loadData();
  store.accounts = data.accounts;
  store.posts = data.posts;
}
const accountById = (id) => store.accounts.find((a) => a.id === id);

// ---------------------------------------------------------------- operações
function postFile(id) {
  return `data/posts/${id}.json`;
}

// Mídias que não são usadas por nenhum outro post podem ser apagadas junto.
function orphanMedia(paths, exceptPostIds) {
  const used = new Set(store.posts.filter((p) => !exceptPostIds.includes(p.id)).flatMap((p) => (p.media || []).map((m) => m.path)));
  return [...new Set(paths)].filter((p) => !used.has(p) && p.startsWith('data/media/'));
}

const cleanMedia = (m) => ({ path: m.path, kind: m.kind, width: m.width ?? null, height: m.height ?? null, name: m.name ?? null, size: m.size ?? null });

function dueSoon(iso) {
  return iso && new Date(iso).getTime() <= Date.now() + 4 * 60e3;
}

async function triggerPublisher() {
  try {
    await gh.runWorkflow({ action: 'publish' });
  } catch (err) {
    toast(`Post salvo, mas não consegui acionar o publicador agora: ${err.message}. Ele roda sozinho a cada 5 min.`, 'error');
  }
}

async function savePosts({ editingId, accountIds, type, caption, media, shareToFeed, status, scheduledAt }) {
  const now = new Date().toISOString();
  const newMedia = media.filter((m) => m.isNew).map((m) => ({ path: m.path, sha: m.sha }));
  const cleanList = media.map(cleanMedia);

  await gh.commit(editingId ? 'Postly: post editado' : 'Postly: novo post agendado', async (read) => {
    const changes = [...newMedia];
    if (editingId) {
      const current = await read(postFile(editingId));
      if (!current) throw new Error('Este post não existe mais.');
      if (!EDITABLE_STATUSES.includes(current.status)) throw new Error('Este post já está sendo publicado e não pode ser editado.');
      const removed = (current.media || []).map((m) => m.path).filter((p) => !media.some((m) => m.path === p));
      const post = {
        ...current,
        accountId: accountIds[0],
        type,
        caption,
        media: cleanList,
        shareToFeed,
        status,
        scheduledAt,
        nextCheckAt: null,
        attempts: 0,
        lastError: null,
        containerId: null,
        childrenIds: null,
        processingStartedAt: null,
        waitingMediaSince: null,
        updatedAt: now,
      };
      addEvent(post, 'info', status === 'draft' ? 'Rascunho atualizado' : `Reagendado para ${fmtDateTime(scheduledAt)}`);
      changes.push({ path: postFile(editingId), json: post });
      for (const p of orphanMedia(removed, [editingId])) changes.push({ path: p, delete: true });
    } else {
      for (const accountId of accountIds) {
        const post = {
          id: newId(),
          accountId,
          type,
          caption,
          media: cleanList,
          shareToFeed,
          status,
          scheduledAt,
          nextCheckAt: null,
          attempts: 0,
          lastError: null,
          containerId: null,
          childrenIds: null,
          processingStartedAt: null,
          igMediaId: null,
          permalink: null,
          publishedAt: null,
          createdAt: now,
          updatedAt: now,
          events: [],
        };
        addEvent(post, 'info', status === 'draft' ? 'Rascunho criado' : `Agendado para ${fmtDateTime(scheduledAt)}`);
        changes.push({ path: postFile(post.id), json: post });
      }
    }
    return changes;
  });
  if (status === 'scheduled' && dueSoon(scheduledAt)) await triggerPublisher();
}

async function mutatePost(id, message, fn) {
  await gh.commit(message, async (read) => {
    const post = await read(postFile(id));
    if (!post) throw new Error('Este post não existe mais.');
    const result = fn(post);
    if (result === false) return [];
    post.updatedAt = new Date().toISOString();
    return [{ path: postFile(id), json: post }];
  });
}

async function postAction(action, post) {
  try {
    if (action === 'edit') {
      location.hash = `#/editar/${post.id}`;
      return false;
    }
    if (action === 'publish') {
      if (!confirm('Publicar este post agora?')) return false;
      await mutatePost(post.id, 'Postly: publicar agora', (p) => {
        if (!EDITABLE_STATUSES.includes(p.status)) throw new Error('Este post não pode ser publicado agora.');
        Object.assign(p, {
          status: 'scheduled',
          scheduledAt: new Date().toISOString(),
          nextCheckAt: null,
          attempts: 0,
          lastError: null,
          containerId: null,
          childrenIds: null,
          processingStartedAt: null,
          waitingMediaSince: null,
        });
        addEvent(p, 'info', 'Enviado para publicação imediata');
      });
      await triggerPublisher();
      toast('Publicação iniciada. O GitHub Actions leva cerca de 1 minuto para começar.');
    } else if (action === 'cancel') {
      if (!confirm('Cancelar este agendamento?')) return false;
      await mutatePost(post.id, 'Postly: agendamento cancelado', (p) => {
        if (p.status !== 'scheduled' && p.status !== 'failed') throw new Error('Este post não pode mais ser cancelado.');
        Object.assign(p, { status: 'canceled', nextCheckAt: null });
        addEvent(p, 'info', 'Agendamento cancelado');
      });
      toast('Agendamento cancelado.');
    } else if (action === 'delete') {
      if (!confirm(post.status === 'published' ? 'Remover do Postly? (O post continua no Instagram.)' : 'Excluir este post?')) return false;
      await gh.commit('Postly: post excluído', async (read) => {
        const p = await read(postFile(post.id));
        if (!p) return [];
        if (p.status === 'processing') throw new Error('Aguarde a publicação terminar para excluir.');
        const media = orphanMedia((p.media || []).map((m) => m.path), [post.id]);
        return [{ path: postFile(post.id), delete: true }, ...media.map((m) => ({ path: m, delete: true }))];
      });
      toast('Post excluído.');
    }
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

// ---------------------------------------------------------------- mídia (processada no navegador)
const VIDEO_EXT = { 'video/mp4': '.mp4', 'video/quicktime': '.mov' };

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    r.readAsDataURL(blob);
  });
}

// Converte imagens para JPEG (único formato aceito pela API), no máx. 1440 px de largura.
async function prepareImage(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(`Não foi possível ler a imagem "${file.name}". Use JPG, PNG ou WEBP.`);
  }
  const scale = Math.min(1, 1440 / bitmap.width);
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
  return { blob, width, height, ext: '.jpg', kind: 'image' };
}

function videoSize(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      resolve({ width: v.videoWidth || null, height: v.videoHeight || null });
      URL.revokeObjectURL(v.src);
    };
    v.onerror = () => resolve({ width: null, height: null });
    v.src = URL.createObjectURL(file);
  });
}

async function prepareFile(file) {
  if (file.type.startsWith('image/')) return prepareImage(file);
  const ext = VIDEO_EXT[file.type];
  if (!ext) throw new Error(`Formato não suportado: ${file.name}. Use imagens (JPG/PNG/WEBP) ou vídeos MP4/MOV.`);
  if (file.size > LIMITS.videoMaxBytes) throw new Error(`O vídeo "${file.name}" passa de 95 MB (limite de arquivo do GitHub).`);
  return { blob: file, ...(await videoSize(file)), ext, kind: 'video' };
}

// ---------------------------------------------------------------- avatar / mídia
function avatar(account, size = '') {
  const letter = esc(account?.username?.[0]?.toUpperCase() ?? '?');
  if (account?.profilePictureUrl) {
    return `<img class="avatar ${size}" src="${esc(account.profilePictureUrl)}" alt="" referrerpolicy="no-referrer" data-letter="${letter}" onerror="this.outerHTML='<div class=&quot;avatar ${size}&quot;>'+this.dataset.letter+'</div>'">`;
  }
  return `<div class="avatar ${size}">${letter}</div>`;
}

function mediaEl(m, attrs = '') {
  if (!m) return '';
  return m.kind === 'video'
    ? `<video src="${esc(mediaSrc(m))}#t=0.5" muted playsinline preload="metadata" ${attrs}></video>`
    : `<img src="${esc(mediaSrc(m))}" alt="" loading="lazy" ${attrs}>`;
}

function thumb(p) {
  if (p.mediaRemoved) return '<div class="thumb"></div>';
  return `<div class="thumb">${mediaEl(p.media?.[0])}${p.media?.length > 1 ? `<span class="count">1/${p.media.length}</span>` : ''}</div>`;
}

// ---------------------------------------------------------------- roteador
let cleanup = null;

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { parts: path.split('/').filter(Boolean), query: new URLSearchParams(qs || '') };
}

async function route() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  closeModal();
  const view = $('#view');
  const { parts, query } = parseHash();
  const name = parts[0] || 'painel';
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (name === 'editar' ? 'novo' : name)));
  view.innerHTML = '<p class="muted">Carregando…</p>';
  try {
    await reload();
    if (name === 'painel') await renderDashboard(view, query);
    else if (name === 'calendario') renderCalendar(view, query);
    else if (name === 'novo') renderEditor(view, null, query);
    else if (name === 'editar') renderEditor(view, parts[1], query);
    else if (name === 'contas') await renderAccounts(view);
    else view.innerHTML = '<div class="empty"><h3>Página não encontrada</h3></div>';
  } catch (err) {
    if (err.status === 401) return logout('Seu token do GitHub expirou ou foi revogado. Entre de novo.');
    view.innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
  }
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- ações nos cards
function postActionsHtml(p) {
  const b = (action, label, cls = '') => `<button class="btn btn-sm ${cls}" data-action="${action}" data-id="${esc(p.id)}">${label}</button>`;
  const out = [];
  if (p.status === 'scheduled') out.push(b('edit', 'Editar'), b('publish', 'Publicar agora'), b('cancel', 'Cancelar', 'btn-danger'));
  if (p.status === 'failed') out.push(b('publish', 'Tentar de novo', 'btn-primary'), b('edit', 'Editar'), b('delete', 'Excluir', 'btn-danger'));
  if (p.status === 'draft' || p.status === 'canceled') out.push(b('edit', 'Editar'), b('delete', 'Excluir', 'btn-danger'));
  if (p.status === 'published') {
    if (p.permalink) out.push(`<a class="btn btn-sm" href="${esc(p.permalink)}" target="_blank" rel="noopener">Ver no Instagram</a>`);
    out.push(b('delete', 'Remover', 'btn-danger'));
  }
  return out.join('');
}

function bindPostActions(root, onDone) {
  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (btn) {
      e.stopPropagation();
      const post = store.posts.find((p) => p.id === btn.dataset.id);
      btn.disabled = true;
      if (post && (await postAction(btn.dataset.action, post))) await onDone();
      btn.disabled = false;
      return;
    }
    const item = e.target.closest('[data-post]');
    if (item && !e.target.closest('a')) openPostModal(item.dataset.post, onDone);
  });
}

// ---------------------------------------------------------------- painel
const FILTERS = {
  proximos: { label: 'Próximos', status: ['scheduled', 'processing'] },
  falhas: { label: 'Falhas', status: ['failed'] },
  publicados: { label: 'Publicados', status: ['published'], desc: true },
  rascunhos: { label: 'Rascunhos', status: ['draft', 'canceled'] },
  todos: { label: 'Todos', status: null },
};

const when = (p) => p.publishedAt || p.scheduledAt;

async function renderDashboard(view, query) {
  const filter = FILTERS[query.get('f')] ? query.get('f') : 'proximos';
  const accountId = query.get('conta') || '';

  if (!store.accounts.length) {
    view.innerHTML = `
      <div class="page-head"><div><h1>Painel</h1></div></div>
      <div class="card empty">
        <h3>Conecte sua primeira conta do Instagram</h3>
        <p>Para agendar publicações, conecte uma conta profissional (Comercial ou Criador de conteúdo).</p>
        <a class="btn btn-primary" href="#/contas">Conectar conta</a>
      </div>`;
    return;
  }

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Painel</h1><p class="muted">Suas publicações agendadas e o histórico.</p></div>
      <a class="btn btn-primary" href="#/novo">+ Novo post</a>
    </div>
    <div class="stats" id="stats"></div>
    <div class="card card-pad row runner" id="runner" style="margin-bottom:18px;padding:12px 16px"><span class="muted small">Verificando o publicador…</span></div>
    <div class="row" style="margin-bottom:6px">
      <div class="tabs">${Object.entries(FILTERS)
        .map(([k, f]) => `<button class="tab ${k === filter ? 'active' : ''}" data-filter="${k}">${f.label}</button>`)
        .join('')}</div>
      <div class="grow"></div>
      <select id="account-filter" style="width:auto">
        <option value="">Todas as contas</option>
        ${store.accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === accountId ? 'selected' : ''}>@${esc(a.username)}</option>`).join('')}
      </select>
    </div>
    <div class="post-list" id="list"></div>`;

  const setQuery = (f, c) => {
    const q = new URLSearchParams();
    if (f !== 'proximos') q.set('f', f);
    if (c) q.set('conta', c);
    location.hash = `#/${q.toString() ? `?${q}` : ''}`;
  };
  $$('[data-filter]').forEach((b) => b.addEventListener('click', () => setQuery(b.dataset.filter, accountId)));
  $('#account-filter').addEventListener('change', (e) => setQuery(filter, e.target.value));

  const list = $('#list');
  function render() {
    if (!list.isConnected) return; // o usuário já foi para outra tela
    const count = (s) => store.posts.filter((p) => p.status === s).length;
    $('#stats').innerHTML = [['scheduled', 'Agendados'], ['processing', 'Publicando agora'], ['published', 'Publicados'], ['failed', 'Com falha']]
      .map(([k, l]) => `<div class="card stat"><div class="stat-value">${count(k)}</div><div class="stat-label">${l}</div></div>`)
      .join('');

    let posts = store.posts.filter((p) => (!FILTERS[filter].status || FILTERS[filter].status.includes(p.status)) && (!accountId || p.accountId === accountId));
    posts.sort((a, b) => (when(a) || a.createdAt).localeCompare(when(b) || b.createdAt));
    if (FILTERS[filter].desc) posts = posts.reverse();

    if (!posts.length) {
      list.innerHTML = `<div class="card empty"><h3>Nada por aqui</h3><p>${
        filter === 'proximos' ? 'Nenhuma publicação agendada.' : 'Nenhum post neste filtro.'
      }</p>${filter === 'proximos' ? '<a class="btn btn-primary" href="#/novo">Agendar um post</a>' : ''}</div>`;
      return;
    }
    let lastDay = '';
    list.innerHTML = posts
      .map((p) => {
        const w = when(p);
        const day = w ? dayLabel(new Date(w)) : 'Sem data';
        const header = day !== lastDay ? `<div class="day-label">${esc(day)}</div>` : '';
        lastDay = day;
        const acc = accountById(p.accountId);
        return `${header}
          <div class="card post-item" data-post="${esc(p.id)}" style="cursor:pointer">
            ${thumb(p)}
            <div class="post-body">
              <div class="row" style="gap:8px">
                ${avatar(acc, 'avatar-xs')}
                <strong>@${esc(acc?.username ?? 'conta removida')}</strong>
                <span class="badge badge-type">${ICONS[p.type]} ${TYPES[p.type]}${p.type === 'feed' && p.media?.length > 1 ? ' · carrossel' : ''}</span>
                <span class="badge badge-${p.status}">${STATUS_LABELS[p.status]}</span>
                ${w ? `<span class="muted small">${p.publishedAt ? 'publicado às ' : ''}${fmtTime(w)}</span>` : ''}
              </div>
              <div class="post-caption">${esc(p.caption) || (p.type === 'story' ? '<i>Story (sem legenda)</i>' : '<i>Sem legenda</i>')}</div>
              ${p.status === 'failed' && p.lastError ? `<div class="post-error">${esc(p.lastError)}</div>` : ''}
              ${p.status === 'scheduled' && p.scheduledAt && new Date(p.scheduledAt) < Date.now() ? '<div class="muted small">Na fila — o GitHub Actions publica em instantes.</div>' : ''}
            </div>
            <div class="post-actions">${postActionsHtml(p)}</div>
          </div>`;
      })
      .join('');
  }

  async function renderRunner() {
    const el = $('#runner');
    if (!el) return;
    let runs;
    try {
      runs = await gh.latestRuns(5);
    } catch {
      el.innerHTML = '<span class="muted small">Não foi possível ver o status do publicador (o token precisa da permissão Actions).</span>';
      return;
    }
    if (runs === null) {
      el.innerHTML = '<span class="small" style="color:var(--danger)">O workflow do publicador não foi encontrado. Confira se o arquivo .github/workflows/publish.yml está no repositório e se o Actions está ativado.</span>';
      return;
    }
    const last = runs.find((r) => r.status === 'completed');
    const running = runs.find((r) => r.status !== 'completed');
    const ok = last?.conclusion === 'success';
    el.innerHTML = `
      <span class="badge ${running ? 'badge-processing' : ok || !last ? 'badge-published' : 'badge-failed'}">${running ? 'Rodando' : ok || !last ? 'Publicador ativo' : 'Última execução falhou'}</span>
      <span class="muted small grow">${last ? `Última verificação ${relTime(last.updated_at)} · ` : ''}roda a cada ~5 min pelo GitHub Actions</span>
      ${last && !ok ? `<a class="btn btn-sm" href="${esc(last.html_url)}" target="_blank" rel="noopener">Ver erro</a>` : ''}
      <button class="btn btn-sm" id="run-now" ${running ? 'disabled' : ''}>Verificar agora</button>`;
    $('#run-now')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await gh.runWorkflow({ action: 'publish' });
        toast('Publicador acionado. Ele começa em cerca de 1 minuto.');
        setTimeout(renderRunner, 4000);
      } catch (err) {
        toast(err.message, 'error');
        e.target.disabled = false;
      }
    });
  }

  bindPostActions(list, async () => {
    await reload();
    render();
  });
  render();
  renderRunner();

  // Atualiza sozinho enquanto houver publicações em andamento ou na fila.
  const timer = setInterval(async () => {
    const busy = store.posts.some((p) => p.status === 'processing' || (p.status === 'scheduled' && new Date(p.scheduledAt) < Date.now() + 60e3));
    if (!busy || document.hidden) return;
    try {
      await reload();
      render();
      renderRunner();
    } catch {
      /* tenta de novo no próximo ciclo */
    }
  }, 15_000);
  cleanup = () => clearInterval(timer);
}

// ---------------------------------------------------------------- calendário
function renderCalendar(view, query) {
  const base = query.get('mes') ? new Date(`${query.get('mes')}-01T00:00:00`) : new Date();
  const first = new Date(base.getFullYear(), base.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  const end = new Date(start);
  end.setDate(start.getDate() + 42);

  const byDay = new Map();
  for (const p of store.posts) {
    if (!when(p)) continue;
    const k = dateKey(new Date(when(p)));
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(p);
  }

  const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const prev = new Date(first.getFullYear(), first.getMonth() - 1, 1);
  const next = new Date(first.getFullYear(), first.getMonth() + 1, 1);
  const title = first.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }).replace(/^./, (c) => c.toUpperCase());

  const days = [];
  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    const k = dateKey(d);
    const items = (byDay.get(k) || []).sort((a, b) => when(a).localeCompare(when(b)));
    days.push(`
      <div class="cal-day ${d.getMonth() !== first.getMonth() ? 'other' : ''} ${k === dateKey(new Date()) ? 'today' : ''}" data-day="${k}">
        <span class="cal-num">${d.getDate()}</span>
        ${items.slice(0, 4).map((p) => {
          const acc = accountById(p.accountId);
          return `<button class="cal-ev s-${p.status}" data-post="${esc(p.id)}" title="@${esc(acc?.username)} · ${TYPES[p.type]} · ${STATUS_LABELS[p.status]}">
            ${ICONS[p.type]}<span class="ev-text">${fmtTime(when(p))} @${esc(acc?.username ?? '')}</span></button>`;
        }).join('')}
        ${items.length > 4 ? `<span class="muted small">+${items.length - 4} mais</span>` : ''}
      </div>`);
  }

  view.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(title)}</h1><p class="muted">Clique em um dia para agendar.</p></div>
      <div class="row">
        <a class="btn btn-sm" href="#/calendario?mes=${monthKey(prev)}" aria-label="Mês anterior">${ICONS.left}</a>
        <a class="btn btn-sm" href="#/calendario">Hoje</a>
        <a class="btn btn-sm" href="#/calendario?mes=${monthKey(next)}" aria-label="Próximo mês">${ICONS.right}</a>
      </div>
    </div>
    <div class="card cal">
      <div class="cal-head">${['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((d) => `<div>${d}</div>`).join('')}</div>
      <div class="cal-grid">${days.join('')}</div>
    </div>`;

  $('.cal-grid').addEventListener('click', (e) => {
    const ev = e.target.closest('[data-post]');
    if (ev) return openPostModal(ev.dataset.post, () => route());
    const day = e.target.closest('[data-day]');
    if (day) location.hash = `#/novo?data=${day.dataset.day}`;
  });
}

// ---------------------------------------------------------------- modal
function closeModal() {
  $('.modal-backdrop')?.remove();
}

function openPostModal(id, onChange) {
  const p = store.posts.find((x) => x.id === id);
  if (!p) return;
  const acc = accountById(p.accountId);
  closeModal();
  const el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.innerHTML = `
    <div class="card modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div class="row">${avatar(acc)}<div><strong>@${esc(acc?.username ?? 'conta removida')}</strong>
          <div class="row" style="gap:6px"><span class="badge badge-type">${TYPES[p.type]}</span><span class="badge badge-${p.status}">${STATUS_LABELS[p.status]}</span></div></div></div>
        <button class="btn btn-ghost icon-btn" data-close aria-label="Fechar">${ICONS.x}</button>
      </div>
      <div class="modal-body stack">
        ${p.mediaRemoved ? '<p class="muted small">As mídias foram removidas do repositório após a publicação.</p>' : `<div class="modal-media">${(p.media || []).map((m) => mediaEl(m, m.kind === 'video' ? 'controls' : '')).join('')}</div>`}
        ${p.caption ? `<div style="white-space:pre-wrap">${esc(p.caption)}</div>` : ''}
        <dl class="kv">
          ${p.scheduledAt ? `<dt>Agendado para</dt><dd>${fmtDateTime(p.scheduledAt)}</dd>` : ''}
          ${p.publishedAt ? `<dt>Publicado em</dt><dd>${fmtDateTime(p.publishedAt)}</dd>` : ''}
          ${p.type === 'reel' ? `<dt>Aparece no feed</dt><dd>${p.shareToFeed !== false ? 'Sim' : 'Não'}</dd>` : ''}
          ${p.attempts ? `<dt>Tentativas</dt><dd>${p.attempts}</dd>` : ''}
          ${p.permalink ? `<dt>Link</dt><dd><a href="${esc(p.permalink)}" target="_blank" rel="noopener">${esc(p.permalink)}</a></dd>` : ''}
        </dl>
        ${p.lastError && p.status === 'failed' ? `<div class="alert alert-danger">${esc(p.lastError)}</div>` : ''}
        <div><h3 style="margin-bottom:8px">Histórico</h3>
          <ul class="timeline">${(p.events || []).map((e) => `<li><time>${fmtDateTime(e.at)}</time><span class="${e.level === 'error' ? 'err' : ''}">${esc(e.message)}</span></li>`).join('')}</ul>
        </div>
        <div class="row" style="justify-content:flex-end">${postActionsHtml(p)}</div>
      </div>
    </div>`;
  document.body.append(el);
  el.addEventListener('click', async (e) => {
    if (e.target === el || e.target.closest('[data-close]')) return closeModal();
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    btn.disabled = true;
    if (await postAction(btn.dataset.action, p)) {
      closeModal();
      onChange?.();
    }
    btn.disabled = false;
  });
  const onKey = (e) => {
    if (e.key === 'Escape') {
      closeModal();
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('keydown', onKey);
}

// ---------------------------------------------------------------- editor
const TYPE_INFO = {
  feed: { title: 'Feed', hint: '1 foto, ou carrossel com até 10 fotos/vídeos' },
  reel: { title: 'Reels', hint: '1 vídeo vertical (9:16), até 95 MB' },
  story: { title: 'Story', hint: '1 foto ou vídeo (até 60s), sem legenda' },
};

function renderEditor(view, editId, query) {
  const accounts = store.accounts;
  if (!accounts.length) {
    view.innerHTML = `<div class="card empty"><h3>Nenhuma conta conectada</h3><p>Conecte uma conta do Instagram antes de agendar.</p>
      <a class="btn btn-primary" href="#/contas">Conectar conta</a></div>`;
    return;
  }

  const active = accounts.filter((a) => a.status === 'active');
  const defaultDate = new Date(Date.now() + 60 * 60e3);
  defaultDate.setMinutes(0, 0, 0);
  const st = {
    accountIds: active.length === 1 ? [active[0].id] : [],
    type: 'feed',
    media: [],
    caption: '',
    shareToFeed: true,
    date: query.get('data') || dateKey(defaultDate),
    time: query.get('data') ? '09:00' : timeKey(defaultDate),
    slide: 0,
  };

  let editing = null;
  if (editId) {
    editing = store.posts.find((p) => p.id === editId);
    if (!editing) {
      view.innerHTML = '<div class="alert alert-danger">Post não encontrado.</div>';
      return;
    }
    if (!EDITABLE_STATUSES.includes(editing.status)) {
      view.innerHTML = '<div class="alert alert-warn">Este post já foi publicado (ou está sendo publicado) e não pode ser editado.</div>';
      return;
    }
    Object.assign(st, {
      accountIds: [editing.accountId],
      type: editing.type,
      media: (editing.media || []).map((m) => ({ ...m })),
      caption: editing.caption || '',
      shareToFeed: editing.shareToFeed !== false,
    });
    if (editing.scheduledAt && new Date(editing.scheduledAt) > Date.now()) {
      const d = new Date(editing.scheduledAt);
      st.date = dateKey(d);
      st.time = timeKey(d);
    }
  }

  view.innerHTML = `
    <div class="page-head">
      <div><h1>${editing ? 'Editar post' : 'Novo post'}</h1>
      <p class="muted">${editing ? `Editando post de @${esc(accountById(editing.accountId)?.username)}` : 'Escolha as contas, o formato, a mídia e quando publicar.'}</p></div>
    </div>
    <div class="editor">
      <div class="stack">
        <section class="card card-pad">
          <div class="section-title"><h2>Contas</h2><span class="hint">${editing ? 'Um post por conta' : 'Selecione uma ou mais — será criado um post para cada'}</span></div>
          <div class="chips" id="accounts">
            ${accounts.map((a) => `
              <button type="button" class="chip ${a.status !== 'active' ? 'disabled' : ''}" data-account="${esc(a.id)}" ${a.status !== 'active' ? 'disabled title="Reconecte esta conta"' : ''}>
                ${avatar(a, 'avatar-xs')} @${esc(a.username)}
              </button>`).join('')}
          </div>
        </section>

        <section class="card card-pad">
          <div class="section-title"><h2>Formato</h2></div>
          <div class="segmented" id="types">
            ${Object.entries(TYPE_INFO).map(([k, t]) => `
              <button type="button" class="segment" data-type="${k}"><strong>${ICONS[k]} ${t.title}</strong><span>${t.hint}</span></button>`).join('')}
          </div>
        </section>

        <section class="card card-pad">
          <div class="section-title"><h2>Mídia</h2><span class="hint" id="media-hint"></span></div>
          <div class="dropzone" id="drop" role="button" tabindex="0">
            ${ICONS.upload}
            <div><strong>Clique ou arraste arquivos aqui</strong></div>
            <div class="small">Imagens JPG, PNG ou WEBP (convertidas para JPEG) · Vídeos MP4 ou MOV até 95 MB</div>
          </div>
          <input type="file" id="file" multiple hidden>
          <div class="media-grid" id="media"></div>
        </section>

        <section class="card card-pad" id="caption-section">
          <div class="section-title"><h2>Legenda</h2><span class="counter" id="counter"></span></div>
          <textarea id="caption" placeholder="Escreva a legenda… use #hashtags e @menções"></textarea>
          <label class="toggle hidden" id="share-wrap" style="margin-top:12px"><input type="checkbox" id="share"> Mostrar o Reels também no feed do perfil</label>
        </section>

        <section class="card card-pad">
          <div class="section-title"><h2>Quando publicar</h2><span class="hint">Fuso: ${esc(timezone)}</span></div>
          <div class="when-grid">
            <label class="field">Data <input class="input" type="date" id="date"></label>
            <label class="field">Hora <input class="input" type="time" id="time"></label>
          </div>
          <div class="row" style="margin-top:10px">
            <button type="button" class="btn btn-sm" data-quick="1h">Daqui 1 hora</button>
            <button type="button" class="btn btn-sm" data-quick="tomorrow9">Amanhã 9h</button>
            <button type="button" class="btn btn-sm" data-quick="tomorrow18">Amanhã 18h</button>
          </div>
          <p class="hint" style="margin:10px 0 0">O publicador roda pelo GitHub Actions a cada ~5 minutos, então o post pode sair alguns minutos depois do horário escolhido.</p>
        </section>

        <div id="messages" class="stack" style="gap:8px"></div>

        <div class="editor-actions">
          <a class="btn btn-ghost" href="#/">Voltar</a>
          <button class="btn" id="save-draft">Salvar rascunho</button>
          <button class="btn" id="publish-now">Publicar agora</button>
          <button class="btn btn-primary" id="schedule">Agendar</button>
        </div>
      </div>

      <aside class="preview-wrap">
        <div class="section-title"><h3>Pré-visualização</h3><span class="hint">aproximada</span></div>
        <div id="preview"></div>
      </aside>
    </div>`;

  const fileInput = $('#file');
  const captionEl = $('#caption');
  captionEl.value = st.caption;
  $('#share').checked = st.shareToFeed;
  $('#date').value = st.date;
  $('#time').value = st.time;
  $('#date').min = dateKey(new Date());

  $('#accounts').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-account]');
    if (!chip || chip.disabled) return;
    const id = chip.dataset.account;
    if (editing) st.accountIds = [id];
    else st.accountIds = st.accountIds.includes(id) ? st.accountIds.filter((x) => x !== id) : [...st.accountIds, id];
    update();
  });
  $('#types').addEventListener('click', (e) => {
    const seg = e.target.closest('[data-type]');
    if (!seg) return;
    st.type = seg.dataset.type;
    st.slide = 0;
    update();
  });
  captionEl.addEventListener('input', () => {
    st.caption = captionEl.value;
    update();
  });
  $('#share').addEventListener('change', (e) => {
    st.shareToFeed = e.target.checked;
    update();
  });
  $('#date').addEventListener('change', (e) => {
    st.date = e.target.value;
    update();
  });
  $('#time').addEventListener('change', (e) => {
    st.time = e.target.value;
    update();
  });
  $$('[data-quick]').forEach((b) =>
    b.addEventListener('click', () => {
      let d = new Date();
      if (b.dataset.quick === '1h') d = new Date(Date.now() + 3600e3);
      else {
        d.setDate(d.getDate() + 1);
        d.setHours(b.dataset.quick === 'tomorrow9' ? 9 : 18, 0, 0, 0);
      }
      st.date = dateKey(d);
      st.time = timeKey(d);
      $('#date').value = st.date;
      $('#time').value = st.time;
      update();
    }),
  );

  const drop = $('#drop');
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && fileInput.click());
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('drag');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drag');
    addFiles([...e.dataTransfer.files]);
  });
  fileInput.addEventListener('change', () => {
    addFiles([...fileInput.files]);
    fileInput.value = '';
  });

  const maxItems = () => (st.type === 'feed' ? LIMITS.carouselItems : 1);

  async function addFiles(files) {
    if (!files.length) return;
    if (maxItems() === 1) st.media = []; // formatos de mídia única: substitui
    const room = maxItems() - st.media.length;
    if (room <= 0) return toast(`Limite de ${maxItems()} mídias para este formato.`, 'error');
    const take = files.slice(0, room);
    if (take.length < files.length) toast(`Apenas ${take.length} arquivo(s) adicionado(s) — limite do formato.`, 'error');

    await Promise.all(
      take.map(async (file) => {
        const tile = { uploading: true, progress: 0, name: file.name, kind: file.type.startsWith('video') ? 'video' : 'image' };
        st.media.push(tile);
        update();
        try {
          const prepared = await prepareFile(file);
          tile.previewUrl = URL.createObjectURL(prepared.blob);
          Object.assign(tile, { width: prepared.width, height: prepared.height, kind: prepared.kind, size: prepared.blob.size });
          renderMedia();
          const base64 = await blobToBase64(prepared.blob);
          tile.sha = await gh.uploadBlob(base64, (p) => {
            tile.progress = p;
            renderMedia();
          });
          Object.assign(tile, { path: `data/media/${newId()}${prepared.ext}`, isNew: true, uploading: false });
        } catch (err) {
          st.media = st.media.filter((x) => x !== tile);
          toast(err.message, 'error');
        }
        update();
      }),
    );
  }

  $('#media').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-move]');
    if (!btn) return;
    const i = Number(btn.dataset.index);
    const op = btn.dataset.move;
    if (op === 'remove') st.media.splice(i, 1);
    if (op === 'left' && i > 0) [st.media[i - 1], st.media[i]] = [st.media[i], st.media[i - 1]];
    if (op === 'right' && i < st.media.length - 1) [st.media[i + 1], st.media[i]] = [st.media[i], st.media[i + 1]];
    st.slide = 0;
    update();
  });

  function renderMedia() {
    $('#media').innerHTML = st.media
      .map((m, i) => {
        if (m.uploading) {
          return `<div class="media-tile uploading">
            ${m.previewUrl && m.kind === 'image' ? `<img src="${esc(m.previewUrl)}" alt="" style="position:absolute;inset:0;opacity:.35">` : ''}
            <div style="text-align:center;width:100%;display:grid;place-items:center;position:relative">
              <span>Enviando…</span><div class="progress"><div style="width:${Math.round(m.progress * 100)}%"></div></div></div></div>`;
        }
        const bad = st.type === 'feed' && ratioOutOfFeedRange(m);
        return `<div class="media-tile">
          ${mediaEl(m)}
          ${st.media.length > 1 ? `<span class="pos">${i + 1}</span>` : ''}
          ${bad ? '<span class="warn" title="Proporção fora do permitido no feed">!</span>' : ''}
          <div class="tools">
            <span>${i > 0 ? `<button type="button" data-move="left" data-index="${i}" title="Mover para a esquerda">${ICONS.left}</button>` : ''}</span>
            <button type="button" data-move="remove" data-index="${i}" title="Remover">${ICONS.x}</button>
            <span>${i < st.media.length - 1 ? `<button type="button" data-move="right" data-index="${i}" title="Mover para a direita">${ICONS.right}</button>` : ''}</span>
          </div>
        </div>`;
      })
      .join('');
  }

  function renderPreview() {
    const acc = accountById(st.accountIds[0]) || accounts[0];
    const ready = st.media.filter((m) => !m.uploading);
    const current = ready[Math.min(st.slide, ready.length - 1)];
    const head = `<div class="phone-head">${avatar(acc, 'avatar-xs')} ${esc(acc.username)}</div>`;
    const media = current ? mediaEl(current, current.kind === 'video' ? 'autoplay loop' : '') : '<span>Sua mídia aparece aqui</span>';

    if (st.type === 'story' || st.type === 'reel') {
      $('#preview').innerHTML = `<div class="phone story">
        ${st.type === 'story' ? '<div class="bar"></div>' : ''}${head}
        <div class="phone-media">${media}</div>
        ${st.type === 'reel' && st.caption ? `<div class="phone-caption" style="position:absolute;bottom:0;left:0;right:0;color:#fff;background:linear-gradient(transparent,rgba(0,0,0,.6));max-height:40%"><b>${esc(acc.username)}</b>${esc(st.caption)}</div>` : ''}
      </div>`;
      return;
    }
    let ratio = 1;
    const first = ready[0];
    if (first?.width && first?.height) ratio = Math.min(LIMITS.feedMaxRatio, Math.max(LIMITS.feedMinRatio, first.width / first.height));
    if (first?.kind === 'video') ratio = 4 / 5;
    $('#preview').innerHTML = `<div class="phone">
      ${head}
      <div class="phone-media" style="aspect-ratio:${ratio}">
        ${media}
        ${ready.length > 1 ? `
          ${st.slide > 0 ? '<button class="nav" style="left:8px" data-slide="-1">‹</button>' : ''}
          ${st.slide < ready.length - 1 ? '<button class="nav" style="right:8px" data-slide="1">›</button>' : ''}
          <div class="dots">${ready.map((_, i) => `<i class="${i === st.slide ? 'on' : ''}"></i>`).join('')}</div>` : ''}
      </div>
      <div class="phone-caption">${st.caption ? `<b>${esc(acc.username)}</b>${esc(st.caption)}` : '<span style="color:#999">Legenda…</span>'}</div>
    </div>`;
  }
  $('#preview').addEventListener('click', (e) => {
    const b = e.target.closest('[data-slide]');
    if (b) {
      st.slide += Number(b.dataset.slide);
      renderPreview();
    }
  });

  function scheduledIso() {
    if (!st.date || !st.time) return null;
    const d = new Date(`${st.date}T${st.time}`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  function check() {
    const ready = st.media.filter((m) => !m.uploading);
    const errors = validatePost({ type: st.type, caption: st.caption, media: ready });
    if (!st.accountIds.length) errors.unshift('Selecione pelo menos uma conta.');
    const warnings = [];
    if (st.type === 'feed' && ready.length === 1 && ready[0].kind === 'video') warnings.push('Vídeos no feed são publicados como Reels.');
    if (st.type === 'story' && ready[0]?.width && Math.abs(ready[0].width / ready[0].height - 9 / 16) > 0.05) {
      warnings.push('Para stories, o ideal é uma mídia vertical 9:16 (ex.: 1080×1920).');
    }
    return { errors, warnings, uploading: st.media.some((m) => m.uploading) };
  }

  function update() {
    $$('[data-account]').forEach((c) => c.classList.toggle('selected', st.accountIds.includes(c.dataset.account)));
    $$('[data-type]').forEach((c) => c.classList.toggle('selected', c.dataset.type === st.type));
    fileInput.accept = st.type === 'reel' ? 'video/mp4,video/quicktime' : 'image/*,video/mp4,video/quicktime';
    $('#media-hint').textContent = st.type === 'feed' ? `${st.media.length}/${LIMITS.carouselItems} · use as setas para ordenar` : `${st.media.length}/1`;
    $('#caption-section').classList.toggle('hidden', st.type === 'story');
    $('#share-wrap').classList.toggle('hidden', st.type !== 'reel');

    const tags = countHashtags(st.caption);
    const counter = $('#counter');
    counter.textContent = `${st.caption.length}/${LIMITS.captionChars} caracteres · ${tags}/${LIMITS.hashtags} hashtags`;
    counter.classList.toggle('over', st.caption.length > LIMITS.captionChars || tags > LIMITS.hashtags);

    renderMedia();
    renderPreview();

    const { errors, warnings, uploading } = check();
    const at = scheduledIso();
    const schedErrors = [...errors];
    if (!at) schedErrors.push('Escolha data e hora.');
    else if (new Date(at) < Date.now()) schedErrors.push('O horário escolhido já passou.');

    const msgs = warnings.map((w) => `<div class="alert alert-info">${esc(w)}</div>`);
    if (st.media.length || st.accountIds.length) errors.forEach((e) => msgs.push(`<div class="alert alert-danger">${esc(e)}</div>`));
    $('#messages').innerHTML = msgs.join('');

    $('#schedule').disabled = uploading || schedErrors.length > 0;
    $('#publish-now').disabled = uploading || errors.length > 0;
    $('#save-draft').disabled = uploading || !st.accountIds.length || !st.media.length;
    $('#schedule').title = schedErrors.join('\n');
  }

  async function submit(mode) {
    const buttons = $$('.editor-actions .btn');
    buttons.forEach((b) => (b.disabled = true));
    const scheduledAt = mode === 'now' ? new Date().toISOString() : scheduledIso();
    try {
      await savePosts({
        editingId: editing?.id,
        accountIds: st.accountIds,
        type: st.type,
        caption: st.type === 'story' ? '' : st.caption.trim(),
        media: st.media.filter((m) => !m.uploading),
        shareToFeed: st.shareToFeed,
        status: mode === 'draft' ? 'draft' : 'scheduled',
        scheduledAt: mode === 'draft' ? scheduledIso() : scheduledAt,
      });
      const n = editing ? 1 : st.accountIds.length;
      toast(
        mode === 'draft' ? 'Rascunho salvo.'
        : mode === 'now' ? 'Publicação iniciada! O GitHub Actions começa em cerca de 1 minuto.'
        : `${n > 1 ? `${n} posts agendados` : 'Post agendado'} para ${fmtDateTime(scheduledAt)}.`,
      );
      location.hash = mode === 'draft' ? '#/?f=rascunhos' : '#/';
    } catch (err) {
      toast(err.message, 'error');
      update();
    }
  }
  $('#schedule').addEventListener('click', () => submit('schedule'));
  $('#publish-now').addEventListener('click', () => confirm('Publicar agora nas contas selecionadas?') && submit('now'));
  $('#save-draft').addEventListener('click', () => submit('draft'));

  update();
}

// ---------------------------------------------------------------- contas
async function connectAccount(igToken, onStatus) {
  const secretName = `IG_TOKEN_${newId().replace(/[^a-z0-9]/gi, '').toUpperCase()}`;
  onStatus('Salvando o token como secret do repositório (criptografado)…');
  await gh.setSecret(secretName, igToken);
  onStatus('Pedindo ao GitHub Actions para validar o token…');
  await gh.runWorkflow({ action: 'connect', secret: secretName });

  const started = Date.now();
  while (Date.now() - started < 4 * 60e3) {
    await sleep(5000);
    const secs = Math.round((Date.now() - started) / 1000);
    onStatus(`Validando no GitHub Actions… (${secs}s — costuma levar de 30s a 1min)`);
    const result = await gh.readJson(`data/connect/${secretName}.json`);
    if (!result) continue;
    if (!result.ok) {
      await gh.deleteSecret(secretName).catch(() => {});
      throw new Error(result.error || 'Token inválido.');
    }
    if (result.replacedSecret) await gh.deleteSecret(result.replacedSecret).catch(() => {});
    return result;
  }
  throw new Error('O GitHub Actions demorou demais para responder. Veja a aba Actions do repositório e tente de novo.');
}

async function removeAccount(acc) {
  await gh.commit(`Postly: conta @${acc.username} removida`, async (read) => {
    const accounts = (await read('data/accounts.json')) || [];
    const posts = store.posts.filter((p) => p.accountId === acc.id && p.status !== 'processing');
    const media = orphanMedia(posts.flatMap((p) => (p.media || []).map((m) => m.path)), posts.map((p) => p.id));
    return [
      { path: 'data/accounts.json', json: accounts.filter((a) => a.id !== acc.id) },
      ...posts.map((p) => ({ path: postFile(p.id), delete: true })),
      ...media.map((m) => ({ path: m, delete: true })),
    ];
  });
  if (acc.secretName) await gh.deleteSecret(acc.secretName);
}

async function renderAccounts(view) {
  const accounts = store.accounts;
  const expiry = (a) => {
    if (!a.tokenExpiresAt) return 'Desconhecida';
    const days = Math.round((new Date(a.tokenExpiresAt) - Date.now()) / 864e5);
    return `${a.expiryEstimated ? '~' : ''}${fmtDateTime(a.tokenExpiresAt)} (${days} dias)`;
  };

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Contas</h1><p class="muted">Contas do Instagram conectadas ao Postly.</p></div>
      <button class="btn btn-primary" id="toggle-connect">Conectar conta do Instagram</button>
    </div>

    <form class="card card-pad stack ${accounts.length ? 'hidden' : ''}" id="connect" style="margin-bottom:16px">
      <h2>Conectar conta do Instagram</h2>
      <ol class="muted small" style="margin:0;padding-left:18px;display:grid;gap:4px">
        <li>No <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener">painel de desenvolvedores da Meta</a>, abra seu app e vá em <em>Instagram › Configuração da API com login do Instagram</em>.</li>
        <li>Em <em>Gerar tokens de acesso</em>, adicione a conta (ela precisa ser Comercial ou Criador de conteúdo) e clique em <em>Gerar token</em>.</li>
        <li>Cole o token abaixo. Ele vai direto para os <strong>secrets do repositório</strong>, criptografado — não fica salvo em nenhum arquivo.</li>
      </ol>
      <label class="field">Token de acesso do Instagram <input class="input" name="token" autocomplete="off" required placeholder="IGAA…"></label>
      <div class="alert alert-info hidden" id="connect-status"></div>
      <div class="row" style="justify-content:flex-end"><button class="btn btn-primary" type="submit">Conectar</button></div>
    </form>

    ${accounts.length ? `<div class="accounts">${accounts.map((a) => {
      const days = a.tokenExpiresAt ? (new Date(a.tokenExpiresAt) - Date.now()) / 864e5 : 99;
      return `
      <div class="card account-card" data-id="${esc(a.id)}">
        <div class="row">
          ${avatar(a, 'avatar-lg')}
          <div class="grow" style="min-width:0">
            <h2>@${esc(a.username)}</h2>
            <div class="muted small">${esc(a.name || '')}${a.accountType ? ` · ${esc(a.accountType === 'MEDIA_CREATOR' ? 'Criador de conteúdo' : a.accountType === 'BUSINESS' ? 'Comercial' : a.accountType)}` : ''}</div>
          </div>
          <span class="badge ${a.status === 'active' ? 'badge-published' : 'badge-failed'}">${a.status === 'active' ? 'Ativa' : 'Reconectar'}</span>
        </div>
        ${a.status !== 'active' ? `<div class="alert alert-danger small">${esc(a.statusMessage || 'O acesso expirou. Gere um novo token e atualize a conta.')}</div>` : ''}
        ${a.status === 'active' && days < 10 ? '<div class="alert alert-warn small">O token está perto de expirar. Gere um novo e clique em "Atualizar token", ou ative a renovação automática abaixo.</div>' : ''}
        <dl class="kv">
          <dt>Token expira</dt><dd>${expiry(a)}</dd>
          <dt>Conectada em</dt><dd>${fmtDateTime(a.createdAt)}</dd>
        </dl>
        <div class="row">
          <a class="btn btn-sm" href="#/?conta=${esc(a.id)}">Ver posts</a>
          <button class="btn btn-sm" data-act="update">Atualizar token</button>
          <div class="grow"></div>
          <button class="btn btn-sm btn-danger" data-act="remove">Remover</button>
        </div>
      </div>`;
    }).join('')}</div>` : ''}

    <h2 style="margin:28px 0 12px">Configuração</h2>
    <div class="card card-pad stack" id="setup"><span class="muted small">Verificando…</span></div>

    <h2 style="margin:28px 0 12px">WhatsApp</h2>
    <div class="card card-pad row">
      <div class="grow"><strong>Número do WhatsApp Business</strong>
        <div class="muted small">A integração com a API do WhatsApp Business é a próxima etapa do Postly.</div></div>
      <span class="badge badge-draft">Em breve</span>
    </div>`;

  const form = $('#connect');
  $('#toggle-connect').addEventListener('click', () => {
    form.classList.toggle('hidden');
    form.querySelector('input').focus();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const status = $('#connect-status');
    btn.disabled = true;
    status.classList.remove('hidden');
    try {
      const res = await connectAccount(form.token.value.trim(), (msg) => (status.textContent = msg));
      toast(`Conta @${res.username} conectada!`);
      route();
    } catch (err) {
      status.classList.add('hidden');
      toast(`Não foi possível conectar: ${err.message}`, 'error');
      btn.disabled = false;
    }
  });

  $$('.account-card').forEach((card) =>
    card.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const acc = accounts.find((a) => a.id === card.dataset.id);
      if (btn.dataset.act === 'update') {
        form.classList.remove('hidden');
        form.scrollIntoView({ behavior: 'smooth' });
        form.querySelector('input').focus();
        toast(`Cole o novo token de @${acc.username} no formulário.`);
        return;
      }
      if (btn.dataset.act === 'remove') {
        if (!confirm(`Remover @${acc.username}? Os posts desta conta também serão apagados do Postly.`)) return;
        btn.disabled = true;
        try {
          await removeAccount(acc);
          toast('Conta removida.');
          route();
        } catch (err) {
          toast(err.message, 'error');
          btn.disabled = false;
        }
      }
    }),
  );

  renderSetup();
}

async function renderSetup() {
  const el = $('#setup');
  const [pages, runs, secretNames] = await Promise.all([
    gh.pagesInfo(),
    gh.latestRuns(1).catch(() => undefined),
    gh.listSecretNames().catch(() => null),
  ]);
  if (!el.isConnected) return;
  const autoRefresh = secretNames?.includes('POSTLY_GH_TOKEN');
  const item = (ok, title, detail) => `
    <div class="row" style="align-items:flex-start;gap:12px">
      <span class="badge ${ok ? 'badge-published' : 'badge-failed'}" style="margin-top:2px">${ok ? 'OK' : 'Atenção'}</span>
      <div class="grow"><strong>${title}</strong><div class="muted small">${detail}</div></div>
    </div>`;
  el.innerHTML = [
    item(Boolean(pages), 'GitHub Pages', pages ? `O site e as mídias estão em <a href="${esc(pages.html_url)}" target="_blank" rel="noopener">${esc(pages.html_url)}</a>. O Instagram baixa as mídias de lá.` : 'Ative em Settings › Pages do repositório (Deploy from a branch).'),
    item(runs !== null && runs !== undefined, 'GitHub Actions (publicador)', runs === null ? 'Workflow publish.yml não encontrado.' : runs === undefined ? 'O token precisa da permissão Actions (leitura e escrita).' : 'Roda a cada ~5 minutos e quando você publica algo.'),
    item(
      autoRefresh,
      'Renovação automática dos tokens do Instagram',
      autoRefresh
        ? 'Ativada. O publicador renova os tokens toda semana (eles duram 60 dias).'
        : `Desativada: os tokens do Instagram expiram em 60 dias. Para o publicador renová-los sozinho, ele precisa de um token do GitHub com permissão de escrever secrets.
           <div style="margin-top:8px"><button class="btn btn-sm" id="enable-refresh">Ativar usando meu token do GitHub</button></div>`,
    ),
  ].join('');
  $('#enable-refresh')?.addEventListener('click', async (e) => {
    if (!confirm('Seu token do GitHub será salvo como secret POSTLY_GH_TOKEN (criptografado) para o publicador renovar os tokens do Instagram. Continuar?')) return;
    e.target.disabled = true;
    try {
      await gh.setSecret('POSTLY_GH_TOKEN', session.token);
      toast('Renovação automática ativada.');
      renderSetup();
    } catch (err) {
      toast(err.message, 'error');
      e.target.disabled = false;
    }
  });
}

// ---------------------------------------------------------------- login
function renderLogin(message) {
  const detected = detectRepo();
  const saved = readStorage('postly.session') || {};
  document.body.innerHTML = `
    <main class="login-page">
      <form class="card login-card stack" id="login" style="width:min(460px,100%)">
        <div class="brand" style="padding:0"><div class="brand-mark">P</div> Postly</div>
        <div>
          <h1 style="font-size:20px">Entrar</h1>
          <p class="muted small" style="margin:4px 0 0">O Postly guarda os posts neste repositório do GitHub. Para entrar, use um token pessoal do GitHub com acesso ao repositório.</p>
        </div>
        <div class="row" style="gap:10px">
          <label class="field grow">Dono <input class="input" name="owner" required value="${esc(saved.owner || detected?.owner || '')}"></label>
          <label class="field grow">Repositório <input class="input" name="repo" required value="${esc(saved.repo || detected?.repo || '')}"></label>
        </div>
        <label class="field">Token do GitHub <input class="input" type="password" name="token" required autocomplete="off" placeholder="github_pat_…"></label>
        <details class="small">
          <summary style="cursor:pointer;font-weight:600">Como criar o token</summary>
          <ol class="muted" style="padding-left:18px;margin:8px 0 0;display:grid;gap:4px">
            <li>Abra <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings/personal-access-tokens/new</a> (token <em>fine-grained</em>).</li>
            <li>Em <em>Repository access</em>, escolha <em>Only select repositories</em> e selecione este repositório.</li>
            <li>Em <em>Permissions › Repository permissions</em>, dê <strong>Read and write</strong> para: <strong>Contents</strong>, <strong>Actions</strong> e <strong>Secrets</strong>.</li>
            <li>Gere o token e cole aqui. Ele fica salvo só neste navegador.</li>
          </ol>
        </details>
        <label class="toggle small"><input type="checkbox" name="remember" checked> Lembrar neste navegador</label>
        <div class="alert alert-danger ${message ? '' : 'hidden'}" id="err">${esc(message || '')}</div>
        <button class="btn btn-primary" type="submit">Entrar</button>
      </form>
    </main>
    <div class="toasts" id="toasts"></div>`;

  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type=submit]');
    const err = $('#err');
    btn.disabled = true;
    err.classList.add('hidden');
    const candidate = { owner: f.owner.value.trim(), repo: f.repo.value.trim(), token: f.token.value.trim() };
    try {
      const client = createGitHub({ ...candidate, apiBase: dev.apiBase });
      await client.verify();
      writeStorage('postly.session', candidate, f.remember.checked);
      location.reload();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
      btn.disabled = false;
    }
  });
}

function logout(message) {
  writeStorage('postly.session', null);
  session = null;
  renderLogin(message);
}

// ---------------------------------------------------------------- inicialização
async function boot() {
  if (!session?.token) return renderLogin();
  gh = createGitHub({ ...session, apiBase: dev.apiBase });
  try {
    await gh.verify();
  } catch (err) {
    if (err.status === 401 || err.status === 403 || err.status === 404) return logout(err.message);
    $('#view').innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
    return;
  }
  $('#repo-name').textContent = `${gh.owner}/${gh.repo}`;
  $('#logout').addEventListener('click', () => confirm('Sair deste navegador?') && logout());
  window.addEventListener('hashchange', route);
  route();
}

boot();
