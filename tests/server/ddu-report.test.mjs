// 2.547: сводка за месяц у руководителя — квартиры в новостройке (права по ДДУ): сколько отчётов сдано, сколько из них для банка
// и какая это доля от всех сданных дел для банка, средняя разница итоговой стоимости из последней версии черновика с ценой по
// договору из заявки; цена есть, а итоговой стоимости в черновике нет — отдельной цифрой. По экспертам, за год и в Excel.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, makeOrg, addMember, makeSpecialist } from '../helpers.mjs';
import { todayMsk } from '../../src/orders/workflow.mjs';
import { dduDraftValue } from '../../src/orgs/report.mjs';

let S;
before(async () => { S = await startApp(); });
after(async () => { await S?.close(); });

const draft = (value) => ['## 1. Задание на оценку', '| Задание | Значение |', '| Цена по договору, руб. | 6 000 000 |',
  '## 13. Сравнительный подход', 'Стоимость права требования сравнительным подходом составляет 5 900 000 руб.',
  '## 14. Согласование результатов',
  `Итоговая рыночная стоимость права требования по договору участия в долевом строительстве составляет ${value} руб.`,
  '## 15. Выводы', `Рыночная стоимость права требования на дату оценки составляет ${value} руб.`].join('\n');

test('итоговая стоимость из черновика', () => {
  assert.equal(dduDraftValue(draft('6 600 000')), 6600000);
  assert.equal(dduDraftValue('## 14. Согласование результатов\n[заполнить]'), null, 'стоимости нет');
  assert.equal(dduDraftValue(null), null);
});

test('сводка за месяц — права по ДДУ, доля от дел для банка, разница с ценой по договору; Excel', async () => {
  const org = await makeOrg(S.sql, 'ООО «ДДУ в сводке»');
  const head = await login(S, '+79990005471');
  const a = await login(S, '+79990005472');
  const b = await login(S, '+79990005473');
  const owner = await login(S, '+79990005474');
  await addMember(S.sql, org.id, head.user.id, 'head');
  for (const [c, name] of [[a, 'Эксперт ДДУ А'], [b, 'Эксперт ДДУ Б']]) {
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
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service, title: 'ДДУ 2.547' })).body.order;
    await S.sql`update orders set status = 'done', deadline = ${`${month}-28`}::date, fields = ${JSON.stringify(fields)}::jsonb, executor_user_id = ${executor} where id = ${o.id}`;
    await S.sql`insert into order_status_history (order_id, from_status, to_status, side, at)
                values (${o.id}, 'review', 'done', 'dispatcher', (${`${month}-${day}`}::date + '12:00'::time) at time zone 'Europe/Moscow')`;
    for (const body of drafts) await S.sql`insert into result_drafts (order_id, author_id, source, body) values (${o.id}, ${executor}, 'edit', ${body})`;
    return o;
  };
  const report = async () => (await head.req('GET', `/api/orgs/${org.id}/report?month=${month}`)).body.report;
  let r = await report();
  assert.deepEqual([r.total.ddu_cases, r.total.ddu_bank_pct, r.total.ddu_diff_pct], [0, null, null], 'ДДУ нет');

  const u = { object_type: 'ddu' };
  // А: для банка, цена 6 000 000 — в последней версии 6 600 000 (+10%, раньше 9 000 000); для банка, 5 000 000 → 4 750 000 (−5%);
  // наследство, цены нет.
  await done(a.user.id, 'realty', { ...u, purpose: 'bank', ddu_price: 6000000 }, '10', [draft('9 000 000'), draft('6 600 000')]);
  await done(a.user.id, 'realty', { ...u, purpose: 'bank', ddu_price: 5000000 }, '11', [draft('4 750 000')]);
  await done(a.user.id, 'realty', { ...u, purpose: 'inheritance' }, '12', [draft('3 000 000')]);
  // Б: цена есть, а черновик пустой; квартира для банка — дело для банка, но не ДДУ; машина с ДДУ — не в счёт.
  await done(b.user.id, 'realty', { ...u, purpose: 'sale', ddu_price: 7000000 }, '13', ['## 14. Согласование результатов\n[заполнить]']);
  await done(b.user.id, 'realty', { object_type: 'flat', purpose: 'bank', ddu_price: 1000000 }, '14', [draft('2 000 000')]);
  await done(b.user.id, 'vehicle', { object_type: 'ddu', purpose: 'bank', ddu_price: 1000000 }, '15');

  r = await report();
  const pick = (x) => [x.ddu_cases, x.ddu_bank, x.ddu_bank_pct, x.ddu_priced, x.ddu_diff_n, x.ddu_diff_pct, x.ddu_diff_rub, x.ddu_no_value];
  const ex = (c) => r.experts.find((x) => x.user_id === c.user.id);
  assert.deepEqual(pick(ex(a)), [3, 2, 100, 2, 2, 2.5, 175000, 0]);
  assert.deepEqual(pick(ex(b)), [1, 0, 0, 1, 0, null, null, 1], 'у Б дела для банка есть (квартира, машина), ДДУ среди них нет');
  assert.deepEqual(pick(r.total), [4, 2, 50, 3, 2, 2.5, 175000, 1], 'для банка всего 4: две ДДУ, квартира, машина');

  const text = (await head.req('GET', `/api/orgs/${org.id}/report?month=${month}&format=csv`, undefined, { binary: true })).body.toString('utf8');
  assert.match(text, /Квартиры в новостройке \(права по ДДУ\) — по экспертам;Сдано;Для банка;Доля от дел для банка, %;Сравнено с ценой по договору;Средняя разница с ценой по договору, %;Средняя разница с ценой по договору, руб\.;Цена есть, итоговой стоимости в черновике нет/);
  assert.match(text, /Эксперт ДДУ А;3;2;100;2;2,5;175000;0\r\n/);
  assert.match(text, /Эксперт ДДУ Б;1;0;0;0;;;1\r\n/);
  assert.match(text, /Итого;4;2;50;2;2,5;175000;1\r\n/);

  const y = (await head.req('GET', `/api/orgs/${org.id}/report?year=${month.slice(0, 4)}`)).body.report;
  assert.deepEqual(pick(y.total), pick(r.total), 'за год — то же');
  assert.equal((await a.req('GET', `/api/orgs/${org.id}/report?month=${month}`)).status, 403, 'только руководитель');
});
