// Нагрузка экспертов организации на две недели (2.111): руководитель видит по дням сроки и выезды каждого эксперта, дни
// «не принимает дела» и свободные будни; без заказчика и названий заявок; чужого дела, куда эксперт едет помощником, — без номера.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, makeOrg, addMember, makeSpecialist } from '../helpers.mjs';

let S;
before(async () => { S = await startApp(); });
after(async () => { await S?.close(); });

test('нагрузка экспертов на две недели (2.111): по дням у каждого эксперта организации; только руководитель; без заказчика', async () => {
  const org = await makeOrg(S.sql, 'ООО «Нагрузка на две недели»');
  const head = await login(S, '+79990004951');
  const busy = await login(S, '+79990004952');
  const free = await login(S, '+79990004953');
  const outsider = await login(S, '+79990004954');
  const owner = await login(S, '+79990004955');
  const otherHead = await login(S, '+79990004956');
  await addMember(S.sql, (await makeOrg(S.sql, 'ООО «Чужая нагрузка»')).id, otherHead.user.id, 'head');
  await addMember(S.sql, org.id, head.user.id, 'head');
  for (const [c, name] of [[busy, 'Нагрузка Занятая'], [free, 'Нагрузка Свободный']]) {
    await makeSpecialist(S.sql, c.user.id);
    await addMember(S.sql, org.id, c.user.id, 'member');
    await c.req('PATCH', '/api/me', { full_name: name });
    assert.equal((await c.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  }
  await makeSpecialist(S.sql, outsider.user.id);
  const url = `/api/orgs/${org.id}/schedule`;
  const empty = (await head.req('GET', url)).body.schedule;
  assert.equal(empty.days.length, 14);
  assert.ok(empty.days[0].today);
  assert.deepEqual(empty.experts.map((x) => [x.full_name, x.due, x.visits]), [['Нагрузка Занятая', 0, 0], ['Нагрузка Свободный', 0, 0]]);
  const today = empty.from;
  const plus = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const workdays = empty.days.filter((d) => !d.weekend).length;
  assert.equal(empty.experts[1].free_workdays, workdays);
  const order = async (title, status, days, executor = busy.user.id) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    await S.sql`update orders set status = ${status}, deadline = ${plus(days)}::date, executor_user_id = ${executor} where id = ${o.id}`;
    return o;
  };
  const soon = await order('Нагрузка: через 2 дня', 'in_work', 2);
  const offered = await order('Нагрузка: предложено', 'awaiting_executor', 2);
  const late = await order('Нагрузка: просрочено', 'in_work', -1);
  const far = await order('Нагрузка: через месяц', 'in_work', 30);
  const done = await order('Нагрузка: сдано', 'done', 3);
  const foreign = await order('Нагрузка: чужое', 'in_work', 4, outsider.user.id);
  await S.sql`insert into deadline_requests (order_id, requested_by, old_deadline, new_deadline, reason)
              values (${soon.id}, ${busy.user.id}, ${plus(2)}::date, ${plus(6)}::date, 'Ждём выписку')`;
  // Выезд помощника по делу занятого эксперта; свободный эксперт едет помощником на чужое дело (не нашей организации).
  await S.sql`insert into onsite_visits (order_id, helper_id, assigned_by, planned_at)
              values (${soon.id}, ${outsider.user.id}, ${busy.user.id}, (${plus(1)}::date + time '10:30') at time zone 'Europe/Moscow'),
                     (${foreign.id}, ${free.user.id}, ${outsider.user.id}, (${plus(4)}::date + time '09:00') at time zone 'Europe/Moscow')`;
  await S.sql`update specialists set away_until = ${plus(3)}::date, away_note = 'отпуск' where user_id = ${free.user.id}`;
  const r = await head.req('GET', url);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [b, f] = r.body.schedule.experts;
  const at = (x, n) => x.days[n].items.map((i) => [i.kind, i.order_ref ?? null, i.time ?? null]);
  const ref = (o) => `№ ${o.id.slice(0, 8).toUpperCase()}`;
  assert.deepEqual(b.overdue.map((i) => [i.kind, i.order_ref, i.day]), [['deadline', ref(late), plus(-1)]]);
  assert.deepEqual(at(b, 1), [['visit', ref(soon), '10:30']]);
  assert.deepEqual(at(b, 2).map((i) => i[1]).sort(), [ref(soon), ref(offered)].sort());
  assert.equal(b.days[2].items.find((i) => i.order_ref === ref(soon)).extend_to, plus(6));
  assert.equal(b.days[2].items.find((i) => i.order_ref === ref(offered)).status, 'awaiting_executor');
  assert.deepEqual([b.due, b.visits], [2, 1]);
  // Чужое дело, куда свободный эксперт едет помощником, — без номера; дни «не принимает дела» отмечены.
  assert.deepEqual(at(f, 4), [['helper', null, '09:00']]);
  assert.deepEqual(f.away, { from: null, until: plus(3), note: 'отпуск' });
  assert.deepEqual(f.days.map((d) => d.away).slice(0, 4), [true, true, true, false]);
  assert.equal(f.free_workdays, f.days.filter((d, i) => !r.body.schedule.days[i].weekend && !d.away && !d.items.length).length);
  // Выключил приём (2.194) — все две недели «не принимает новые дела», свободных будней нет; включил — снова как было.
  await S.sql`update specialists set active = false where user_id = ${busy.user.id}`;
  const paused = (await head.req('GET', url)).body.schedule.experts[0];
  assert.equal(paused.paused, true);
  assert.ok(paused.days.every((d) => d.away));
  assert.equal(paused.free_workdays, 0);
  await S.sql`update specialists set active = true where user_id = ${busy.user.id}`;
  const text = JSON.stringify(r.body);
  for (const t of ['Нагрузка:', soon.id, far.id, done.id, foreign.id, ref(foreign), ref(far), ref(done), owner.user.id, 'Ждём выписку']) {
    assert.ok(!text.includes(t), `не раскрывает: ${t}`);
  }
  // Сколько сдавать за две недели — и в «Делах экспертов» (для выбора, кому назначить или передать).
  const load = (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.load;
  assert.deepEqual(load.map((l) => [l.full_name, l.due14]), [['Нагрузка Занятая', 2], ['Нагрузка Свободный', 0]]);
  // Только руководитель: эксперт организации — 403; посторонний и руководитель чужой — «не найдено».
  for (const c of [busy, free]) assert.equal((await c.req('GET', url)).status, 403);
  for (const c of [outsider, otherHead, owner]) assert.equal((await c.req('GET', url)).status, 404);
});

test('2.245: нагрузка — сколько экспертов принимают новые дела в каждый день; никто — 0', async () => {
  const org = await makeOrg(S.sql, 'ООО «Кто принимает дела»');
  const head = await login(S, '+79990004961');
  const a = await login(S, '+79990004962');
  const b = await login(S, '+79990004963');
  await addMember(S.sql, org.id, head.user.id, 'head');
  const url = `/api/orgs/${org.id}/schedule`;
  // Экспертов нет — у дней 0.
  const none = (await head.req('GET', url)).body.schedule;
  assert.ok(none.days.every((d) => d.accepting === 0));
  for (const c of [a, b]) {
    await makeSpecialist(S.sql, c.user.id);
    await addMember(S.sql, org.id, c.user.id, 'member');
    assert.equal((await c.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  }
  assert.ok((await head.req('GET', url)).body.schedule.days.every((d) => d.accepting === 2));
  const today = none.from;
  const plus = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  // Первый не принимает со 2-го по 5-й день, второй выключил приём: со 2-го по 5-й — никто, остальные дни — один.
  await S.sql`update specialists set away_from = ${plus(2)}::date, away_until = ${plus(6)}::date where user_id = ${a.user.id}`;
  await S.sql`update specialists set active = false where user_id = ${b.user.id}`;
  const s = (await head.req('GET', url)).body.schedule;
  assert.deepEqual(s.days.map((d) => d.accepting), [1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1]);
  // Совпадает с днями «не принимает» у экспертов.
  s.days.forEach((d, i) => assert.equal(d.accepting, s.experts.filter((x) => !x.days[i].away).length));
});

test('2.318: нагрузка — срок по заданию на оценку раньше срока дела в день срока по заданию; дело не считается дважды', async () => {
  const org = await makeOrg(S.sql, 'ООО «Срок по заданию в нагрузке»');
  const head = await login(S, '+79990004971');
  const ex = await login(S, '+79990004972');
  const owner = await login(S, '+79990004973');
  await addMember(S.sql, org.id, head.user.id, 'head');
  await makeSpecialist(S.sql, ex.user.id);
  await addMember(S.sql, org.id, ex.user.id, 'member');
  assert.equal((await ex.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  const url = `/api/orgs/${org.id}/schedule`;
  const today = (await head.req('GET', url)).body.schedule.from;
  const plus = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const ruD = (s) => s.split('-').reverse().join('.');
  const order = async (title, days, due) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    await S.sql`update orders set status = 'in_work', deadline = ${plus(days)}::date, executor_user_id = ${ex.user.id} where id = ${o.id}`;
    if (due != null) {
      assert.equal((await owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(`ЗАДАНИЕ НА ОЦЕНКУ\nОбъект оценки: квартира\nСрок составления отчёта: не позднее ${ruD(plus(due))}`), {
        raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('Задание банка Иванова.txt'), 'x-doc-kind': 'basis' } })).status, 201);
    }
    return o;
  };
  const ref = (o) => `№ ${o.id.slice(0, 8).toUpperCase()}`;
  const near = await order('Задание: срок дела в две недели', 9, 3);
  const far = await order('Задание: срок дела через месяц', 30, 5);
  const plain = await order('Задание: без задания', 6);
  const later = await order('Задание: срок по заданию позже', 4, 8);
  const s = (await head.req('GET', url)).body.schedule;
  const [x] = s.experts;
  const on = (n) => x.days[n].items.map((i) => [i.kind, i.order_ref, i.task_due ?? null]);
  assert.deepEqual(on(3), [['task_due', ref(near), { day: plus(3), by: 'по заданию на оценку' }]]);
  assert.deepEqual(on(9), [['deadline', ref(near), plus(3)]]);
  // Срок дела после двух недель — дело видно в день срока по заданию.
  assert.deepEqual(on(5), [['task_due', ref(far), { day: plus(5), by: 'по заданию на оценку' }]]);
  assert.deepEqual(on(6), [['deadline', ref(plain), null]]);
  // Срок по заданию позже срока дела — отметки нет.
  assert.deepEqual(on(4), [['deadline', ref(later), null]]);
  assert.ok(!x.days.some((d) => d.items.some((i) => i.kind === 'task_due' && i.order_ref === ref(later))));
  // Сдать за две недели: near (по заданию), far (по заданию), plain, later — каждое по разу.
  assert.equal(x.due, 4);
  // Без названий файлов и заявок.
  const text = JSON.stringify(s);
  for (const t of ['Иванова', 'Задание:', near.id]) assert.ok(!text.includes(t), `не раскрывает: ${t}`);
  // Срок по заданию прошёл — в «срок уже прошёл».
  const { orgSchedule } = await import('../../src/orders/schedule.mjs');
  const past = await orgSchedule(S.sql, org.id, S.app.locals.registry, plus(4), { storage: S.providers.storage });
  assert.deepEqual(past.experts[0].overdue.filter((i) => i.kind === 'task_due').map((i) => [i.order_ref, i.day]), [[ref(near), plus(3)]]);
  // Без хранилища — как раньше, без сроков по заданию.
  const bare = await orgSchedule(S.sql, org.id, S.app.locals.registry);
  assert.ok(!bare.experts[0].days.some((d) => d.items.some((i) => i.kind === 'task_due')));
  assert.equal(bare.experts[0].due, 3);
});

test('2.354: нагрузка — срок по письму о переносе раньше срока дела в его день; прежний срок и просьба письма с новым сроком', async () => {
  const org = await makeOrg(S.sql, 'ООО «Письмо о переносе в нагрузке»');
  const head = await login(S, '+79990004981');
  const ex = await login(S, '+79990004982');
  const owner = await login(S, '+79990004983');
  await addMember(S.sql, org.id, head.user.id, 'head');
  await makeSpecialist(S.sql, ex.user.id);
  await addMember(S.sql, org.id, ex.user.id, 'member');
  assert.equal((await ex.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  const url = `/api/orgs/${org.id}/schedule`;
  const today = (await head.req('GET', url)).body.schedule.from;
  const plus = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const ruD = (s) => s.split('-').reverse().join('.');
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Письмо: квартира Петрова' })).body.order;
  await S.sql`update orders set status = 'in_work', deadline = ${plus(10)}::date, executor_user_id = ${ex.user.id} where id = ${o.id}`;
  const put = async (body, name) => assert.equal((await owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(body), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name), 'x-doc-kind': 'basis' } })).status, 201);
  const ref = `№ ${o.id.slice(0, 8).toUpperCase()}`;
  const items = async () => (await head.req('GET', url)).body.schedule.experts[0].days
    .flatMap((d) => d.items.map((i) => ({ ...i, date: d.date }))).filter((i) => i.order_ref === ref);
  await put(`ЗАДАНИЕ НА ОЦЕНКУ\nОбъект оценки: квартира\nСрок составления отчёта: не позднее ${ruD(plus(2))}`, 'Задание банка Петрова.txt');
  let s = await items();
  assert.deepEqual(s.find((i) => i.kind === 'task_due').task_due, { day: plus(2), by: 'по заданию на оценку' });
  assert.equal(s.find((i) => i.kind === 'deadline').task_due_letter, undefined);
  // Письмо переносит срок, но всё ещё раньше срока дела — в день письма, с прежним сроком; срок дела не переносили — о
  // просьбе письма ничего.
  await put(`Письмо банка\nСрок составления отчёта продлён: не позднее ${ruD(plus(5))}`, 'Письмо банка Петрова.txt');
  s = await items();
  const t = s.find((i) => i.kind === 'task_due');
  assert.equal(t.date, plus(5));
  assert.deepEqual(t.task_due, { day: plus(5), by: 'по письму заказчика', letter: { was: plus(2), ask: null } });
  const d = s.find((i) => i.kind === 'deadline');
  assert.equal(d.date, plus(10));
  assert.equal(d.task_due, plus(5));
  assert.equal(d.task_due_letter, true);
  // Срок дела перенесён по согласованной просьбе — эксперт может попросить письмо; попросил — день просьбы.
  await S.sql`insert into deadline_requests (order_id, requested_by, old_deadline, new_deadline, reason, outcome, decided_at)
              values (${o.id}, ${ex.user.id}, ${plus(2)}, ${plus(10)}, 'Жду документы', 'approved', now())`;
  assert.deepEqual((await items()).find((i) => i.kind === 'task_due').task_due.letter.ask, { asked_on: null, can_ask: true });
  assert.equal((await ex.req('POST', `/api/orders/${o.id}/doc-requests`, { task_move: true })).status, 201);
  assert.deepEqual((await items()).find((i) => i.kind === 'task_due').task_due.letter.ask, { asked_on: today, can_ask: false });
  // Дело считается один раз — в день срока по письму.
  assert.equal((await head.req('GET', url)).body.schedule.experts[0].due, 1);
  // Новое письмо переносит срок на день срока дела — строки по письму нет, у срока дела «по письму о переносе».
  await put(`Письмо банка\nСрок составления отчёта продлён: не позднее ${ruD(plus(10))}`, 'Второе письмо банка Петрова.txt');
  s = await items();
  assert.deepEqual(s.map((i) => i.kind), ['deadline']);
  assert.deepEqual(s[0].task_letter, { day: plus(10), was: plus(5) });
  // Без названий файлов и заявок.
  const text = JSON.stringify((await head.req('GET', url)).body);
  for (const w of ['Петрова', 'Письмо:', o.id]) assert.ok(!text.includes(w), `не раскрывает: ${w}`);
});
