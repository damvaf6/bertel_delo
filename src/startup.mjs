// Шаги при старте контейнера в облаке. База закрыта от интернета, поэтому схема обновляется изнутри облака —
// самим контейнером при запуске (MIGRATE_ON_START=1), а не через сеть. Две копии одновременно не мигрируют
// (блокировка в migrate.mjs). STARTUP_CHECK=1 — пробная запись, чтение и удаление файла в хранилище; итог — в журнал.
import crypto from 'node:crypto';
import { migrate } from './migrate.mjs';

export async function startupSteps({ cfg, sql, providers, log = console.log }) {
  if (cfg.startup.migrate) {
    const applied = await migrate(sql, { log });
    log(applied.length ? `схема: применено миграций ${applied.length}` : 'схема: актуальна');
  }
  if (cfg.startup.check) {
    await sql`select 1`;
    const key = `_check/${crypto.randomUUID()}.txt`;
    const body = Buffer.from(`проверка хранилища ${new Date().toISOString()}`);
    await providers.storage.put(key, body, 'text/plain; charset=utf-8');
    const back = await providers.storage.get(key);
    await providers.storage.delete(key);
    if (!back || !back.equals(body)) throw new Error('проверка хранилища: прочитано не то, что записано');
    log(`проверка при старте: база — ок, файлы (${providers.storage.kind}) — ок`);
  }
}
