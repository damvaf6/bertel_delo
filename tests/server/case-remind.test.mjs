// «Напомнить эксперту» (2.125): руководитель организации по делу в работе эксперта — одной кнопкой, не чаще раза в сутки
// по делу; эксперту — уведомление, ведёт к делу. После передачи дела другому эксперту счёт начинается заново.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, makeOrg, addMember } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';

let S, owner, dispatcher, spec, colleague, head, org;
const FIELDS = { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, Напоминальная ул., 5', area: '40' };

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990003601');
  dispatcher = await login(S, '+79990003602');
  spec = await login(S, '+79990003603');
  colleague = await login(S, '+79990003604');
  head = await login(S, '+79990003605');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  org = await makeOrg(S.sql, 'ООО «Напоминание»');
  await addMember(S.sql, org.id, head.user.id, 'head');
  for (const [c, name] of [[spec, 'Эксперт Медленный'], [colleague, 'Эксперт Коллега']]) {
    await makeSpecialist(S.sql, c.user.id);
    await c.req('PATCH', '/api/me', { full_name: name });
    await addMember(S.sql, org.id, c.user.id, 'member');
    assert.equal((await c.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  }
});
after(async () => { await S?.close(); });

async function inWork(title, who = spec) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 9), fields: FIELDS })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: who.user.id, from: 'matching' })).status, 200);
  assert.equal((await who.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  return o;
}
const events = async (userId) => (await S.sql`select count(*)::int as n from notifications where user_id = ${userId} and event = 'org_case_reminder'`)[0].n;
const caseOf = async (o) => (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.cases.find((c) => c.id === o.id);
const remind = (o) => head.req('POST', `/api/orgs/${org.id}/cases/${o.id}/remind`);

test('руководитель напоминает эксперту о деле: уведомление ведёт к делу, снова — через сутки', async () => {
  const o = await inWork('Долго нет отчёта');
  let c = await caseOf(o);
  assert.deepEqual([c.remind.reminded_at, c.remind.can_remind, c.remind.reminders], [null, true, 0]);
  const r = await remind(o);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.remind.can_remind, false);
  assert.ok(r.body.remind.next_remind_at);
  assert.equal(await events(spec.user.id), 1);
  // Эксперту — по делу (открывается дело).
  const n = (await spec.req('GET', '/api/notifications')).body.notifications.find((x) => x.title.startsWith('Руководитель организации напоминает'));
  assert.ok(n, 'уведомление в ленте эксперта');
  assert.equal(n.order_id, o.id);
  // СМС — с коротким номером дела, без названия.
  const sms = (await S.sql`select body from notification_deliveries d join notifications x on x.id = d.notification_id
                           where x.user_id = ${spec.user.id} and x.event = 'org_case_reminder'`)[0]?.body;
  assert.ok(sms?.includes(o.id.slice(0, 8).toUpperCase()), sms);
  assert.ok(!sms.includes('Долго нет отчёта'));
  // Второй раз в те же сутки — нельзя; в «Делах экспертов» видно, когда напоминали.
  assert.equal((await remind(o)).body.error, 'too_often');
  assert.equal(await events(spec.user.id), 1);
  c = await caseOf(o);
  assert.equal(c.remind.can_remind, false);
  assert.ok(c.remind.reminded_at);
  // Прошли сутки — снова можно.
  await S.sql`update case_reminders set created_at = now() - interval '25 hours' where order_id = ${o.id}`;
  assert.equal((await caseOf(o)).remind.can_remind, true);
  assert.equal((await remind(o)).status, 201);
  assert.equal(await events(spec.user.id), 2);
  assert.equal((await caseOf(o)).remind.reminders, 2);
  // В журнале — кто и кому.
  const a = await S.sql`select actor_id, details from audit_log where action = 'org.case.remind' and subject_id = ${o.id}`;
  assert.equal(a.length, 2);
});

test('после передачи дела другому эксперту — напомнить новому можно сразу; сданное дело — нельзя', async () => {
  const o = await inWork('Передали и напомнили');
  assert.equal((await remind(o)).status, 201);
  assert.equal((await head.req('POST', `/api/orgs/${org.id}/cases/${o.id}/transfer`, { specialist_id: colleague.user.id, reason: 'Болезнь' })).status, 200);
  const c = await caseOf(o);
  assert.deepEqual([c.remind.can_remind, c.remind.reminders], [true, 0]);
  assert.equal((await remind(o)).status, 201);
  assert.equal(await events(colleague.user.id), 1);
  // Дело на проверке — кнопки нет, напомнить нельзя.
  await S.sql`update orders set status = 'review' where id = ${o.id}`;
  assert.equal((await caseOf(o)).remind, null);
  assert.equal((await remind(o)).body.error, 'status_changed');
});

// Срок дела — в дни, когда эксперт не принимает дела, а передать некому (2.201): «Напомнить эксперту попросить перенос
// срока» — то же напоминание раз в сутки, но эксперту уведомление ведёт на просьбу о переносе с готовой причиной.
test('руководитель просит эксперта попросить перенос срока: уведомление ведёт к переносу, предел — общий', async () => {
  const o = await inWork('Срок в отпуске');
  const ext = (body) => head.req('POST', `/api/orgs/${org.id}/cases/${o.id}/remind`, body);
  assert.equal((await ext({ kind: 'другое' })).body.error, 'bad_kind');
  const r = await ext({ kind: 'extend' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.remind.kind, 'extend');
  const n = (await spec.req('GET', '/api/notifications')).body.notifications.find((x) => x.order_id === o.id);
  assert.ok(n.title.startsWith('Руководитель организации: попросите перенести срок'), n.title);
  assert.equal(n.to, 'away');
  // Предел общий: в те же сутки ни «напомнить», ни «попросить перенос» ещё раз.
  assert.equal((await remind(o)).body.error, 'too_often');
  assert.equal((await ext({ kind: 'extend' })).body.error, 'too_often');
  assert.equal((await caseOf(o)).remind.kind, 'extend');
  const a = await S.sql`select details from audit_log where action = 'org.case.remind' and subject_id = ${o.id}`;
  assert.equal(a[0].details.kind, 'extend');
  // Эксперт уже попросил перенос — просить его об этом не нужно, даже через сутки.
  await S.sql`update case_reminders set created_at = now() - interval '25 hours' where order_id = ${o.id}`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/deadline-requests`, { new_deadline: addDays(todayMsk(), 15), reason: 'В день срока меня не будет' })).status, 201);
  assert.equal((await ext({ kind: 'extend' })).body.error, 'extend_open');
  // Обычное «Напомнить эксперту» — можно.
  assert.equal((await remind(o)).status, 201);
  assert.equal((await caseOf(o)).remind.kind, 'case');
});

// «Мои сроки на две недели» (2.219): руководитель просил попросить перенос срока — у дела отметка «напоминал руководитель»
// и кнопка «Попросить перенос», пока эксперт не попросил перенос. Обычное «Напомнить» отметки не даёт.
test('«Мои сроки»: отметка «напоминал руководитель» у дела, по которому пришло «попросите перенос»', async () => {
  await head.req('PATCH', '/api/me', { full_name: 'Руководитель Строгий' });
  const o = await inWork('Сроки: напоминал руководитель');
  const plain = await inWork('Сроки: обычное напоминание');
  const itemOf = async (c, id) => (await c.req('GET', '/api/specialist/me/schedule')).body.schedule.days
    .flatMap((d) => d.items).find((i) => i.kind === 'deadline' && i.order_id === id);
  assert.equal((await itemOf(spec, o.id)).head_ask, undefined);
  assert.equal((await remind(plain)).status, 201);
  assert.equal((await itemOf(spec, plain.id)).head_ask, undefined, 'обычное напоминание — без отметки');

  assert.equal((await head.req('POST', `/api/orgs/${org.id}/cases/${o.id}/remind`, { kind: 'extend' })).status, 201);
  let it = await itemOf(spec, o.id);
  assert.equal(it.head_ask.by, 'Руководитель Строгий');
  assert.ok(Date.parse(it.head_ask.at) > Date.now() - 60_000);
  // День не перегружен и не в отпуске — кнопка «Попросить перенос» всё равно есть.
  assert.equal(it.away_due, false);
  assert.equal(it.can_extend, true);

  // Эксперт попросил перенос — отметки нет; диспетчер отказал — отметка не возвращается (эксперт уже просил).
  const r = await spec.req('POST', `/api/orders/${o.id}/deadline-requests`, { new_deadline: addDays(todayMsk(), 15), reason: 'В день срока меня не будет' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  it = await itemOf(spec, o.id);
  assert.equal(it.head_ask, undefined);
  assert.equal(it.can_extend, false);
  await S.sql`update deadline_requests set outcome = 'declined', decided_at = now() where order_id = ${o.id} and outcome is null`;
  assert.equal((await itemOf(spec, o.id)).head_ask, undefined);
  // Руководитель снова просит (через сутки) — отметка снова есть.
  await S.sql`update case_reminders set created_at = created_at - interval '25 hours' where order_id = ${o.id}`;
  await S.sql`update deadline_requests set requested_at = requested_at - interval '25 hours' where order_id = ${o.id}`;
  assert.equal((await head.req('POST', `/api/orgs/${org.id}/cases/${o.id}/remind`, { kind: 'extend' })).status, 201);
  assert.equal((await itemOf(spec, o.id)).head_ask.by, 'Руководитель Строгий');

  // Дело передали коллеге — у него отметки нет (просили не его).
  assert.equal((await head.req('POST', `/api/orgs/${org.id}/cases/${o.id}/transfer`, { specialist_id: colleague.user.id, reason: 'Отпуск' })).status, 200);
  assert.equal((await itemOf(colleague, o.id)).head_ask, undefined);
  assert.equal(await itemOf(spec, o.id), undefined);
});

test('2.235: «Ждём документы от заказчика» в «Делах экспертов» — что запрошено, сколько дней, напоминал ли эксперт', async () => {
  const o = await inWork('Ждём документы');
  assert.equal((await caseOf(o)).docs_wait, null);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['egrn'] })).status, 201);
  // Запросили сегодня — уже видно, но без тревоги.
  let w = (await caseOf(o)).docs_wait;
  assert.deepEqual([w.titles, w.days, w.long, w.reminded_at], [['Выписка из ЕГРН'], 0, false, null]);
  // Позже — ещё один документ; самый старый ждём 4 дня — заметно; эксперт напомнил заказчику — видно когда.
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { custom: ['Справка БТИ'] })).status, 201);
  await S.sql`update doc_requests set requested_at = now() - interval '4 days' where order_id = ${o.id} and title = 'Выписка из ЕГРН'`;
  w = (await caseOf(o)).docs_wait;
  assert.deepEqual([w.titles, w.days, w.long, w.reminded_at], [['Выписка из ЕГРН', 'Справка БТИ'], 4, true, null]);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/doc-requests/remind`)).status, 201);
  assert.ok((await caseOf(o)).docs_wait.reminded_at);
  // Заказчик прислал всё — строки нет.
  for (const x of (await owner.req('GET', `/api/orders/${o.id}/doc-requests`)).body.requests) {
    const doc = (await owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from('скан'), {
      raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(`${x.title}.pdf`) } })).body.document;
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/doc-requests/${x.id}/attach`, { document_id: doc.id })).status, 200);
  }
  assert.equal((await caseOf(o)).docs_wait, null);
  // Отменённый запрос не ждём.
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { custom: ['Ещё справка'] })).status, 201);
  await S.sql`update doc_requests set cancelled_at = now() where order_id = ${o.id} and fulfilled_at is null`;
  assert.equal((await caseOf(o)).docs_wait, null);
});
