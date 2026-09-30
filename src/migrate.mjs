// Миграции схемы: файлы migrations/NNN_имя.sql применяются по порядку, каждый — в своей транзакции.
// Применённый файл менять нельзя (сверяется контрольная сумма) — только новая миграция.
// Запуск отдельной командой (npm run migrate), не из интернета (исправление Б-6).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const LOCK_ID = 7_300_001; // номер блокировки: две копии не мигрируют одновременно

export function readMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const body = fs.readFileSync(path.join(dir, file), 'utf8');
      return { version: file.slice(0, 3), file, body, checksum: crypto.createHash('sha256').update(body).digest('hex') };
    });
}

export async function migrate(sql, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const list = readMigrations(dir);
  await sql`create table if not exists schema_migrations (
    version text primary key, file text not null, checksum text not null, applied_at timestamptz not null default now())`;
  const applied = [];
  for (const m of list) {
    // Блокировка на транзакцию: работает и через пулер соединений Яндекса (режим транзакций).
    const done = await sql.tx(async (tx, client) => {
      await tx`select pg_advisory_xact_lock(${LOCK_ID})`;
      const row = await tx.one`select checksum from schema_migrations where version = ${m.version}`;
      if (row) {
        if (row.checksum !== m.checksum) throw new Error(`Миграция ${m.file} изменена после применения — нужна новая миграция`);
        return false;
      }
      await client.query(m.body);
      await tx`insert into schema_migrations (version, file, checksum) values (${m.version}, ${m.file}, ${m.checksum})`;
      return true;
    });
    if (done) { applied.push(m.file); log(`применена ${m.file}`); }
  }
  return applied;
}

// Запуск из командной строки: node src/migrate.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { loadConfig } = await import('./config.mjs');
  const { createDb } = await import('./db.mjs');
  const sql = createDb(loadConfig());
  try {
    const applied = await migrate(sql, { log: console.log });
    console.log(applied.length ? `готово, применено: ${applied.length}` : 'схема актуальна');
  } catch (e) {
    console.error('миграция не удалась:', e.message);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
