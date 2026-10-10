// Заметки эксперта к делу (2.115): свои записи исполнителя, видит только он; напоминание на дату — одно уведомление в ленту
// (без текста заметки) и строка в «Сегодня», пока не «сделано». После передачи дела новый эксперт чужих заметок не видит.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, makeOrg, addMember } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { beforeDeadline, moveDeadlineNotes, remindNotes } from '../../src/ops/note-ops.mjs';

let S, owner, dispatcher, spec, colleague, head, org;
const FIELDS = { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, Заметочная ул., 3', area: '40' };
const today = todayMsk();

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990003601');
  dispatcher = await login(S, '+79990003602');
  spec = await login(S, '+79990003603');
  colleague = await login(S, '+79990003604');
  head = await login(S, '+79990003605');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  org = await makeOrg(S.sql, 'ООО «Заметки»');
  await addMember(S.sql, org.id, head.user.id, 'head');
  for (const [c, name] of [[spec, 'Эксперт Заметкин'], [colleague, 'Эксперт Коллега']]) {
    await makeSpecialist(S.sql, c.user.id);
    await c.req('PATCH', '/api/me', { full_name: name });
    await addMember(S.sql, org.id, c.user.id, 'member');
    assert.equal((await c.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  }
});
after(async () => { await S?.close(); });

async function inWork(title) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(today, 9), fields: FIELDS })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  return o;
}
const events = async (userId) => (await S.sql`select count(*)::int as n from notifications where user_id = ${userId} and event = 'note_reminder'`)[0].n;

test('эксперт пишет заметку с напоминанием — в день напоминания одно уведомление и строка в «Сегодня»; «сделано» убирает', async () => {
  const o = await inWork('Квартира с заметками');
  const base = `/api/orders/${o.id}/notes`;
  let v = (await spec.req('GET', base)).body;
  assert.deepEqual([v.available, v.can_write, v.today, v.notes], [true, true, today, []]);
  assert.equal((await spec.req('POST', base, { body: '  ' })).body.error, 'bad_input');
  assert.equal((await spec.req('POST', base, { body: 'x', remind_on: addDays(today, -1) })).body.error, 'bad_date');
  assert.equal((await spec.req('POST', base, { body: 'x', remind_on: '2026-13-40' })).body.error, 'bad_date');
  assert.equal((await spec.req('POST', base, { body: 'x', remind_on: addDays(today, 400) })).body.error, 'bad_date');
  let r = await spec.req('POST', base, { body: 'Уточнить этаж у заказчика', remind_on: addDays(today, 2) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await spec.req('POST', base, { body: 'Взять выписку из ЕГРН' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.notes.map((n) => [n.body, n.remind_on]), [['Уточнить этаж у заказчика', addDays(today, 2)], ['Взять выписку из ЕГРН', null]]);
  const note = r.body.notes[0];

  // Сегодня — рано: ни уведомления, ни строки.
  assert.equal(await remindNotes(S.sql), 0);
  assert.equal((await spec.req('GET', '/api/today')).body.expert.notes.length, 0);
  // Настал день: одно уведомление, повторно — нет.
  assert.equal(await remindNotes(S.sql, { today: addDays(today, 2) }), 1);
  assert.equal(await remindNotes(S.sql, { today: addDays(today, 3) }), 0);
  assert.equal(await events(spec.user.id), 1);
  const n = (await spec.req('GET', '/api/notifications')).body.notifications.find((x) => x.title === 'Напоминание по Вашей заметке к делу');
  assert.deepEqual([n?.order_id, n?.to], [o.id, 'notes'], JSON.stringify(n));
  const sms = await S.sql`select d.body from notification_deliveries d join notifications x on x.id = d.notification_id
                          where x.user_id = ${spec.user.id} and x.event = 'note_reminder'`;
  assert.equal(sms.length, 1);
  assert.ok(!sms[0].body.includes('этаж'), 'в СМС нет текста заметки');

  // Перенёс дату на сегодня — напоминание придёт снова (по новой дате); строка в «Сегодня».
  r = await spec.req('PATCH', `${base}/${note.id}`, { remind_on: today });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await remindNotes(S.sql), 1);
  let t = (await spec.req('GET', '/api/today')).body.expert.notes;
  assert.deepEqual(t.map((x) => [x.id, x.note, x.remind_on]), [[o.id, 'Уточнить этаж у заказчика', today]]);
  // Правка текста без смены даты — без повторного уведомления.
  assert.equal((await spec.req('PATCH', `${base}/${note.id}`, { body: 'Уточнить этаж и лифт', remind_on: today })).status, 200);
  assert.equal(await remindNotes(S.sql), 0);
  // «Сделано» — из «Сегодня» уходит, в списке внизу; «Вернуть» — снова.
  r = await spec.req('PATCH', `${base}/${note.id}`, { done: true });
  assert.ok(r.body.notes.at(-1).done_at);
  assert.equal(r.body.notes.at(-1).body, 'Уточнить этаж и лифт');
  assert.equal((await spec.req('GET', '/api/today')).body.expert.notes.length, 0);
  assert.equal((await spec.req('PATCH', `${base}/${note.id}`, { done: 'да' })).body.error, 'bad_input');
  r = await spec.req('PATCH', `${base}/${note.id}`, { done: false });
  assert.equal(r.body.notes[0].done_at, null);
  // Удалить — пропадает; второй раз — «не найдена».
  r = await spec.req('DELETE', `${base}/${note.id}`);
  assert.deepEqual(r.body.notes.map((x) => x.body), ['Взять выписку из ЕГРН']);
  assert.equal((await spec.req('DELETE', `${base}/${note.id}`)).status, 404);
  assert.equal((await spec.req('PATCH', `${base}/${note.id}`, { done: true })).status, 404);

  // Заказчик, диспетчер, руководитель организации эксперта — заметок не видят; в журнале дела их нет.
  for (const c of [owner, dispatcher]) assert.deepEqual((await c.req('GET', base)).body, { available: false });
  assert.equal((await head.req('GET', base)).status, 404);
  const journal = (await dispatcher.req('GET', `/api/orders/${o.id}/journal`)).body;
  assert.ok(!JSON.stringify(journal).includes('ЕГРН') && !JSON.stringify(journal).includes('note.'), 'в журнале нет заметок');
});

test('после передачи дела новый эксперт чужих заметок не видит, а прежнему напоминание не приходит', async () => {
  const o = await inWork('Передаю с заметкой');
  const base = `/api/orders/${o.id}/notes`;
  assert.equal((await spec.req('POST', base, { body: 'Позвонить владельцу', remind_on: addDays(today, 1) })).status, 201);
  const t = await head.req('POST', `/api/orgs/${org.id}/cases/${o.id}/transfer`, { specialist_id: colleague.user.id, reason: 'Отпуск' });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.deepEqual((await colleague.req('GET', base)).body.notes, []);
  assert.equal((await spec.req('GET', base)).status, 404);
  const before = await events(spec.user.id);
  assert.equal(await remindNotes(S.sql, { today: addDays(today, 1) }), 0);
  assert.equal(await events(spec.user.id), before);
});

test('закрытое дело — заметки только для чтения; больше 50 нельзя', async () => {
  const o = await inWork('Много заметок');
  const base = `/api/orders/${o.id}/notes`;
  await S.sql`insert into order_notes (order_id, author_id, body) select ${o.id}, ${spec.user.id}, 'Заметка ' || g from generate_series(1, 50) g`;
  assert.equal((await spec.req('POST', base, { body: 'Пятьдесят первая' })).body.error, 'too_many');
  await S.sql`update orders set status = 'closed' where id = ${o.id}`;
  const v = (await spec.req('GET', base)).body;
  assert.deepEqual([v.available, v.can_write, v.notes.length], [true, false, 50]);
  assert.equal((await spec.req('DELETE', `${base}/${v.notes[0].id}`)).body.error, 'status_changed');
});

// 2.120: напоминания по заметкам видны в «Моих сроках на две недели» — в свой день; не отмеченные «сделано» с прошлых дней —
// на сегодня; руководителю в нагрузке экспертов их нет, после передачи дела — ни прежнему, ни новому.
test('напоминания по заметкам — в «Моих сроках» по дням; «сделано» и передача дела убирают', async () => {
  const o = await inWork('Заметка в сроках');
  const base = `/api/orders/${o.id}/notes`;
  const a = (await spec.req('POST', base, { body: 'Уточнить этаж', remind_on: addDays(today, 3) })).body.notes[0];
  await spec.req('POST', base, { body: 'Без даты' });
  await spec.req('POST', base, { body: 'Через месяц', remind_on: addDays(today, 30) });
  const late = (await spec.req('POST', base, { body: 'Просрочено', remind_on: today })).body.notes.find((n) => n.body === 'Просрочено');
  await S.sql`update order_notes set remind_on = ${addDays(today, -2)}::date where id = ${late.id}`;
  const notesOf = async (c) => (await c.req('GET', '/api/specialist/me/schedule')).body.schedule.days
    .flatMap((d) => d.items.filter((i) => i.kind === 'note' && i.order_id === o.id).map((i) => [d.date, i.note, i.late]));
  assert.deepEqual(await notesOf(spec), [[today, 'Просрочено', true], [addDays(today, 3), 'Уточнить этаж', false]]);
  // Руководитель в нагрузке экспертов заметок не видит.
  const load = (await head.req('GET', `/api/orgs/${org.id}/schedule`)).body;
  assert.ok(!JSON.stringify(load).includes('Уточнить этаж'), 'заметки не видны руководителю');
  assert.equal((await spec.req('PATCH', `${base}/${a.id}`, { done: true })).status, 200);
  assert.deepEqual(await notesOf(spec), [[today, 'Просрочено', true]]);
  const t = await head.req('POST', `/api/orgs/${org.id}/cases/${o.id}/transfer`, { specialist_id: colleague.user.id, reason: 'Отпуск' });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.deepEqual(await notesOf(spec), []);
  assert.deepEqual(await notesOf(colleague), []);
});

// 2.149: «За день до срока» одной кнопкой — дата от срока дела (срок − 1, не раньше сегодня); своя дата снимает привязку;
// диспетчер перенёс срок — напоминание переезжает и придёт снова; сделанные заметки не трогаются.
test('напоминание «за день до срока»: от срока дела, переезжает при переносе срока', async () => {
  const o = await inWork('Заметка за день до срока');
  const base = `/api/orders/${o.id}/notes`;
  const deadline = addDays(today, 9);
  let v = (await spec.req('GET', base)).body;
  assert.deepEqual([v.deadline, v.before_deadline], [deadline, addDays(today, 8)]);
  let r = await spec.req('POST', base, { body: 'Проверить подпись руководителя', remind_on: 'deadline' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const a = r.body.notes[0];
  assert.deepEqual([a.remind_on, a.remind_deadline], [addDays(today, 8), true]);
  const b = (await spec.req('POST', base, { body: 'Своя дата', remind_on: addDays(today, 2) })).body.notes.find((n) => n.body === 'Своя дата');
  assert.equal(b.remind_deadline, false);
  // Уже записанная заметка — «за день до срока» одной кнопкой; потом своя дата — привязка снята.
  const c0 = (await spec.req('POST', base, { body: 'Без даты' })).body.notes.find((n) => n.body === 'Без даты');
  r = await spec.req('PATCH', `${base}/${c0.id}`, { remind_on: 'deadline' });
  let c = r.body.notes.find((n) => n.id === c0.id);
  assert.deepEqual([c.remind_on, c.remind_deadline], [addDays(today, 8), true]);
  // Правка текста с той же датой привязку не снимает.
  r = await spec.req('PATCH', `${base}/${c0.id}`, { body: 'Без даты — уже с датой', remind_on: addDays(today, 8) });
  assert.equal(r.body.notes.find((n) => n.id === c0.id).remind_deadline, true);
  r = await spec.req('PATCH', `${base}/${c0.id}`, { remind_on: addDays(today, 5) });
  c = r.body.notes.find((n) => n.id === c0.id);
  assert.deepEqual([c.remind_on, c.remind_deadline], [addDays(today, 5), false]);

  // Напоминание пришло (день настал), потом диспетчер перенёс срок на 5 дней — заметка переехала и напомнит снова.
  assert.equal(await remindNotes(S.sql, { today: addDays(today, 8) }), 3);
  const done = (await spec.req('POST', base, { body: 'Сделанная', remind_on: 'deadline' })).body.notes.find((n) => n.body === 'Сделанная');
  await spec.req('PATCH', `${base}/${done.id}`, { done: true });
  const ask = await spec.req('POST', `/api/orders/${o.id}/deadline-requests`, { new_deadline: addDays(deadline, 5), reason: 'Жду документы' });
  assert.equal(ask.status, 201, JSON.stringify(ask.body));
  const rid = ask.body.requests?.[0]?.id ?? ask.body.request?.id;
  const dec = await dispatcher.req('POST', `/api/orders/${o.id}/deadline-requests/${rid}/decide`, { approve: true });
  assert.equal(dec.status, 200, JSON.stringify(dec.body));
  v = (await spec.req('GET', base)).body;
  const by = Object.fromEntries(v.notes.map((n) => [n.body, [n.remind_on, n.remind_deadline, !!n.reminded_at]]));
  assert.deepEqual(by['Проверить подпись руководителя'], [addDays(today, 13), true, false]);
  assert.deepEqual(by['Своя дата'], [addDays(today, 2), false, true]);
  assert.deepEqual(by['Без даты — уже с датой'], [addDays(today, 5), false, true]);
  assert.deepEqual(by['Сделанная'], [addDays(today, 8), true, false]);
  assert.equal(v.before_deadline, addDays(today, 13));
  assert.equal(await remindNotes(S.sql, { today: addDays(today, 13) }), 1);

  // Срок завтра или уже прошёл — напомнить сегодня; без срока — ошибка с подсказкой.
  await S.sql`update orders set deadline = ${today}::date where id = ${o.id}`;
  r = await spec.req('POST', base, { body: 'Срок сегодня', remind_on: 'deadline' });
  assert.equal(r.body.notes.find((n) => n.body === 'Срок сегодня').remind_on, today);
  assert.equal(beforeDeadline(addDays(today, -3), today), today);
  assert.equal(beforeDeadline(null, today), null);
});

// 2.157: в «Моих сроках на две недели» напоминание «за день до срока» — с отметкой и сроком дела; после переноса срока —
// в новом дне; своя дата — без отметки.
test('«Мои сроки»: напоминание «за день до срока» — со сроком дела, переезжает с переносом срока', async () => {
  const o = await inWork('Сроки: за день до срока');
  const base = `/api/orders/${o.id}/notes`;
  const deadline = addDays(today, 9);
  await spec.req('POST', base, { body: 'Проверить отчёт', remind_on: 'deadline' });
  await spec.req('POST', base, { body: 'Позвонить', remind_on: addDays(today, 2) });
  const notesOf = async () => (await spec.req('GET', '/api/specialist/me/schedule')).body.schedule.days
    .flatMap((d) => d.items.filter((i) => i.kind === 'note' && i.order_id === o.id)
      .map((i) => [d.date, i.note, i.by_deadline ?? false, i.deadline ?? null]));
  assert.deepEqual(await notesOf(), [[addDays(today, 2), 'Позвонить', false, null], [addDays(today, 8), 'Проверить отчёт', true, deadline]]);
  await S.sql`update orders set deadline = ${addDays(today, 12)}::date where id = ${o.id}`;
  await moveDeadlineNotes(S.sql, o.id, addDays(today, 12), today);
  assert.deepEqual((await notesOf())[1], [addDays(today, 11), 'Проверить отчёт', true, addDays(today, 12)]);
});
