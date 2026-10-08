// Просьба эксперта передать дело коллеге (2.107): эксперт от организации просит с причиной, руководитель видит в «Сегодня» и
// «Делах экспертов», передаёт (2.62) или отказывает; эксперт может отозвать. Заказчик и диспетчер просьбу не видят.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, makeOrg, addMember } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';

let S, owner, dispatcher, spec, colleague, head, solo, org;
const FIELDS = { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, Передаточная ул., 7', area: '40' };

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990003501');
  dispatcher = await login(S, '+79990003502');
  spec = await login(S, '+79990003503');
  colleague = await login(S, '+79990003504');
  head = await login(S, '+79990003505');
  solo = await login(S, '+79990003506');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  org = await makeOrg(S.sql, 'ООО «Передача дел»');
  await addMember(S.sql, org.id, head.user.id, 'head');
  for (const [c, name] of [[spec, 'Эксперт Уходящий'], [colleague, 'Эксперт Коллега'], [solo, 'Эксперт Частный']]) {
    await makeSpecialist(S.sql, c.user.id);
    await c.req('PATCH', '/api/me', { full_name: name });
  }
  for (const c of [spec, colleague]) {
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
const events = async (userId, event) => (await S.sql`select count(*)::int as n from notifications where user_id = ${userId} and event = ${event}`)[0].n;
const caseOf = async (o) => (await head.req('GET', `/api/orgs/${org.id}/cases`)).body.cases.find((c) => c.id === o.id);
const todayOf = async () => (await head.req('GET', '/api/today')).body.orgs.find((g) => g.id === org.id).handover;

test('эксперт просит передать дело — руководитель видит в «Сегодня» и «Делах экспертов» и передаёт коллеге', async () => {
  const o = await inWork('Ухожу в отпуск');
  const base = `/api/orders/${o.id}/handover`;
  let v = (await spec.req('GET', base)).body;
  assert.deepEqual([v.available, v.org, v.open, v.can_request], [true, org.name, null, true]);
  assert.equal((await spec.req('POST', base, { reason: '  ' })).body.error, 'reason_required');
  const r = await spec.req('POST', base, { reason: 'Отпуск с 12 октября' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.open.reason, 'Отпуск с 12 октября');
  assert.equal(r.body.can_request, false);
  assert.equal((await spec.req('POST', base, { reason: 'Ещё раз' })).body.error, 'already_requested');
  assert.equal(await events(head.user.id, 'org_handover_requested'), 1);
  const n = (await head.req('GET', '/api/notifications')).body.notifications.find((x) => x.title.startsWith('Эксперт просит передать'));
  assert.equal(n?.section, `org=${org.id}&case=${o.id.slice(0, 8).toUpperCase()}&to=handover`, JSON.stringify(n));
  // Руководитель: в «Сегодня» — с причиной, без названия заявки; в «Делах экспертов» — просьба и кому передать.
  const t = (await todayOf()).find((x) => x.order_ref === `№ ${o.id.slice(0, 8).toUpperCase()}`);
  assert.equal(t.reason, 'Отпуск с 12 октября');
  assert.equal(t.expert, 'Эксперт Уходящий');
  assert.ok(!JSON.stringify(t).includes('Ухожу в отпуск'));
  const c = await caseOf(o);
  assert.equal(c.handover.reason, 'Отпуск с 12 октября');
  assert.deepEqual(c.transfer_to.map((x) => x.full_name), ['Эксперт Коллега']);
  // Заказчик и диспетчер просьбу не видят; в журнале заказчика её нет, у диспетчера — есть.
  for (const who of [owner, dispatcher]) assert.equal((await who.req('GET', base)).body.available, false);
  assert.ok(!JSON.stringify((await owner.req('GET', `/api/orders/${o.id}/journal`)).body).includes('Отпуск'));
  assert.ok((await dispatcher.req('GET', `/api/orders/${o.id}/journal`)).body.journal
    .some((j) => j.what === 'Эксперт попросил руководителя передать дело коллеге: Отпуск с 12 октября'));
  // Передача (2.62) закрывает просьбу.
  const tr = await head.req('POST', `/api/orgs/${org.id}/cases/${o.id}/transfer`, { specialist_id: colleague.user.id, reason: 'По просьбе эксперта: отпуск' });
  assert.equal(tr.status, 200, JSON.stringify(tr.body));
  const [row] = await S.sql`select outcome, to_user from handover_requests where order_id = ${o.id}`;
  assert.deepEqual(row, { outcome: 'transferred', to_user: colleague.user.id });
  assert.equal((await caseOf(o)).handover, null);
  assert.ok(!(await todayOf()).some((x) => x.order_ref === `№ ${o.id.slice(0, 8).toUpperCase()}`));
  // Новый исполнитель видит блок с возможностью попросить; прежний — дела уже не видит.
  v = (await colleague.req('GET', base)).body;
  assert.deepEqual([v.open, v.can_request, v.declined], [null, true, null]);
  assert.equal((await spec.req('GET', base)).status, 404);
});

test('руководитель отказывает с пояснением; эксперт видит отказ и может попросить снова; отозвать до ответа', async () => {
  const o = await inWork('Болею');
  const base = `/api/orders/${o.id}/handover`;
  assert.equal((await spec.req('POST', base, { reason: 'Болезнь' })).status, 201);
  const decline = (c = head, orgId = org.id) => c.req('POST', `/api/orgs/${orgId}/cases/${o.id}/handover/decline`, { answer: 'Срок близко, доделайте' });
  assert.equal((await decline()).status, 200);
  assert.equal((await decline()).body.error, 'already_decided');
  assert.equal(await events(spec.user.id, 'org_handover_declined'), 1);
  let v = (await spec.req('GET', base)).body;
  assert.equal(v.open, null);
  assert.equal(v.declined.answer, 'Срок близко, доделайте');
  assert.equal(v.can_request, true);
  assert.equal((await caseOf(o)).handover, null);
  assert.equal((await S.sql`select executor_user_id from orders where id = ${o.id}`)[0].executor_user_id, spec.user.id, 'дело осталось у эксперта');
  // Попросил снова и отозвал.
  const again = (await spec.req('POST', base, { reason: 'Всё-таки больничный' })).body;
  assert.equal(again.open.reason, 'Всё-таки больничный');
  v = (await spec.req('DELETE', `${base}/${again.open.id}`)).body;
  assert.deepEqual([v.open, v.can_request], [null, true]);
  assert.equal((await spec.req('DELETE', `${base}/${again.open.id}`)).body.error, 'already_decided');
  assert.equal((await decline()).body.error, 'already_decided', 'отозванную не отклонить');
  // Сдал на проверку — просить нельзя.
  await S.sql`update orders set status = 'review' where id = ${o.id}`;
  assert.equal((await spec.req('POST', base, { reason: 'Поздно' })).body.error, 'status_changed');
});

test('кто может: просит только исполнитель от организации; отвечает только руководитель его организации', async () => {
  const o = await inWork('Чужие руки');
  const base = `/api/orders/${o.id}/handover`;
  const stranger = await login(S, '+79990003507');
  const otherHead = await login(S, '+79990003508');
  const otherOrg = await makeOrg(S.sql, 'ООО «Чужая»');
  await addMember(S.sql, otherOrg.id, otherHead.user.id, 'head');
  // Не видят заявку — «не найдено»; заказчик и диспетчер — «недостаточно прав».
  for (const c of [stranger, colleague, head, otherHead]) assert.equal((await c.req('POST', base, { reason: 'x' })).status, 404);
  for (const c of [owner, dispatcher]) assert.equal((await c.req('POST', base, { reason: 'x' })).status, 403);
  assert.equal((await spec.req('POST', base, { reason: 'Отпуск' })).status, 201);
  const rid = (await spec.req('GET', base)).body.open.id;
  for (const c of [owner, dispatcher]) assert.equal((await c.req('DELETE', `${base}/${rid}`)).status, 403);
  const decline = (c, orgId) => c.req('POST', `/api/orgs/${orgId}/cases/${o.id}/handover/decline`, {});
  for (const c of [stranger, owner]) assert.equal((await decline(c, org.id)).status, 404);
  for (const c of [spec, colleague, dispatcher]) assert.equal((await decline(c, org.id)).status, 403);
  assert.equal((await decline(otherHead, otherOrg.id)).status, 404, 'своей организацией чужое дело не взять');
  assert.equal((await S.sql`select outcome from handover_requests where id = ${rid}`)[0].outcome, null);
  // Эксперт без организации — блока нет, просить некого.
  const p = await inWork('Частное дело', solo);
  assert.equal((await solo.req('GET', `/api/orders/${p.id}/handover`)).body.available, false);
  assert.equal((await solo.req('POST', `/api/orders/${p.id}/handover`, { reason: 'Отпуск' })).body.error, 'no_org');
});

// Прогон пачки (2.110): после передачи дела файл результата прежнего эксперта остаётся в деле, но новому помечен «не свой» —
// карточка «Готово к сдаче?» и «Что дальше» не засчитывают его подписи (сервер и так не примет сдачу без своего файла).
test('после передачи дела файл прежнего эксперта у нового — own: false; свой — own: true; остальным пометки нет', async () => {
  const o = await inWork('Передача с отчётом');
  const up = (c, name) => c.req('POST', `/api/orders/${o.id}/results`, Buffer.from('отчёт'), { raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': name } });
  assert.equal((await up(spec, 'old.pdf')).status, 201);
  let docs = (await spec.req('GET', `/api/orders/${o.id}/documents`)).body.documents;
  assert.deepEqual(docs.map((d) => [d.filename, d.own]), [['old.pdf', true]]);
  assert.equal((await head.req('POST', `/api/orgs/${org.id}/cases/${o.id}/transfer`, { specialist_id: colleague.user.id, reason: 'Болезнь' })).status, 200);
  assert.equal((await up(colleague, 'new.pdf')).status, 201);
  docs = (await colleague.req('GET', `/api/orders/${o.id}/documents`)).body.documents;
  assert.deepEqual(docs.map((d) => [d.filename, d.own]), [['old.pdf', false], ['new.pdf', true]]);
  docs = (await dispatcher.req('GET', `/api/orders/${o.id}/documents`)).body.documents;
  assert.ok(docs.every((d) => !('own' in d)));
});

// «Что сделал прежний эксперт» (2.112): новому эксперту после передачи — что осталось в деле от прежнего и его просьба о
// переносе срока: оставить (диспетчер ответит как обычно) или отозвать. Прежнему, заказчику, диспетчеру и руководителю — нет.
test('после передачи новый эксперт видит, что сделал прежний, и решает судьбу его просьбы о переносе срока', async () => {
  const o = await inWork('Передача с наработками');
  const pred = (c) => c.req('GET', `/api/orders/${o.id}/predecessor`);
  assert.deepEqual((await pred(spec)).body, { transferred: false }, 'до передачи — нечего показывать');
  const up = (c, name) => c.req('POST', `/api/orders/${o.id}/results`, Buffer.from('отчёт'), { raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': name } });
  assert.equal((await up(spec, 'old.pdf')).status, 201);
  const doc = (kind, name) => S.sql`insert into documents (order_id, uploaded_by, filename, mime, size_bytes, storage_key, kind)
    values (${o.id}, ${spec.user.id}, ${name}, 'image/jpeg', 10, ${`t/${o.id}/${name}`}, ${kind})`;
  await doc('other', 'план.pdf');
  await doc('inspection', 'фото1.jpg');
  await doc('inspection', 'фото2.jpg');
  for (const body of ['Черновик ИИ', 'Правка эксперта']) {
    await S.sql`insert into result_drafts (order_id, author_id, source, body) values (${o.id}, ${spec.user.id}, 'edit', ${body})`;
  }
  for (const [url, confirmed] of [['https://example.test/a1', true], ['https://example.test/a2', false]]) {
    await S.sql`insert into order_analogs (order_id, author_id, url, url_key, confirmed_at) values (${o.id}, ${spec.user.id}, ${url}, ${url}, ${confirmed ? new Date() : null})`;
  }
  await S.sql`insert into onsite_visits (order_id, helper_id, assigned_by, planned_at, finished_at) values (${o.id}, ${solo.user.id}, ${spec.user.id}, now(), now())`;
  const to = addDays(todayMsk(), 20);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/deadline-requests`, { new_deadline: to, reason: 'Ждём выписку' })).status, 201);
  assert.equal((await head.req('POST', `/api/orgs/${org.id}/cases/${o.id}/transfer`, { specialist_id: colleague.user.id, reason: 'Болезнь' })).status, 200);

  const v = (await pred(colleague)).body;
  assert.equal(v.transferred, true);
  assert.equal(v.from, 'Эксперт Уходящий');
  assert.deepEqual([v.results, v.files, v.drafts, v.photos, v.visits_done, v.visits_cancelled, v.analogs, v.analogs_confirmed], [1, 1, 2, 2, 1, 0, 2, 1]);
  assert.ok(v.at && v.draft_at);
  assert.equal(v.extend.new_deadline, to);
  assert.equal(v.extend.reason, 'Ждём выписку');
  assert.ok(!JSON.stringify(v).includes('Болезнь'), 'причину передачи новый эксперт не видит');
  // Прежний дела не видит; заказчик, диспетчер, руководитель — не исполнители.
  assert.equal((await pred(spec)).status, 404);
  for (const c of [owner, dispatcher]) assert.deepEqual((await pred(c)).body, { transferred: false });
  assert.equal((await pred(head)).status, 404);

  // Оставить просьбу: строка уходит, просьба остаётся открытой — диспетчер отвечает как обычно; повторно — «уже нет».
  const keep = (c, rid) => c.req('POST', `/api/orders/${o.id}/predecessor/extend/${rid}/keep`, {});
  for (const c of [owner, dispatcher]) assert.equal((await keep(c, v.extend.id)).status, 403);
  const k = await keep(colleague, v.extend.id);
  assert.equal(k.status, 200, JSON.stringify(k.body));
  assert.equal(k.body.extend, null);
  assert.equal((await keep(colleague, v.extend.id)).body.error, 'already_decided');
  const dl = (await colleague.req('GET', `/api/orders/${o.id}/deadline-requests`)).body;
  assert.equal(dl.open?.new_deadline, to);
  assert.equal(dl.can_withdraw, true, 'оставленную можно отозвать и потом');
  assert.ok((await dispatcher.req('GET', `/api/orders/${o.id}/journal`)).body.journal
    .some((j) => j.what.startsWith('Новый исполнитель оставил просьбу прежнего о переносе срока')));
  // Своя просьба нового эксперта — не «прежнего»: строки нет.
  assert.equal((await colleague.req('DELETE', `/api/orders/${o.id}/deadline-requests/${v.extend.id}`)).status, 200);
  assert.equal((await colleague.req('POST', `/api/orders/${o.id}/deadline-requests`, { new_deadline: to, reason: 'Сам' })).status, 201);
  assert.equal((await pred(colleague)).body.extend, null);
  // Сдал на проверку — блок не нужен.
  await S.sql`update orders set status = 'review' where id = ${o.id}`;
  assert.deepEqual((await pred(colleague)).body, { transferred: false });
});

test('передача обратно: прежнему эксперту — то, что сделал второй; отозвать просьбу прежнего можно сразу', async () => {
  const o = await inWork('Туда и обратно');
  const to = addDays(todayMsk(), 15);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/deadline-requests`, { new_deadline: to, reason: 'Нет доступа в квартиру' })).status, 201);
  const transfer = (who) => head.req('POST', `/api/orgs/${org.id}/cases/${o.id}/transfer`, { specialist_id: who.user.id, reason: 'Нагрузка' });
  assert.equal((await transfer(colleague)).status, 200);
  const v = (await colleague.req('GET', `/api/orders/${o.id}/predecessor`)).body;
  assert.deepEqual([v.results, v.files, v.drafts, v.photos, v.analogs], [0, 0, 0, 0, 0]);
  const w = await colleague.req('DELETE', `/api/orders/${o.id}/deadline-requests/${v.extend.id}`);
  assert.equal(w.status, 200, JSON.stringify(w.body));
  assert.equal((await colleague.req('GET', `/api/orders/${o.id}/predecessor`)).body.extend, null);
  assert.equal((await transfer(spec)).status, 200);
  const back = (await spec.req('GET', `/api/orders/${o.id}/predecessor`)).body;
  assert.deepEqual([back.transferred, back.from], [true, 'Эксперт Коллега']);
  assert.equal((await colleague.req('GET', `/api/orders/${o.id}/predecessor`)).status, 404);
});
