// Нерабочие праздничные дни РФ (2.371): в «Моих сроках на две недели» и нагрузке экспертов праздник — не будний день и
// не «свободный будень»; срок сдачи в праздник — подсказка о последнем рабочем дне перед ним; готовый новый срок при
// просьбе о переносе и у руководителя — не на праздник.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, makeOrg, addMember, makeSpecialist } from '../helpers.mjs';
import { holidayName, isWorkday, isWorkingWeekend, newYearAhead, offDayName, workdayFrom, workdayBefore } from '../../src/orders/holidays.mjs';
import { newYearCases } from '../../src/ops/today-ops.mjs';
import { expertSchedule, orgSchedule } from '../../src/orders/schedule.mjs';
import { extendSuggest } from '../../src/ops/handover-ops.mjs';

let S;
before(async () => { S = await startApp(); });
after(async () => { await S?.close(); });

test('2.371: календарь — праздники по ТК, перенос выходного с субботы и воскресенья, переносы 2026 года', () => {
  assert.equal(holidayName('2026-06-12'), 'День России');
  assert.equal(holidayName('2026-11-04'), 'День народного единства');
  assert.match(holidayName('2026-03-09'), /Международный женский день/); // 8 марта 2026 — воскресенье
  assert.match(holidayName('2026-05-11'), /День Победы/); // 9 мая 2026 — суббота, 10-го воскресенье
  assert.equal(holidayName('2026-01-09'), 'Новогодние каникулы');
  assert.ok(holidayName('2026-12-31'));
  assert.equal(holidayName('2026-10-22'), null);
  assert.equal(isWorkday('2026-11-04'), false);
  assert.equal(isWorkday('2026-11-07'), false); // суббота
  assert.equal(isWorkday('2026-11-05'), true);
  assert.equal(workdayFrom('2026-11-04'), '2026-11-05');
  assert.equal(workdayFrom('2026-12-31'), '2027-01-11');
  assert.equal(workdayBefore('2026-06-12'), '2026-06-11');
  assert.equal(workdayBefore('2026-05-11'), '2026-05-08');
  // Новогодние праздники в выходные не переносятся автоматически — только постановлением.
  assert.equal(holidayName('2027-01-11'), null);
  assert.match(holidayName('2027-06-14'), /День России/);
});

test('2.391: календарь 2027 — переносы по постановлению № 1187 и рабочая суббота 20 февраля', async () => {
  for (const d of ['2027-01-01', '2027-01-08', '2027-02-22', '2027-02-23', '2027-03-08', '2027-05-03', '2027-05-10',
    '2027-06-14', '2027-11-04', '2027-11-05', '2027-12-31']) assert.equal(isWorkday(d), false, d);
  assert.match(holidayName('2027-11-05'), /2 января/);
  assert.match(holidayName('2027-12-31'), /3 января/);
  assert.match(holidayName('2027-02-22'), /20 февраля/);
  // Суббота 20 февраля 2027 — рабочая; соседние субботы — выходные.
  assert.equal(isWorkday('2027-02-20'), true);
  assert.equal(isWorkingWeekend('2027-02-20'), true);
  assert.equal(offDayName('2027-02-20'), null);
  assert.equal(isWorkday('2027-02-27'), false);
  assert.equal(isWorkingWeekend('2027-02-27'), false);
  assert.equal(workdayFrom('2027-11-04'), '2027-11-08');
  assert.equal(workdayBefore('2027-02-23'), '2027-02-20');
  assert.equal(workdayBefore('2028-01-10'), '2027-12-30');
  // «Мои сроки на две недели» с понедельника 15 февраля 2027: суббота 20-го — не выходной, 22-е — выходной.
  const sp = await login(S, '+79990004991');
  await makeSpecialist(S.sql, sp.user.id);
  const s = await expertSchedule(S.sql, sp.user.id, S.app.locals.registry, '2027-02-15');
  assert.equal(s.days.find((d) => d.date === '2027-02-20').weekend, false);
  assert.equal(s.days.find((d) => d.date === '2027-02-22').weekend, true);
  assert.equal(s.days.find((d) => d.date === '2027-02-22').holiday, 'перенос выходного с 20 февраля');
});

test('2.392: рабочая суббота по переносу — пометка `working` в «Моих сроках» и нагрузке, и она свободный будний день', async () => {
  const org = await makeOrg(S.sql, 'ООО «Рабочая суббота»');
  const head = await login(S, '+79990004992');
  const expert = await login(S, '+79990004993');
  await addMember(S.sql, org.id, head.user.id, 'head');
  await makeSpecialist(S.sql, expert.user.id);
  await S.sql`update specialists set org_id = ${org.id} where user_id = ${expert.user.id}`;
  await addMember(S.sql, org.id, expert.user.id, 'member');
  const registry = S.app.locals.registry;
  const s = await expertSchedule(S.sql, expert.user.id, registry, '2027-02-15');
  assert.equal(s.days.find((d) => d.date === '2027-02-20').working, true);
  // Обычная суббота и выходной по переносу — без пометки.
  assert.equal(s.days.find((d) => d.date === '2027-02-27').working, undefined);
  assert.equal(s.days.find((d) => d.date === '2027-02-22').working, undefined);
  const g = await orgSchedule(S.sql, org.id, registry, '2027-02-15');
  const h = g.days.find((d) => d.date === '2027-02-20');
  assert.equal(h.working, true);
  assert.equal(h.weekend, false);
  // С 15 по 28 февраля: 10 будней, без 22 и 23 февраля — 8, и рабочая суббота 20-го — 9.
  assert.equal(g.experts.find((x) => x.user_id === expert.user.id).free_workdays, 9);
});

test('2.371: «Мои сроки» и нагрузка — праздник выходной, срок в праздник с последним рабочим днём; новый срок — не на праздник', async () => {
  const org = await makeOrg(S.sql, 'ООО «Праздники в сроках»');
  const head = await login(S, '+79990004971');
  const expert = await login(S, '+79990004972');
  const owner = await login(S, '+79990004973');
  await addMember(S.sql, org.id, head.user.id, 'head');
  await makeSpecialist(S.sql, expert.user.id);
  await addMember(S.sql, org.id, expert.user.id, 'member');
  assert.equal((await expert.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Срок в праздник' })).body.order;
  await S.sql`update orders set status = 'in_work', deadline = '2026-11-04', executor_user_id = ${expert.user.id} where id = ${o.id}`;
  const registry = S.app.locals.registry;

  // Понедельник 2 ноября 2026: среда 4 ноября — праздник.
  const s = await expertSchedule(S.sql, expert.user.id, registry, '2026-11-02');
  const hol = s.days.find((d) => d.date === '2026-11-04');
  assert.equal(hol.holiday, 'День народного единства');
  assert.equal(hol.weekend, true);
  assert.equal(hol.work_before, '2026-11-03');
  assert.equal(hol.items[0].order_id, o.id);
  assert.equal(s.days.find((d) => d.date === '2026-11-03').holiday, undefined);
  // Суббота — просто выходной, без названия праздника.
  assert.equal(s.days.find((d) => d.date === '2026-11-07').holiday, undefined);

  const g = await orgSchedule(S.sql, org.id, registry, '2026-11-02');
  const h = g.days.find((d) => d.date === '2026-11-04');
  assert.equal(h.holiday, 'День народного единства');
  assert.equal(h.weekend, true);
  // Две недели со 2 ноября: 10 будних дней, из них 4 ноября — праздник; срок дела — в праздник, он не «свободный».
  assert.equal(g.experts[0].free_workdays, 9);

  // Руководитель просит перенос от организации: эксперт не работает до праздника — новый срок на следующий рабочий день.
  assert.equal(extendSuggest({ deadline: '2026-11-03' }, '2026-11-04', '2026-11-02').new_deadline, '2026-11-05');
  // Неделя от срока выпадает на 12 июня — на понедельник 15-го.
  assert.equal(extendSuggest({ deadline: '2026-06-05' }, null, '2026-06-01').new_deadline, '2026-06-15');
  await S.sql`update orders set status = 'cancelled' where id = ${o.id}`;
});

test('2.393: за две недели до новогодних каникул — дела со сроком в каникулы, «сдайте до 30 декабря»', async () => {
  const ny = { from: '2026-12-31', to: '2027-01-10', work_before: '2026-12-30' };
  assert.equal(newYearAhead('2026-12-16'), null, 'больше двух недель — рано');
  assert.deepEqual(newYearAhead('2026-12-17'), ny);
  assert.deepEqual(newYearAhead('2026-12-30'), ny);
  assert.equal(newYearAhead('2026-12-31'), null, 'каникулы уже начались');
  assert.equal(newYearAhead('2026-10-24'), null);
  // 2027: 31 декабря — перенос выходного, каникулы с него.
  assert.equal(newYearAhead('2027-12-20').from, '2027-12-31');
  const o = (id, deadline, status = 'in_work') => ({ id, deadline, status });
  const rows = [o('a', '2027-01-11'), o('b', '2027-01-05'), o('c', '2026-12-31'), o('d', '2027-01-10'), o('e', '2026-12-30'),
    o('f', '2027-01-04', 'review'), o('g', null)];
  const got = newYearCases(rows, '2026-12-20');
  assert.equal(got.work_before, '2026-12-30');
  assert.deepEqual(got.rows.map((x) => x.id), ['c', 'b', 'd'], 'только в работе и срок в каникулы, ближе — выше');
  assert.equal(newYearCases(rows, '2026-12-10'), null);
  assert.equal(newYearCases([o('a', '2027-01-11')], '2026-12-20'), null, 'дел в каникулы нет — группы нет');
  // Через «Сегодня» сейчас (не декабрь) группы нет — поле есть и пустое.
  const exp = await login(S, '+79990003931');
  await makeSpecialist(S.sql, exp.user.id);
  const t = await exp.req('GET', '/api/today');
  assert.equal(t.status, 200);
  assert.equal(t.body.expert.new_year, newYearCases([], t.body.today));
});
