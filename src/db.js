import fs from 'node:fs';
import Database from 'better-sqlite3';
import { config } from './config.js';

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ig_user_id          TEXT NOT NULL UNIQUE,
  username            TEXT NOT NULL,
  name                TEXT,
  profile_picture_url TEXT,
  account_type        TEXT,
  access_token_enc    TEXT NOT NULL,
  token_expires_at    TEXT,
  token_refreshed_at  TEXT,
  status              TEXT NOT NULL DEFAULT 'active', -- active | needs_reauth
  status_message      TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS media (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  filename      TEXT NOT NULL UNIQUE,
  original_name TEXT,
  mime_type     TEXT NOT NULL,
  kind          TEXT NOT NULL,       -- image | video
  size_bytes    INTEGER NOT NULL,
  width         INTEGER,
  height        INTEGER,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS posts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type           TEXT NOT NULL,      -- feed | reel | story
  caption        TEXT NOT NULL DEFAULT '',
  share_to_feed  INTEGER NOT NULL DEFAULT 1,
  scheduled_at   TEXT,               -- ISO 8601 (UTC)
  status         TEXT NOT NULL,      -- draft | scheduled | processing | published | failed | canceled
  next_run_at    TEXT,               -- quando o agendador deve olhar este post de novo
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  children_ids   TEXT,               -- JSON: ids dos containers filhos (carrossel)
  container_id   TEXT,               -- container principal
  processing_started_at TEXT,
  ig_media_id    TEXT,
  permalink      TEXT,
  published_at   TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_posts_due ON posts(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_posts_scheduled ON posts(scheduled_at);

CREATE TABLE IF NOT EXISTS post_media (
  post_id  INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (post_id, position)
);

CREATE TABLE IF NOT EXISTS post_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  level      TEXT NOT NULL,          -- info | error
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

export function getDb() {
  if (!db) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.mkdirSync(config.uploadsDir, { recursive: true });
    db = new Database(config.dbFile);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
  }
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}

export const nowIso = () => new Date().toISOString();
