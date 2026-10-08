// «Напомнить эксперту» (2.125): руководитель организации по делу в работе эксперта — одной кнопкой, не чаще раза в сутки
// по делу; эксперту — уведомление, ведёт к делу. После передачи дела другому эксперту счёт начинается заново.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, makeOrg, addMember } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';

let S, owner, dispatcher, spec, colleague, head, org;
const FIELDS = { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, Напоминальная ул., 5', area: '40' };

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990003601');
  dispatcher = await login(S, '+79990003602');
  spec = await login(S, '+79990003603');
  colleague = await login(S, '+79990003604');
  head = await login(S, '+79990003605');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  org = await makeOrg(S.sql, 'ООО «Напоминание»');
  await addMember(S.sql, org.id, head.user.id, 'head');
  for (const [c, name] of [[spec, 'Эксперт Медленный'], [colleague, 'Эксперт Коллега']]) {
    await makeSpecialist(S.sql, c.user.id);
    await c.req('PATCH', '/api/me', { full_name: name });
    await addMember(S.sql, org.id, c.user.id, 'member');
    assert.equal((await c.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  }
});
after(async () => { await S?.close(); });

async function inWork(title, who = spec) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 9), fields: FIELDS })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: who.user.id, from: 'matching' })).status, 200);
  assert.equal((await who.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  return o;
}
const events = async (userId) => (await S.sql`select count(*)::int as n from notifications where user_id = ${userId} and event = 'org_case_reminder'`)[0].n;
const caseOf = async (o) => (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.cases.find((c) => c.id === o.id);
const remind = (o) => head.req('POST', `/api/orgs/${org.id}/cases/${o.id}/remind`);

test('руководитель напоминает эксперту о деле: уведомление ведёт к делу, снова — через сутки', async () => {
  const o = await inWork('Долго нет отчёта');
  let c = await caseOf(o);
  assert.deepEqual([c.remind.reminded_at, c.remind.can_remind, c.remind.reminders], [null, true, 0]);
  const r = await remind(o);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.remind.can_remind, false);
  assert.ok(r.body.remind.next_remind_at);
  assert.equal(await events(spec.user.id), 1);
  // Эксперту — по делу (открывается дело).
  const n = (await spec.req('GET', '/api/notifications')).body.notifications.find((x) => x.title.startsWith('Руководитель организации напоминает'));
  assert.ok(n, 'уведомление в ленте эксперта');
  assert.equal(n.order_id, o.id);
  // СМС — с коротким номером дела, без названия.
  const sms = (await S.sql`select body from notification_deliveries d join notifications x on x.id = d.notification_id
                           where x.user_id = ${spec.user.id} and x.event = 'org_case_reminder'`)[0]?.body;
  assert.ok(sms?.includes(o.id.slice(0, 8).toUpperCase()), sms);
  assert.ok(!sms.includes('Долго нет отчёта'));
  // Второй раз в те же сутки — нельзя; в «Делах экспертов» видно, когда напоминали.
  assert.equal((await remind(o)).body.error, 'too_often');
  assert.equal(await events(spec.user.id), 1);
  c = await caseOf(o);
  assert.equal(c.remind.can_remind, false);
  assert.ok(c.remind.reminded_at);
  // Прошли сутки — снова можно.
  await S.sql`update case_reminders set created_at = now() - interval '25 hours' where order_id = ${o.id}`;
  assert.equal((await caseOf(o)).remind.can_remind, true);
  assert.equal((await remind(o)).status, 201);
  assert.equal(await events(spec.user.id), 2);
  assert.equal((await caseOf(o)).remind.reminders, 2);
  // В журнале — кто и кому.
  const a = await S.sql`select actor_id, details from audit_log where action = 'org.case.remind' and subject_id = ${o.id}`;
  assert.equal(a.length, 2);
});

test('после передачи дела другому эксперту — напомнить новому можно сразу; сданное дело — нельзя', async () => {
  const o = await inWork('Передали и напомнили');
  assert.equal((await remind(o)).status, 201);
  assert.equal((await head.req('POST', `/api/orgs/${org.id}/cases/${o.id}/transfer`, { specialist_id: colleague.user.id, reason: 'Болезнь' })).status, 200);
  const c = await caseOf(o);
  assert.deepEqual([c.remind.can_remind, c.remind.reminders], [true, 0]);
  assert.equal((await remind(o)).status, 201);
  assert.equal(await events(colleague.user.id), 1);
  // Дело на проверке — кнопки нет, напомнить нельзя.
  await S.sql`update orders set status = 'review' where id = ${o.id}`;
  assert.equal((await caseOf(o)).remind, null);
  assert.equal((await remind(o)).body.error, 'status_changed');
});
