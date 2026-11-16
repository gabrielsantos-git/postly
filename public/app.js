// Postly — front-end (SPA sem build, roteamento por hash).

// ---------------------------------------------------------------- utilidades
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $('#view');

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeKey = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const fmtDateTime = (iso) =>
  new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function dayLabel(d) {
  const today = new Date();
  const tomorrow = new Date(Date.now() + 864e5);
  const yesterday = new Date(Date.now() - 864e5);
  if (dateKey(d) === dateKey(today)) return 'Hoje';
  if (dateKey(d) === dateKey(tomorrow)) return 'Amanhã';
  if (dateKey(d) === dateKey(yesterday)) return 'Ontem';
  return d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
}

const STATUS = {
  draft: 'Rascunho',
  scheduled: 'Agendado',
  processing: 'Publicando…',
  published: 'Publicado',
  failed: 'Falhou',
  canceled: 'Cancelado',
};
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
  setTimeout(() => el.remove(), type === 'error' ? 7000 : 3500);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login.html';
    throw new Error('Sessão expirada');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const fd = new FormData();
    fd.append('files', file);
    xhr.open('POST', '/api/media');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* vazio */ }
      if (xhr.status === 401) location.href = '/login.html';
      if (xhr.status >= 200 && xhr.status < 300) resolve(data[0]);
      else reject(new Error(data.error || `Falha no upload (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Falha de conexão no upload'));
    xhr.send(fd);
  });
}

function avatar(account, size = '') {
  if (!account) return `<div class="avatar ${size}">?</div>`;
  if (account.profile_picture_url) {
    return `<img class="avatar ${size}" src="${esc(account.profile_picture_url)}" alt="" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'avatar ${size}',textContent:'${esc(account.username[0]?.toUpperCase() ?? '?')}'}))">`;
  }
  return `<div class="avatar ${size}">${esc(account.username[0]?.toUpperCase() ?? '?')}</div>`;
}

function mediaEl(m, attrs = '') {
  if (!m) return '';
  return m.kind === 'video'
    ? `<video src="${esc(m.url)}#t=0.5" muted playsinline preload="metadata" ${attrs}></video>`
    : `<img src="${esc(m.url)}" alt="" loading="lazy" ${attrs}>`;
}

// ---------------------------------------------------------------- estado global
const store = { config: null, accounts: [] };
let cleanup = null; // função chamada ao sair de uma tela

async function loadAccounts() {
  store.accounts = await api('/accounts');
  return store.accounts;
}

// ---------------------------------------------------------------- roteador
function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { parts: path.split('/').filter(Boolean), query: new URLSearchParams(qs || '') };
}

async function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  closeModal();
  const { parts, query } = parseHash();
  const name = parts[0] || 'painel';
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (name === 'editar' ? 'novo' : name)));
  view.innerHTML = '<p class="muted">Carregando…</p>';
  try {
    if (name === 'painel') await renderDashboard(query);
    else if (name === 'calendario') await renderCalendar(query);
    else if (name === 'novo') await renderEditor(null, query);
    else if (name === 'editar') await renderEditor(Number(parts[1]), query);
    else if (name === 'contas') await renderAccounts(query);
    else view.innerHTML = '<div class="empty"><h3>Página não encontrada</h3></div>';
  } catch (err) {
    view.innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
  }
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- ações de post
async function postAction(action, post) {
  try {
    if (action === 'publish') {
      await api(`/posts/${post.id}/publish-now`, { method: 'POST' });
      toast('Publicação iniciada. Acompanhe o status no painel.');
    } else if (action === 'cancel') {
      if (!confirm('Cancelar este agendamento?')) return false;
      await api(`/posts/${post.id}/cancel`, { method: 'POST' });
      toast('Agendamento cancelado.');
    } else if (action === 'delete') {
      if (!confirm(post.status === 'published' ? 'Remover do Postly? (O post continua no Instagram.)' : 'Excluir este post?')) return false;
      await api(`/posts/${post.id}`, { method: 'DELETE' });
      toast('Post excluído.');
    } else if (action === 'edit') {
      location.hash = `#/editar/${post.id}`;
      return false;
    }
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

function postActionsHtml(p) {
  const b = (action, label, cls = '') => `<button class="btn btn-sm ${cls}" data-action="${action}" data-id="${p.id}">${label}</button>`;
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

function bindPostActions(root, posts, onDone) {
  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (btn) {
      e.stopPropagation();
      const post = posts().find((p) => p.id === Number(btn.dataset.id));
      if (post && (await postAction(btn.dataset.action, post))) onDone();
      return;
    }
    const item = e.target.closest('[data-post]');
    if (item && !e.target.closest('a')) openPostModal(Number(item.dataset.post), onDone);
  });
}

// ---------------------------------------------------------------- painel
const FILTERS = {
  proximos: { label: 'Próximos', status: 'scheduled,processing' },
  falhas: { label: 'Falhas', status: 'failed' },
  publicados: { label: 'Publicados', status: 'published', desc: true },
  rascunhos: { label: 'Rascunhos', status: 'draft,canceled' },
  todos: { label: 'Todos', status: '' },
};

async function renderDashboard(query) {
  const filter = FILTERS[query.get('f')] ? query.get('f') : 'proximos';
  const accountId = query.get('conta') || '';
  const [stats, accounts] = await Promise.all([api('/stats'), loadAccounts()]);

  if (!accounts.length) {
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
    <div class="stats">
      ${[['scheduled', 'Agendados'], ['processing', 'Publicando agora'], ['published', 'Publicados'], ['failed', 'Com falha']]
        .map(([k, l]) => `<div class="card stat"><div class="stat-value">${stats[k] || 0}</div><div class="stat-label">${l}</div></div>`)
        .join('')}
    </div>
    <div class="row" style="margin-bottom:6px">
      <div class="tabs">${Object.entries(FILTERS)
        .map(([k, f]) => `<button class="tab ${k === filter ? 'active' : ''}" data-filter="${k}">${f.label}</button>`)
        .join('')}</div>
      <div class="grow"></div>
      <select id="account-filter" style="width:auto">
        <option value="">Todas as contas</option>
        ${accounts.map((a) => `<option value="${a.id}" ${String(a.id) === accountId ? 'selected' : ''}>@${esc(a.username)}</option>`).join('')}
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

  let posts = [];
  const list = $('#list');
  const load = async () => {
    const q = new URLSearchParams();
    if (FILTERS[filter].status) q.set('status', FILTERS[filter].status);
    if (accountId) q.set('accountId', accountId);
    posts = await api(`/posts?${q}`);
    if (FILTERS[filter].desc) posts.reverse();
    renderList();
  };

  function renderList() {
    if (!posts.length) {
      list.innerHTML = `<div class="card empty"><h3>Nada por aqui</h3><p>${
        filter === 'proximos' ? 'Nenhuma publicação agendada.' : 'Nenhum post neste filtro.'
      }</p>${filter === 'proximos' ? '<a class="btn btn-primary" href="#/novo">Agendar um post</a>' : ''}</div>`;
      return;
    }
    let lastDay = '';
    list.innerHTML = posts
      .map((p) => {
        const when = p.published_at || p.scheduled_at;
        const day = when ? dayLabel(new Date(when)) : 'Sem data';
        const header = day !== lastDay ? `<div class="day-label">${esc(day)}</div>` : '';
        lastDay = day;
        return `${header}
          <div class="card post-item" data-post="${p.id}" style="cursor:pointer">
            <div class="thumb">${mediaEl(p.media[0])}${p.media.length > 1 ? `<span class="count">1/${p.media.length}</span>` : ''}</div>
            <div class="post-body">
              <div class="row" style="gap:8px">
                ${avatar(p.account, 'avatar-xs')}
                <strong>@${esc(p.account?.username ?? 'conta removida')}</strong>
                <span class="badge badge-type">${ICONS[p.type]} ${TYPES[p.type]}${p.type === 'feed' && p.media.length > 1 ? ' · carrossel' : ''}</span>
                <span class="badge badge-${p.status}">${STATUS[p.status]}</span>
                ${when ? `<span class="muted small">${p.published_at ? 'publicado às' : ''} ${fmtTime(when)}</span>` : ''}
              </div>
              <div class="post-caption">${esc(p.caption) || (p.type === 'story' ? '<i>Story (sem legenda)</i>' : '<i>Sem legenda</i>')}</div>
              ${p.status === 'failed' && p.last_error ? `<div class="post-error">${esc(p.last_error)}</div>` : ''}
            </div>
            <div class="post-actions">${postActionsHtml(p)}</div>
          </div>`;
      })
      .join('');
  }

  bindPostActions(list, () => posts, async () => {
    await load();
    const s = await api('/stats');
    $$('.stat-value').forEach((el, i) => (el.textContent = s[['scheduled', 'processing', 'published', 'failed'][i]] || 0));
  });
  await load();

  // Atualiza sozinho enquanto houver posts em andamento.
  const timer = setInterval(() => {
    if (posts.some((p) => p.status === 'processing' || (p.status === 'scheduled' && new Date(p.scheduled_at) < Date.now() + 60e3))) {
      load().catch(() => {});
    }
  }, 10_000);
  cleanup = () => clearInterval(timer);
}

// ---------------------------------------------------------------- calendário
async function renderCalendar(query) {
  const base = query.get('mes') ? new Date(`${query.get('mes')}-01T00:00:00`) : new Date();
  const first = new Date(base.getFullYear(), base.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay()); // começa no domingo
  const end = new Date(start);
  end.setDate(start.getDate() + 42);

  const [posts] = await Promise.all([
    api(`/posts?from=${start.toISOString()}&to=${end.toISOString()}`),
    loadAccounts(),
  ]);
  const byDay = new Map();
  for (const p of posts) {
    const when = p.published_at || p.scheduled_at;
    if (!when) continue;
    const k = dateKey(new Date(when));
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
    const items = (byDay.get(k) || []).sort((a, b) => (a.published_at || a.scheduled_at).localeCompare(b.published_at || b.scheduled_at));
    days.push(`
      <div class="cal-day ${d.getMonth() !== first.getMonth() ? 'other' : ''} ${k === dateKey(new Date()) ? 'today' : ''}" data-day="${k}">
        <span class="cal-num">${d.getDate()}</span>
        ${items.slice(0, 4).map((p) => `
          <button class="cal-ev s-${p.status}" data-post="${p.id}" title="@${esc(p.account?.username)} · ${TYPES[p.type]} · ${STATUS[p.status]}">
            ${ICONS[p.type]}<span class="ev-text">${fmtTime(p.published_at || p.scheduled_at)} @${esc(p.account?.username ?? '')}</span>
          </button>`).join('')}
        ${items.length > 4 ? `<span class="muted small">+${items.length - 4} mais</span>` : ''}
      </div>`);
  }

  view.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(title)}</h1><p class="muted">Clique em um dia para agendar.</p></div>
      <div class="row">
        <a class="btn btn-sm" href="#/calendario?mes=${monthKey(prev)}">${ICONS.left}</a>
        <a class="btn btn-sm" href="#/calendario">Hoje</a>
        <a class="btn btn-sm" href="#/calendario?mes=${monthKey(next)}">${ICONS.right}</a>
      </div>
    </div>
    <div class="card cal">
      <div class="cal-head">${['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((d) => `<div>${d}</div>`).join('')}</div>
      <div class="cal-grid">${days.join('')}</div>
    </div>`;

  $('.cal-grid').addEventListener('click', (e) => {
    const ev = e.target.closest('[data-post]');
    if (ev) return openPostModal(Number(ev.dataset.post), () => route());
    const day = e.target.closest('[data-day]');
    if (day) location.hash = `#/novo?data=${day.dataset.day}`;
  });
}

// ---------------------------------------------------------------- modal de detalhes
function closeModal() {
  $('.modal-backdrop')?.remove();
}

async function openPostModal(id, onChange) {
  const p = await api(`/posts/${id}`);
  closeModal();
  const el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.innerHTML = `
    <div class="card modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div class="row">${avatar(p.account)}<div><strong>@${esc(p.account?.username ?? 'conta removida')}</strong>
          <div class="row" style="gap:6px"><span class="badge badge-type">${TYPES[p.type]}</span><span class="badge badge-${p.status}">${STATUS[p.status]}</span></div></div></div>
        <button class="btn btn-ghost icon-btn" data-close aria-label="Fechar">${ICONS.x}</button>
      </div>
      <div class="modal-body stack">
        <div class="modal-media">${p.media.map((m) => mediaEl(m, m.kind === 'video' ? 'controls' : '')).join('')}</div>
        ${p.caption ? `<div style="white-space:pre-wrap">${esc(p.caption)}</div>` : ''}
        <dl class="kv">
          ${p.scheduled_at ? `<dt>Agendado para</dt><dd>${fmtDateTime(p.scheduled_at)}</dd>` : ''}
          ${p.published_at ? `<dt>Publicado em</dt><dd>${fmtDateTime(p.published_at)}</dd>` : ''}
          ${p.type === 'reel' ? `<dt>Aparece no feed</dt><dd>${p.share_to_feed ? 'Sim' : 'Não'}</dd>` : ''}
          ${p.attempts ? `<dt>Tentativas</dt><dd>${p.attempts}</dd>` : ''}
          ${p.permalink ? `<dt>Link</dt><dd><a href="${esc(p.permalink)}" target="_blank" rel="noopener">${esc(p.permalink)}</a></dd>` : ''}
        </dl>
        ${p.last_error && p.status === 'failed' ? `<div class="alert alert-danger">${esc(p.last_error)}</div>` : ''}
        <div><h3 style="margin-bottom:8px">Histórico</h3>
          <ul class="timeline">${p.events.map((e) => `<li><time>${fmtDateTime(e.created_at)}</time><span class="${e.level === 'error' ? 'err' : ''}">${esc(e.message)}</span></li>`).join('')}</ul>
        </div>
        <div class="row" style="justify-content:flex-end">${postActionsHtml(p)}</div>
      </div>
    </div>`;
  document.body.append(el);
  el.addEventListener('click', async (e) => {
    if (e.target === el || e.target.closest('[data-close]')) return closeModal();
    const btn = e.target.closest('[data-action]');
    if (btn && (await postAction(btn.dataset.action, p))) {
      closeModal();
      onChange?.();
    }
  });
  const onKey = (e) => { if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
}

// ---------------------------------------------------------------- editor
const TYPE_INFO = {
  feed: { title: 'Feed', hint: '1 foto, ou carrossel com até 10 fotos/vídeos' },
  reel: { title: 'Reels', hint: '1 vídeo vertical (9:16), 3s a 15min' },
  story: { title: 'Story', hint: '1 foto ou vídeo (até 60s), sem legenda' },
};

function validate(st, limits) {
  const errors = [];
  const warnings = [];
  const ready = st.media.filter((m) => m.id);
  if (!st.accountIds.length) errors.push('Selecione pelo menos uma conta.');
  if (!ready.length) errors.push('Adicione uma mídia.');
  if (st.media.some((m) => !m.id)) errors.push('Aguarde o envio das mídias terminar.');
  if (st.type === 'feed' && ready.length > limits.carouselItems) errors.push(`O carrossel aceita até ${limits.carouselItems} itens.`);
  if (st.type === 'reel' && (ready.length !== 1 || ready[0]?.kind !== 'video')) errors.push('Reels precisam de exatamente 1 vídeo.');
  if (st.type === 'story' && ready.length > 1) errors.push('Story aceita apenas 1 mídia.');
  if (st.type === 'feed') {
    for (const m of ready) {
      if (m.kind === 'image' && m.width && m.height) {
        const r = m.width / m.height;
        if (r < limits.feedMinRatio - 0.01 || r > limits.feedMaxRatio + 0.01) {
          errors.push(`"${m.original_name}" (${m.width}×${m.height}) está fora da proporção do feed (4:5 até 1.91:1).`);
        }
      }
    }
    if (ready.length === 1 && ready[0].kind === 'video') warnings.push('Vídeos no feed são publicados como Reels.');
  }
  if (st.type !== 'story') {
    if (st.caption.length > limits.captionChars) errors.push(`Legenda acima de ${limits.captionChars} caracteres.`);
    if (countHashtags(st.caption) > limits.hashtags) errors.push(`Máximo de ${limits.hashtags} hashtags.`);
  }
  if ((st.type === 'story' || st.type === 'reel') && ready[0]?.kind === 'image' && ready[0].width && ready[0].height) {
    if (Math.abs(ready[0].width / ready[0].height - 9 / 16) > 0.05 && st.type === 'story') {
      warnings.push('Para stories, o ideal é uma imagem vertical 9:16 (ex.: 1080×1920).');
    }
  }
  return { errors, warnings };
}

const countHashtags = (s) => (s.match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).length;

async function renderEditor(editId, query) {
  if (!store.config) store.config = await api('/config');
  const accounts = await loadAccounts();
  const limits = store.config.limits;

  if (!accounts.length) {
    view.innerHTML = `<div class="card empty"><h3>Nenhuma conta conectada</h3><p>Conecte uma conta do Instagram antes de agendar.</p>
      <a class="btn btn-primary" href="#/contas">Conectar conta</a></div>`;
    return;
  }

  const defaultDate = new Date(Date.now() + 60 * 60e3);
  defaultDate.setMinutes(0, 0, 0);
  const st = {
    accountIds: accounts.filter((a) => a.status === 'active').length === 1 ? [accounts.find((a) => a.status === 'active').id] : [],
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
    editing = await api(`/posts/${editId}`);
    Object.assign(st, {
      accountIds: [editing.account_id],
      type: editing.type,
      media: editing.media,
      caption: editing.caption,
      shareToFeed: editing.share_to_feed,
    });
    if (editing.scheduled_at && new Date(editing.scheduled_at) > Date.now()) {
      const d = new Date(editing.scheduled_at);
      st.date = dateKey(d);
      st.time = timeKey(d);
    }
  }

  view.innerHTML = `
    <div class="page-head">
      <div><h1>${editing ? 'Editar post' : 'Novo post'}</h1>
      <p class="muted">${editing ? `Editando post de @${esc(editing.account?.username)}` : 'Escolha as contas, o formato, a mídia e quando publicar.'}</p></div>
    </div>
    <div class="editor">
      <div class="stack">
        <section class="card card-pad">
          <div class="section-title"><h2>Contas</h2><span class="hint">${editing ? 'Um post por conta' : 'Selecione uma ou mais — será criado um post para cada'}</span></div>
          <div class="chips" id="accounts">
            ${accounts.map((a) => `
              <button type="button" class="chip ${a.status !== 'active' ? 'disabled' : ''}" data-account="${a.id}" ${a.status !== 'active' ? 'disabled title="Reconecte esta conta"' : ''}>
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
          <div class="dropzone" id="drop">
            ${ICONS.upload}
            <div><strong>Clique ou arraste arquivos aqui</strong></div>
            <div class="small">Imagens JPG, PNG ou WEBP (convertidas para JPEG) · Vídeos MP4 ou MOV</div>
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

  // ----- interações
  $('#accounts').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-account]');
    if (!chip || chip.disabled) return;
    const id = Number(chip.dataset.account);
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
  captionEl.addEventListener('input', () => { st.caption = captionEl.value; update(); });
  $('#share').addEventListener('change', (e) => { st.shareToFeed = e.target.checked; update(); });
  $('#date').addEventListener('change', (e) => { st.date = e.target.value; update(); });
  $('#time').addEventListener('change', (e) => { st.time = e.target.value; update(); });
  $$('[data-quick]').forEach((b) => b.addEventListener('click', () => {
    let d = new Date();
    if (b.dataset.quick === '1h') d = new Date(Date.now() + 3600e3);
    else { d.setDate(d.getDate() + 1); d.setHours(b.dataset.quick === 'tomorrow9' ? 9 : 18, 0, 0, 0); }
    st.date = dateKey(d); st.time = timeKey(d);
    $('#date').value = st.date; $('#time').value = st.time;
    update();
  }));

  const drop = $('#drop');
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); addFiles([...e.dataTransfer.files]); });
  fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });

  function maxItems() {
    return st.type === 'feed' ? limits.carouselItems : 1;
  }

  async function addFiles(files) {
    const room = maxItems() - st.media.length;
    if (room <= 0) {
      if (maxItems() === 1 && files.length) {
        st.media = []; // substitui a mídia única
      } else {
        return toast(`Limite de ${maxItems()} mídia(s) para este formato.`, 'error');
      }
    }
    const take = files.slice(0, Math.max(1, maxItems() - st.media.length));
    if (take.length < files.length) toast(`Apenas ${take.length} arquivo(s) adicionado(s) — limite do formato.`, 'error');
    await Promise.all(take.map(async (file) => {
      const tile = { uploading: true, progress: 0, original_name: file.name, kind: file.type.startsWith('video') ? 'video' : 'image' };
      st.media.push(tile);
      update();
      try {
        const m = await uploadFile(file, (p) => { tile.progress = p; renderMedia(); });
        Object.assign(tile, m, { uploading: false });
      } catch (err) {
        st.media = st.media.filter((x) => x !== tile);
        toast(err.message, 'error');
      }
      update();
    }));
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

  // ----- renderização
  function renderMedia() {
    $('#media').innerHTML = st.media.map((m, i) => {
      if (m.uploading) {
        return `<div class="media-tile uploading"><div style="text-align:center;width:100%;display:grid;place-items:center">
          <span>Enviando…</span><div class="progress"><div style="width:${Math.round(m.progress * 100)}%"></div></div></div></div>`;
      }
      const ratio = m.width && m.height ? m.width / m.height : null;
      const bad = st.type === 'feed' && m.kind === 'image' && ratio && (ratio < limits.feedMinRatio - 0.01 || ratio > limits.feedMaxRatio + 0.01);
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
    }).join('');
  }

  function renderPreview() {
    const acc = accounts.find((a) => a.id === st.accountIds[0]) || accounts[0];
    const ready = st.media.filter((m) => m.id);
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
    if (first?.width && first?.height) ratio = Math.min(limits.feedMaxRatio, Math.max(limits.feedMinRatio, first.width / first.height));
    if (first?.kind === 'video') ratio = 4 / 5;
    $('#preview').innerHTML = `<div class="phone">
      ${head}
      <div class="phone-media" style="aspect-ratio:${ratio}">
        ${media}
        ${ready.length > 1 ? `
          ${st.slide > 0 ? `<button class="nav" style="left:8px" data-slide="-1">‹</button>` : ''}
          ${st.slide < ready.length - 1 ? `<button class="nav" style="right:8px" data-slide="1">›</button>` : ''}
          <div class="dots">${ready.map((_, i) => `<i class="${i === st.slide ? 'on' : ''}"></i>`).join('')}</div>` : ''}
      </div>
      <div class="phone-caption">${st.caption ? `<b>${esc(acc.username)}</b>${esc(st.caption)}` : '<span style="color:#999">Legenda…</span>'}</div>
    </div>`;
  }
  $('#preview').addEventListener('click', (e) => {
    const b = e.target.closest('[data-slide]');
    if (b) { st.slide += Number(b.dataset.slide); renderPreview(); }
  });

  function scheduledIso() {
    if (!st.date || !st.time) return null;
    const d = new Date(`${st.date}T${st.time}`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  function update() {
    $$('[data-account]').forEach((c) => c.classList.toggle('selected', st.accountIds.includes(Number(c.dataset.account))));
    $$('[data-type]').forEach((c) => c.classList.toggle('selected', c.dataset.type === st.type));
    fileInput.accept = st.type === 'reel' ? 'video/mp4,video/quicktime' : 'image/*,video/mp4,video/quicktime';
    $('#media-hint').textContent = st.type === 'feed' ? `${st.media.length}/${limits.carouselItems} · use as setas para ordenar` : `${st.media.length}/1`;
    $('#caption-section').classList.toggle('hidden', st.type === 'story');
    $('#share-wrap').classList.toggle('hidden', st.type !== 'reel');

    const tags = countHashtags(st.caption);
    const over = st.caption.length > limits.captionChars || tags > limits.hashtags;
    const counter = $('#counter');
    counter.textContent = `${st.caption.length}/${limits.captionChars} caracteres · ${tags}/${limits.hashtags} hashtags`;
    counter.classList.toggle('over', over);

    renderMedia();
    renderPreview();

    const { errors, warnings } = validate(st, limits);
    const when = scheduledIso();
    const schedErrors = [...errors];
    if (!when) schedErrors.push('Escolha data e hora.');
    else if (new Date(when) < Date.now()) schedErrors.push('O horário escolhido já passou.');

    const msgs = [];
    if (store.config.publicUrlIsLocal) {
      msgs.push(`<div class="alert alert-warn">A URL pública do site é <code>${esc(store.config.publicBaseUrl)}</code>. O Instagram não consegue baixar mídias de um endereço local — configure <code>PUBLIC_BASE_URL</code> com um domínio público ou túnel (ex.: ngrok, cloudflared).</div>`);
    }
    warnings.forEach((w) => msgs.push(`<div class="alert alert-info">${esc(w)}</div>`));
    const showErrors = st.media.length || st.accountIds.length ? errors.filter((e) => !e.startsWith('Aguarde')) : [];
    showErrors.forEach((e) => msgs.push(`<div class="alert alert-danger">${esc(e)}</div>`));
    $('#messages').innerHTML = msgs.join('');

    $('#schedule').disabled = schedErrors.length > 0;
    $('#publish-now').disabled = errors.length > 0;
    $('#save-draft').disabled = !st.accountIds.length || st.media.some((m) => m.uploading) || !st.media.length;
    $('#schedule').title = schedErrors.join('\n');
  }

  async function submit(mode) {
    const body = {
      accountIds: st.accountIds,
      type: st.type,
      caption: st.type === 'story' ? '' : st.caption,
      mediaIds: st.media.filter((m) => m.id).map((m) => m.id),
      shareToFeed: st.shareToFeed,
      status: mode === 'draft' ? 'draft' : 'scheduled',
      scheduledAt: mode === 'now' ? new Date().toISOString() : scheduledIso(),
    };
    const buttons = $$('.editor-actions .btn');
    buttons.forEach((b) => (b.disabled = true));
    try {
      if (editing) await api(`/posts/${editing.id}`, { method: 'PUT', body });
      else await api('/posts', { method: 'POST', body });
      const n = editing ? 1 : st.accountIds.length;
      toast(
        mode === 'draft' ? 'Rascunho salvo.'
          : mode === 'now' ? 'Publicação iniciada! Acompanhe no painel.'
          : `${n > 1 ? `${n} posts agendados` : 'Post agendado'} para ${fmtDateTime(body.scheduledAt)}.`,
      );
      location.hash = mode === 'draft' ? '#/?f=rascunhos' : '#/';
    } catch (err) {
      toast(err.message, 'error');
      update();
    }
  }
  $('#schedule').addEventListener('click', () => submit('schedule'));
  $('#publish-now').addEventListener('click', () => {
    if (confirm('Publicar agora nas contas selecionadas?')) submit('now');
  });
  $('#save-draft').addEventListener('click', () => submit('draft'));

  update();
}

// ---------------------------------------------------------------- contas
async function renderAccounts(query) {
  store.config = await api('/config');
  const accounts = await loadAccounts();
  const cfg = store.config;

  if (query.get('conectada')) toast(`Conta @${query.get('conectada')} conectada!`);
  if (query.get('erro')) toast(`Não foi possível conectar: ${query.get('erro')}`, 'error');
  if (query.toString()) history.replaceState(null, '', '#/contas');

  const expiry = (a) => {
    if (!a.token_expires_at) return 'Desconhecida';
    const days = Math.round((new Date(a.token_expires_at) - Date.now()) / 864e5);
    return `${fmtDateTime(a.token_expires_at)} (${days} dias) · renovação automática`;
  };

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Contas</h1><p class="muted">Contas do Instagram conectadas ao Postly.</p></div>
      <div class="row">
        <button class="btn" id="toggle-manual">Adicionar com token</button>
        ${cfg.oauthConfigured ? '<a class="btn btn-primary" href="/auth/instagram/start">Conectar conta do Instagram</a>' : ''}
      </div>
    </div>

    ${cfg.oauthConfigured ? '' : `
      <div class="alert alert-info" style="margin-bottom:16px">
        <strong>Login com Instagram ainda não configurado.</strong> Crie um app no painel de desenvolvedores da Meta com o produto
        <em>Instagram</em> (API com login do Instagram), defina <code>INSTAGRAM_APP_ID</code> e <code>INSTAGRAM_APP_SECRET</code> no <code>.env</code>
        e cadastre a URL de redirecionamento <code>${esc(cfg.redirectUri)}</code>. Enquanto isso, você pode adicionar contas colando um token de acesso.
      </div>`}
    ${cfg.publicUrlIsLocal ? `
      <div class="alert alert-warn" style="margin-bottom:16px">
        <strong>Atenção:</strong> <code>PUBLIC_BASE_URL</code> está como <code>${esc(cfg.publicBaseUrl)}</code>. Para publicar, o Instagram precisa baixar as mídias de uma URL pública (HTTPS).
      </div>` : ''}

    <form class="card card-pad stack hidden" id="manual" style="margin-bottom:16px">
      <h2>Adicionar conta com token de acesso</h2>
      <p class="muted small" style="margin:0">No painel do seu app na Meta, em <em>Instagram › Configuração da API com login do Instagram</em>, gere um token para a conta e cole aqui. Ele fica criptografado no banco.</p>
      <label class="field">Token de acesso <input class="input" name="token" autocomplete="off" required placeholder="IGAA…"></label>
      <div class="row" style="justify-content:flex-end"><button class="btn btn-primary" type="submit">Adicionar conta</button></div>
    </form>

    ${accounts.length ? `<div class="accounts">${accounts.map((a) => `
      <div class="card account-card" data-id="${a.id}">
        <div class="row">
          ${avatar(a, 'avatar-lg')}
          <div class="grow" style="min-width:0">
            <h2>@${esc(a.username)}</h2>
            <div class="muted small">${esc(a.name || '')}${a.account_type ? ` · ${esc(a.account_type === 'MEDIA_CREATOR' ? 'Criador de conteúdo' : a.account_type === 'BUSINESS' ? 'Comercial' : a.account_type)}` : ''}</div>
          </div>
          <span class="badge ${a.status === 'active' ? 'badge-published' : 'badge-failed'}">${a.status === 'active' ? 'Ativa' : 'Reconectar'}</span>
        </div>
        ${a.status !== 'active' ? `<div class="alert alert-danger small">${esc(a.status_message || 'O acesso expirou. Reconecte a conta.')}</div>` : ''}
        <dl class="kv">
          <dt>Token expira</dt><dd>${expiry(a)}</dd>
          <dt>Conectada em</dt><dd>${fmtDateTime(a.created_at)}</dd>
        </dl>
        <div class="quota-box small muted">Limite diário: <button class="btn btn-sm btn-ghost" data-act="limit" style="padding:0 4px;color:var(--primary)">consultar</button></div>
        <div class="row">
          <a class="btn btn-sm" href="#/?conta=${a.id}">Ver posts</a>
          <button class="btn btn-sm" data-act="refresh">Renovar token</button>
          ${a.status !== 'active' && cfg.oauthConfigured ? '<a class="btn btn-sm btn-primary" href="/auth/instagram/start">Reconectar</a>' : ''}
          <div class="grow"></div>
          <button class="btn btn-sm btn-danger" data-act="remove">Remover</button>
        </div>
      </div>`).join('')}</div>` : `
      <div class="card empty"><h3>Nenhuma conta conectada</h3>
        <p>A conta precisa ser profissional (Comercial ou Criador de conteúdo).</p></div>`}

    <h2 style="margin:28px 0 12px">WhatsApp</h2>
    <div class="card card-pad row">
      <div class="grow"><strong>Número do WhatsApp Business</strong>
        <div class="muted small">A integração com a API do WhatsApp Business é a próxima etapa do Postly.</div></div>
      <span class="badge badge-draft">Em breve</span>
    </div>`;

  $('#toggle-manual').addEventListener('click', () => {
    $('#manual').classList.toggle('hidden');
    $('#manual input').focus();
  });
  $('#manual').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const acc = await api('/accounts/manual', { method: 'POST', body: { accessToken: e.target.token.value.trim() } });
      toast(`Conta @${acc.username} conectada!`);
      route();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });

  $$('.account-card').forEach((card) => card.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = card.dataset.id;
    const acc = accounts.find((a) => String(a.id) === id);
    btn.disabled = true;
    try {
      if (btn.dataset.act === 'remove') {
        if (!confirm(`Remover @${acc.username}? Os posts agendados desta conta também serão apagados.`)) return;
        await api(`/accounts/${id}`, { method: 'DELETE' });
        toast('Conta removida.');
        return route();
      }
      if (btn.dataset.act === 'refresh') {
        await api(`/accounts/${id}/refresh`, { method: 'POST' });
        toast('Token renovado.');
        return route();
      }
      if (btn.dataset.act === 'limit') {
        const l = await api(`/accounts/${id}/limit`);
        const total = l.config?.quota_total ?? 100;
        const used = l.quota_usage ?? 0;
        card.querySelector('.quota-box').innerHTML = `
          <div class="row" style="justify-content:space-between"><span>Publicações nas últimas 24h</span><strong style="color:var(--text)">${used} / ${total}</strong></div>
          <div class="quota" style="margin-top:6px"><div style="width:${Math.min(100, (used / total) * 100)}%"></div></div>`;
      }
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }));
}

// ---------------------------------------------------------------- inicialização
$('#logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
});
window.addEventListener('hashchange', route);
route();
