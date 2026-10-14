// 2.226: дни «не принимаю дела» с заданного дня; за 3 дня до первого такого дня — эксперту предупреждение, если срок его
// дел в работе — в эти дни (одно на день начала; сдвинул начало — по новому). До начала подбор эксперта предлагает.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { warnAway } from '../../src/notify/away.mjs';

let S, owner, dispatcher, spec;
const T = todayMsk();
before(async () => {
  S = await startApp();
  owner = await login(S, '+79990002261');
  dispatcher = await login(S, '+79990002262');
  spec = await login(S, '+79990002263');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id);
});
after(async () => { await S?.close(); });

async function newOrder(title) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  const fields = { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 26' };
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(T, 20), fields })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  return o;
}
async function inWork(days, title = 'Дело перед отпуском') {
  const o = await newOrder(title);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: 'awaiting_executor', to: 'in_work' })).status, 200);
  await S.sql`update orders set deadline = ${addDays(T, days)}::date where id = ${o.id}`;
  return o;
}
const warned = async () => (await S.sql`select n.id, d.body from notifications n left join notification_deliveries d on d.notification_id = n.id
                                         where n.user_id = ${spec.user.id} and n.event = 'away_soon' order by n.id`);
const setAway = (away) => spec.req('PATCH', '/api/specialist/me', { away });

test('2.226: день начала — проверка; до него подбор предлагает; «Мои сроки» отмечают только дни с начала', async () => {
  assert.equal((await setAway({ from: T, until: addDays(T, 10) })).status, 400, 'с сегодня — пустое поле');
  assert.equal((await setAway({ from: addDays(T, 10), until: addDays(T, 10) })).status, 400, 'начало раньше возвращения');
  assert.equal((await setAway({ from: '2026-02-30', until: addDays(T, 10) })).status, 400);
  const r = await setAway({ from: addDays(T, 3), until: addDays(T, 10), note: 'отпуск' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.specialist.away, { from: addDays(T, 3), until: addDays(T, 10), note: 'отпуск' });

  // Дни ещё не начались — подбор эксперта предлагает.
  const o = await newOrder('Подбор до отпуска');
  const cands = (await dispatcher.req('GET', `/api/orders/${o.id}/candidates`)).body.candidates;
  assert.ok(cands.some((c) => c.user_id === spec.user.id), 'до начала — в подборе');

  const before3 = await inWork(2, 'Срок до отпуска');
  const inside = await inWork(5, 'Срок в отпуске');
  const s = (await spec.req('GET', '/api/specialist/me/schedule')).body.schedule;
  assert.equal(s.away.from, addDays(T, 3));
  assert.equal(s.days[2].away, false);
  assert.equal(s.days[3].away, true);
  assert.equal(s.days[9].away, true);
  assert.equal(s.days[10].away, false);
  const item = (id) => s.days.flatMap((d) => d.items).find((i) => i.order_id === id && i.kind === 'deadline');
  assert.equal(item(before3.id).away_due, false, 'срок до первого дня — не в отпуске');
  assert.equal(item(inside.id).away_due, true);
  assert.equal(item(inside.id).can_extend, true, 'у дела — «Попросить перенос»');
  assert.equal(s.away_due, 1);
  // Готовая причина «меня не будет» — только у дела со сроком в эти дни.
  const reasons = async (id) => (await spec.req('GET', `/api/orders/${id}/deadline-requests`)).body.reasons?.map((x) => x.id) ?? [];
  assert.ok((await reasons(inside.id)).includes('away'));
  assert.ok(!(await reasons(before3.id)).includes('away'));

  // Начались — подбор не предлагает.
  await S.sql`update specialists set away_from = ${T}::date where user_id = ${spec.user.id}`;
  const cands2 = (await dispatcher.req('GET', `/api/orders/${o.id}/candidates`)).body.candidates;
  assert.ok(!cands2.some((c) => c.user_id === spec.user.id), 'дни начались — не в подборе');
  for (const x of [o, before3, inside]) await S.sql`update orders set status = 'cancelled' where id = ${x.id}`;
  assert.equal((await setAway(null)).status, 200);
});

test('2.226: за 3 дня до начала — одно предупреждение, если срок дел в эти дни; сдвинул начало — снова', async () => {
  await S.sql`delete from notifications where user_id = ${spec.user.id} and event = 'away_soon'`;
  const before3 = await inWork(1);
  assert.equal((await setAway({ from: addDays(T, 4), until: addDays(T, 12) })).status, 200);
  await warnAway(S.sql, { today: T });
  assert.equal((await warned()).length, 0, 'дел со сроком в эти дни нет — не предупреждаем');

  const inside = await inWork(6, 'Секретное название дела');
  await warnAway(S.sql, { today: T });
  assert.equal((await warned()).length, 0, 'за 4 дня — ещё рано');
  await warnAway(S.sql, { today: addDays(T, 1) });
  await warnAway(S.sql, { today: addDays(T, 1) });
  const w = await warned();
  assert.equal(w.length, 1, 'за 3 дня — один раз');
  assert.match(w[0].body, /Вы не принимаете дела, а срок 1 дела — в эти дни/);
  assert.ok(!/Секретное/.test(w[0].body), 'в СМС нет названия дела');
  // Уведомление ведёт к «Моим срокам».
  const feed = (await spec.req('GET', '/api/notifications')).body.notifications.find((n) => n.event === 'away_soon' || /не принимаю дела/.test(n.title));
  assert.equal(feed.section, 'specialist&to=schedule');

  // Сдвинул начало — по новому дню снова.
  assert.equal((await setAway({ from: addDays(T, 3), until: addDays(T, 12) })).status, 200);
  await warnAway(S.sql, { today: T });
  assert.equal((await warned()).length, 2);

  // Уже попросил перенос по делу — предупреждать не о чем.
  assert.equal((await setAway({ from: addDays(T, 2), until: addDays(T, 12) })).status, 200);
  const ask = await spec.req('POST', `/api/orders/${inside.id}/deadline-requests`, { new_deadline: addDays(T, 13), reason: 'В день срока меня не будет' });
  assert.equal(ask.status, 201, JSON.stringify(ask.body));
  await warnAway(S.sql, { today: T });
  assert.equal((await warned()).length, 2, 'просьба о переносе уже есть');
  for (const x of [before3, inside]) await S.sql`update orders set status = 'cancelled' where id = ${x.id}`;
  assert.equal((await setAway(null)).status, 200);
});
