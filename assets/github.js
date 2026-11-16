// Acesso ao repositório pelo navegador, usando a API do GitHub com o token pessoal do usuário.
// Os dados do Postly ficam no próprio repositório:
//   data/accounts.json        contas conectadas (sem tokens)
//   data/posts/<id>.json      um arquivo por post
//   data/media/<arquivo>      fotos e vídeos (servidos pelo GitHub Pages para o Instagram baixar)
// Os tokens do Instagram ficam nos secrets do repositório (IG_TOKEN_...), nunca nos arquivos.

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const b64encodeUtf8 = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const b64decodeUtf8 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

export function createGitHub({ owner, repo, token, apiBase = 'https://api.github.com' }) {
  let branch = null;
  const base = `/repos/${owner}/${repo}`;
  const headers = () => ({
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  });

  async function request(method, path, body) {
    let res;
    try {
      res = await fetch(apiBase + path, {
        method,
        headers: { ...headers(), ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
    } catch {
      throw new GitHubError('Sem conexão com o GitHub.', 0);
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        res.status === 401 ? 'Token do GitHub inválido ou expirado.'
        : res.status === 403 || res.status === 404 ? `Sem permissão no repositório (${data.message || res.status}). Confira as permissões do token.`
        : data.message || `Erro ${res.status} no GitHub`;
      throw new GitHubError(msg, res.status);
    }
    return data;
  }

  async function graphql(query, variables) {
    const res = await fetch(`${apiBase}/graphql`, {
      method: 'POST',
      headers: { ...headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.errors) throw new GitHubError(data.errors?.[0]?.message || data.message || `Erro ${res.status}`, res.status);
    return data.data;
  }

  async function getBranch() {
    if (!branch) branch = (await request('GET', base)).default_branch;
    return branch;
  }

  return {
    owner,
    repo,
    get branch() {
      return branch;
    },

    // Confere o token e as permissões. Retorna informações do repositório.
    async verify() {
      const info = await request('GET', base);
      branch = info.default_branch;
      if (!info.permissions?.push) throw new GitHubError('O token não tem permissão de escrita neste repositório.', 403);
      return info;
    },

    // Lê contas e posts em uma única chamada.
    async loadData() {
      const b = await getBranch();
      const data = await graphql(
        `query($owner: String!, $name: String!, $accounts: String!, $posts: String!) {
          repository(owner: $owner, name: $name) {
            accounts: object(expression: $accounts) { ... on Blob { text } }
            posts: object(expression: $posts) { ... on Tree { entries { name object { ... on Blob { text } } } } }
          }
        }`,
        { owner, name: repo, accounts: `${b}:data/accounts.json`, posts: `${b}:data/posts` },
      );
      const parse = (t, fb) => {
        try {
          return JSON.parse(t);
        } catch {
          return fb;
        }
      };
      const accounts = parse(data.repository?.accounts?.text, []);
      const posts = (data.repository?.posts?.entries || [])
        .filter((e) => e.name.endsWith('.json'))
        .map((e) => parse(e.object?.text, null))
        .filter(Boolean);
      return { accounts, posts };
    },

    async readJson(path, ref) {
      try {
        const file = await request('GET', `${base}/contents/${path}?ref=${encodeURIComponent(ref || (await getBranch()))}`);
        return JSON.parse(b64decodeUtf8(file.content));
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
    },

    // Envia um arquivo binário (base64) como blob do git, com progresso. Retorna o sha.
    uploadBlob(base64, onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${apiBase}${base}/git/blobs`);
        for (const [k, v] of Object.entries(headers())) xhr.setRequestHeader(k, v);
        xhr.setRequestHeader('content-type', 'application/json');
        xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
        xhr.onload = () => {
          let data = {};
          try {
            data = JSON.parse(xhr.responseText);
          } catch {
            /* vazio */
          }
          if (xhr.status >= 200 && xhr.status < 300) resolve(data.sha);
          else reject(new GitHubError(data.message || `Falha no envio (${xhr.status})`, xhr.status));
        };
        xhr.onerror = () => reject(new GitHubError('Falha de conexão no envio do arquivo.', 0));
        xhr.send(JSON.stringify({ content: base64, encoding: 'base64' }));
      });
    },

    // Faz um commit com várias alterações. `build` recebe uma função para ler JSON na versão atual
    // do repositório e devolve [{ path, json } | { path, sha } | { path, delete: true }].
    // Se outra pessoa (ou o publicador) commitar no meio, tenta de novo com os dados atualizados.
    async commit(message, build) {
      const b = await getBranch();
      for (let attempt = 0; attempt < 4; attempt++) {
        const ref = await request('GET', `${base}/git/ref/heads/${b}`);
        const headSha = ref.object.sha;
        const head = await request('GET', `${base}/git/commits/${headSha}`);
        const changes = await build((path) => this.readJson(path, headSha));
        if (!changes.length) return null;

        const tree = [];
        for (const c of changes) {
          if (c.delete) tree.push({ path: c.path, mode: '100644', type: 'blob', sha: null });
          else if (c.sha) tree.push({ path: c.path, mode: '100644', type: 'blob', sha: c.sha });
          else {
            const blob = await request('POST', `${base}/git/blobs`, {
              content: b64encodeUtf8(`${JSON.stringify(c.json, null, 2)}\n`),
              encoding: 'base64',
            });
            tree.push({ path: c.path, mode: '100644', type: 'blob', sha: blob.sha });
          }
        }
        const newTree = await request('POST', `${base}/git/trees`, { base_tree: head.tree.sha, tree });
        const commit = await request('POST', `${base}/git/commits`, { message, tree: newTree.sha, parents: [headSha] });
        try {
          await request('PATCH', `${base}/git/refs/heads/${b}`, { sha: commit.sha, force: false });
          return commit.sha;
        } catch (err) {
          if (err.status !== 422 && err.status !== 409) throw err; // 422 = alguém commitou antes; tenta de novo
        }
      }
      throw new GitHubError('O repositório mudou várias vezes seguidas. Tente de novo.', 409);
    },

    // Salva um secret do repositório (criptografado no navegador com a chave pública do repositório).
    async setSecret(name, value) {
      const key = await request('GET', `${base}/actions/secrets/public-key`);
      const { default: sodium } = await import('./vendor/libsodium-wrappers.mjs');
      await sodium.ready;
      const sealed = sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL));
      await request('PUT', `${base}/actions/secrets/${name}`, {
        encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL),
        key_id: key.key_id,
      });
    },

    async deleteSecret(name) {
      try {
        await request('DELETE', `${base}/actions/secrets/${name}`);
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    },

    async listSecretNames() {
      const res = await request('GET', `${base}/actions/secrets?per_page=100`);
      return res.secrets.map((s) => s.name);
    },

    // Dispara o workflow do publicador.
    async runWorkflow(inputs = {}) {
      await request('POST', `${base}/actions/workflows/publish.yml/dispatches`, { ref: await getBranch(), inputs });
    },

    async latestRuns(n = 5) {
      try {
        const res = await request('GET', `${base}/actions/workflows/publish.yml/runs?per_page=${n}`);
        return res.workflow_runs;
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
    },

    async pagesInfo() {
      try {
        return await request('GET', `${base}/pages`);
      } catch {
        return null;
      }
    },
  };
}
