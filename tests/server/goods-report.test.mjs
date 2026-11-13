// 2.488: сводка за месяц у руководителя — сданные товароведческие дела: сколько, по «Что за товар» из заявки и недостатки
// из таблицы дела (2.482) по характеру — производственные, эксплуатационные; по экспертам и в таблице для Excel.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, makeOrg, addMember, makeSpecialist } from '../helpers.mjs';
import { todayMsk } from '../../src/orders/workflow.mjs';

let S;
before(async () => { S = await startApp(); });
after(async () => { await S?.close(); });

test('сводка за месяц — товароведческие дела по виду товара и недостатки по характеру; по экспертам; таблица для Excel', async () => {
  const org = await makeOrg(S.sql, 'ООО «Товар в сводке»');
  const head = await login(S, '+79990004881');
  const a = await login(S, '+79990004882');
  const b = await login(S, '+79990004883');
  const owner = await login(S, '+79990004884');
  await addMember(S.sql, org.id, head.user.id, 'head');
  for (const [c, name] of [[a, 'Эксперт товара А'], [b, 'Эксперт товара Б']]) {
    await makeSpecialist(S.sql, c.user.id);
    await addMember(S.sql, org.id, c.user.id, 'member');
    await c.req('PATCH', '/api/me', { full_name: name });
    assert.equal((await c.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  }
  await S.sql`update org_members set created_at = now() - interval '120 days' where org_id = ${org.id}`;
  await S.sql`update organizations set created_at = now() - interval '120 days' where id = ${org.id}`;
  const d = new Date(`${todayMsk().slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1);
  const month = d.toISOString().slice(0, 7);
  const done = async (executor, service, fields, day, natures = []) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service, title: 'Товар 2.488' })).body.order;
    await S.sql`update orders set status = 'done', deadline = ${`${month}-28`}::date, fields = ${JSON.stringify(fields)}::jsonb, executor_user_id = ${executor} where id = ${o.id}`;
    await S.sql`insert into order_status_history (order_id, from_status, to_status, side, at)
                values (${o.id}, 'review', 'done', 'dispatcher', (${`${month}-${day}`}::date + '12:00'::time) at time zone 'Europe/Moscow')`;
    for (const [i, nature] of natures.entries()) {
      await S.sql`insert into goods_defects (order_id, defect, place, nature, created_by)
                  values (${o.id}, ${`Недостаток ${i + 1}`}, 'корпус', ${nature}, ${executor})`;
    }
    return o;
  };
  const report = async () => (await head.req('GET', `/api/orgs/${org.id}/report?month=${month}`)).body.report;
  let r = await report();
  assert.deepEqual(r.by_goods, [], 'товароведческих дел нет');
  assert.equal(r.total.goods_cases, 0);

  // А: телефон — два производственных и эксплуатационный; телефон — не подтвердился; бытовая техника без таблицы.
  await done(a.user.id, 'goods', { goods_kind: 'gadget' }, '10', ['production', 'production', 'operation']);
  await done(a.user.id, 'goods', { goods_kind: 'gadget' }, '11', ['not_confirmed']);
  await done(a.user.id, 'goods', { goods_kind: 'appliance' }, '12');
  // Б: обувь — эксплуатационный и «не установлен»; вид не указан — производственный; оценка недвижимости и ДТП — не в счёт.
  await done(b.user.id, 'goods', { goods_kind: 'clothes' }, '13', ['operation', 'unknown']);
  await done(b.user.id, 'goods', {}, '14', ['production']);
  await done(b.user.id, 'realty', { purpose: 'deal' }, '15');
  await done(b.user.id, 'car_damage', { method: 'osago' }, '16');

  r = await report();
  assert.deepEqual(r.by_goods, [
    { id: 'gadget', name: 'Телефон, планшет, ноутбук, компьютер', done: 2, defects: 4, production: 2, operation: 1 },
    { id: 'appliance', name: 'Бытовая техника', done: 1, defects: 0, production: 0, operation: 0 },
    { id: 'clothes', name: 'Одежда, обувь, сумки', done: 1, defects: 2, production: 0, operation: 1 },
    { id: '', name: 'Не указано в заявке', done: 1, defects: 1, production: 1, operation: 0 },
  ]);
  const row = (c) => r.experts.find((x) => x.user_id === c.user.id);
  const pick = (x) => [x.goods_cases, x.goods_defects, x.goods_production, x.goods_operation, x.goods_unknown, x.goods_not_confirmed,
    x.goods_prod_cases, x.goods_no_table];
  assert.deepEqual(pick(row(a)), [3, 4, 2, 1, 0, 1, 1, 1]);
  assert.deepEqual(pick(row(b)), [2, 3, 1, 1, 1, 0, 1, 0]);
  assert.deepEqual(pick(r.total), [5, 7, 3, 2, 1, 1, 2, 1]);
  assert.equal(r.total.car_cases, 1, 'ДТП — своей строкой');

  const text = (await head.req('GET', `/api/orgs/${org.id}/report?month=${month}&format=csv`, undefined, { binary: true })).body.toString('utf8');
  assert.match(text, /Товароведческие дела — что за товар;Сдано;Недостатков в таблицах;Производственных;Эксплуатационных/);
  assert.match(text, /Телефон, планшет, ноутбук, компьютер;2;4;2;1/);
  assert.match(text, /Не указано в заявке;1;1;1;0/);
  assert.match(text, /Эксперт товара А;3;4;2;1;0;1;1;1/);
  assert.match(text, /Итого;5;7;3;2;1;1;2;1/);

  // За год — то же; эксперт сводку не видит.
  const y = (await head.req('GET', `/api/orgs/${org.id}/report?year=${month.slice(0, 4)}`)).body.report;
  assert.equal(y.total.goods_cases, 5);
  assert.equal((await a.req('GET', `/api/orgs/${org.id}/report?month=${month}`)).status, 403, 'только руководитель');
});
