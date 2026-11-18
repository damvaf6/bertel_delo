// 2.537: сводка за месяц у руководителя — жилые дома: сколько отчётов сдано, участок под домом по заявке (в собственности, в
// аренде, не оформлен, не указан) и средняя доля участка в итоговой стоимости — из таблицы «Стоимость дома и участка» последней
// версии черновика; участок в собственности, а его стоимости в черновике нет — отдельной цифрой. По экспертам, за год и в Excel.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, makeOrg, addMember, makeSpecialist } from '../helpers.mjs';
import { todayMsk } from '../../src/orders/workflow.mjs';
import { houseFacts, houseTable } from '../../src/orders/house.mjs';

let S;
before(async () => { S = await startApp(); });
after(async () => { await S?.close(); });

const table = (house, land, total, share = '[заполнить]') => [
  '## 14. Согласование результатов', '', '| Стоимость дома и участка | Значение |',
  `| Жилой дом, руб. | ${house} |`,
  `| Земельный участок под домом (кадастровый номер 50:20:0010101:15, 12 сот. — по заявке, сверьте с выпиской ЕГРН на участок), руб. | ${land} |`,
  `| Итого: дом и участок (единый объект, ст. 35 ЗК РФ), руб. | ${total} |`,
  `| Доля участка в итоговой стоимости, % | ${share} |`, '', 'Дальше текст: жилой дом 1 000 000 руб.'].join('\n');

test('суммы и доля участка из таблицы «Стоимость дома и участка»', () => {
  assert.deepEqual(houseFacts(table('7 500 000', '2 500 000', '10 000 000')), { house: 7500000, land: 2500000, total: 10000000, share: 25 },
    'доля не вписана — по суммам');
  assert.deepEqual(houseFacts(table('7 500 000', '2 500 000', '10 000 000', '24,5')).share, 24.5, 'вписана — как у эксперта');
  const empty = houseTable('realty', { object_type: 'house', house_land: 'own', land_cadastral: '50:20:0010101:15', land_area: 12 }).join('\n');
  assert.deepEqual(houseFacts(empty), { house: null, land: null, total: null, share: null }, 'пустая таблица');
  assert.deepEqual(houseFacts('Жилой дом, руб. 5 000 000'), { house: null, land: null, total: null, share: null }, 'таблицы нет');
  assert.equal(houseFacts(table('5 000 000', '[заполнить]', '5 000 000', '150')).share, null, 'не похоже на процент');
});

test('сводка за месяц — дома, участок по заявке и средняя доля участка в итоге; Excel', async () => {
  const org = await makeOrg(S.sql, 'ООО «Дома в сводке»');
  const head = await login(S, '+79990005371');
  const a = await login(S, '+79990005372');
  const b = await login(S, '+79990005373');
  const owner = await login(S, '+79990005374');
  await addMember(S.sql, org.id, head.user.id, 'head');
  for (const [c, name] of [[a, 'Эксперт домов А'], [b, 'Эксперт домов Б']]) {
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
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service, title: 'Дом 2.537' })).body.order;
    await S.sql`update orders set status = 'done', deadline = ${`${month}-28`}::date, fields = ${JSON.stringify(fields)}::jsonb, executor_user_id = ${executor} where id = ${o.id}`;
    await S.sql`insert into order_status_history (order_id, from_status, to_status, side, at)
                values (${o.id}, 'review', 'done', 'dispatcher', (${`${month}-${day}`}::date + '12:00'::time) at time zone 'Europe/Moscow')`;
    for (const body of drafts) await S.sql`insert into result_drafts (order_id, author_id, source, body) values (${o.id}, ${executor}, 'edit', ${body})`;
    return o;
  };
  const report = async () => (await head.req('GET', `/api/orgs/${org.id}/report?month=${month}`)).body.report;
  let r = await report();
  assert.deepEqual([r.total.house_cases, r.total.house_share_avg], [0, null], 'домов нет');

  const h = { object_type: 'house' };
  // А: в собственности — в последней версии 20% по суммам (раньше 40%); в собственности — доля вписана 30; в аренде.
  await done(a.user.id, 'realty', { ...h, house_land: 'own' }, '10', [table('6 000 000', '4 000 000', '10 000 000'), table('8 000 000', '2 000 000', '10 000 000')]);
  await done(a.user.id, 'realty', { ...h, house_land: 'own' }, '11', [table('7 000 000', '[заполнить]', '10 000 000', '30')]);
  await done(a.user.id, 'realty', { ...h, house_land: 'lease' }, '12');
  // Б: в собственности — таблица пустая; не оформлен; не указан; квартира и машина — не в счёт.
  await done(b.user.id, 'realty', { ...h, house_land: 'own' }, '13', [table('[заполнить]', '[заполнить]', '[заполнить]')]);
  await done(b.user.id, 'realty', { ...h, house_land: 'none' }, '14');
  await done(b.user.id, 'realty', { ...h }, '15');
  await done(b.user.id, 'realty', { object_type: 'flat', house_land: 'own' }, '16', [table('1', '1', '2')]);
  await done(b.user.id, 'vehicle', { object_type: 'house', house_land: 'own' }, '17');

  r = await report();
  const pick = (x) => [x.house_cases, x.house_land_own, x.house_land_lease, x.house_land_none, x.house_land_unknown, x.house_share_avg,
    x.house_no_land_value];
  const ex = (c) => r.experts.find((x) => x.user_id === c.user.id);
  assert.deepEqual(pick(ex(a)), [3, 2, 1, 0, 0, 25, 0]);
  assert.deepEqual(pick(ex(b)), [3, 1, 0, 1, 1, null, 1]);
  assert.deepEqual(pick(r.total), [6, 3, 1, 1, 1, 25, 1]);

  const text = (await head.req('GET', `/api/orgs/${org.id}/report?month=${month}&format=csv`, undefined, { binary: true })).body.toString('utf8');
  assert.match(text, /Жилые дома — по экспертам;Сдано;Участок в собственности;Участок в аренде;Участок не оформлен;Участок не указан;Средняя доля участка в итоге, %;Участок в собственности, без его стоимости в черновике/);
  assert.match(text, /Эксперт домов А;3;2;1;0;0;25;0\r\n/);
  assert.match(text, /Эксперт домов Б;3;1;0;1;1;;1\r\n/);
  assert.match(text, /Итого;6;3;1;1;1;25;1\r\n/);

  const y = (await head.req('GET', `/api/orgs/${org.id}/report?year=${month.slice(0, 4)}`)).body.report;
  assert.deepEqual(pick(y.total), pick(r.total), 'за год — то же');
  assert.equal((await a.req('GET', `/api/orgs/${org.id}/report?month=${month}`)).status, 403, 'только руководитель');
});
