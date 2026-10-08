// Отбор «Дел экспертов» у руководителя (2.127): по эксперту — по его номеру, по сроку — «Срок на этой неделе»
// (до воскресенья включительно, просроченные тоже); завершённые и сроки после воскресенья — нет.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, makeOrg, addMember } from '../helpers.mjs';
import { addDays, todayMsk, weekEnd } from '../../src/orders/workflow.mjs';

let S, owner, dispatcher, a, b, head, org;
const FIELDS = { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 127', area: '41' };

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990012701');
  dispatcher = await login(S, '+79990012702');
  a = await login(S, '+79990012703');
  b = await login(S, '+79990012704');
  head = await login(S, '+79990012705');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  org = await makeOrg(S.sql, 'ООО «Отбор по неделе»');
  await addMember(S.sql, org.id, head.user.id, 'head');
  for (const [u, n] of [[a, 'Эксперт Один'], [b, 'Эксперт Два']]) {
    await makeSpecialist(S.sql, u.user.id);
    await addMember(S.sql, org.id, u.user.id, 'member');
    await u.req('PATCH', '/api/me', { full_name: n });
    { const r = await u.req('PATCH', '/api/specialist/me', { org_id: org.id }); assert.equal(r.status, 200, JSON.stringify(r.body)); }
  }
});
after(async () => { await S?.close(); });

async function taken(title, days, who) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), Math.max(days, 1)), fields: FIELDS })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: o.status })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: who.user.id, from: 'matching' })).status, 200);
  assert.equal((await who.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  if (days < 1) await S.sql`update orders set deadline = ${addDays(todayMsk(), days)} where id = ${o.id}`;
  return o;
}

test('weekEnd: воскресенье той же недели', () => {
  assert.equal(weekEnd('2026-10-05'), '2026-10-11', 'понедельник');
  assert.equal(weekEnd('2026-10-08'), '2026-10-11', 'четверг');
  assert.equal(weekEnd('2026-10-11'), '2026-10-11', 'воскресенье — тот же день');
  assert.equal(weekEnd('2026-12-29'), '2027-01-03', 'через год');
});

test('дела экспертов (2.127): номер эксперта у дела и «срок на этой неделе»', async () => {
  const today = todayMsk();
  const soon = await taken('Сдать сегодня', 0, a);
  const later = await taken('Сдать через три недели', 21, a);
  const late = await taken('Просрочено', -3, b);
  const done = await taken('Уже сдано', 0, b);
  await S.sql`update orders set status = 'done' where id = ${done.id}`;
  const r = await head.req('GET', `/api/orgs/${org.id}/cases`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const of = (o) => r.body.cases.find((c) => c.id === o.id);
  assert.deepEqual([soon, later, late, done].map((o) => of(o).expert_id), [a.user.id, a.user.id, b.user.id, b.user.id]);
  assert.deepEqual([soon, later, late, done].map((o) => of(o).week), [true, false, true, false]);
  // Срок до воскресенья включительно — на этой неделе; понедельник — уже нет.
  await S.sql`update orders set deadline = ${weekEnd(today)} where id = ${later.id}`;
  let c = (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.cases.find((x) => x.id === later.id);
  assert.equal(c.week, true, 'воскресенье');
  await S.sql`update orders set deadline = ${addDays(weekEnd(today), 1)} where id = ${later.id}`;
  c = (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.cases.find((x) => x.id === later.id);
  assert.equal(c.week, false, 'понедельник следующей недели');
  // Эксперт сам «Дела экспертов» не видит — номера коллег ему не раскрываются.
  assert.equal((await a.req('GET', `/api/orgs/${org.id}/cases`)).status, 403);
});
