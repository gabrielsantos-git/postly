// Cliente mínimo da API do Instagram (Instagram API com Login do Instagram).
// Referência: https://developers.facebook.com/documentation/instagram-platform

export class GraphApiError extends Error {
  constructor(message, { status, code, subcode, type, userMessage } = {}) {
    super(message);
    this.name = 'GraphApiError';
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.type = type;
    this.userMessage = userMessage;
  }

  // Token expirado, revogado ou sem permissão.
  get isAuthError() {
    return this.code === 190 || this.code === 102 || (this.type === 'OAuthException' && this.code === 10);
  }

  // Vale tentar de novo (instabilidade, limite de taxa, falha de rede).
  get isTransient() {
    if (this.status === undefined) return true;
    if (this.status >= 500) return true;
    return [1, 2, 4, 17, 32, 341, 613].includes(this.code) || this.subcode === 2207001;
  }

  describe() {
    const parts = [this.userMessage || this.message];
    if (this.code) parts.push(`(código ${this.code}${this.subcode ? `/${this.subcode}` : ''})`);
    return parts.join(' ');
  }
}

export function createInstagramClient({ apiVersion = 'v24.0', host = 'https://graph.instagram.com' } = {}) {
  const graph = (path) => `${host}/${apiVersion}/${path}`;

  async function request(url, { method = 'GET', params = {} } = {}) {
    const u = new URL(url);
    const init = { method, headers: {} };
    const clean = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
    if (method === 'GET') {
      for (const [k, v] of clean) u.searchParams.set(k, v);
    } else {
      init.body = new URLSearchParams(clean.map(([k, v]) => [k, String(v)]));
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
    if (!res.ok || json.error) {
      const e = json.error || {};
      throw new GraphApiError(e.message || `HTTP ${res.status}`, {
        status: res.status,
        code: e.code,
        subcode: e.error_subcode,
        type: e.type,
        userMessage: e.error_user_msg || e.error_user_title,
      });
    }
    return json;
  }

  return {
    getMe: (token) =>
      request(graph('me'), {
        params: { fields: 'id,user_id,username,name,profile_picture_url,account_type', access_token: token },
      }),

    // Renova um token de longa duração (precisa ter mais de 24h). Retorna { access_token, expires_in }.
    refreshToken: (token) =>
      request(`${host}/refresh_access_token`, { params: { grant_type: 'ig_refresh_token', access_token: token } }),

    async getPublishingLimit(igUserId, token) {
      const json = await request(graph(`${igUserId}/content_publishing_limit`), {
        params: { fields: 'quota_usage,config', access_token: token },
      });
      return Array.isArray(json.data) ? json.data[0] : json;
    },

    createContainer: (igUserId, token, params) =>
      request(graph(`${igUserId}/media`), { method: 'POST', params: { ...params, access_token: token } }),

    // status_code: EXPIRED | ERROR | FINISHED | IN_PROGRESS | PUBLISHED
    getContainerStatus: (containerId, token) =>
      request(graph(containerId), { params: { fields: 'status_code,status', access_token: token } }),

    publishContainer: (igUserId, token, containerId) =>
      request(graph(`${igUserId}/media_publish`), {
        method: 'POST',
        params: { creation_id: containerId, access_token: token },
      }),

    getMedia: (mediaId, token) =>
      request(graph(mediaId), { params: { fields: 'id,permalink,media_type,timestamp', access_token: token } }),
  };
}
