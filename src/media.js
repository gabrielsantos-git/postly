import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config } from './config.js';
import { getDb } from './db.js';
import { randomId } from './crypto.js';

export const IMAGE_MAX_BYTES = 30 * 1024 * 1024; // entrada; a saída JPEG fica bem menor (limite do IG: 8 MB)
export const VIDEO_MAX_BYTES = 1024 * 1024 * 1024; // 1 GB (limite do IG para reels/stories)
const IMAGE_MAX_WIDTH = 1440;

const VIDEO_TYPES = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
};

export function mediaUrl(filename) {
  return `${config.publicBaseUrl}/media/${filename}`;
}

export function serializeMedia(row) {
  return row && { ...row, url: mediaUrl(row.filename) };
}

export function getMediaByIds(ids) {
  if (!ids.length) return [];
  const rows = getDb()
    .prepare(`SELECT * FROM media WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

// Recebe um arquivo enviado (salvo temporariamente pelo multer) e o prepara para o Instagram:
// imagens são convertidas para JPEG (único formato aceito pela API); vídeos são guardados como estão.
export async function ingestUpload(file) {
  const db = getDb();
  try {
    if (file.mimetype.startsWith('image/')) {
      if (file.size > IMAGE_MAX_BYTES) throw new UserError('Imagem muito grande (máx. 30 MB).');
      const filename = `${randomId()}.jpg`;
      const dest = path.join(config.uploadsDir, filename);
      let info;
      try {
        info = await sharp(file.path)
          .rotate() // respeita a orientação EXIF
          .resize({ width: IMAGE_MAX_WIDTH, withoutEnlargement: true })
          .flatten({ background: '#ffffff' }) // remove transparência (JPEG não tem alpha)
          .jpeg({ quality: 90, mozjpeg: true })
          .toFile(dest);
      } catch {
        throw new UserError(`Não foi possível ler a imagem "${file.originalname}". Use JPG, PNG ou WEBP.`);
      }
      const r = db
        .prepare(
          `INSERT INTO media (filename, original_name, mime_type, kind, size_bytes, width, height)
           VALUES (?, ?, 'image/jpeg', 'image', ?, ?, ?)`,
        )
        .run(filename, file.originalname, info.size, info.width, info.height);
      return serializeMedia(db.prepare('SELECT * FROM media WHERE id = ?').get(r.lastInsertRowid));
    }

    const ext = VIDEO_TYPES[file.mimetype];
    if (ext) {
      if (file.size > VIDEO_MAX_BYTES) throw new UserError('Vídeo muito grande (máx. 1 GB).');
      const filename = `${randomId()}${ext}`;
      fs.renameSync(file.path, path.join(config.uploadsDir, filename));
      const r = db
        .prepare(
          `INSERT INTO media (filename, original_name, mime_type, kind, size_bytes)
           VALUES (?, ?, ?, 'video', ?)`,
        )
        .run(filename, file.originalname, file.mimetype, file.size);
      return serializeMedia(db.prepare('SELECT * FROM media WHERE id = ?').get(r.lastInsertRowid));
    }

    throw new UserError(`Formato não suportado: ${file.mimetype}. Use imagens (JPG/PNG/WEBP) ou vídeos MP4/MOV.`);
  } finally {
    fs.rm(file.path, { force: true }, () => {});
  }
}

// Apaga mídias enviadas mas nunca usadas em um post (após 24h).
export function cleanupOrphanMedia() {
  const db = getDb();
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT id, filename FROM media
       WHERE created_at < ? AND id NOT IN (SELECT media_id FROM post_media)`,
    )
    .all(cutoff);
  for (const row of rows) {
    fs.rm(path.join(config.uploadsDir, row.filename), { force: true }, () => {});
    db.prepare('DELETE FROM media WHERE id = ?').run(row.id);
  }
  return rows.length;
}

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UserError';
    this.status = status;
  }
}
