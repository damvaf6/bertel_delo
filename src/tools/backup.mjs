// Еженедельная выгрузка базы в хранилище копий и учебное восстановление (задача «До первого показа»).
// Работает внутри облака (отдельный контейнер в сети контура, запуск по расписанию) — данные из России не уходят,
// через GitHub проходит только итог: имена таблиц и число строк, без содержимого.
//   1) число строк в каждой таблице до и после выгрузки (если база менялась во время выгрузки — повтор);
//   2) pg_dump (сжатый формат) → хранилище копий (бакет с блокировкой от удаления на 30 дней);
//   3) копия скачивается обратно из хранилища, сверяется контрольная сумма;
//   4) учебное восстановление скачанной копии во временную базу и сверка таблиц и числа строк с исходной.
// Запуск: node src/tools/backup.mjs        — один раз, итог в журнал (JSON);
//         node src/tools/backup.mjs serve  — контейнер: POST /run → тот же итог ответом (вызывает таймер облака).
// Настройки: DATABASE_URL, DB_SSL, DB_CA_PATH; S3_ENDPOINT, S3_REGION, S3_BUCKET (бакет копий), S3_ACCESS_KEY,
// S3_SECRET_KEY, S3_PATH_STYLE; BACKUP_PREFIX (по умолчанию weekly/); RESTORE_ADMIN_URL — восстанавливать во временную
// базу на этом сервере (проверки), иначе — во временный PostgreSQL внутри контейнера (initdb, только не от root).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { sslOptions, stripSslParams } from '../db.mjs';

const PG_BIN_DEFAULT = '/usr/lib/postgresql/16/bin';
const pgBin = (name) => {
  const dir = process.env.PG_BIN || (fs.existsSync(PG_BIN_DEFAULT) ? PG_BIN_DEFAULT : '');
  return dir ? path.join(dir, name) : name;
};

export function backupConfig(env = process.env) {
  const need = (k) => { if (!env[k]) throw new Error(`${k} не задан`); return env[k]; };
  return {
    databaseUrl: need('DATABASE_URL'),
    dbSsl: env.DB_SSL === 'disable' ? 'disable' : 'verify',
    dbCaPath: env.DB_CA_PATH || '',
    prefix: env.BACKUP_PREFIX || 'weekly/',
    restoreAdminUrl: env.RESTORE_ADMIN_URL || '',
    s3: {
      endpoint: env.S3_ENDPOINT || 'https://storage.yandexcloud.net',
      region: env.S3_REGION || 'ru-central1',
      bucket: need('S3_BUCKET'),
      accessKeyId: need('S3_ACCESS_KEY'),
      secretAccessKey: need('S3_SECRET_KEY'),
      forcePathStyle: env.S3_PATH_STYLE === '1',
    },
  };
}

function run(cmd, args, { env = {}, input } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)}: код ${code}: ${err.trim().slice(-500)}`))));
    p.stdin.end(input);
  });
}

// Переменные libpq для pg_dump: сертификат базы проверяется так же, как в ядре (без него — не подключаемся).
function libpqEnv(cfg) {
  if (cfg.dbSsl === 'disable') return { PGSSLMODE: 'disable' };
  sslOptions(cfg); // нет сертификата — ошибка
  return { PGSSLMODE: 'verify-full', ...(cfg.dbCaPath ? { PGSSLROOTCERT: cfg.dbCaPath } : {}) };
}

async function withClient(connectionString, ssl, fn) {
  const c = new pg.Client({ connectionString, ssl });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

// Таблицы схемы public и точное число строк в каждой — для сверки копии с исходной базой.
export async function tableCounts(c) {
  const { rows } = await c.query(
    "select tablename from pg_tables where schemaname = 'public' order by tablename");
  const counts = {};
  for (const { tablename } of rows) {
    const r = await c.query(`select count(*)::bigint as n from public.${pg.escapeIdentifier(tablename)}`);
    counts[tablename] = Number(r.rows[0].n);
  }
  return counts;
}

const sameCounts = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function s3Client(s) {
  return new S3Client({
    region: s.region,
    endpoint: s.endpoint,
    forcePathStyle: s.forcePathStyle,
    credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
    // Бакет копий с блокировкой от удаления принимает загрузку только с Content-MD5 — передаём его сами.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

// Временный PostgreSQL внутри контейнера: только сокет в своей папке, без сети; удаляется после проверки.
async function tempPostgres(dir) {
  const data = path.join(dir, 'data');
  const sock = path.join(dir, 'sock');
  fs.mkdirSync(sock);
  await run(pgBin('initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '--encoding=UTF8', '--locale=C', '-N']);
  await run(pgBin('pg_ctl'), ['-D', data, '-w', '-l', path.join(dir, 'pg.log'),
    '-o', `-c listen_addresses='' -k ${sock} -c fsync=off`, 'start']);
  return {
    url: `postgres://postgres@localhost/postgres?host=${encodeURIComponent(sock)}`,
    stop: () => run(pgBin('pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop']).catch(() => {}),
  };
}

function withDb(url, db) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

// Восстановить копию во временную базу и вернуть таблицы с числом строк. Временная база удаляется в любом случае.
export async function restoreCheck(file, { restoreAdminUrl = '', workDir }) {
  let server = null;
  let adminUrl = restoreAdminUrl;
  if (!adminUrl) {
    server = await tempPostgres(workDir);
    adminUrl = server.url;
  }
  const db = `delo_restore_${crypto.randomBytes(4).toString('hex')}`;
  try {
    await withClient(adminUrl, false, (c) => c.query(`create database ${db}`));
    try {
      const target = withDb(adminUrl, db);
      await run(pgBin('pg_restore'), ['--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction',
        '-d', target, file]);
      return await withClient(target, false, tableCounts);
    } finally {
      await withClient(adminUrl, false, (c) => c.query(`drop database if exists ${db} with (force)`));
    }
  } finally {
    await server?.stop();
  }
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); // 20261004T230000Z

// s3 — клиент хранилища (в проверках без MinIO — его подмена с тем же send()).
export async function runBackup(cfg, { now = new Date(), log = () => {}, s3 = s3Client(cfg.s3) } = {}) {
  const started = Date.now();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delo-backup-'));
  const ssl = sslOptions(cfg);
  const srcUrl = stripSslParams(cfg.databaseUrl);
  const dumpFile = path.join(workDir, 'delo.dump');
  const backFile = path.join(workDir, 'back.dump');
  try {
    // 1–2. Выгрузка; число строк до и после должно совпасть, иначе база менялась — повторяем (до трёх раз).
    let counts = null;
    for (let attempt = 1; attempt <= 3 && !counts; attempt++) {
      const before = await withClient(srcUrl, ssl, tableCounts);
      await run(pgBin('pg_dump'), ['--format=custom', '--compress=6', '--no-owner', '--no-privileges',
        '-f', dumpFile, '-d', stripSslParams(cfg.databaseUrl)], { env: libpqEnv(cfg) });
      const after = await withClient(srcUrl, ssl, tableCounts);
      if (sameCounts(before, after)) counts = after;
      else log(`выгрузка ${attempt}: база менялась во время выгрузки — повтор`);
    }
    if (!counts) throw new Error('база всё время менялась во время выгрузки — сверить копию нельзя');

    const body = fs.readFileSync(dumpFile);
    const md5 = crypto.createHash('md5').update(body).digest('base64');
    const key = `${cfg.prefix}${stamp(now)}.dump`;
    await s3.send(new PutObjectCommand({
      Bucket: cfg.s3.bucket, Key: key, Body: body, ContentMD5: md5, ContentType: 'application/octet-stream',
    }));
    log(`копия выгружена: ${key}, ${body.length} байт`);

    // 3. Скачать обратно и сверить: восстанавливаем то, что лежит в хранилище, а не локальный файл.
    const got = await s3.send(new GetObjectCommand({ Bucket: cfg.s3.bucket, Key: key }));
    const back = Buffer.from(await got.Body.transformToByteArray());
    const backMd5 = crypto.createHash('md5').update(back).digest('base64');
    if (backMd5 !== md5) throw new Error('копия в хранилище не совпадает с выгрузкой');
    fs.writeFileSync(backFile, back);

    // 4. Учебное восстановление.
    const restored = await restoreCheck(backFile, { restoreAdminUrl: cfg.restoreAdminUrl, workDir });
    const tablesOk = sameCounts(Object.keys(counts), Object.keys(restored));
    const rowsOk = sameCounts(counts, restored);
    const report = {
      ok: tablesOk && rowsOk,
      key,
      bytes: body.length,
      tables: Object.keys(counts).length,
      rows: Object.values(counts).reduce((a, b) => a + b, 0),
      restore: { tables: tablesOk, rows: rowsOk },
      counts,
      ...(rowsOk ? {} : { restored }),
      seconds: Math.round((Date.now() - started) / 1000),
    };
    log(report.ok ? 'учебное восстановление: таблицы и число строк совпали' : 'учебное восстановление: РАСХОЖДЕНИЕ');
    return report;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// Контейнер в облаке: таймер вызывает POST /run; один запуск за раз.
export function serve(cfg, port = Number(process.env.PORT || 8080)) {
  let busy = false;
  const srv = http.createServer(async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    if (req.method !== 'POST') return send(405, { ok: false, error: 'только POST' });
    if (busy) return send(409, { ok: false, error: 'выгрузка уже идёт' });
    busy = true;
    try {
      const report = await runBackup(cfg, { log: (m) => console.log(m) });
      console.log(JSON.stringify({ ...report, counts: undefined, restored: undefined }));
      send(report.ok ? 200 : 500, report);
    } catch (e) {
      console.error('выгрузка не удалась:', e.message);
      send(500, { ok: false, error: e.message });
    } finally {
      busy = false;
    }
  });
  srv.listen(port, () => console.log(`выгрузка копий: жду вызова на порту ${port}`));
  return srv;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = backupConfig();
  if (process.argv[2] === 'serve') serve(cfg);
  else {
    runBackup(cfg, { log: (m) => console.error(m) })
      .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); })
      .catch((e) => { console.error('выгрузка не удалась:', e.message); process.exit(1); });
  }
}
