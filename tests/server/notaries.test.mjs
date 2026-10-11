// Нотариусы-партнёры (задача 2а.4, задача штаба 3f617197): справочник ведёт администратор; переводчик видит окна на две
// недели и пачку — свои нотариальные заказы в работе.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { upcomingWindows } from '../../src/translation/notaries.mjs';

let S, admin, dispatcher, owner, tr, expert;
const soon = addDays(todayMsk(), 7);
const IVANOVA = {
  full_name: 'Тестовый нотариус Иванова И. И.', address: 'г. Москва, тестовая ул., 1', contacts: '+7 999 000-09-69',
  windows: [{ weekday: 4, from: '10:00', to: '12:00' }, { weekday: 2, from: '15:00', to: '17:00' }],
};

before(async () => {
  S = await startApp();
  admin = await login(S, '+79990000960');
  dispatcher = await login(S, '+79990000961');
  owner = await login(S, '+79990000962');
  tr = await login(S, '+79990000963');
  expert = await login(S, '+79990000964');
  await setPlatformRole(S.sql, admin.user.id, 'admin');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, tr.user.id, { permits: [['translation', 'notary_paper'], ['translation', 'plain']], capacity: 20, taxStatus: 'self_employed', languages: ['en'] });
  await makeSpecialist(S.sql, expert.user.id);
});
after(async () => { await S?.close(); });

test('окна на две недели: по дням недели, по порядку; закончившееся сегодня окно не показывается', () => {
  const n = { id: 'n1', full_name: 'Н', address: 'А', contacts: '', file_for_identity: false, windows: IVANOVA.windows };
  // 2026-10-12 — понедельник.
  const w = upcomingWindows([n], '2026-10-12', '09:00');
  assert.deepEqual(w.map((x) => `${x.weekday} ${x.date} ${x.from}`), [
    'вт 2026-10-13 15:00', 'чт 2026-10-15 10:00', 'вт 2026-10-20 15:00', 'чт 2026-10-22 10:00',
  ]);
  assert.equal(upcomingWindows([n], '2026-10-13', '16:59')[0].date, '2026-10-13', 'окно ещё идёт');
  assert.equal(upcomingWindows([n], '2026-10-13', '17:00')[0].date, '2026-10-15', 'окно закончилось');
  assert.deepEqual(upcomingWindows([], '2026-10-12'), []);
});

test('справочник нотариусов: ведёт только администратор; проверка полей; выключить вместо удаления', async () => {
  for (const c of [dispatcher, owner, tr]) {
    assert.equal((await c.req('GET', '/api/admin/notaries')).status, 404);
    assert.equal((await c.req('POST', '/api/admin/notaries', IVANOVA)).status, 404);
  }
  const bad = async (patch, why) => assert.equal((await admin.req('POST', '/api/admin/notaries', { ...IVANOVA, ...patch })).status, 400, why);
  await bad({ full_name: '' }, 'без ФИО');
  await bad({ address: ' ' }, 'без адреса');
  await bad({ windows: [{ weekday: 8, from: '10:00', to: '12:00' }] }, 'нет такого дня');
  await bad({ windows: [{ weekday: 1, from: '12:00', to: '10:00' }] }, 'конец раньше начала');
  await bad({ windows: [{ weekday: 1, from: '9:00', to: '10:00' }] }, 'время 09:00');
  await bad({ payment: 'cash' }, 'способ оплаты');

  const r = await admin.req('POST', '/api/admin/notaries', IVANOVA);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const n = r.body.notary;
  // По умолчанию: счёт от платформы, электронный файл для паспортов — нет, окна по порядку дней.
  assert.equal(n.payment, 'invoice');
  assert.equal(n.payment_name, 'по счёту от платформы');
  assert.equal(n.file_for_identity, false);
  assert.equal(n.windows_text, 'вт 15:00–17:00, чт 10:00–12:00');
  assert.equal(n.active, true);

  for (const c of [dispatcher, owner, tr]) assert.equal((await c.req('PUT', `/api/admin/notaries/${n.id}`, { active: false })).status, 404);
  assert.equal((await admin.req('PUT', '/api/admin/notaries/не-номер', { active: false })).status, 404);
  assert.equal((await admin.req('PUT', `/api/admin/notaries/${crypto.randomUUID()}`, { active: false })).status, 404);
  const u = await admin.req('PUT', `/api/admin/notaries/${n.id}`, { file_for_identity: true, payment: 'on_site', contacts: '' });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal(u.body.notary.file_for_identity, true);
  assert.equal(u.body.notary.payment_name, 'на месте при подписании');
  assert.equal(u.body.notary.full_name, IVANOVA.full_name, 'непереданное не меняется');
  assert.equal(u.body.notary.windows.length, 2);
  const [log] = await S.sql`select action from audit_log where subject_type = 'notary' and subject_id = ${n.id} order by id desc limit 1`;
  assert.equal(log.action, 'notary.update');

  const off = await admin.req('PUT', `/api/admin/notaries/${n.id}`, { active: false });
  assert.equal(off.body.notary.active, false);
  assert.ok((await admin.req('GET', '/api/admin/notaries')).body.notaries.some((x) => x.id === n.id && !x.active), 'выключенный остаётся в справочнике');
  // Для следующей проверки — снова работаем.
  assert.equal((await admin.req('PUT', `/api/admin/notaries/${n.id}`, { active: true })).status, 200);
});

test('переводчик: окна работающих нотариусов и пачка — только свои нотариальные заказы в работе; эксперту блок не нужен', async () => {
  const other = (await admin.req('POST', '/api/admin/notaries', { ...IVANOVA, full_name: 'Тестовый нотариус Петров П. П.', windows: [{ weekday: 1, from: '11:00', to: '13:00' }] })).body.notary;
  await admin.req('PUT', `/api/admin/notaries/${other.id}`, { active: false });

  // Эксперт без переводов — блок не показывается.
  assert.deepEqual((await expert.req('GET', '/api/specialist/me/notary')).body.desk, { translator: false });
  assert.deepEqual((await owner.req('GET', '/api/specialist/me/notary')).body.desk, { translator: false });

  const empty = (await tr.req('GET', '/api/specialist/me/notary')).body.desk;
  assert.equal(empty.translator, true);
  assert.deepEqual(empty.batch, []);
  assert.equal(empty.notaries, 1, 'выключенный нотариус не считается');
  assert.ok(empty.windows.length >= 3 && empty.windows.length <= 4, JSON.stringify(empty.windows));
  assert.ok(empty.windows.every((w) => w.notary.full_name.includes('Иванова')), 'окон выключенного нет');

  // Заказы: нотариальный бумагой в работе — в пачке; без нотариуса — нет.
  const order = async (service, fields) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'translation', service, title: `Перевод ${service}` })).body.order;
    assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: soon, fields })).status, 200);
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
    await ensurePaid(S.sql, o.id);
    const off = await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: tr.user.id, from: 'matching' });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal((await tr.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
    return o;
  };
  const base = { recipient: 'mvd', language: 'en', direction: 'to_ru', doc_kind: 'identity', docs: 2, pages: 3, urgent: 'yes' };
  const paper = await order('notary_paper', { ...base, original: 'courier', delivery: 'pickup' });
  await order('plain', { ...base, recipient: 'business', delivery: 'none' });

  const desk = (await tr.req('GET', '/api/specialist/me/notary')).body.desk;
  assert.equal(desk.batch.length, 1);
  const b = desk.batch[0];
  assert.equal(b.order_id, paper.id);
  assert.equal(b.service, 'Нотариальный перевод (бумага)');
  assert.equal(b.language, 'английский → русский');
  assert.equal(b.doc_kind, 'Паспорт, удостоверение личности');
  assert.equal(b.original, 'Курьером');
  assert.equal(b.docs, 2);
  assert.equal(b.urgent, true);
  assert.equal(b.deadline, soon);
  assert.ok(b.ref.startsWith('№ '));
  assert.deepEqual(desk.totals, { orders: 1, docs: 2 });
  // Чужой переводчик чужой пачки не видит.
  const tr2 = await login(S, '+79990000965');
  await makeSpecialist(S.sql, tr2.user.id, { permits: [['translation', 'notary_paper']], taxStatus: 'ip', languages: ['en'] });
  assert.deepEqual((await tr2.req('GET', '/api/specialist/me/notary')).body.desk.batch, []);
});
