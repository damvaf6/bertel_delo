// «Ваш эксперт» и «Принять» (2.465, схема 5 экранов — решение Дамира 31.10/02.11.2026): заказчик видит карточку эксперта,
// взявшего дело (имя, документы досье без номеров, сданные дела), и нажимает «Принять» — согласие с условиями заказа.
// Эксперт и диспетчер видят, принял ли заказчик; эксперту — уведомление. Сменился эксперт — принимается заново.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry } from '../../src/modules/index.mjs';

let S, owner, dispatcher, a, b, stranger;

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990004651');
  dispatcher = await login(S, '+79990004652');
  a = await login(S, '+79990004653');
  b = await login(S, '+79990004654');
  stranger = await login(S, '+79990004655');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, a.user.id);
  await makeSpecialist(S.sql, b.user.id);
  await S.sql`update users set full_name = 'Тестов Эксперт Первый' where id = ${a.user.id}`;
  await S.sql`update users set full_name = 'Тестов Эксперт Второй' where id = ${b.user.id}`;
  const add = (body) => a.req('POST', '/api/specialist/me/dossier', body);
  assert.equal((await add({ kind: 'certificate', title: 'Оценка недвижимости', number: '000777-1', valid_until: addDays(todayMsk(), 400) })).status, 201);
  assert.equal((await add({ kind: 'sro', title: 'Тестовая СРО оценщиков', number: '9876' })).status, 201);
  assert.equal((await add({ kind: 'policy', title: 'Тестовое страхование', number: 'ТП-55', valid_until: addDays(todayMsk(), 200), amount_rub: 5000000 })).status, 201);
});
after(async () => { await S?.close(); });

async function takenOrder(title) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  const fields = { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, Принятая ул., 1' };
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { fields, deadline: addDays(todayMsk(), 10) })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id, 1_200_000);
  assert.equal((await a.req('POST', `/api/specialist/feed/${o.id}/take`)).status, 200);
  return o;
}
const view = async (c, id) => (await c.req('GET', `/api/orders/${id}`)).body;
const accept = (c, id, executor) => c.req('POST', `/api/orders/${id}/expert/accept`, { executor_user_id: executor });

test('у «Экспертизы» в условиях заказа — «Принять» эксперта; у переводов — нет', () => {
  const reg = createRegistry();
  const offer = reg.offer('expertise', 'realty');
  assert.equal(offer.accept, 'expert');
  assert.ok(offer.customer.some((p) => p.id === 'accept'));
  assert.ok(offer.executor.some((p) => p.id === 'executor_money'));
  assert.equal(reg.offer('translation', 'plain').accept, null);
});

test('до того как эксперт взял дело, карточки нет; взял — заказчик видит карточку без номеров документов и адреса эксперта', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Принять: ещё нет' })).body.order;
  assert.equal((await view(owner, o.id)).my_expert, null);
  const t = await takenOrder('Принять: карточка');
  const v = await view(owner, t.id);
  const x = v.my_expert;
  assert.equal(x.name, 'Тестов Эксперт Первый');
  assert.equal(x.executor_user_id, a.user.id);
  assert.deepEqual(x.docs.map((d) => d.kind), ['certificate', 'sro', 'policy']);
  assert.equal(x.docs.find((d) => d.kind === 'policy').amount_kop, 500000000);
  assert.ok(!JSON.stringify(x).includes('000777-1') && !JSON.stringify(x).includes('ТП-55'), 'номеров документов нет');
  assert.ok(!JSON.stringify(x).includes('+7999'), 'телефона эксперта нет');
  assert.equal(x.accepted_at, null);
  assert.equal(x.can_accept, true);
  assert.equal(v.executor, null, 'прежний блок «исполнитель» заказчику по-прежнему не отдаётся');
  // Эксперт и диспетчер карточки «Ваш эксперт» не видят, но видят, принял ли заказчик.
  for (const c of [a, dispatcher]) {
    const w = await view(c, t.id);
    assert.equal(w.my_expert, null);
    assert.deepEqual(w.customer_accept, { accepted_at: null });
  }
  assert.equal((await view(owner, t.id)).customer_accept, null);
});

test('«Принять»: только заказчик и только видевший этого эксперта; второй раз — нельзя; эксперту — уведомление', async () => {
  const t = await takenOrder('Принять: жмём');
  assert.equal((await accept(stranger, t.id, a.user.id)).status, 404, 'чужой — заявки не видно');
  assert.equal((await accept(a, t.id, a.user.id)).status, 403, 'эксперт сам себя не принимает');
  assert.equal((await accept(dispatcher, t.id, a.user.id)).status, 403, 'диспетчер за заказчика не принимает');
  assert.equal((await accept(owner, t.id, b.user.id)).status, 409, 'видел другого эксперта — «обновите»');
  assert.equal((await accept(owner, t.id, 'нет')).status, 404);
  const r = await accept(owner, t.id, a.user.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.accepted_at);
  assert.equal((await accept(owner, t.id, a.user.id)).status, 409, 'уже принят');
  const x = (await view(owner, t.id)).my_expert;
  assert.ok(x.accepted_at);
  assert.equal(x.can_accept, false);
  assert.ok((await view(a, t.id)).customer_accept.accepted_at);
  assert.ok((await view(dispatcher, t.id)).customer_accept.accepted_at);
  const [row] = await S.sql`select offer_version, user_id from expert_accepts where order_id = ${t.id}`;
  assert.equal(row.offer_version, createRegistry().offer('expertise', 'realty').version, 'запомнена редакция условий');
  assert.equal(row.user_id, owner.user.id);
  const ev = await S.sql`select event from notifications where user_id = ${a.user.id} and order_id = ${t.id}`;
  assert.ok(ev.some((e) => e.event === 'expert_accepted'), 'эксперту — уведомление');
});

test('дело передали другому эксперту — новый принимается заново; выданное дело — карточка без кнопки', async () => {
  const t = await takenOrder('Принять: смена');
  assert.equal((await accept(owner, t.id, a.user.id)).status, 200);
  await S.sql`update orders set executor_user_id = ${b.user.id} where id = ${t.id}`;
  const x = (await view(owner, t.id)).my_expert;
  assert.equal(x.name, 'Тестов Эксперт Второй');
  assert.equal(x.accepted_at, null);
  assert.equal(x.can_accept, true);
  assert.deepEqual(x.docs, [], 'у второго досье пустое');
  assert.equal((await accept(owner, t.id, b.user.id)).status, 200);
  await S.sql`update orders set status = 'done' where id = ${t.id}`;
  const done = (await view(owner, t.id)).my_expert;
  assert.ok(done.accepted_at);
  await S.sql`delete from expert_accepts where order_id = ${t.id} and executor_user_id = ${b.user.id}`;
  const late = (await view(owner, t.id)).my_expert;
  assert.equal(late.can_accept, false, 'после выдачи «Принять» уже нет');
  assert.equal((await accept(owner, t.id, b.user.id)).status, 409);
});

test('у перевода карточки «Ваш эксперт» нет', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'translation', service: 'plain', title: 'Перевод без карточки' })).body.order;
  assert.equal((await view(owner, o.id)).my_expert, null);
  assert.equal((await accept(owner, o.id, a.user.id)).status, 409);
});
