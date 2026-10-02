// Кнопка назначения первого администратора на проверочной площадке (решение Дамира 02.10.2026, вопрос 10, вариант А):
// только APP_ENV=stage, только тестовый номер +7999000xxxx, запись в журнал. На рабочем сайте (prod) кнопки нет и быть
// не может — первый администратор там назначается отдельно и только с «да» Дамира.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, login } from '../helpers.mjs';
import { STAGE_ADMIN_ENVS, stageAdminPhone, stageGrantAdmin, grantServer } from '../../src/tools/grant-role.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let S;

before(async () => { S = await startApp(); });
after(async () => { await S?.close(); });

test('кнопка площадки: тестовый номер становится администратором, действие в журнале; повтор ничего не меняет', async () => {
  const r = await stageGrantAdmin(S.sql, S.cfg, '8 999 000-95-00');
  assert.deepEqual(r, { phone: '+79990009500', role: 'admin', changed: true });
  const [u] = await S.sql`select id, platform_role from users where phone = '+79990009500'`;
  assert.equal(u.platform_role, 'admin');
  const rows = await S.sql`select action, details from audit_log where subject_id = ${String(u.id)} order by id`;
  assert.deepEqual(rows.map((x) => x.action), ['admin.role', 'stage.grant_admin']);
  assert.equal(rows[1].details.via, 'github-workflow');

  const again = await stageGrantAdmin(S.sql, S.cfg, '+79990009500');
  assert.equal(again.changed, false);
  const [{ n }] = await S.sql`select count(*)::int as n from audit_log where subject_id = ${String(u.id)}`;
  assert.equal(n, 2);

  // Назначенный администратор входит и видит раздел управления.
  const c = await login(S, '+79990009500');
  assert.equal((await c.req('GET', '/api/admin/staff')).status, 200);
});

test('кнопка площадки: только тестовые номера', async () => {
  for (const phone of ['+79161234567', '+79990001', '', undefined, 'abc', '+7999000123']) {
    await assert.rejects(() => stageGrantAdmin(S.sql, S.cfg, phone), /тестовый номер/, String(phone));
  }
  const [{ n }] = await S.sql`select count(*)::int as n from users where phone = '+79161234567'`;
  assert.equal(n, 0);
});

test('кнопка площадки: вызов контейнера — только POST /grant', async () => {
  const srv = grantServer(S.sql, S.cfg, '+79990009501');
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await fetch(`${base}/grant`)).status, 404);
    assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 404);
    const r = await fetch(`${base}/grant`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, phone: '+79990009501', role: 'admin', changed: true });
  } finally {
    await new Promise((r) => srv.close(r));
  }
  assert.throws(() => grantServer(S.sql, S.cfg, '+79161234567'), /тестовый номер/);
});

test('рабочий сайт (prod): кнопки нет — программа отказывается, workflow только для stage', async () => {
  assert.deepEqual([...STAGE_ADMIN_ENVS].sort(), ['stage', 'test']);
  for (const appEnv of ['prod', 'dev', undefined]) {
    assert.throws(() => stageAdminPhone({ appEnv }, '+79990009500'), /только на проверочной площадке/, String(appEnv));
    await assert.rejects(() => stageGrantAdmin(S.sql, { appEnv }, '+79990009502'), /только на проверочной площадке/);
    assert.throws(() => grantServer(S.sql, { appEnv }, '+79990009500'), /только на проверочной площадке/);
  }
  const [{ n }] = await S.sql`select count(*)::int as n from users where phone = '+79990009502'`;
  assert.equal(n, 0);

  // Программа в режиме контейнера сама проверяет APP_ENV=stage.
  const src = fs.readFileSync(path.join(ROOT, 'src/tools/grant-role.mjs'), 'utf8');
  assert.match(src, /if \(cfg\.appEnv !== 'stage'\)/);

  // Workflow: только каталог проверочной площадки, только stage, контейнер закрыт и удаляется после нажатия.
  const workflows = path.join(ROOT, '.github/workflows');
  const users = fs.readdirSync(workflows).filter((f) => /grant-role\.mjs|STAGE_ADMIN_PHONE/.test(fs.readFileSync(path.join(workflows, f), 'utf8')));
  assert.deepEqual(users.sort(), ['deploy.yml', 'stage-admin.yml']);
  const y = fs.readFileSync(path.join(workflows, 'stage-admin.yml'), 'utf8');
  assert.match(y, /^\s+ENV: stage$/m);
  assert.match(y, /^\s+FOLDER: bertel-delo-test$/m);
  assert.match(y, /APP_ENV=stage/);
  assert.doesNotMatch(y, /prod|inputs\.env|allow-unauthenticated-invoke/);
  assert.match(y, /STAGE_ADMIN_PHONE: '\+7999000\d{4}'/);
  const deny = y.indexOf('deny-unauthenticated-invoke');
  const deploy = y.indexOf('revision deploy');
  assert.ok(deny > 0 && deny < deploy, 'сначала контейнер закрывается, потом выкладывается');
  assert.match(y, /container delete/, 'временный контейнер удаляется после нажатия');
  // В выкладке номер администратора нужен только прогону на телефоне.
  const d = fs.readFileSync(path.join(workflows, 'deploy.yml'), 'utf8');
  assert.doesNotMatch(d, /grant-role\.mjs/);
});
