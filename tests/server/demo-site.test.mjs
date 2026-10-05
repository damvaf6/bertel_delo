// Открытая демо-площадка (решение Дамира 05.10.2026, вопрос 21, вариант Б): только вымышленные данные, вход кнопками
// «Войти как …», без входа по телефону и без настоящих поставщиков, закрыта от поисковиков, сброс данных по ключу.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ConfigError } from '../../src/config.mjs';
import { createDb } from '../../src/db.mjs';
import { migrate } from '../../src/migrate.mjs';
import { createProviders } from '../../src/providers/index.mjs';
import { createApp, listOps } from '../../src/app.mjs';
import { DB_URL, resetDatabase, client } from '../helpers.mjs';
import { DEMO_ROLES, DEMO_ADMIN } from '../../src/demo/demo.mjs';
import { DEMO_CASES, DEMO_PEOPLE } from '../../src/demo/seed.mjs';

const KEY = 'demo-reset-key-for-tests-0123456789abcdef';
const ROOT = path.resolve(import.meta.dirname, '../..');
const demoEnv = { APP_ENV: 'demo', DATABASE_URL: 'postgres://x/y', APP_SECRET: 'x'.repeat(40), STORAGE_PROVIDER: 's3', S3_BUCKET: 'b', DEMO_RESET_KEY: KEY };
let S;

before(async () => {
  await resetDatabase();
  // Локальная база — без сертификата и без S3: берём настройки автотестов и включаем режим демо.
  const cfg = { ...loadConfig({ APP_ENV: 'test', DATABASE_URL: DB_URL, DB_SSL: 'disable', COOKIE_SECURE: '0' }), appEnv: 'demo', demoResetKey: KEY };
  const sql = createDb(cfg);
  await migrate(sql);
  const providers = createProviders(cfg);
  const app = createApp({ cfg, sql, providers });
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  S = { base: `http://127.0.0.1:${server.address().port}`, sql, close: async () => { await new Promise((r) => server.close(r)); await sql.end(); } };
});
after(async () => { await S?.close(); });

test('настройки демо: только поддельные оплата, СМС, почта, подпись и модель; ключ сброса — только на демо', () => {
  assert.equal(loadConfig(demoEnv).appEnv, 'demo');
  for (const [k, v] of [['PAYMENTS_PROVIDER', 'yookassa'], ['SMS_PROVIDER', 'smsru'], ['MAIL_PROVIDER', 'imap'], ['SIGN_PROVIDER', 'kontur'], ['AI_PROVIDER', 'yandexgpt'], ['CALL_PROVIDER', 'x']]) {
    assert.throws(() => loadConfig({ ...demoEnv, [k]: v, YOOKASSA_SHOP_ID: '123456', YOOKASSA_SECRET_KEY: 'test_x', PUBLIC_URL: 'https://x', AI_YANDEX_API_KEY: 'k', AI_YANDEX_FOLDER: 'f', MAIL_INBOX_ADDRESS: 'a@b.ru' }), ConfigError, k);
  }
  assert.throws(() => loadConfig({ ...demoEnv, DEMO_RESET_KEY: 'short' }), ConfigError);
  assert.throws(() => loadConfig({ ...demoEnv, DB_SSL: 'disable' }), ConfigError, 'база — только с сертификатом');
  assert.throws(() => loadConfig({ ...demoEnv, STAGE_LOGIN_KEY: 'k'.repeat(40) }), ConfigError, 'служебного входа нет');
  assert.throws(() => loadConfig({ APP_ENV: 'stage', DATABASE_URL: 'x', APP_SECRET: 'x'.repeat(40), STORAGE_PROVIDER: 's3', S3_BUCKET: 'b', DEMO_RESET_KEY: KEY }), ConfigError);
  // Операций демо нет ни на stage, ни на prod.
  for (const env of ['stage', 'prod', 'test']) {
    const ops = listOps({ ...loadConfig({ APP_ENV: 'test', DATABASE_URL: 'x' }), appEnv: env }, { storage: { kind: 's3' } });
    assert.ok(!ops.some((o) => o.id.startsWith('demo.')), env);
  }
});

test('демо: входа по телефону нет; вход только кнопками за вымышленных людей; закрыта от поисковиков', async () => {
  const anon = client(S);
  assert.equal((await anon.req('POST', '/api/auth/code', { phone: '+79161234567' })).status, 404);
  assert.equal((await anon.req('POST', '/api/auth/verify', { phone: '+79161234567', code: '123456' })).status, 404);
  const h = await fetch(`${S.base}/api/health`);
  assert.deepEqual(await h.json(), { ok: true, test_data: true, demo: true });
  assert.equal(h.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  const robots = await fetch(`${S.base}/robots.txt`);
  assert.equal(await robots.text(), 'User-agent: *\nDisallow: /\n');
  assert.equal((await fetch(`${S.base}/`)).headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');

  const roles = (await anon.req('GET', '/api/demo/roles')).body.roles;
  assert.deepEqual(roles.map((r) => r.as), DEMO_ROLES.map((r) => r.as));
  assert.equal((await anon.req('POST', '/api/demo/login', { as: 'нет-такого' })).status, 404);
  assert.equal((await anon.req('POST', '/api/demo/login', { as: 'orlov' })).status, 404, 'только роли с кнопками');
  assert.equal((await anon.req('POST', '/api/demo/login', { phone: DEMO_ADMIN })).status, 404, 'администратором не войти');
  const r = await anon.req('POST', '/api/demo/login', { as: 'lawyer' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.phone, DEMO_PEOPLE.lawyer.phone);
  assert.equal((await anon.req('GET', '/api/me')).body.user.phone, DEMO_PEOPLE.lawyer.phone);
});

test('демо: сброс — только по ключу; стирает всё и наполняет заново; повтор даёт то же', async () => {
  const post = (key) => fetch(`${S.base}/__demo/reset`, { method: 'POST', headers: { 'x-delo-request': '1', ...(key ? { 'x-demo-reset': key } : {}) } });
  assert.equal((await post()).status, 404);
  assert.equal((await post('wrong-key-0123456789abcdef0123456789')).status, 404);
  // Гость что-то натворил — после сброса этого нет.
  const g = client(S);
  await g.req('POST', '/api/demo/login', { as: 'petrov' });
  assert.equal((await g.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Гость написал своё' })).status, 201);
  const r1 = await post(KEY);
  assert.equal(r1.status, 200, await r1.clone().text());
  assert.deepEqual(await r1.json(), { ok: true, cases: DEMO_CASES.length, orgs: 4 });
  const titles = (await S.sql`select title from orders`).map((o) => o.title);
  assert.equal(titles.length, DEMO_CASES.length);
  assert.ok(!titles.includes('Гость написал своё'));
  for (const u of await S.sql`select phone from users`) assert.match(u.phone, /^\+79990001\d{3}$/, 'только вымышленные демо-номера');
  // Старая сессия гостя после сброса недействительна.
  assert.equal((await g.req('GET', '/api/me')).status, 401);
  const r2 = await post(KEY);
  assert.equal(r2.status, 200);
  assert.equal((await S.sql`select count(*)::int as n from orders`)[0].n, DEMO_CASES.length);
  assert.equal((await S.sql`select count(*)::int as n from payments where status = 'succeeded'`)[0].n > 0, true, 'оплаты — поддельные');
});

test('workflow демо: открыт по кнопке, сброс каждую ночь, выключение одним действием, только stage', () => {
  const y = fs.readFileSync(path.join(ROOT, '.github/workflows/demo.yml'), 'utf8');
  assert.match(y, /cron: '0 0 \* \* \*'/);
  assert.match(y, /options: \[deploy, reset, off, on\]/);
  assert.match(y, /FOLDER: bertel-delo-test/);
  assert.match(y, /APP_ENV=demo/);
  assert.match(y, /deny-unauthenticated-invoke/);
  assert.match(y, /allow-unauthenticated-invoke/);
  assert.doesNotMatch(y, /prod|STAGE_LOGIN_KEY|PAYMENTS_PROVIDER|AI_PROVIDER=yandexgpt/);
  const tf = fs.readFileSync(path.join(ROOT, 'infra/terraform/main.tf'), 'utf8');
  const blocks = tf.split(/\n(?=resource )/).filter((b) => /"demo"|"pg_demo"|"demo_secret"|"demo_reset"|"demo_read"/.test(b.split('\n')[0]));
  assert.equal(blocks.length, 9, 'ресурсы демо в Terraform');
  for (const b of blocks) assert.match(b, /count\s+= var\.env == "stage" \? 1 : 0/, b.split('\n')[0]);
});
