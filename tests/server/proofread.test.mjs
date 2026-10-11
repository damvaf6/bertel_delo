// Вычитка и переделка перевода (задача 2а.7, задача штаба 3f617197): новым переводчикам — обязательная вычитка, остальным —
// выборочная; заказчик нашёл ошибку после выдачи — бесплатная переделка (и снова вычитка); возврат — только за качество.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { createRegistry, validateModule } from '../../src/modules/index.mjs';
import { addDays, availableActions, findTransition, todayMsk } from '../../src/orders/workflow.mjs';
import { proofreadReason } from '../../src/ops/order-ops.mjs';
import translation from '../../src/modules/translation.mjs';

let S, dispatcher, owner, tr, tr2;
const soon = addDays(todayMsk(), 7);
const FIELDS = { recipient: 'business', language: 'en', direction: 'to_ru', doc_kind: 'contract', docs: 1, pages: 2, urgent: 'no', delivery: 'none' };

before(async () => {
  S = await startApp();
  dispatcher = await login(S, '+79990000990');
  owner = await login(S, '+79990000991');
  tr = await login(S, '+79990000992');
  tr2 = await login(S, '+79990000993');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  for (const u of [tr, tr2]) await makeSpecialist(S.sql, u.user.id, { permits: [['translation', 'plain']], capacity: 20, taxStatus: 'self_employed', languages: ['en'] });
});
after(async () => { await S?.close(); });

async function order(who) {
  const o = (await owner.req('POST', '/api/orders', { module: 'translation', service: 'plain', title: 'Перевод договора' })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: soon, fields: FIELDS })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: who.user.id, from: 'matching' })).status, 200);
  assert.equal((await who.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  const up = await who.req('POST', `/api/orders/${o.id}/results`, Buffer.from('%PDF перевод'), { raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('перевод.pdf') } });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  return o;
}
const submit = (who, o) => who.req('POST', `/api/orders/${o.id}/status`, { to: 'review', from: 'in_work' });
const review = async (o, who = dispatcher) => (await who.req('GET', `/api/orders/${o.id}/review`)).body;
const mark = (o, rv, id, verdict, note) => dispatcher.req('PUT', `/api/orders/${o.id}/review/${id}`, { verdict, note, round: rv.round });
async function allOkDone(o) {
  const rv = await review(o);
  for (const c of rv.checks) assert.equal((await mark(o, rv, c.id, 'ok')).status, 200);
  const r = await dispatcher.req('POST', `/api/orders/${o.id}/status`, { to: 'done', from: 'review' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

test('описание модуля и правило выбора: новый — обязательно, остальные — выборочно', () => {
  validateModule(translation);
  const reg = createRegistry();
  assert.deepEqual(reg.proofread('translation'), { new_orders: 3, sample_percent: 10, redo_days: 2, refund_note: translation.proofread.refund_note });
  assert.equal(reg.proofread('expertise'), null, 'у экспертизы вычитки нет');
  const cfg = reg.proofread('translation');
  assert.equal(proofreadReason(cfg, 0, 99), 'new');
  assert.equal(proofreadReason(cfg, 2, 99), 'new');
  assert.equal(proofreadReason(cfg, 3, 9), 'sample');
  assert.equal(proofreadReason(cfg, 3, 10), 'none');
  assert.equal(proofreadReason({ new_orders: 0, sample_percent: 100 }, 0, 99), 'sample');
  const bad = (proofread) => assert.throws(() => validateModule({ ...translation, proofread }));
  bad({ new_orders: -1, sample_percent: 10, redo_days: 2 });
  bad({ new_orders: 3, sample_percent: 101, redo_days: 2 });
  bad({ new_orders: 3, sample_percent: 10, redo_days: 0 });
  bad({ new_orders: 3, sample_percent: 10, redo_days: 2, extra: 1 });
  assert.throws(() => validateModule({ ...translation, checks: [...translation.checks, { id: 'proofread', title: 'Чужое' }] }));
  // Переделка после выдачи — только в модулях с вычиткой.
  assert.equal(findTransition('done', 'in_work', ['customer']), null);
  assert.equal(findTransition('done', 'in_work', ['customer'], ['redo'])?.reason, true);
  assert.ok(!availableActions('done', ['customer']).some((a) => a.to === 'in_work'));
  assert.ok(availableActions('done', ['customer'], ['redo']).some((a) => a.to === 'in_work'));
});

test('новый переводчик: вычитка обязательна; замечание — переделка, без отметки «готово» нельзя', async () => {
  const o = await order(tr);
  assert.equal((await submit(tr, o)).status, 200);
  const rv = await review(o);
  assert.deepEqual(rv.proofread, { reason: 'new', name: 'обязательная — у исполнителя ещё мало сданных дел' });
  assert.equal(rv.checks.at(-1).id, 'proofread');
  // Исполнитель видит вычитку, заказчик — только итог.
  assert.equal((await review(o, tr)).proofread.reason, 'new');
  const cust = await review(o, owner);
  assert.equal(cust.details, false);
  assert.equal(cust.proofread, undefined);

  for (const c of rv.checks.filter((x) => x.id !== 'proofread')) await mark(o, rv, c.id, 'ok');
  const left = await dispatcher.req('POST', `/api/orders/${o.id}/status`, { to: 'done', from: 'review' });
  assert.equal(left.status, 409);
  assert.match(left.body.message, /Вычитка/);
  assert.equal((await mark(o, rv, 'proofread', 'issue', 'опечатка в дате на с. 2')).status, 200);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/status`, { to: 'done', from: 'review' })).body.error, 'review_issues');
  // Возврат на доработку — бесплатно: цена и оплата те же, выплаты нет.
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'review', reason: 'опечатка в дате' })).status, 200);
  assert.equal((await submit(tr, o)).status, 200);
  const rv2 = await review(o);
  assert.equal(rv2.round, 2);
  assert.ok(rv2.checks.some((c) => c.id === 'proofread' && !c.verdict), 'во втором круге — снова вычитка');
  await allOkDone(o);
  const pays = await S.sql`select count(*)::int as n from payouts where order_id = ${o.id}`;
  assert.equal(pays[0].n, 1);
});

test('заказчик нашёл ошибку после выдачи: бесплатная переделка тем же переводчиком, снова вычитка, без второй выплаты', async () => {
  const o = await order(tr);
  assert.equal((await submit(tr, o)).status, 200);
  await allOkDone(o);
  const view = (await owner.req('GET', `/api/orders/${o.id}`)).body;
  assert.ok(view.actions.some((a) => a.to === 'in_work' && a.name === 'Нашли ошибку — переделать бесплатно' && a.reason));
  assert.equal(view.cancel_note, null, 'правило возврата заказчику не показывается');
  // Диспетчер такой кнопки не видит — переделку просит заказчик.
  assert.ok(!(await dispatcher.req('GET', `/api/orders/${o.id}`)).body.actions.some((a) => a.to === 'in_work'));

  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'done' })).body.error, 'reason_required');
  await S.sql`update orders set deadline = ${todayMsk()} where id = ${o.id}`;
  const r = await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'done', reason: 'Фамилия написана с ошибкой' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [row] = await S.sql`select status, proofread, deadline, executor_user_id from orders where id = ${o.id}`;
  assert.equal(row.status, 'in_work');
  assert.equal(row.proofread, 'redo');
  assert.equal(row.executor_user_id, tr.user.id, 'дело у того же переводчика');
  assert.ok(row.deadline >= addDays(todayMsk(), 2), 'срок — не раньше чем через 2 дня');
  const kinds = await S.sql`select user_id, event from notifications where order_id = ${o.id} and event in ('redo', 'redo_staff')`;
  assert.ok(kinds.some((n) => n.event === 'redo' && n.user_id === tr.user.id));
  assert.ok(kinds.some((n) => n.event === 'redo_staff' && n.user_id === dispatcher.user.id));

  // Отменить с возвратом после выплаты нельзя: правило возврата диспетчер видит.
  const dv = (await dispatcher.req('GET', `/api/orders/${o.id}`)).body;
  assert.match(dv.cancel_note, /только за качество/);
  const c = await dispatcher.req('POST', `/api/orders/${o.id}/status`, { to: 'cancelled', from: 'in_work', reason: 'x', fault: 'executor' });
  assert.equal(c.status, 409);
  assert.equal(c.body.error, 'paid_out');

  assert.equal((await submit(tr, o)).status, 200);
  const rv = await review(o);
  assert.equal(rv.proofread.reason, 'redo');
  await allOkDone(o);
  const pays = await S.sql`select count(*)::int as n from payouts where order_id = ${o.id}`;
  assert.equal(pays[0].n, 1, 'переделка бесплатная — вторая выплата не появляется');
  const refunds = await S.sql`select count(*)::int as n from refunds where order_id = ${o.id}`;
  assert.equal(refunds[0].n, 0);
});

test('опытный переводчик (сдал 3 перевода): вычитка выборочная или не нужна; передача другому — решается заново', async () => {
  for (let i = 0; i < 3; i += 1) {
    const o = await order(tr2);
    assert.equal((await submit(tr2, o)).status, 200);
    assert.equal((await review(o)).proofread.reason, 'new');
    await allOkDone(o);
  }
  const o = await order(tr2);
  assert.equal((await submit(tr2, o)).status, 200);
  const [row] = await S.sql`select proofread from orders where id = ${o.id}`;
  assert.ok(['sample', 'none'].includes(row.proofread));
  const rv = await review(o);
  assert.equal(rv.checks.some((c) => c.id === 'proofread'), row.proofread === 'sample');
  // Правило «Вычитка» отмечается, только если оно у дела есть.
  if (row.proofread === 'none') assert.equal((await mark(o, rv, 'proofread', 'ok')).status, 404);
  // Передали другому переводчику — решение сброшено; у нового (tr) сдано меньше 3 — вычитка обязательна.
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'review', reason: 'другому' })).status, 200);
  const [r2] = await S.sql`select proofread from orders where id = ${o.id}`;
  assert.equal(r2.proofread, null);
});
