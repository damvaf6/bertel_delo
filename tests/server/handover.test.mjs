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
