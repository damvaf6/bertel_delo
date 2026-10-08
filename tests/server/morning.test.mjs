// Утренняя сводка эксперту «На сегодня» (2.119): раз в день после 8:00 по Москве — одно уведомление с цифрами: сколько дел
// сдать сегодня и с прошедшим сроком, выезды на объект сегодня, ссылки на осмотр, которые истекают в ближайшие сутки.
// Нечего сообщить — не приходит. В ленте и СМС — без названий дел и имён; ведёт к «Моим срокам» в разделе «Специалист».
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { digestText, sendMorning } from '../../src/notify/morning.mjs';

let S, owner, dispatcher, spec, helper, idle;
const FIELDS = { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, Утренняя ул., 8', area: '40' };
const today = todayMsk();
const tomorrow = addDays(today, 1);
const at = (day, time) => new Date(`${day}T${time}:00+03:00`);

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990003701');
  dispatcher = await login(S, '+79990003702');
  spec = await login(S, '+79990003703');
  helper = await login(S, '+79990003704');
  idle = await login(S, '+79990003705');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  for (const c of [spec, helper, idle]) await makeSpecialist(S.sql, c.user.id);
});
after(async () => { await S?.close(); });

async function inWork(title, deadline) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(today, 9), fields: FIELDS })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  await S.sql`update orders set deadline = ${deadline}::date where id = ${o.id}`;
  return o;
}
const mine = async (userId) => S.sql`select id from notifications where user_id = ${userId} and event = 'morning_today' order by id`;

test('текст сводки: только непустые части, склонения', () => {
  assert.equal(digestText({ due: 0, overdue: 0, visits: 0, links: 0 }), null);
  assert.equal(digestText({ due: 1, overdue: 0, visits: 0, links: 0 }), 'На сегодня: сдать 1 дело');
  assert.equal(digestText({ due: 2, overdue: 5, visits: 1, links: 1 }),
    'На сегодня: сдать 2 дела, 5 дел с прошедшим сроком, 1 выезд на объект, 1 ссылка на осмотр истекает в ближайшие сутки');
  assert.equal(digestText({ due: 11, overdue: 21, visits: 3, links: 2 }),
    'На сегодня: сдать 11 дел, 21 дело с прошедшим сроком, 3 выезда на объект, 2 ссылки на осмотр истекают в ближайшие сутки');
});

test('после 8:00 — одна сводка с цифрами дня; до 8:00, повторно и без дел — ничего', async () => {
  const due = await inWork('Квартира на Утренней — сдать сегодня', today);
  await inWork('Дом с прошедшим сроком', addDays(today, -1));
  const sent = await inWork('Сдано на проверку', today);
  await S.sql`update orders set status = 'review' where id = ${sent.id}`;
  const later = await inWork('Срок через неделю', addDays(today, 7));
  // Выезд помощника по делу эксперта сегодня в 15:00 — у эксперта «выезд», у помощника — свой выезд.
  await S.sql`insert into onsite_visits (order_id, helper_id, assigned_by, planned_at) values (${due.id}, ${helper.user.id}, ${spec.user.id}, ${at(today, '15:00')})`;
  // Ссылка на осмотр истекает завтра в 9:00 — раньше, чем «сейчас» по часам (12:00), значит в ближайшие сутки; завтра в 18:00 — нет.
  await S.sql`insert into inspection_links (order_id, created_by, token_hash, expires_at) values (${due.id}, ${spec.user.id}, 'morning-1', ${at(tomorrow, '09:00')})`;
  await S.sql`insert into inspection_links (order_id, created_by, token_hash, expires_at) values (${later.id}, ${spec.user.id}, 'morning-2', ${at(tomorrow, '18:00')})`;

  assert.equal(await sendMorning(S.sql, { now: at(today, '07:30') }), 0);
  assert.equal((await S.sql`select count(*)::int as n from morning_digests`)[0].n, 0);

  assert.equal(await sendMorning(S.sql, { now: at(today, '12:00') }), 2);
  const [d] = await S.sql`select due, overdue, visits, links from morning_digests where user_id = ${spec.user.id}`;
  assert.deepEqual({ ...d }, { due: 1, overdue: 1, visits: 1, links: 1 });
  assert.equal((await mine(spec.user.id)).length, 1);
  assert.equal((await mine(helper.user.id)).length, 1);
  // Без дел — сводки нет, но день посчитан (не считаем заново каждую минуту).
  assert.equal((await mine(idle.user.id)).length, 0);
  assert.equal((await S.sql`select count(*)::int as n from morning_digests where user_id = ${idle.user.id} and notification_id is null`)[0].n, 1);
  assert.equal(await sendMorning(S.sql, { now: at(today, '12:05') }), 0);

  // В ленте — цифры, ведёт к «Моим срокам»; название дела нигде не звучит.
  const feed = (await spec.req('GET', '/api/notifications')).body.notifications.filter((n) => n.title.startsWith('На сегодня'));
  assert.equal(feed.length, 1);
  assert.equal(feed[0].title, 'На сегодня: сдать 1 дело, 1 дело с прошедшим сроком, 1 выезд на объект, 1 ссылка на осмотр истекает в ближайшие сутки');
  assert.deepEqual([feed[0].section, feed[0].order_id, feed[0].order_ref], ['specialist&to=schedule', null, null]);
  const hfeed = (await helper.req('GET', '/api/notifications')).body.notifications.filter((n) => n.title.startsWith('На сегодня'));
  assert.equal(hfeed[0].title, 'На сегодня: 1 выезд на объект');
  const [sms] = await S.sql`select d.body from notification_deliveries d join notifications n on n.id = d.notification_id
                            where n.user_id = ${spec.user.id} and n.event = 'morning_today'`;
  assert.equal(sms.body, `БЕРТЕЛ Дело: ${feed[0].title}. Подробно — «Мои сроки» в кабинете.`);
  assert.ok(sms.body.length <= 300);
  assert.doesNotMatch(sms.body, /Утренн|Квартира|Москва/);
});

test('СМС сводки выключается отдельно; в настройках вид есть только у специалиста; отключённой учётке — ничего', async () => {
  const types = (await spec.req('GET', '/api/notifications/settings')).body.settings.map((t) => t.type);
  assert.ok(types.includes('morning'));
  assert.ok(!(await owner.req('GET', '/api/notifications/settings')).body.settings.some((t) => t.type === 'morning'));
  assert.equal((await spec.req('PUT', '/api/notifications/settings', { type: 'morning', sms: false })).status, 200);
  await S.sql`update users set is_active = false where id = ${helper.user.id}`;
  // Назавтра: дело «сдать сегодня» стало с прошедшим сроком — сводка снова, но без СМС; помощнику (отключён) — нет.
  assert.equal(await sendMorning(S.sql, { now: at(tomorrow, '08:01') }), 1);
  const [d] = await S.sql`select due, overdue, visits, links, notification_id from morning_digests where user_id = ${spec.user.id} and day = ${tomorrow}::date`;
  assert.deepEqual([d.due, d.overdue], [0, 2]);
  assert.equal((await S.sql`select count(*)::int as n from notification_deliveries where notification_id = ${d.notification_id}`)[0].n, 0);
  assert.equal((await S.sql`select count(*)::int as n from morning_digests where user_id = ${helper.user.id} and day = ${tomorrow}::date`)[0].n, 0);
  await S.sql`update users set is_active = true where id = ${helper.user.id}`;
});

test('реестр: anchor — только у раздела «Специалист» и только известный блок', async () => {
  const { validateRegistry, TYPES } = await import('../../src/notify/registry.mjs');
  assert.throws(() => validateRegistry(TYPES, { x: { type: 'morning', title: 'т', order: false, section: 'orgs', anchor: 'schedule' } }), /неверный anchor/);
  assert.throws(() => validateRegistry(TYPES, { x: { type: 'morning', title: 'т', order: false, section: 'specialist', anchor: 'нет' } }), /неверный anchor/);
});
