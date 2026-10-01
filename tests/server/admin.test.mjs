// Администрирование (задача 1.2): служебные роли через интерфейс, отключение, первый администратор командой.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, client, lastCode, ageCodes } from '../helpers.mjs';
import { grantRole } from '../../src/tools/grant-role.mjs';

let S, admin;
before(async () => {
  S = await startApp();
  // Первый администратор — командой, до его первого входа.
  const u = await grantRole(S.sql, '8 999 000-20-01', 'admin');
  assert.equal(u.platform_role, 'admin');
  admin = await login(S, '+79990002001');
});
after(async () => { await S?.close(); });

const find = (phone) => admin.req('GET', `/api/admin/users?phone=${encodeURIComponent(phone)}`);

test('команда первого назначения: пользователь создаётся, действие в журнале', async () => {
  assert.equal(admin.user.platform_role, 'admin');
  const log = await S.sql`select actor_id, action, details from audit_log where subject_id = ${admin.user.id} and action = 'admin.role'`;
  assert.equal(log.length, 1);
  assert.equal(log[0].actor_id, null, 'автор — команда, не пользователь');
  await assert.rejects(grantRole(S.sql, '123', 'admin'), /Номер/);
  await assert.rejects(grantRole(S.sql, '+79990002001', 'boss'), /Роль/);
});

test('назначить диспетчера: права действуют сразу, без повторного входа; снять — пропадают', async () => {
  const d = await login(S, '+79990002002');
  const owner = await login(S, '+79990002003');
  const order = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Тестовая заявка клиента' })).body.order;
  assert.equal((await d.req('GET', `/api/orders/${order.id}`)).status, 404);

  const r = await admin.req('PATCH', `/api/admin/users/${d.user.id}`, { platform_role: 'dispatcher' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.platform_role, 'dispatcher');
  assert.equal((await d.req('GET', `/api/orders/${order.id}`)).status, 200);
  assert.equal((await d.req('GET', '/api/admin/staff')).status, 404, 'диспетчер — не администратор');

  const staff = (await admin.req('GET', '/api/admin/staff')).body.users.map((u) => [u.phone, u.platform_role]);
  assert.deepEqual(staff.sort(), [['+79990002001', 'admin'], ['+79990002002', 'dispatcher']]);

  assert.equal((await admin.req('PATCH', `/api/admin/users/${d.user.id}`, { platform_role: null })).body.user.platform_role, null);
  assert.equal((await d.req('GET', `/api/orders/${order.id}`)).status, 404);
});

test('поиск по номеру: в любом написании; кто не входил — понятный ответ', async () => {
  await login(S, '+79990002004');
  const r = await find('8 (999) 000-20-04');
  assert.equal(r.status, 200);
  assert.equal(r.body.user.phone, '+79990002004');
  assert.deepEqual(r.body.user.orgs, []);
  const none = await find('+79990002099');
  assert.equal(none.status, 404);
  assert.equal(none.body.error, 'user_not_found');
  assert.equal((await find('abc')).status, 400);
});

test('отключить: все сессии гаснут, вход закрыт; включить — снова входит', async () => {
  const phone = '+79990002005';
  const u = await login(S, phone);
  const r = await admin.req('PATCH', `/api/admin/users/${u.user.id}`, { is_active: false });
  assert.equal(r.body.user.is_active, false);
  assert.equal((await u.req('GET', '/api/me')).status, 401);
  const [{ n }] = await S.sql`select count(*)::int as n from sessions where user_id = ${u.user.id}`;
  assert.equal(n, 0);
  await ageCodes(S, phone);
  const c = client(S);
  await c.req('POST', '/api/auth/code', { phone });
  assert.equal((await c.req('POST', '/api/auth/verify', { phone, code: lastCode(S, phone) })).status, 403);

  await admin.req('PATCH', `/api/admin/users/${u.user.id}`, { is_active: true });
  await ageCodes(S, phone);
  await login(S, phone);
  const log = await S.sql`select action from audit_log where subject_id = ${u.user.id} and action like 'admin.%' order by id`;
  assert.deepEqual(log.map((x) => x.action), ['admin.disable', 'admin.enable']);
});

test('себя не изменить; неверные значения — отказ', async () => {
  const self = await admin.req('PATCH', `/api/admin/users/${admin.user.id}`, { platform_role: null });
  assert.equal(self.status, 409);
  assert.equal((await admin.req('PATCH', `/api/admin/users/${admin.user.id}`, { is_active: false })).status, 409);
  const u = await login(S, '+79990002006');
  assert.equal((await admin.req('PATCH', `/api/admin/users/${u.user.id}`, { platform_role: 'boss' })).status, 400);
  assert.equal((await admin.req('PATCH', `/api/admin/users/${u.user.id}`, { is_active: 'нет' })).status, 400);
  assert.equal((await admin.req('PATCH', '/api/admin/users/00000000-0000-0000-0000-000000000000', { platform_role: 'dispatcher' })).status, 404);
  assert.equal((await admin.req('PATCH', '/api/admin/users/не-uuid', { platform_role: 'dispatcher' })).status, 404);
  const [row] = await S.sql`select platform_role, is_active from users where id = ${u.user.id}`;
  assert.deepEqual(row, { platform_role: null, is_active: true }, 'при ошибке ничего не поменялось');
});
