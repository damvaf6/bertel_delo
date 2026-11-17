// 2.527: сводка за месяц у руководителя — нежилые помещения: сколько отчётов сдано, по назначению из заявки, сколько сдаётся в
// аренду, у скольких в последней версии черновика посчитан доходный подход и средняя ставка капитализации по ним; сдаётся, а
// доходного подхода нет — отдельной цифрой. По экспертам, за год и в таблице для Excel.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, makeOrg, addMember, makeSpecialist } from '../helpers.mjs';
import { todayMsk } from '../../src/orders/workflow.mjs';
import { incomeFacts, incomeTable } from '../../src/orders/income.mjs';

let S;
before(async () => { S = await startApp(); });
after(async () => { await S?.close(); });

test('ставка капитализации и стоимость доходным подходом из черновика', () => {
  assert.deepEqual(incomeFacts('| Ставка капитализации, % | 10,5 (источник — справочник) |\n| Стоимость доходным подходом (ЧОД / ставка), руб. | 12 000 000 |'),
    { cap: 10.5, value: 12000000 });
  assert.deepEqual(incomeFacts(incomeTable('realty', { object_type: 'commercial', area: 120 }).join('\n')), { cap: null, value: null }, 'пустая таблица');
  assert.deepEqual(incomeFacts('Ставка капитализации определена ниже.\nСтавка капитализации 11% по данным справочника.\n'
    + 'Стоимость объекта оценки доходным подходом составляет 9 500 000 руб.'), { cap: 11, value: 9500000 }, 'текстом, строка без числа — дальше');
  assert.deepEqual(incomeFacts('| Ставка капитализации, % | 250 |'), { cap: null, value: null }, 'не похоже на процент');
  assert.deepEqual(incomeFacts(''), { cap: null, value: null });
});

test('сводка за месяц — нежилые по назначению, аренда, доходный подход и средняя ставка капитализации; Excel', async () => {
  const org = await makeOrg(S.sql, 'ООО «Нежилое в сводке»');
  const head = await login(S, '+79990005271');
  const a = await login(S, '+79990005272');
  const b = await login(S, '+79990005273');
  const owner = await login(S, '+79990005274');
  await addMember(S.sql, org.id, head.user.id, 'head');
  for (const [c, name] of [[a, 'Эксперт нежилого А'], [b, 'Эксперт нежилого Б']]) {
    await makeSpecialist(S.sql, c.user.id);
    await addMember(S.sql, org.id, c.user.id, 'member');
    await c.req('PATCH', '/api/me', { full_name: name });
    assert.equal((await c.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  }
  await S.sql`update org_members set created_at = now() - interval '120 days' where org_id = ${org.id}`;
  await S.sql`update organizations set created_at = now() - interval '120 days' where id = ${org.id}`;
  const d = new Date(`${todayMsk().slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1);
  const month = d.toISOString().slice(0, 7);
  const done = async (executor, service, fields, day, drafts = []) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service, title: 'Нежилое 2.527' })).body.order;
    await S.sql`update orders set status = 'done', deadline = ${`${month}-28`}::date, fields = ${JSON.stringify(fields)}::jsonb, executor_user_id = ${executor} where id = ${o.id}`;
    await S.sql`insert into order_status_history (order_id, from_status, to_status, side, at)
                values (${o.id}, 'review', 'done', 'dispatcher', (${`${month}-${day}`}::date + '12:00'::time) at time zone 'Europe/Moscow')`;
    for (const body of drafts) await S.sql`insert into result_drafts (order_id, author_id, source, body) values (${o.id}, ${executor}, 'edit', ${body})`;
    return o;
  };
  const calc = (cap, value) => `## 13. Доходный подход\n\n| Расчёт доходным подходом | Значение |\n| Ставка капитализации, % | ${cap} |\n`
    + `| Стоимость доходным подходом (ЧОД / ставка), руб. | ${value} |`;
  const report = async () => (await head.req('GET', `/api/orgs/${org.id}/report?month=${month}`)).body.report;
  let r = await report();
  assert.deepEqual([r.total.prem_cases, r.total.prem_cap_avg], [0, null], 'нежилых нет');

  const com = { object_type: 'commercial' };
  // А: офис сдаётся — в последней версии 12% (раньше 9%); склад сдаётся частично — 10%; магазин не сдаётся — доходный подход
  // посчитан без ставки (вписана стоимость, ставка — пропуск).
  await done(a.user.id, 'realty', { ...com, premises_use: 'office', lease: 'full' }, '10', [calc('9', '10 000 000'), calc('12 (источник — справочник)', '8 000 000')]);
  await done(a.user.id, 'realty', { ...com, premises_use: 'warehouse', lease: 'part' }, '11', [calc('10', '15 000 000')]);
  await done(a.user.id, 'realty', { ...com, premises_use: 'retail', lease: 'no' }, '12', [calc('[заполнить]', '7 000 000')]);
  // Б: офис сдаётся — таблица пустая; свободное назначение без аренды; без назначения; квартира и машина — не в счёт.
  await done(b.user.id, 'realty', { ...com, premises_use: 'office', lease: 'full' }, '13', [calc('[заполнить] (источник — [заполнить])', '[заполнить]')]);
  await done(b.user.id, 'realty', { ...com, premises_use: 'free' }, '14');
  await done(b.user.id, 'realty', { ...com }, '15');
  await done(b.user.id, 'realty', { object_type: 'flat', lease: 'full' }, '16', [calc('8', '5 000 000')]);
  await done(b.user.id, 'vehicle', { object_type: 'commercial', premises_use: 'office' }, '17');

  r = await report();
  const pick = (x) => [x.prem_cases, x.prem_office, x.prem_retail, x.prem_warehouse, x.prem_free, x.prem_no_use, x.prem_leased, x.prem_income,
    x.prem_cap_avg, x.prem_leased_no_income];
  const ex = (c) => r.experts.find((x) => x.user_id === c.user.id);
  assert.deepEqual(pick(ex(a)), [3, 1, 1, 1, 0, 0, 2, 3, 11, 0]);
  assert.deepEqual(pick(ex(b)), [3, 1, 0, 0, 1, 1, 1, 0, null, 1]);
  assert.deepEqual(pick(r.total), [6, 2, 1, 1, 1, 1, 3, 3, 11, 1]);

  const text = (await head.req('GET', `/api/orgs/${org.id}/report?month=${month}&format=csv`, undefined, { binary: true })).body.toString('utf8');
  assert.match(text, /Нежилые помещения — по экспертам;Сдано;Офис;Магазин, общепит, услуги;Склад, производство;Свободное назначение;Назначение не указано;Сдаётся в аренду;С доходным подходом;Средняя ставка капитализации, %;Сдаётся, без доходного подхода/);
  assert.match(text, /Эксперт нежилого А;3;1;1;1;0;0;2;3;11;0\r\n/);
  assert.match(text, /Эксперт нежилого Б;3;1;0;0;1;1;1;0;;1\r\n/);
  assert.match(text, /Итого;6;2;1;1;1;1;3;3;11;1\r\n/);

  const y = (await head.req('GET', `/api/orgs/${org.id}/report?year=${month.slice(0, 4)}`)).body.report;
  assert.deepEqual(pick(y.total), pick(r.total), 'за год — то же');
  assert.equal((await a.req('GET', `/api/orgs/${org.id}/report?month=${month}`)).status, 403, 'только руководитель');
});
