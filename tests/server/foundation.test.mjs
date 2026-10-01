// Фундамент: миграции, настройки, подключение к базе, реестр операций, заголовки безопасности, ошибки.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { startApp, client, resetDatabase, testEnv, TEST_TOKEN, login } from '../helpers.mjs';
import { loadConfig, ConfigError } from '../../src/config.mjs';
import { createDb, buildQuery, stripSslParams, sslOptions } from '../../src/db.mjs';
import { migrate, readMigrations, MIGRATIONS_DIR } from '../../src/migrate.mjs';
import { validateOp, mountOps, errorHandler } from '../../src/http/router.mjs';

let S;
before(async () => { S = await startApp(); });
after(async () => { await S?.close(); });

test('миграции: схема создаётся с нуля, повторный запуск ничего не меняет', async () => {
  await S.close();
  await resetDatabase();
  const sql = createDb(loadConfig(testEnv()));
  try {
    const first = await migrate(sql);
    assert.deepEqual(first, readMigrations().map((m) => m.file));
    assert.deepEqual(await migrate(sql), []);
    const tables = (await sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`).map((r) => r.table_name);
    for (const t of ['users', 'organizations', 'org_members', 'org_invites', 'sessions', 'login_codes', 'orders', 'documents', 'audit_log', 'schema_migrations']) {
      assert.ok(tables.includes(t), t);
    }
  } finally { await sql.end(); }
  S = await startApp();
});

test('миграции: изменённый после применения файл — ошибка, нужна новая миграция', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  for (const f of fs.readdirSync(MIGRATIONS_DIR)) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
  const file = path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith('001_')));
  fs.appendFileSync(file, '\n-- правка задним числом\n');
  await assert.rejects(migrate(S.sql, { dir }), /изменена после применения/);
});

test('настройки: на prod запрещены поддельные поставщики, база без сертификата, тестовые пути', () => {
  const prod = (extra) => loadConfig({ APP_ENV: 'prod', DATABASE_URL: 'postgres://x/y', APP_SECRET: 'x'.repeat(40),
    STORAGE_PROVIDER: 's3', S3_BUCKET: 'b', SMS_PROVIDER: 'sms-real', CALL_PROVIDER: 'call-real', PAYMENTS_PROVIDER: 'p', AI_PROVIDER: 'a', MAIL_PROVIDER: 'm', ...extra });
  assert.ok(prod({}).live);
  assert.throws(() => prod({ SMS_PROVIDER: 'fake' }), ConfigError);
  assert.throws(() => prod({ CALL_PROVIDER: 'fake' }), ConfigError);
  assert.throws(() => prod({ DB_SSL: 'disable' }), ConfigError);
  assert.throws(() => prod({ STORAGE_PROVIDER: 'memory' }), ConfigError);
  assert.throws(() => prod({ COOKIE_SECURE: '0' }), ConfigError);
  assert.throws(() => prod({ APP_SECRET: 'short' }), ConfigError);
  assert.throws(() => prod({ TEST_CONTROL_TOKEN: 't' }), ConfigError);
  assert.throws(() => loadConfig({ APP_ENV: 'dev', DATABASE_URL: 'x', TEST_CONTROL_TOKEN: 't' }), ConfigError);
  assert.throws(() => loadConfig({ APP_ENV: 'nope', DATABASE_URL: 'x' }), ConfigError);
  assert.throws(() => loadConfig({ APP_ENV: 'dev' }), ConfigError);
  // stage — тестовые данные: поддельные СМС допустимы, но файлы только в S3 и база только с сертификатом.
  const stage = loadConfig({ APP_ENV: 'stage', DATABASE_URL: 'postgres://x/y', APP_SECRET: 'x'.repeat(40), STORAGE_PROVIDER: 's3', S3_BUCKET: 'b' });
  assert.equal(stage.providers.sms, 'fake');
  assert.throws(() => loadConfig({ APP_ENV: 'stage', DATABASE_URL: 'x', APP_SECRET: 'x'.repeat(40) }), ConfigError);
});

test('база: без сертификата не подключаемся; параметры SSL из строки не перебивают проверку (Б-13)', () => {
  assert.throws(() => sslOptions({ dbSsl: 'verify', dbCaPath: '/nonexistent/root.crt' }), /сертификата/);
  const ca = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-')), 'root.crt');
  fs.writeFileSync(ca, 'CERT');
  assert.deepEqual(sslOptions({ dbSsl: 'verify', dbCaPath: ca }), { ca: 'CERT', rejectUnauthorized: true });
  assert.equal(sslOptions({ dbSsl: 'disable' }), false);
  assert.equal(stripSslParams('postgres://u:p@h:6432/delo?sslmode=verify-full&application_name=a'), 'postgres://u:p@h:6432/delo?application_name=a');
});

test('запросы: значения всегда параметрами, не текстом', () => {
  const evil = "'; drop table users; --";
  const q = buildQuery(['select * from users where phone = ', ' and id = ', ''], [evil, 1]);
  assert.equal(q.text, 'select * from users where phone = $1 and id = $2');
  assert.deepEqual(q.values, [evil, 1]);
});

test('транзакция: ошибка откатывает всё', async () => {
  await assert.rejects(S.sql.tx(async (tx) => {
    await tx`insert into organizations (name) values ('Откат')`;
    throw new Error('сбой');
  }));
  assert.equal((await S.sql`select 1 from organizations where name = 'Откат'`).length, 0);
});

test('реестр: операция без описания доступа не запускается', () => {
  const h = async () => {};
  assert.throws(() => validateOp({ id: 'x', method: 'GET', path: '/x', handler: h }), /auth/);
  assert.throws(() => validateOp({ id: 'x', method: 'GET', path: '/x', auth: 'user', handler: h }), /проверка доступа/);
  assert.throws(() => validateOp({ id: 'x', method: 'GET', path: '/x', auth: 'public', handler: h }), /без объяснения/);
  assert.throws(() => validateOp({ id: 'x', method: 'GET', path: '/x', auth: 'user', access: { resource: 'order', param: 'id', need: 'read' }, handler: h }), /параметра/);
  assert.throws(() => validateOp({ id: 'x', method: 'GET', path: '/x/:id', auth: 'user', access: { resource: 'nope', param: 'id', need: 'read' }, handler: h }), /проверка доступа/);
  assert.throws(() => validateOp({ id: 'x', method: 'GET', path: '/x/:id', auth: 'user', access: { resource: 'order', param: 'id', need: 'none' }, handler: h }), /проверка доступа/);
  assert.throws(() => validateOp({ id: 'x', method: 'GET', path: '/x', auth: 'user', access: { platform: 'dispatcher' }, handler: h }), /проверка доступа/);
  assert.throws(() => validateOp({ id: 'x', method: 'GET', path: '/x/:id', auth: 'user', access: { platform: 'admin', resource: 'order', param: 'id', need: 'read' }, handler: h }), /проверка доступа/);
  validateOp({ id: 'x', method: 'GET', path: '/x/:id', auth: 'user', access: { resource: 'order', param: 'id', need: 'read' }, handler: h });
  validateOp({ id: 'x', method: 'GET', path: '/x/:id', auth: 'user', access: { resource: 'org', param: 'id', need: 'manage' }, handler: h });
  validateOp({ id: 'x', method: 'GET', path: '/x', auth: 'user', access: { platform: 'admin' }, handler: h });
});

test('внутренняя ошибка: наружу только общий текст, подробности — в журнал (Б-11)', async () => {
  const app = express();
  mountOps(app, [{ id: 'boom', method: 'GET', path: '/boom', auth: 'public', publicReason: 'тест', handler: async () => { throw new Error('секрет базы: relation xyz'); } }], {});
  app.use(errorHandler());
  const server = app.listen(0);
  const orig = console.error;
  console.error = () => {};
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/boom`);
    assert.equal(r.status, 500);
    const body = await r.text();
    assert.ok(!body.includes('секрет'), body);
  } finally { console.error = orig; server.close(); }
});

test('заголовки безопасности и запрет внешних ресурсов (Б-20, Б-22)', async () => {
  for (const p of ['/', '/kabinet', '/api/health']) {
    const r = await fetch(S.base + p);
    assert.equal(r.status, 200, p);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-powered-by'), null);
  }
  const pub = path.resolve(MIGRATIONS_DIR, '..', 'public');
  for (const f of fs.readdirSync(pub)) {
    const text = fs.readFileSync(path.join(pub, f), 'utf8');
    assert.ok(!/https?:\/\//.test(text), `${f}: ссылки на внешние ресурсы запрещены`);
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(text), `${f}: вывод HTML строкой запрещён (Б-7)`);
    if (f.endsWith('.html')) assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(text), `${f}: встроенные скрипты запрещены`);
  }
});

test('размер запроса ограничен: JSON — 64 КБ, файл — 5 МБ', async () => {
  const c = await login(S, '+79990000201');
  const big = await c.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'x'.repeat(70 * 1024) });
  assert.equal(big.status, 413);
  const order = (await c.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Размеры' })).body.order;
  const up = (buf) => c.req('POST', `/api/orders/${order.id}/documents`, buf, { raw: true, headers: { 'x-file-name': 'f.bin' } });
  assert.equal((await up(Buffer.alloc(5 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await up(Buffer.alloc(0))).status, 400);
  assert.equal((await up(Buffer.alloc(5 * 1024 * 1024))).status, 201);
  assert.equal((await c.req('POST', '/api/orders', '{плохой', { raw: true, headers: { 'content-type': 'application/json' } })).status, 400);
});

test('имя файла: русские буквы сохраняются, пути и управляющие символы вычищаются', async () => {
  const c = await login(S, '+79990000202');
  const order = (await c.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Имена' })).body.order;
  const name = '../../Отчёт об оценке №1.pdf';
  const r = await c.req('POST', `/api/orders/${order.id}/documents`, Buffer.from('%PDF'), {
    raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name) },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.document.filename, '.._.._Отчёт об оценке №1.pdf');
  const link = (await c.req('GET', `/api/documents/${r.body.document.id}/link`)).body.url;
  const file = await fetch(new URL(link, S.base));
  assert.match(file.headers.get('content-disposition'), /filename\*=UTF-8''\.\._\.\._%D0%9E/);
});

test('служебные тестовые пути: без токена не видны, в других режимах не существуют', async () => {
  assert.equal((await fetch(`${S.base}/__test/fakes/sms/calls`)).status, 404);
  assert.equal((await fetch(`${S.base}/__test/fakes/sms/calls`, { headers: { 'x-test-control': 'wrong-token-local-xx' } })).status, 404);
  assert.equal((await fetch(`${S.base}/__test/fakes/sms/calls`, { headers: { 'x-test-control': TEST_TOKEN } })).status, 200);
  const { listOps } = await import('../../src/app.mjs');
  const devOps = listOps(loadConfig({ APP_ENV: 'dev', DATABASE_URL: 'x' }), { storage: { kind: 's3' } }).map((o) => o.id);
  assert.ok(!devOps.some((id) => id.startsWith('test.')));
  assert.ok(!devOps.includes('files.memory'));
});

test('подделанная или просроченная ссылка на файл не открывается', async () => {
  const c = await login(S, '+79990000203');
  const order = (await c.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Ссылки' })).body.order;
  const doc = (await c.req('POST', `/api/orders/${order.id}/documents`, Buffer.from('abc'), { raw: true, headers: { 'x-file-name': 'a.txt' } })).body.document;
  const url = (await c.req('GET', `/api/documents/${doc.id}/link`)).body.url;
  const [payload, sig] = url.slice('/files/'.length).split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), e: Date.now() + 1e9 })).toString('base64url');
  assert.equal((await fetch(`${S.base}/files/${forged}.${sig}`)).status, 404);
  const expired = await S.providers.storage.link(`orders/${order.id}/x`, { filename: 'a', ttlSec: -1 });
  assert.equal((await fetch(S.base + expired)).status, 404);
  assert.equal((await fetch(S.base + url)).status, 200);
});

test('неизвестный адрес API — 404 в JSON', async () => {
  const r = await client(S).req('GET', '/api/nope');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'not_found');
});
