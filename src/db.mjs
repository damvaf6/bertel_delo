// Подключение к PostgreSQL: пул, запросы шаблонными строками, транзакции.
// Перенесено из наследия (pgCompat.mjs) с исправлением Б-13: без сертификата — не подключаемся.
import pg from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Дата без времени (срок заявки) — строкой 'ГГГГ-ММ-ДД', как в базе. По умолчанию pg делает из неё момент
// в часовом поясе сервера, и дата может съехать на день.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

// Параметры SSL из строки подключения pg применяет поверх ssl-объекта — убираем их и задаём сами.
const SSL_URL_PARAMS = ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl'];

export function sslOptions(cfg) {
  if (cfg.dbSsl === 'disable') return false;
  const caPath = cfg.dbCaPath || path.join(os.homedir(), '.postgresql', 'root.crt');
  let ca;
  try {
    ca = fs.readFileSync(caPath, 'utf8');
  } catch {
    throw new Error(`Нет сертификата базы (${caPath}); подключение без проверки запрещено`);
  }
  return { ca, rejectUnauthorized: true };
}

export function stripSslParams(url) {
  const u = new URL(url);
  for (const p of SSL_URL_PARAMS) u.searchParams.delete(p);
  return u.toString();
}

// sql`select ... where id = ${id}` → { text: 'select ... where id = $1', values: [id] }
export function buildQuery(strings, values) {
  let text = strings[0];
  for (let i = 0; i < values.length; i++) text += `$${i + 1}` + strings[i + 1];
  return { text, values };
}

function bind(runner) {
  const sql = async (strings, ...values) => (await runner.query(buildQuery(strings, values))).rows;
  sql.one = async (strings, ...values) => (await sql(strings, ...values))[0] || null;
  return sql;
}

export function createDb(cfg) {
  const pool = new pg.Pool({
    connectionString: stripSslParams(cfg.databaseUrl),
    ssl: sslOptions(cfg),
    max: 5,
    idleTimeoutMillis: 10_000,
  });
  pool.on('error', (e) => console.error('db pool error:', e.message));

  const sql = bind(pool);
  // Всё внутри fn — одна транзакция; ошибка — откат целиком.
  sql.tx = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(bind(client), client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };
  sql.pool = pool;
  sql.end = () => pool.end();
  return sql;
}
