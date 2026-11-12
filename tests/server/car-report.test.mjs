// 2.478: сводка за месяц у руководителя — сданные дела «Ущерб автомобилю после ДТП»: сколько, по «Как считать ремонт» из
// заявки и средняя разница суммы эксперта с суммой страховой (сверка 2.475); по экспертам и в таблице для Excel.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, makeOrg, addMember, makeSpecialist } from '../helpers.mjs';
import { todayMsk } from '../../src/orders/workflow.mjs';

let S;
before(async () => { S = await startApp(); });
after(async () => { await S?.close(); });

test('сводка за месяц — дела по ДТП по методике и разница со страховой; по экспертам; таблица для Excel', async () => {
  const org = await makeOrg(S.sql, 'ООО «ДТП в сводке»');
  const head = await login(S, '+79990004781');
  const a = await login(S, '+79990004782');
  const b = await login(S, '+79990004783');
  const owner = await login(S, '+79990004784');
  await addMember(S.sql, org.id, head.user.id, 'head');
  for (const [c, name] of [[a, 'Эксперт ДТП А'], [b, 'Эксперт ДТП Б']]) {
    await makeSpecialist(S.sql, c.user.id);
    await addMember(S.sql, org.id, c.user.id, 'member');
    await c.req('PATCH', '/api/me', { full_name: name });
    assert.equal((await c.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  }
  await S.sql`update org_members set created_at = now() - interval '120 days' where org_id = ${org.id}`;
  await S.sql`update organizations set created_at = now() - interval '120 days' where id = ${org.id}`;
  const d = new Date(`${todayMsk().slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1);
  const month = d.toISOString().slice(0, 7);
  const done = async (executor, service, fields, day, calc = null) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service, title: 'ДТП 2.478' })).body.order;
    await S.sql`update orders set status = 'done', deadline = ${`${month}-28`}::date, fields = ${JSON.stringify(fields)}::jsonb, executor_user_id = ${executor} where id = ${o.id}`;
    await S.sql`insert into order_status_history (order_id, from_status, to_status, side, at)
                values (${o.id}, 'review', 'done', 'dispatcher', (${`${month}-${day}`}::date + '12:00'::time) at time zone 'Europe/Moscow')`;
    if (calc) {
      await S.sql`insert into insurer_calcs (order_id, wear, insurer_kop, own_kop, created_by)
                  values (${o.id}, 'with', ${calc[0]}, ${calc[1]}, ${executor})`;
    }
    return o;
  };
  const report = async () => (await head.req('GET', `/api/orgs/${org.id}/report?month=${month}`)).body.report;
  let r = await report();
  assert.deepEqual(r.by_method, [], 'дел по ДТП нет');
  assert.equal(r.total.car_cases, 0);

  // А: два по ОСАГО — эксперт больше страховой на 20 000 и на 10 000 ₽; одно по рыночным без своей суммы (сверки нет).
  await done(a.user.id, 'car_damage', { method: 'osago' }, '10', [5000000, 7000000]);
  await done(a.user.id, 'car_damage', { method: 'osago' }, '11', [3000000, 4000000]);
  await done(a.user.id, 'car_damage', { method: 'market' }, '12', [3000000, null]);
  // Б: рыночные — эксперт меньше на 5 000 ₽; «Не знаю» без сверки; метод не указан; оценка недвижимости — не в счёт.
  await done(b.user.id, 'car_damage', { method: 'market' }, '13', [6000000, 5500000]);
  await done(b.user.id, 'car_damage', { method: 'unknown' }, '14');
  await done(b.user.id, 'car_damage', {}, '15');
  await done(b.user.id, 'realty', { purpose: 'deal' }, '16');

  r = await report();
  assert.deepEqual(r.by_method, [
    { id: 'market', name: 'По рыночным ценам — для суда или к виновнику', done: 2, compared: 1, diff_kop: -500000 },
    { id: 'osago', name: 'По Единой методике — спор со страховой по ОСАГО', done: 2, compared: 2, diff_kop: 1500000 },
    { id: 'unknown', name: 'Не знаю — подскажет эксперт', done: 1, compared: 0, diff_kop: null },
    { id: '', name: 'Не указано в заявке', done: 1, compared: 0, diff_kop: null },
  ]);
  const row = (c) => r.experts.find((x) => x.user_id === c.user.id);
  assert.deepEqual([row(a).car_cases, row(a).car_compared, row(a).car_diff_kop, row(a).car_more, row(a).car_less, row(a).car_no_calc], [3, 2, 1500000, 2, 0, 1]);
  assert.deepEqual([row(b).car_cases, row(b).car_compared, row(b).car_diff_kop, row(b).car_more, row(b).car_less, row(b).car_no_calc], [3, 1, -500000, 0, 1, 2]);
  assert.deepEqual([r.total.car_cases, r.total.car_compared, r.total.car_diff_kop, r.total.car_more, r.total.car_less, r.total.car_same],
    [6, 3, 833333, 2, 1, 0]);

  const text = (await head.req('GET', `/api/orgs/${org.id}/report?month=${month}&format=csv`, undefined, { binary: true })).body.toString('utf8');
  assert.match(text, /Дела по ДТП — как считали ремонт;Сдано;Со сверкой с расчётом страховой/);
  assert.match(text, /По рыночным ценам — для суда или к виновнику;2;1;-5000,00/);
  assert.match(text, /По Единой методике — спор со страховой по ОСАГО;2;2;15000,00/);
  assert.match(text, /Эксперт ДТП А;3;2;15000,00;2;0;0;1/);
  assert.match(text, /Итого;6;3;8333,33;2;1;0;3/);

  // За год — то же.
  const y = (await head.req('GET', `/api/orgs/${org.id}/report?year=${month.slice(0, 4)}`)).body.report;
  assert.equal(y.total.car_cases, 6);
  assert.equal((await a.req('GET', `/api/orgs/${org.id}/report?month=${month}`)).status, 403, 'только руководитель');
});
