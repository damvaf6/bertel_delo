// Нерабочие праздничные дни РФ (2.371): в «Моих сроках на две недели» и нагрузке экспертов праздник — не будний день и
// не «свободный будень»; срок сдачи в праздник — подсказка о последнем рабочем дне перед ним; готовый новый срок при
// просьбе о переносе и у руководителя — не на праздник.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, makeOrg, addMember, makeSpecialist } from '../helpers.mjs';
import { calendarWarning, holidayName, holidayRunFrom, isWorkday, isWorkingWeekend, newYearAhead, newYearRun, offDayName, workdayFrom, workdayBefore, yearCalendar } from '../../src/orders/holidays.mjs';
import { newYearCases } from '../../src/ops/today-ops.mjs';
import { newYearTerms } from '../../src/dossier/dossier.mjs';
import { expertSchedule, orgSchedule } from '../../src/orders/schedule.mjs';
import { extendSuggest } from '../../src/ops/handover-ops.mjs';
import { scheduleIcs } from '../../src/orders/ics.mjs';

let S;
before(async () => { S = await startApp(); });
after(async () => { await S?.close(); });

test('2.371: календарь — праздники по ТК, перенос выходного с субботы и воскресенья, переносы 2026 года', () => {
  assert.equal(holidayName('2026-06-12'), 'День России');
  assert.equal(holidayName('2026-11-04'), 'День народного единства');
  assert.match(holidayName('2026-03-09'), /Международный женский день/); // 8 марта 2026 — воскресенье
  assert.match(holidayName('2026-05-11'), /День Победы/); // 9 мая 2026 — суббота, 10-го воскресенье
  assert.equal(holidayName('2026-01-09'), 'перенос выходного с 3 января');
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

// 2.405: в декабре аттестат или полис из досье кончается до 15 января — «продлите до каникул» в «Сегодня» эксперта.
test('2.405: досье — аттестат или полис кончается до 15 января, в декабре «продлите до каникул»', async () => {
  assert.deepEqual(newYearRun(2027), { from: '2026-12-31', to: '2027-01-10', work_before: '2026-12-30' });
  assert.equal(newYearRun(2028).from, '2027-12-31');
  const i = (id, kind, valid_until) => ({ id, kind, kind_name: kind, title: 't', number: id, valid_until });
  const items = [i('1', 'policy', '2027-01-15'), i('2', 'certificate', '2027-01-09'), i('3', 'policy_org', '2027-01-16'),
    i('4', 'sro', null), i('5', 'education', '2027-01-05'), i('6', 'policy', '2026-12-05'), i('7', 'certificate', null)];
  const got = newYearTerms(items, '2026-12-10');
  assert.deepEqual({ by: got.by, from: got.from, to: got.to }, { by: '2026-12-30', from: '2026-12-31', to: '2027-01-10' });
  assert.deepEqual(got.items.map((x) => [x.id, x.expired]), [['6', true], ['2', false], ['1', false]],
    'только аттестат и полисы, по 15 января включительно, истёкший — тоже, раньше срок — выше');
  assert.equal(newYearTerms(items, '2026-12-01').items.length, 3, 'с 1 декабря');
  assert.equal(newYearTerms(items, '2026-11-30'), null, 'в ноябре — рано');
  assert.equal(newYearTerms(items, '2026-12-30').items.length, 3, 'последний рабочий день перед каникулами');
  assert.equal(newYearTerms(items, '2026-12-31'), null, 'каникулы начались — продлить уже не успеть');
  assert.equal(newYearTerms([i('3', 'policy_org', '2027-01-16')], '2026-12-10'), null, 'после 15 января — не пишем');
  // Через «Сегодня»: поле у эксперта есть; не декабрь — пусто, даже при полисе до 15 января.
  const exp = await login(S, '+79990004051');
  await makeSpecialist(S.sql, exp.user.id);
  const y = Number(new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 4)) + 1;
  await S.sql`insert into dossier_items (user_id, kind, title, number, valid_until, amount_kop)
              values (${exp.user.id}, 'policy', 'Страховщик', 'П-2405', ${`${y}-01-12`}::date, 30000000)`;
  const t = await exp.req('GET', '/api/today');
  assert.equal(t.status, 200);
  assert.ok('dossier_new_year' in t.body.expert);
  const want = newYearTerms([{ id: 'x', kind: 'policy', kind_name: 'Полис', valid_until: `${y}-01-12` }], t.body.today);
  assert.equal(!!t.body.expert.dossier_new_year, !!want);
  // Чужое досье не попадает: у другого эксперта поля нет.
  const other = await login(S, '+79990004052');
  await makeSpecialist(S.sql, other.user.id);
  assert.equal((await other.req('GET', '/api/today')).body.expert.dossier_new_year, null);
});

// 2.395: день возвращения после «не принимаю дела» — праздник: подсказка продлить до последнего нерабочего дня.
test('2.395: отпуск кончается перед праздниками — away_holiday с последним нерабочим днём', async () => {
  assert.deepEqual(holidayRunFrom('2026-12-31'), { name: 'Новогодние каникулы', to: '2027-01-10', back: '2027-01-11' });
  assert.deepEqual(holidayRunFrom('2026-11-04'), { name: 'День народного единства', to: '2026-11-04', back: '2026-11-05' });
  assert.deepEqual(holidayRunFrom('2027-02-21'), { name: 'День защитника Отечества', to: '2027-02-23', back: '2027-02-24' });
  assert.equal(holidayRunFrom('2026-10-24'), null, 'обычные выходные — без подсказки');
  assert.equal(holidayRunFrom('2026-11-05'), null, 'рабочий день');
  assert.equal(holidayRunFrom('2027-02-20'), null, 'рабочая суббота');
  // Через операцию: ближайший праздник после завтра — в пределах года всегда есть.
  const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  const plus = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  let day = plus(today, 1);
  while (!holidayRunFrom(day)) day = plus(day, 1);
  const run = holidayRunFrom(day);
  const exp = await login(S, '+79990003951');
  await makeSpecialist(S.sql, exp.user.id);
  let r = await exp.req('PATCH', '/api/specialist/me', { away: { until: day, note: 'отпуск' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.specialist.away_holiday, run);
  r = await exp.req('PATCH', '/api/specialist/me', { away: { until: run.back, note: 'отпуск' } });
  assert.equal(r.body.specialist.away_holiday, null, 'продлил до первого рабочего дня — подсказки нет');
  assert.equal(r.body.specialist.away.until, run.back);
  r = await exp.req('PATCH', '/api/specialist/me', { away: null });
  assert.equal(r.body.specialist.away_holiday, null);
});

// 2.396: нерабочие дни в каталоге — подсказка к сроку заявки в выходной или праздник на весь допустимый срок (2 года).
test('2.396: каталог — today и off_days на два года вперёд', async () => {
  const c = await login(S, '+79990003962');
  const r = await c.req('GET', '/api/catalog');
  assert.equal(r.status, 200);
  const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  assert.equal(r.body.today, today);
  const days = Object.keys(r.body.off_days);
  assert.ok(days.every((d) => d >= today && offDayName(d) === r.body.off_days[d]));
  const next = `${Number(today.slice(0, 4)) + 1}-11-04`;
  assert.equal(r.body.off_days[next], 'День народного единства', 'праздник через год с лишним — тоже в перечне');
  assert.ok(!(r.body.off_days['2027-02-20']), 'рабочая суббота — не нерабочий день');
});

test('2.398: файл календаря — срок в нерабочий день: «сдайте до …» и напоминание накануне рабочего дня перед ним', async () => {
  const expert = await login(S, '+79990004981');
  const owner = await login(S, '+79990004982');
  await makeSpecialist(S.sql, expert.user.id);
  const mk = async (title, deadline, status = 'in_work') => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    await S.sql`update orders set status = ${status}, deadline = ${deadline}, executor_user_id = ${expert.user.id} where id = ${o.id}`;
    return o;
  };
  const hol = await mk('В праздник', '2026-11-04');
  const sun = await mk('В воскресенье', '2026-11-08');
  const work = await mk('В будний', '2026-11-05');
  const sent = await mk('Сдано, в субботу', '2026-11-07', 'review');
  const s = await expertSchedule(S.sql, expert.user.id, S.app.locals.registry, '2026-11-02');
  const cal = scheduleIcs(s, new Date('2026-11-02T06:00:00Z')).replace(/\r\n /g, '');
  const ev = (id) => cal.split('BEGIN:VEVENT').find((e) => e.includes(`UID:deadline-${id}@`));

  // Праздник 4 ноября — до вторника 3-го, напоминание 2-го в 9:00 (за сутки и 15 часов до полуночи 4-го).
  assert.match(ev(hol.id), /SUMMARY:Срок сдачи: дело .*— нерабочий день\\, сдайте до 03\.11\.2026\r\n/);
  assert.match(ev(hol.id), /DESCRIPTION:04\.11\.2026 — День народного единства\\, нерабочий день: .*к 03\.11\.2026\. /);
  assert.match(ev(hol.id), /TRIGGER:-P1DT15H\r\n/);
  // Воскресенье 8-го — до пятницы 6-го, напоминание в четверг 5-го.
  assert.match(ev(sun.id), /сдайте до 06\.11\.2026\r\n/);
  assert.match(ev(sun.id), /DESCRIPTION:08\.11\.2026 — воскресенье\\, нерабочий день/);
  assert.match(ev(sun.id), /TRIGGER:-P2DT15H\r\n/);
  // Будний день — как раньше: накануне в 9:00, без «нерабочий день».
  assert.ok(!ev(work.id).includes('нерабочий'));
  assert.match(ev(work.id), /TRIGGER:-PT15H\r\n/);
  // Уже сдано — пометка есть, напоминания нет.
  assert.match(ev(sent.id), /сдайте до 06\.11\.2026\r\n/);
  assert.ok(!ev(sent.id).includes('VALARM'));
  await S.sql`update orders set status = 'cancelled' where id in (${hol.id}, ${sun.id}, ${work.id}, ${sent.id})`;
});

test('2.399: «Праздники и переносы» — год одной страницей, в декабре без следующего года — «дописать постановление»', async () => {
  const c = yearCalendar(2027);
  assert.equal(c.decree, true);
  assert.match(c.source, /№ 1187/);
  // Новогодние каникулы начинаются 31 декабря прошлого года — так и показаны.
  const ny = c.runs[0];
  assert.deepEqual([ny.from, ny.to, ny.days, ny.back], ['2026-12-31', '2027-01-10', 11, '2027-01-11']);
  assert.ok(ny.names.includes('Рождество Христово'));
  // 4 и 5 ноября 2027 (четверг и пятница) с выходными — одни дни отдыха до 7-го.
  const nov = c.runs.find((r) => r.from === '2027-11-04');
  assert.deepEqual([nov.to, nov.days, nov.names], ['2027-11-07', 4, ['День народного единства']]);
  const feb = c.runs.find((r) => r.names.includes('День защитника Отечества'));
  assert.deepEqual([feb.from, feb.to], ['2027-02-21', '2027-02-23']);
  assert.deepEqual(c.working, ['2027-02-20']);
  assert.deepEqual(c.moves.map((m) => m.date), ['2027-02-22', '2027-05-03', '2027-05-10', '2027-06-14', '2027-11-05', '2027-12-31']);
  // Последние дни отдыха года заходят в следующий.
  assert.deepEqual([c.runs.at(-1).from, c.runs.at(-1).to], ['2027-12-31', '2028-01-09']);
  const none = yearCalendar(2028);
  assert.equal(none.decree, false);
  assert.equal(none.source, null);
  assert.deepEqual(none.working, []);
  assert.ok(none.runs.some((r) => r.names.includes('День России')));

  assert.equal(calendarWarning('2026-12-01'), null, '2027 записан');
  assert.equal(calendarWarning('2027-11-30'), null, 'до декабря не тревожим');
  const w = calendarWarning('2027-12-01');
  assert.equal(w.year, 2028);
  assert.match(w.text, /2028.*дописать постановление/i);
  assert.equal(calendarWarning('2028-03-01').year, 2028, 'текущий год не записан — в любой месяц');

  const admin = await login(S, '+79990004399');
  await S.sql`update users set platform_role = 'admin' where id = ${admin.user.id}`;
  const r = await admin.req('GET', '/api/admin/holidays');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.years.map((y) => y.year), [Number(r.body.today.slice(0, 4)), Number(r.body.today.slice(0, 4)) + 1]);
  assert.deepEqual(r.body.warning, calendarWarning(r.body.today));
  const sp = await login(S, '+79990004398');
  assert.equal((await sp.req('GET', '/api/admin/holidays')).status, 404);
});

test('прогон 2.400: «Праздники и переносы» 2026 — оба переноса новогодних выходных (3 января — на 9-е, 4 января — на 31 декабря)', () => {
  const c = yearCalendar(2026);
  assert.deepEqual(c.moves.filter((m) => m.name.includes('января')).map((m) => [m.date, m.name]),
    [['2026-01-09', 'перенос выходного с 3 января'], ['2026-12-31', 'перенос выходного с 4 января']]);
  // В днях отдыха — сами праздники, а не «перенос»; в «не принимаю дела до …» — тоже праздник.
  assert.deepEqual(c.runs[0].names, ['Новогодние каникулы', 'Рождество Христово']);
  assert.equal(holidayRunFrom('2026-01-09').name, 'Новогодние каникулы');
  assert.equal(offDayName('2026-01-09'), 'перенос выходного с 3 января');
});
