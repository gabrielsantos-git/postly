import crypto from 'node:crypto';
import { config } from './config.js';

function deriveKey(purpose) {
  return crypto.createHmac('sha256', config.appSecret).update(`postly:${purpose}`).digest();
}

// --- Criptografia dos tokens de acesso (AES-256-GCM) ---

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey('token-encryption'), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
}

export function decrypt(payload) {
  const [version, iv, tag, data] = String(payload).split('.');
  if (version !== 'v1') throw new Error('Formato de token criptografado desconhecido');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveKey('token-encryption'),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

// --- Valores assinados (cookie de sessão, parâmetro "state" do OAuth) ---

export function sign(obj) {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const mac = crypto.createHmac('sha256', deriveKey('signing')).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', deriveKey('signing')).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (obj.exp && Date.now() > obj.exp) return null;
    return obj;
  } catch {
    return null;
  }
}

export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}
