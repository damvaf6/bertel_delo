// Служебный вход тестовыми номерами (решение Дамира 02.10.2026, вариант А): только на проверочной площадке, только с
// ключом, только номера +7999000xxxx. Здесь же — проверки, что на рабочем сайте (prod) такого входа нет и быть не может.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, client } from '../helpers.mjs';
import { loadConfig, ConfigError, STAGE_LOGIN_ENVS } from '../../src/config.mjs';
import { listOps } from '../../src/app.mjs';
import { stageLoginOps } from '../../src/ops/service-ops.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEY = 'stage-login-key-local-only-0123456789abcdef';
let S;

before(async () => {
  S = await startApp({ STAGE_LOGIN_KEY: KEY });
});
after(async () => { await S?.close(); });

const stageLogin = (c, phone, key = KEY, opts = {}) =>
  c.req('POST', '/__stage/login', { phone }, { headers: key === null ? {} : { 'x-stage-login': key }, ...opts });

test('служебный вход: тестовый номер с ключом — вход и сессия', async () => {
  const c = client(S);
  const r = await stageLogin(c, '8 999 000-90-01');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.phone, '+79990009001');
  const me = await c.req('GET', '/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.phone, '+79990009001');
  const [row] = await S.sql`select action from audit_log where actor_id = ${r.body.user.id} order by id desc limit 1`;
  assert.equal(row.action, 'auth.stage_login');
});

test('служебный вход: без ключа или с чужим ключом — «не найдено», сессии нет', async () => {
  for (const key of [null, '', 'x', KEY.slice(0, -1), KEY + 'x']) {
    const c = client(S);
    const r = await stageLogin(c, '+79990009002', key);
    assert.equal(r.status, 404, `ключ ${JSON.stringify(key)}`);
    assert.equal(c.cookie, '');
  }
  assert.equal((await S.sql`select count(*)::int as n from users where phone = '+79990009002'`)[0].n, 0);
});

test('служебный вход: не тестовый номер — отказ', async () => {
  for (const phone of ['+79161234567', '+79990010001', '+79991000001']) {
    const c = client(S);
    const r = await stageLogin(c, phone);
    assert.equal(r.status, 403, phone);
    assert.equal(r.body.error, 'not_test_phone');
    assert.equal(c.cookie, '');
  }
});

test('служебный вход: без защиты от подделки запроса — отказ', async () => {
  const r = await stageLogin(client(S), '+79990009003', KEY, { csrf: false });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'csrf');
});

test('служебный вход: без ключа в настройках операции нет', async () => {
  const cfg = loadConfig({ APP_ENV: 'test', DATABASE_URL: 'x' });
  assert.deepEqual(stageLoginOps(cfg), []);
  assert.ok(!listOps(cfg, { storage: { kind: 'memory' } }).some((o) => o.id === 'stage.login'));
});

test('рабочий сайт (prod): служебного входа нет и сервер с его ключом не стартует', () => {
  // 1. Настройка: ключ на prod (и на dev) — сервер не стартует.
  const prodEnv = { APP_ENV: 'prod', DATABASE_URL: 'postgres://x/y', APP_SECRET: 'x'.repeat(40), STORAGE_PROVIDER: 's3', S3_BUCKET: 'b',
    SMS_PROVIDER: 'sms-real', CALL_PROVIDER: 'call-real', PAYMENTS_PROVIDER: 'p', AI_PROVIDER: 'yandexgpt', AI_YANDEX_API_KEY: 'k',
    AI_YANDEX_FOLDER: 'f', MAIL_PROVIDER: 'm', SIGN_PROVIDER: 'g', MAIL_INBOX_ADDRESS: 'zayavki@delo.example', PUBLIC_URL: 'https://delo.example/' };
  assert.equal(loadConfig(prodEnv).stageLoginKey, '');
  assert.throws(() => loadConfig({ ...prodEnv, STAGE_LOGIN_KEY: KEY }), ConfigError);
  assert.throws(() => loadConfig({ APP_ENV: 'dev', DATABASE_URL: 'x', STAGE_LOGIN_KEY: KEY }), ConfigError);
  assert.throws(() => loadConfig({ APP_ENV: 'test', DATABASE_URL: 'x', STAGE_LOGIN_KEY: 'short' }), ConfigError);
  const stage = loadConfig({ APP_ENV: 'stage', DATABASE_URL: 'postgres://x/y', APP_SECRET: 'x'.repeat(40), STORAGE_PROVIDER: 's3', S3_BUCKET: 'b', STAGE_LOGIN_KEY: KEY });
  assert.equal(stage.stageLoginKey, KEY);
  assert.deepEqual([...STAGE_LOGIN_ENVS].sort(), ['stage', 'test']);

  // 2. Сборка операций: даже если настройку обойти, на prod операции нет.
  const forged = { ...loadConfig(prodEnv), stageLoginKey: KEY };
  assert.deepEqual(stageLoginOps(forged), []);
  assert.ok(!listOps(forged, { storage: { kind: 's3' } }).some((o) => o.id === 'stage.login' || o.path.startsWith('/__stage')));

  // 3. Облако: секрет с ключом заводится только для stage, выкладка с ключом — только на stage и только на закрытую площадку.
  const tf = fs.readFileSync(path.join(ROOT, 'infra/terraform/main.tf'), 'utf8');
  const blocks = tf.split(/\n(?=resource )/).filter((b) => /stage_login/.test(b.split('\n')[0]));
  assert.equal(blocks.length, 4, 'ресурсы служебного входа в Terraform');
  for (const b of blocks) assert.match(b, /count\s+= var\.env == "stage" \? 1 : 0/, b.split('\n')[0]);
  assert.ok(!/STAGE_LOGIN_KEY/.test(tf.replace(blocks.join('\n'), '')), 'ключ служебного входа — только в своём секрете');

  const workflows = path.join(ROOT, '.github/workflows');
  for (const f of fs.readdirSync(workflows)) {
    const y = fs.readFileSync(path.join(workflows, f), 'utf8');
    if (!/STAGE_LOGIN_KEY|stage-login/.test(y)) continue;
    assert.equal(f, 'deploy.yml', `${f}: служебный вход только в выкладке stage`);
    assert.match(y, /^\s+ENV: stage$/m);
    assert.doesNotMatch(y, /ENV: prod|inputs\.env/);
    assert.doesNotMatch(y, /allow-unauthenticated-invoke/, 'площадка не открывается всем');
    const deny = y.indexOf('deny-unauthenticated-invoke');
    const deploy = y.indexOf('revision deploy');
    assert.ok(deny > 0 && deny < deploy, 'сначала площадка закрывается, потом выкладывается ядро с ключом');
  }
});
