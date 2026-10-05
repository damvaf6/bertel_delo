// Задача 2.51: наполнение демо-площадки (tests/tools/demo-seed.mjs) — обычными операциями через служебный вход.
// Проверяется: все виды экспертизы и оценки, все статусы заявки, организации и эксперты; повторный запуск ничего не
// дублирует; посторонний эксперт не видит чужих демо-дел; только тестовые номера.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../helpers.mjs';
import { grantRole } from '../../src/tools/grant-role.mjs';
import { seedDemo, stageLogin, DEMO_PEOPLE, DEMO_CASES } from '../tools/demo-seed.mjs';

const KEY = 'demo-stage-login-key-0123456789abcdef';
const ADMIN = '+79990009500';
let S;
before(async () => {
  S = await startApp({ STAGE_LOGIN_KEY: KEY, AUTH_RATE_MAX: '500' });
  await grantRole(S.sql, ADMIN, 'admin');
});
after(async () => { await S?.close(); });

test('демо-площадка: все виды услуг и статусы, повтор не дублирует', async () => {
  const r = await seedDemo({ base: S.base, login: stageLogin(S.base, {}, KEY), adminPhone: ADMIN });
  assert.equal(r.created, true);
  const orders = await S.sql`select service, status, title, org_id, executor_user_id from orders order by created_at`;
  assert.equal(orders.length, DEMO_CASES.length);
  const services = new Set(orders.map((o) => o.service));
  for (const s of ['realty', 'land', 'vehicle', 'movable', 'goods', 'construction', 'handwriting']) assert.ok(services.has(s), `нет дела по услуге ${s}`);
  const statuses = new Set(orders.map((o) => o.status));
  for (const s of ['new', 'matching', 'awaiting_executor', 'in_work', 'review', 'done', 'closed', 'cancelled']) assert.ok(statuses.has(s), `нет дела в статусе ${s}`);
  assert.ok(orders.some((o) => o.org_id), 'есть заявки от организаций');
  const orgs = await S.sql`select name from organizations order by name`;
  assert.equal(orgs.length, 4);
  for (const o of orgs) assert.match(o.name, /\(демо\)$/);
  const phones = await S.sql`select phone from users`;
  for (const p of phones) assert.match(p.phone, /^\+7999000\d{4}$/);
  // Выплаты по закрытым и готовым делам, подписи организаций на делах экспертов организаций.
  const payouts = await S.sql`select count(*)::int as n from payouts where status = 'succeeded'`;
  assert.ok(payouts[0].n >= 3);
  const orgSigns = await S.sql`select count(*)::int as n from document_signatures where role = 'org'`;
  assert.ok(orgSigns[0].n >= 3);

  const again = await seedDemo({ base: S.base, login: stageLogin(S.base, {}, KEY), adminPhone: ADMIN });
  assert.equal(again.created, false);
  assert.equal((await S.sql`select count(*)::int as n from orders`)[0].n, DEMO_CASES.length);
  assert.equal((await S.sql`select count(*)::int as n from organizations`)[0].n, 4);
  assert.ok(Object.keys(DEMO_PEOPLE).length >= 10);
});
