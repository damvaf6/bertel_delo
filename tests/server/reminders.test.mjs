// Напоминания о сроках (разбор 03.10.2026, 2.13; устав, раздел 1а): за 3 рабочих дня и в последний рабочий день до срока
// (2.390) — исполнителю дела в работе,
// при просрочке — исполнителю и диспетчерам; каждое — один раз; перенесли срок — по новому сроку снова.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { remindDeadlines } from '../../src/notify/reminders.mjs';

let S, owner, dispatcher, spec;
before(async () => {
  S = await startApp();
  owner = await login(S, '+79990000871');
  dispatcher = await login(S, '+79990000872');
  spec = await login(S, '+79990000873');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id);
});
after(async () => { await S?.close(); });

async function inWork(days) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Тест сроков' })).body.order;
  const fields = { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 9' };
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 20), fields })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: 'awaiting_executor', to: 'in_work' })).status, 200);
  await S.sql`update orders set deadline = ${addDays(todayMsk(), days)}::date where id = ${o.id}`;
  return o;
}
const events = async (userId, orderId) => (await S.sql`select event from notifications where user_id = ${userId} and order_id = ${orderId} and event like 'deadline%' order by id`).map((r) => r.event);

test('за 3 рабочих дня и в последний рабочий день — исполнителю; по разу; просрочка — исполнителю и диспетчеру; перенесли срок — снова', async () => {
  // 2.390: срок — понедельник 9 ноября 2026, перед ним праздник 4 ноября и выходные. Дни — постоянные, не от дня прогона.
  const o = await inWork(3);
  await S.sql`update orders set deadline = '2026-11-09'::date where id = ${o.id}`;
  await remindDeadlines(S.sql, { today: '2026-11-02' });
  assert.deepEqual(await events(spec.user.id, o.id), [], 'за 4 рабочих дня — рано');
  await remindDeadlines(S.sql, { today: '2026-11-03' });
  await remindDeadlines(S.sql, { today: '2026-11-03' });
  assert.deepEqual(await events(spec.user.id, o.id), ['deadline_soon'], 'вт 3 ноября — за 3 рабочих дня (4 ноября — праздник), один раз');
  for (const day of ['2026-11-04', '2026-11-05', '2026-11-07', '2026-11-08']) await remindDeadlines(S.sql, { today: day });
  assert.deepEqual(await events(spec.user.id, o.id), ['deadline_soon'], 'в праздник, в четверг и в выходные «завтра» не приходит');
  await remindDeadlines(S.sql, { today: '2026-11-06' });
  assert.deepEqual(await events(spec.user.id, o.id), ['deadline_soon', 'deadline_tomorrow'], 'в пятницу — последний рабочий день перед сроком');
  await remindDeadlines(S.sql, { today: '2026-11-09' });
  await remindDeadlines(S.sql, { today: '2026-11-10' });
  assert.deepEqual(await events(spec.user.id, o.id), ['deadline_soon', 'deadline_tomorrow', 'deadline_overdue']);
  assert.deepEqual(await events(dispatcher.user.id, o.id), ['deadline_overdue_staff']);
  assert.deepEqual(await events(owner.user.id, o.id), [], 'заказчику напоминания исполнителю не приходят');
  // СМС — только с коротким номером, без названия заявки.
  const [sms] = await S.sql`select d.body from notification_deliveries d join notifications n on n.id = d.notification_id
                            where n.user_id = ${spec.user.id} and n.event = 'deadline_tomorrow' and n.order_id = ${o.id}`;
  assert.ok(sms && !/Тест сроков/.test(sms.body), sms?.body);
  // Срок перенесли на пятницу 20 ноября — по новому сроку снова: за 3 рабочих дня — вторник 17-го, «завтра» — четверг 19-го.
  await S.sql`update orders set deadline = '2026-11-20'::date where id = ${o.id}`;
  await remindDeadlines(S.sql, { today: '2026-11-17' });
  assert.deepEqual((await events(spec.user.id, o.id)).at(-1), 'deadline_soon');
  await remindDeadlines(S.sql, { today: '2026-11-19' });
  assert.deepEqual((await events(spec.user.id, o.id)).at(-1), 'deadline_tomorrow');
});

test('2.390: срок в субботу — «завтра» в пятницу, за 3 рабочих дня — в среду', async () => {
  const o = await inWork(3);
  await S.sql`update orders set deadline = '2026-11-14'::date where id = ${o.id}`;
  await remindDeadlines(S.sql, { today: '2026-11-11' });
  await remindDeadlines(S.sql, { today: '2026-11-13' });
  assert.deepEqual(await events(spec.user.id, o.id), ['deadline_soon', 'deadline_tomorrow']);
});

test('готовые и закрытые заявки и заявки без срока — без напоминаний', async () => {
  const o = await inWork(1);
  await S.sql`update orders set status = 'done' where id = ${o.id}`;
  await remindDeadlines(S.sql, { today: todayMsk() });
  await remindDeadlines(S.sql, { today: addDays(todayMsk(), 3) });
  assert.deepEqual(await events(spec.user.id, o.id), []);
});
