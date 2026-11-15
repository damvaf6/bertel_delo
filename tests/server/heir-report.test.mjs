// 2.508: сводка за месяц у руководителя — сданная оценка для наследства: сколько, по виду объекта, сколько с несколькими
// объектами наследства и насколько дата оценки (день открытия наследства) раньше сдачи — в среднем, в месяцах; по экспертам
// и в таблице для Excel. Дела без настоящей даты (или с датой позже сдачи) — «без даты», в среднее не идут.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, makeOrg, addMember, makeSpecialist } from '../helpers.mjs';
import { todayMsk } from '../../src/orders/workflow.mjs';

let S;
before(async () => { S = await startApp(); });
after(async () => { await S?.close(); });

// День за days дней до iso — «ДД.ММ.ГГГГ», как пишет заказчик в заявке.
const ruBefore = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10).split('-').reverse().join('.');
};

test('сводка за месяц — оценка для наследства по виду объекта, несколько объектов, дата оценки раньше сдачи; Excel', async () => {
  const org = await makeOrg(S.sql, 'ООО «Наследство в сводке»');
  const head = await login(S, '+79990005081');
  const a = await login(S, '+79990005082');
  const b = await login(S, '+79990005083');
  const owner = await login(S, '+79990005084');
  await addMember(S.sql, org.id, head.user.id, 'head');
  for (const [c, name] of [[a, 'Эксперт наследства А'], [b, 'Эксперт наследства Б']]) {
    await makeSpecialist(S.sql, c.user.id);
    await addMember(S.sql, org.id, c.user.id, 'member');
    await c.req('PATCH', '/api/me', { full_name: name });
    assert.equal((await c.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  }
  await S.sql`update org_members set created_at = now() - interval '120 days' where org_id = ${org.id}`;
  await S.sql`update organizations set created_at = now() - interval '120 days' where id = ${org.id}`;
  const d = new Date(`${todayMsk().slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1);
  const month = d.toISOString().slice(0, 7);
  const done = async (executor, service, fields, day) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service, title: 'Наследство 2.508' })).body.order;
    await S.sql`update orders set status = 'done', deadline = ${`${month}-28`}::date, fields = ${JSON.stringify(fields)}::jsonb, executor_user_id = ${executor} where id = ${o.id}`;
    await S.sql`insert into order_status_history (order_id, from_status, to_status, side, at)
                values (${o.id}, 'review', 'done', 'dispatcher', (${`${month}-${day}`}::date + '12:00'::time) at time zone 'Europe/Moscow')`;
    return o;
  };
  const report = async () => (await head.req('GET', `/api/orgs/${org.id}/report?month=${month}`)).body.report;
  let r = await report();
  assert.deepEqual(r.by_heir, [], 'дел для наследства нет');
  assert.deepEqual([r.total.heir_cases, r.total.heir_multi, r.total.heir_no_date, r.total.heir_lag_months], [0, 0, 0, null]);

  // А: квартира — открытие наследства за 183 дня до сдачи, в составе ещё гараж; машина — за 91 день.
  await done(a.user.id, 'realty', { purpose: 'inheritance', death_date: ruBefore(`${month}-10`, 183), heir_objects: 'гараж, ГСК «Ромашка», бокс 12' }, '10');
  await done(a.user.id, 'vehicle', { purpose: 'inheritance', death_date: ruBefore(`${month}-12`, 91) }, '12');
  // Б: квартира без даты; квартира с датой позже сдачи (ошибка в заявке); для банка с датой — не в счёт; ДТП — не в счёт.
  await done(b.user.id, 'realty', { purpose: 'inheritance' }, '14');
  await done(b.user.id, 'realty', { purpose: 'inheritance', death_date: ruBefore(`${month}-15`, -5) }, '15');
  await done(b.user.id, 'realty', { purpose: 'bank', death_date: ruBefore(`${month}-16`, 30) }, '16');
  await done(b.user.id, 'car_damage', { purpose: 'inheritance', method: 'osago' }, '17');

  r = await report();
  assert.deepEqual(r.by_heir, [
    { id: 'realty', name: 'Оценка недвижимости', done: 3, multi: 1, lag_months: 6 },
    { id: 'vehicle', name: r.by_heir[1].name, done: 1, multi: 0, lag_months: 3 },
  ]);
  assert.equal(r.by_heir[1].id, 'vehicle');
  const row = (c) => r.experts.find((x) => x.user_id === c.user.id);
  assert.deepEqual([row(a).heir_cases, row(a).heir_multi, row(a).heir_no_date, row(a).heir_lag_months], [2, 1, 0, 4.5]);
  assert.deepEqual([row(b).heir_cases, row(b).heir_multi, row(b).heir_no_date, row(b).heir_lag_months], [2, 0, 2, null]);
  assert.deepEqual([r.total.heir_cases, r.total.heir_multi, r.total.heir_no_date, r.total.heir_lag_months], [4, 1, 2, 4.5]);

  const text = (await head.req('GET', `/api/orgs/${org.id}/report?month=${month}&format=csv`, undefined, { binary: true })).body.toString('utf8');
  assert.match(text, /Оценка для наследства — вид объекта;Сдано;Несколько объектов;Дата оценки раньше сдачи, месяцев/);
  assert.match(text, /Оценка недвижимости;3;1;6\r\n/);
  assert.match(text, /Эксперт наследства А;2;1;0;4,5\r\n/);
  assert.match(text, /Эксперт наследства Б;2;0;2;\r\n/);
  assert.match(text, /Итого;4;1;2;4,5\r\n/);

  // За год — то же; эксперт сводку не видит.
  const y = (await head.req('GET', `/api/orgs/${org.id}/report?year=${month.slice(0, 4)}`)).body.report;
  assert.equal(y.total.heir_cases, 4);
  assert.equal((await a.req('GET', `/api/orgs/${org.id}/report?month=${month}`)).status, 403, 'только руководитель');
});
