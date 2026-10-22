// Нерабочие праздничные дни РФ (2.371): в «Моих сроках на две недели» и нагрузке экспертов праздник — не будний день и
// не «свободный будень»; срок сдачи в праздник — подсказка о последнем рабочем дне перед ним; готовый новый срок при
// просьбе о переносе и у руководителя — не на праздник.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, makeOrg, addMember, makeSpecialist } from '../helpers.mjs';
import { holidayName, isWorkday, workdayFrom, workdayBefore } from '../../src/orders/holidays.mjs';
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
