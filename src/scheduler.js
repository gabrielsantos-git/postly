import { config } from './config.js';
import { getDb, nowIso } from './db.js';
import { advancePost } from './instagram/publisher.js';
import { refreshStaleTokens } from './accounts.js';
import { cleanupOrphanMedia } from './media.js';

const MAINTENANCE_EVERY_MS = 6 * 3600 * 1000;

let timer = null;
let running = false;
let lastMaintenance = 0;

// Um "tick": avança todos os posts cujo próximo passo já venceu.
// Posts de contas diferentes rodam em paralelo; posts da mesma conta, em sequência.
export async function tick(logger = console) {
  if (running) return;
  running = true;
  try {
    const due = getDb()
      .prepare(
        `SELECT id, account_id FROM posts
         WHERE status IN ('scheduled', 'processing') AND next_run_at <= ?
         ORDER BY next_run_at LIMIT 50`,
      )
      .all(nowIso());

    const byAccount = new Map();
    for (const p of due) {
      if (!byAccount.has(p.account_id)) byAccount.set(p.account_id, []);
      byAccount.get(p.account_id).push(p.id);
    }
    await Promise.all(
      [...byAccount.values()].map(async (ids) => {
        for (const id of ids) await advancePost(id);
      }),
    );

    if (Date.now() - lastMaintenance > MAINTENANCE_EVERY_MS) {
      lastMaintenance = Date.now();
      await refreshStaleTokens(logger);
      const removed = cleanupOrphanMedia();
      if (removed) logger.info?.(`[mídia] ${removed} arquivo(s) não usados removidos`);
    }
  } catch (err) {
    logger.error?.('[agendador] erro:', err);
  } finally {
    running = false;
  }
}

export function startScheduler(logger = console) {
  if (timer || !config.schedulerEnabled) return;
  // Posts que estavam "processing" quando o servidor caiu continuam de onde pararam.
  timer = setInterval(() => tick(logger), config.schedulerIntervalMs);
  timer.unref?.();
  setTimeout(() => tick(logger), 1000).unref?.();
  logger.info?.(`[agendador] ativo (verifica a cada ${config.schedulerIntervalMs / 1000}s)`);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
