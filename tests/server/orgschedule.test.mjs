// Нагрузка экспертов организации на две недели (2.111): руководитель видит по дням сроки и выезды каждого эксперта, дни
// «не принимает дела» и свободные будни; без заказчика и названий заявок; чужого дела, куда эксперт едет помощником, — без номера.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, makeOrg, addMember, makeSpecialist } from '../helpers.mjs';

let S;
before(async () => { S = await startApp(); });
after(async () => { await S?.close(); });

test('нагрузка экспертов на две недели (2.111): по дням у каждого эксперта организации; только руководитель; без заказчика', async () => {
  const org = await makeOrg(S.sql, 'ООО «Нагрузка на две недели»');
  const head = await login(S, '+79990004951');
  const busy = await login(S, '+79990004952');
  const free = await login(S, '+79990004953');
  const outsider = await login(S, '+79990004954');
  const owner = await login(S, '+79990004955');
  const otherHead = await login(S, '+79990004956');
  await addMember(S.sql, (await makeOrg(S.sql, 'ООО «Чужая нагрузка»')).id, otherHead.user.id, 'head');
  await addMember(S.sql, org.id, head.user.id, 'head');
  for (const [c, name] of [[busy, 'Нагрузка Занятая'], [free, 'Нагрузка Свободный']]) {
    await makeSpecialist(S.sql, c.user.id);
    await addMember(S.sql, org.id, c.user.id, 'member');
    await c.req('PATCH', '/api/me', { full_name: name });
    assert.equal((await c.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  }
  await makeSpecialist(S.sql, outsider.user.id);
  const url = `/api/orgs/${org.id}/schedule`;
  const empty = (await head.req('GET', url)).body.schedule;
  assert.equal(empty.days.length, 14);
  assert.ok(empty.days[0].today);
  assert.deepEqual(empty.experts.map((x) => [x.full_name, x.due, x.visits]), [['Нагрузка Занятая', 0, 0], ['Нагрузка Свободный', 0, 0]]);
  const today = empty.from;
  const plus = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const workdays = empty.days.filter((d) => !d.weekend).length;
  assert.equal(empty.experts[1].free_workdays, workdays);
  const order = async (title, status, days, executor = busy.user.id) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    await S.sql`update orders set status = ${status}, deadline = ${plus(days)}::date, executor_user_id = ${executor} where id = ${o.id}`;
    return o;
  };
  const soon = await order('Нагрузка: через 2 дня', 'in_work', 2);
  const offered = await order('Нагрузка: предложено', 'awaiting_executor', 2);
  const late = await order('Нагрузка: просрочено', 'in_work', -1);
  const far = await order('Нагрузка: через месяц', 'in_work', 30);
  const done = await order('Нагрузка: сдано', 'done', 3);
  const foreign = await order('Нагрузка: чужое', 'in_work', 4, outsider.user.id);
  await S.sql`insert into deadline_requests (order_id, requested_by, old_deadline, new_deadline, reason)
              values (${soon.id}, ${busy.user.id}, ${plus(2)}::date, ${plus(6)}::date, 'Ждём выписку')`;
  // Выезд помощника по делу занятого эксперта; свободный эксперт едет помощником на чужое дело (не нашей организации).
  await S.sql`insert into onsite_visits (order_id, helper_id, assigned_by, planned_at)
              values (${soon.id}, ${outsider.user.id}, ${busy.user.id}, (${plus(1)}::date + time '10:30') at time zone 'Europe/Moscow'),
                     (${foreign.id}, ${free.user.id}, ${outsider.user.id}, (${plus(4)}::date + time '09:00') at time zone 'Europe/Moscow')`;
  await S.sql`update specialists set away_until = ${plus(3)}::date, away_note = 'отпуск' where user_id = ${free.user.id}`;
  const r = await head.req('GET', url);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [b, f] = r.body.schedule.experts;
  const at = (x, n) => x.days[n].items.map((i) => [i.kind, i.order_ref ?? null, i.time ?? null]);
  const ref = (o) => `№ ${o.id.slice(0, 8).toUpperCase()}`;
  assert.deepEqual(b.overdue.map((i) => [i.kind, i.order_ref, i.day]), [['deadline', ref(late), plus(-1)]]);
  assert.deepEqual(at(b, 1), [['visit', ref(soon), '10:30']]);
  assert.deepEqual(at(b, 2).map((i) => i[1]).sort(), [ref(soon), ref(offered)].sort());
  assert.equal(b.days[2].items.find((i) => i.order_ref === ref(soon)).extend_to, plus(6));
  assert.equal(b.days[2].items.find((i) => i.order_ref === ref(offered)).status, 'awaiting_executor');
  assert.deepEqual([b.due, b.visits], [2, 1]);
  // Чужое дело, куда свободный эксперт едет помощником, — без номера; дни «не принимает дела» отмечены.
  assert.deepEqual(at(f, 4), [['helper', null, '09:00']]);
  assert.deepEqual(f.away, { until: plus(3), note: 'отпуск' });
  assert.deepEqual(f.days.map((d) => d.away).slice(0, 4), [true, true, true, false]);
  assert.equal(f.free_workdays, f.days.filter((d, i) => !r.body.schedule.days[i].weekend && !d.away && !d.items.length).length);
  const text = JSON.stringify(r.body);
  for (const t of ['Нагрузка:', soon.id, far.id, done.id, foreign.id, ref(foreign), ref(far), ref(done), owner.user.id, 'Ждём выписку']) {
    assert.ok(!text.includes(t), `не раскрывает: ${t}`);
  }
  // Сколько сдавать за две недели — и в «Делах экспертов» (для выбора, кому назначить или передать).
  const load = (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.load;
  assert.deepEqual(load.map((l) => [l.full_name, l.due14]), [['Нагрузка Занятая', 2], ['Нагрузка Свободный', 0]]);
  // Только руководитель: эксперт организации — 403; посторонний и руководитель чужой — «не найдено».
  for (const c of [busy, free]) assert.equal((await c.req('GET', url)).status, 403);
  for (const c of [outsider, otherHead, owner]) assert.equal((await c.req('GET', url)).status, 404);
});
