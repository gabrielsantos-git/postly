// Cliente mínimo da API do Instagram (Instagram API com Login do Instagram).
// Referência: https://developers.facebook.com/documentation/instagram-platform
import { config, redirectUri } from '../config.js';

export class GraphApiError extends Error {
  constructor(message, { status, code, subcode, type, userMessage, traceId } = {}) {
    super(message);
    this.name = 'GraphApiError';
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.type = type;
    this.userMessage = userMessage;
    this.traceId = traceId;
  }

  // Token expirado, revogado ou sem permissão.
  get isAuthError() {
    return this.code === 190 || this.code === 102 || (this.type === 'OAuthException' && this.code === 10);
  }

  // Erros que valem uma nova tentativa (instabilidade, limite de taxa, timeout).
  get isTransient() {
    if (this.status === undefined) return true; // falha de rede
    if (this.status >= 500) return true;
    return [1, 2, 4, 17, 32, 341, 613].includes(this.code) || this.subcode === 2207001;
  }

  describe() {
    const parts = [this.userMessage || this.message];
    if (this.code) parts.push(`(código ${this.code}${this.subcode ? `/${this.subcode}` : ''})`);
    return parts.join(' ');
  }
}

async function request(url, { method = 'GET', params = {} } = {}) {
  const u = new URL(url);
  const init = { method, headers: {} };

  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  } else {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.set(k, String(v));
    init.body = body;
    init.headers['content-type'] = 'application/x-www-form-urlencoded';
  }

  let res;
  try {
    res = await globalThis.fetch(u, init);
  } catch (err) {
    throw new GraphApiError(`Falha de rede ao chamar a API do Instagram: ${err.message}`);
  }

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok || json.error || json.error_type) {
    const e = json.error || {};
    throw new GraphApiError(e.message || json.error_message || `HTTP ${res.status}`, {
      status: res.status,
      code: e.code ?? json.code,
      subcode: e.error_subcode,
      type: e.type || json.error_type,
      userMessage: e.error_user_msg || e.error_user_title,
      traceId: e.fbtrace_id,
    });
  }
  return json;
}

const graph = (path) => `${config.instagram.graphHost}/${config.instagram.apiVersion}/${path}`;

// ---------------- OAuth ----------------

export function buildAuthorizeUrl(state) {
  const u = new URL(config.instagram.authorizeUrl);
  u.searchParams.set('enable_fb_login', '0');
  u.searchParams.set('force_authentication', '1');
  u.searchParams.set('client_id', config.instagram.appId);
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', config.instagram.scopes);
  u.searchParams.set('state', state);
  return u.toString();
}

// Troca o "code" do OAuth por um token de curta duração (~1h).
export async function exchangeCodeForToken(code) {
  const json = await request(`${config.instagram.oauthHost}/oauth/access_token`, {
    method: 'POST',
    params: {
      client_id: config.instagram.appId,
      client_secret: config.instagram.appSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(),
      code: String(code).replace(/#_$/, ''),
    },
  });
  // A resposta pode vir como { data: [ {...} ] } ou diretamente como objeto.
  const payload = Array.isArray(json.data) ? json.data[0] : json;
  if (!payload?.access_token) throw new GraphApiError('Resposta do OAuth sem access_token');
  return payload; // { access_token, user_id, permissions }
}

// Token de curta duração -> token de longa duração (60 dias).
export async function exchangeForLongLivedToken(shortToken) {
  return request(`${config.instagram.graphHost}/access_token`, {
    params: {
      grant_type: 'ig_exchange_token',
      client_secret: config.instagram.appSecret,
      access_token: shortToken,
    },
  }); // { access_token, token_type, expires_in }
}

// Renova um token de longa duração (precisa ter pelo menos 24h e ainda ser válido).
export async function refreshLongLivedToken(token) {
  return request(`${config.instagram.graphHost}/refresh_access_token`, {
    params: { grant_type: 'ig_refresh_token', access_token: token },
  }); // { access_token, token_type, expires_in }
}

// ---------------- Perfil ----------------

export async function getMe(token) {
  return request(graph('me'), {
    params: {
      fields: 'id,user_id,username,name,profile_picture_url,account_type',
      access_token: token,
    },
  });
}

export async function getPublishingLimit(igUserId, token) {
  const json = await request(graph(`${igUserId}/content_publishing_limit`), {
    params: { fields: 'quota_usage,config', access_token: token },
  });
  return Array.isArray(json.data) ? json.data[0] : json;
}

// ---------------- Publicação ----------------

// Cria um container de mídia. Retorna { id }.
export async function createContainer(igUserId, token, params) {
  return request(graph(`${igUserId}/media`), {
    method: 'POST',
    params: { ...params, access_token: token },
  });
}

// Status de processamento: EXPIRED | ERROR | FINISHED | IN_PROGRESS | PUBLISHED
export async function getContainerStatus(containerId, token) {
  return request(graph(containerId), {
    params: { fields: 'status_code,status', access_token: token },
  });
}

export async function publishContainer(igUserId, token, containerId) {
  return request(graph(`${igUserId}/media_publish`), {
    method: 'POST',
    params: { creation_id: containerId, access_token: token },
  });
}

export async function getMedia(mediaId, token) {
  return request(graph(mediaId), {
    params: { fields: 'id,permalink,media_type,timestamp', access_token: token },
  });
}
