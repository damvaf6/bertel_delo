// 2.498: сводка за месяц у руководителя — сданная оценка транспорта: сколько, по виду транспорта и по цели оценки (банк, суд,
// наследство…), средний срок от принятия до сдачи; по экспертам и в таблице для Excel. Дела о ДТП — своим блоком (2.478).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, makeOrg, addMember, makeSpecialist } from '../helpers.mjs';
import { todayMsk } from '../../src/orders/workflow.mjs';

let S;
before(async () => { S = await startApp(); });
after(async () => { await S?.close(); });

test('сводка за месяц — оценка транспорта по виду и цели, средний срок; по экспертам; таблица для Excel', async () => {
  const org = await makeOrg(S.sql, 'ООО «Транспорт в сводке»');
  const head = await login(S, '+79990004981');
  const a = await login(S, '+79990004982');
  const b = await login(S, '+79990004983');
  const owner = await login(S, '+79990004984');
  await addMember(S.sql, org.id, head.user.id, 'head');
  for (const [c, name] of [[a, 'Эксперт транспорта А'], [b, 'Эксперт транспорта Б']]) {
    await makeSpecialist(S.sql, c.user.id);
    await addMember(S.sql, org.id, c.user.id, 'member');
    await c.req('PATCH', '/api/me', { full_name: name });
    assert.equal((await c.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  }
  await S.sql`update org_members set created_at = now() - interval '120 days' where org_id = ${org.id}`;
  await S.sql`update organizations set created_at = now() - interval '120 days' where id = ${org.id}`;
  const d = new Date(`${todayMsk().slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1);
  const month = d.toISOString().slice(0, 7);
  // Дело сдано в день day, принято экспертом в день taken (без принятия — в средний срок не идёт).
  const done = async (executor, service, fields, day, taken) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service, title: 'Транспорт 2.498' })).body.order;
    await S.sql`update orders set status = 'done', deadline = ${`${month}-28`}::date, fields = ${JSON.stringify(fields)}::jsonb, executor_user_id = ${executor} where id = ${o.id}`;
    await S.sql`insert into order_status_history (order_id, from_status, to_status, side, at)
                values (${o.id}, 'review', 'done', 'dispatcher', (${`${month}-${day}`}::date + '12:00'::time) at time zone 'Europe/Moscow')`;
    if (taken) {
      await S.sql`insert into order_offers (order_id, specialist_id, score, outcome, outcome_at)
                  values (${o.id}, ${executor}, '{}'::jsonb, 'accepted', (${`${month}-${taken}`}::date + '10:00'::time) at time zone 'Europe/Moscow')`;
    }
    return o;
  };
  const report = async () => (await head.req('GET', `/api/orgs/${org.id}/report?month=${month}`)).body.report;
  let r = await report();
  assert.deepEqual(r.by_vehicle, [], 'оценки транспорта нет');
  assert.deepEqual(r.by_vehicle_purpose, []);
  assert.equal(r.total.veh_cases, 0);
  assert.equal(r.total.veh_avg_days, null);

  // А: легковая для банка (4 дня) и для суда (2 дня); грузовой для наследства без отметки о принятии.
  await done(a.user.id, 'vehicle', { vehicle_type: 'car', purpose: 'bank' }, '10', '06');
  await done(a.user.id, 'vehicle', { vehicle_type: 'car', purpose: 'court' }, '12', '10');
  await done(a.user.id, 'vehicle', { vehicle_type: 'truck', purpose: 'inheritance' }, '14');
  // Б: мотоцикл для банка (3 дня); вид и цель не указаны (6 дней); ДТП и недвижимость — не в счёт.
  await done(b.user.id, 'vehicle', { vehicle_type: 'moto', purpose: 'bank' }, '15', '12');
  await done(b.user.id, 'vehicle', {}, '20', '14');
  await done(b.user.id, 'car_damage', { vehicle_type: 'car', method: 'osago' }, '16', '15');
  await done(b.user.id, 'realty', { purpose: 'bank' }, '17', '16');

  r = await report();
  assert.deepEqual(r.by_vehicle, [
    { id: 'car', name: 'Легковой автомобиль', done: 2, avg_days: 3 },
    { id: 'truck', name: 'Грузовой автомобиль', done: 1, avg_days: null },
    { id: 'moto', name: 'Мотоцикл', done: 1, avg_days: 3 },
    { id: '', name: 'Не указано в заявке', done: 1, avg_days: 6 },
  ]);
  assert.deepEqual(r.by_vehicle_purpose, [
    { id: 'court', name: 'Для суда', done: 1, avg_days: 2 },
    { id: 'inheritance', name: 'Наследство, нотариус', done: 1, avg_days: null },
    { id: 'bank', name: 'Ипотека, залог, банк', done: 2, avg_days: 3.5 },
    { id: '', name: 'Не указано в заявке', done: 1, avg_days: 6 },
  ]);
  const row = (c) => r.experts.find((x) => x.user_id === c.user.id);
  assert.deepEqual([row(a).veh_cases, row(a).veh_avg_days], [3, 3]);
  assert.deepEqual([row(b).veh_cases, row(b).veh_avg_days], [2, 4.5]);
  assert.deepEqual([r.total.veh_cases, r.total.veh_avg_days], [5, 3.8]);
  assert.equal(r.total.car_cases, 1, 'ДТП — своим блоком');

  const text = (await head.req('GET', `/api/orgs/${org.id}/report?month=${month}&format=csv`, undefined, { binary: true })).body.toString('utf8');
  assert.match(text, /Оценка транспорта — вид транспорта;Сдано;Средний срок, дней/);
  assert.match(text, /Легковой автомобиль;2;3\r\n/);
  assert.match(text, /Грузовой автомобиль;1;\r\n/);
  assert.match(text, /Оценка транспорта — для чего оценка;Сдано;Средний срок, дней/);
  assert.match(text, /Ипотека, залог, банк;2;3,5/);
  assert.match(text, /Эксперт транспорта Б;2;4,5/);
  assert.match(text, /Итого;5;3,8\r\n/);

  // За год — то же; эксперт сводку не видит.
  const y = (await head.req('GET', `/api/orgs/${org.id}/report?year=${month.slice(0, 4)}`)).body.report;
  assert.equal(y.total.veh_cases, 5);
  assert.equal((await a.req('GET', `/api/orgs/${org.id}/report?month=${month}`)).status, 403, 'только руководитель');
});
