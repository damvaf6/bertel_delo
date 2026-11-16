// 2.517: сводка за месяц у руководителя — доли и раздел имущества: сколько отчётов об оценке доли сдано, каким способом по
// заявке (рыночная со скидкой / часть стоимости целого / не указан), средняя скидка на долю у «рыночной» — из таблицы «Расчёт
// стоимости доли» последней версии черновика; скидка не вписана — «без скидки в черновике». Раздел имущества — сданные дела с
// целью «Раздел имущества», из них доли. По экспертам, за год и в таблице для Excel.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, makeOrg, addMember, makeSpecialist } from '../helpers.mjs';
import { todayMsk } from '../../src/orders/workflow.mjs';
import { shareDiscount } from '../../src/orders/share.mjs';

let S;
before(async () => { S = await startApp(); });
after(async () => { await S?.close(); });

test('скидка на долю из черновика — процент, «не применяется», пропуск', () => {
  assert.equal(shareDiscount('| Скидка на долю, % | 15 (источник — справочник Лейфера) |'), 15);
  assert.equal(shareDiscount('| Скидка на долю, % | 12,5 |'), 12.5);
  assert.equal(shareDiscount('Скидка на долю 22,5% принята по справочнику'), 22.5);
  assert.equal(shareDiscount('| Скидка на долю | не применяется — оценивается часть стоимости всего объекта |'), 0);
  assert.equal(shareDiscount('| Скидка на долю, % | [заполнить] (источник — [заполнить]) |'), null);
  assert.equal(shareDiscount('Скидка на долю обоснована ниже.\n| Скидка на долю, % | 20 |'), 20, 'строка без числа — дальше');
  assert.equal(shareDiscount(''), null);
});

test('сводка за месяц — доли по способу, средняя скидка из черновика, раздел имущества; Excel', async () => {
  const org = await makeOrg(S.sql, 'ООО «Доли в сводке»');
  const head = await login(S, '+79990005171');
  const a = await login(S, '+79990005172');
  const b = await login(S, '+79990005173');
  const owner = await login(S, '+79990005174');
  await addMember(S.sql, org.id, head.user.id, 'head');
  for (const [c, name] of [[a, 'Эксперт долей А'], [b, 'Эксперт долей Б']]) {
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
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service, title: 'Доля 2.517' })).body.order;
    await S.sql`update orders set status = 'done', deadline = ${`${month}-28`}::date, fields = ${JSON.stringify(fields)}::jsonb, executor_user_id = ${executor} where id = ${o.id}`;
    await S.sql`insert into order_status_history (order_id, from_status, to_status, side, at)
                values (${o.id}, 'review', 'done', 'dispatcher', (${`${month}-${day}`}::date + '12:00'::time) at time zone 'Europe/Moscow')`;
    for (const body of drafts) await S.sql`insert into result_drafts (order_id, author_id, source, body) values (${o.id}, ${executor}, 'edit', ${body})`;
    return o;
  };
  const row = (pct) => `## 14. Согласование результатов\n\n| Расчёт стоимости доли | Значение |\n| Скидка на долю, % | ${pct} |`;
  const report = async () => (await head.req('GET', `/api/orgs/${org.id}/report?month=${month}`)).body.report;
  let r = await report();
  assert.deepEqual([r.total.share_cases, r.total.share_disc_avg, r.total.division_cases], [0, null, 0], 'долей нет');

  const share = { object_type: 'share', share_size: '1/3' };
  // А: рыночная — в последней версии черновика 20% (раньше было 10%); рыночная — 15%; часть стоимости целого для раздела.
  await done(a.user.id, 'realty', { ...share, purpose: 'deal', share_method: 'market' }, '10', [row('10 (источник — справочник)'), row('20 (источник — справочник)')]);
  await done(a.user.id, 'realty', { ...share, purpose: 'deal', share_method: 'market' }, '11', [row('15 (источник — справочник)')]);
  await done(a.user.id, 'realty', { ...share, purpose: 'division', share_method: 'pro_rata' }, '12', [row('не применяется')]);
  // Б: рыночная без скидки в черновике; доля без способа; квартира целиком для раздела; машина для раздела;
  // «доля» у машины (не бывает) и квартира целиком для продажи — не в счёт.
  await done(b.user.id, 'realty', { ...share, purpose: 'court', share_method: 'market' }, '13', [row('[заполнить] (источник — [заполнить])')]);
  await done(b.user.id, 'realty', { ...share, purpose: 'deal' }, '14');
  await done(b.user.id, 'realty', { object_type: 'flat', purpose: 'division' }, '15');
  await done(b.user.id, 'vehicle', { purpose: 'division' }, '16');
  await done(b.user.id, 'vehicle', { object_type: 'share', purpose: 'deal', share_method: 'market' }, '17');
  await done(b.user.id, 'realty', { object_type: 'flat', purpose: 'deal' }, '18');

  r = await report();
  const pick = (x) => [x.share_cases, x.share_market, x.share_pro_rata, x.share_no_method, x.share_disc_avg, x.share_no_disc, x.division_cases, x.division_share];
  const ex = (c) => r.experts.find((x) => x.user_id === c.user.id);
  assert.deepEqual(pick(ex(a)), [3, 2, 1, 0, 17.5, 0, 1, 1]);
  assert.deepEqual(pick(ex(b)), [2, 1, 0, 1, null, 1, 2, 0]);
  assert.deepEqual(pick(r.total), [5, 3, 1, 1, 17.5, 1, 3, 1]);

  const text = (await head.req('GET', `/api/orgs/${org.id}/report?month=${month}&format=csv`, undefined, { binary: true })).body.toString('utf8');
  assert.match(text, /Доли и раздел имущества — по экспертам;Доли: сдано;Рыночная со скидкой;Часть стоимости целого;Способ не указан;Средняя скидка на долю, %;Без скидки в черновике;Раздел имущества: сдано;Из них доли/);
  assert.match(text, /Эксперт долей А;3;2;1;0;17,5;0;1;1\r\n/);
  assert.match(text, /Эксперт долей Б;2;1;0;1;;1;2;0\r\n/);
  assert.match(text, /Итого;5;3;1;1;17,5;1;3;1\r\n/);

  const y = (await head.req('GET', `/api/orgs/${org.id}/report?year=${month.slice(0, 4)}`)).body.report;
  assert.deepEqual(pick(y.total), pick(r.total), 'за год — то же');
  assert.equal((await a.req('GET', `/api/orgs/${org.id}/report?month=${month}`)).status, 403, 'только руководитель');
});
