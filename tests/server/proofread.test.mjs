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

  // Отмена с возвратом после выплаты (2а.11): диспетчер видит правило возврата и должен указать, чем признан перевод.
  const dv = (await dispatcher.req('GET', `/api/orders/${o.id}`)).body;
  assert.match(dv.cancel_note, /только за качество/);
  assert.equal(dv.after_payout, true);
  assert.equal((await owner.req('GET', `/api/orders/${o.id}`)).body.after_payout, false, 'заказчику — нет');
  const c = await dispatcher.req('POST', `/api/orders/${o.id}/status`, { to: 'cancelled', from: 'in_work', reason: 'x', fault: 'executor' });
  assert.equal(c.status, 400);
  assert.equal(c.body.error, 'quality_required');

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

// Решение Дамира 12.10.2026 (2а.11): возврат после выплаты переводчику. Плохой перевод — выплаченное удерживается из его
// следующих выплат; нормальный, а заказчик просто недоволен, — возврат за счёт платформы, у переводчика не удерживается.
test('возврат после выплаты: перевод нормальный — за счёт платформы, у переводчика не удерживается', async () => {
  const o = await order(tr2);
  assert.equal((await submit(tr2, o)).status, 200);
  await allOkDone(o);
  const [pay] = await S.sql`select * from payouts where order_id = ${o.id}`;
  const dv = (await dispatcher.req('GET', `/api/orders/${o.id}`)).body;
  assert.ok(dv.actions.some((a) => a.to === 'cancelled' && a.name === 'Отменить с возвратом' && a.reason), 'выданное дело диспетчер может отменить');
  assert.equal(dv.after_payout, true);
  assert.ok(!(await owner.req('GET', `/api/orders/${o.id}`)).body.actions.some((a) => a.to === 'cancelled'), 'заказчик сам не отменяет');
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/status`, { to: 'cancelled', from: 'done', reason: 'x', quality: 'так себе' })).body.error, 'quality_required');
  const r = await dispatcher.req('POST', `/api/orders/${o.id}/status`, { to: 'cancelled', from: 'done', reason: 'Заказчику не понравился стиль', quality: 'ok' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [row] = await S.sql`select status, refund_quality, cancel_fault, executor_user_id from orders where id = ${o.id}`;
  assert.deepEqual([row.status, row.refund_quality, row.cancel_fault, row.executor_user_id], ['cancelled', 'ok', null, tr2.user.id]);
  const [pm] = await S.sql`select amount_kop from payments where order_id = ${o.id} and status = 'succeeded'`;
  const [rf] = await S.sql`select * from refunds where order_id = ${o.id}`;
  assert.equal(Number(rf.amount_kop), Number(pm.amount_kop) - Number(pay.transit_kop), 'возврат — оплата услуг');
  assert.equal(rf.after_payout, true);
  assert.equal(rf.status, 'succeeded');
  assert.equal((await S.sql`select count(*)::int as n from clawbacks where order_id = ${o.id}`)[0].n, 0, 'у переводчика не удерживается');
  // Переводчик видит дело и деньги: выплата на месте, удержания нет.
  const m = (await tr2.req('GET', `/api/orders/${o.id}/money`)).body.money;
  assert.equal(m.payout.status, 'succeeded');
  assert.equal(m.clawback, null);
  assert.equal(m.refund_quality, 'ok');
});

test('возврат после выплаты: перевод плохой — выплаченное удерживается из следующих выплат переводчику', async () => {
  const tr3 = await login(S, '+79990000994');
  await makeSpecialist(S.sql, tr3.user.id, { permits: [['translation', 'plain']], capacity: 20, taxStatus: 'self_employed', languages: ['en'] });
  const a = await order(tr3);
  assert.equal((await submit(tr3, a)).status, 200);
  await allOkDone(a);
  const [payA] = await S.sql`select * from payouts where order_id = ${a.id}`;
  assert.equal((await owner.req('POST', `/api/orders/${a.id}/status`, { to: 'in_work', from: 'done', reason: 'Пропущен абзац' })).status, 200);
  const r = await dispatcher.req('POST', `/api/orders/${a.id}/status`, { to: 'cancelled', from: 'in_work', reason: 'Переделка не исправила ошибки', quality: 'bad' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [row] = await S.sql`select refund_quality, cancel_fault from orders where id = ${a.id}`;
  assert.deepEqual([row.refund_quality, row.cancel_fault], ['bad', 'executor']);
  const [cb] = await S.sql`select * from clawbacks where order_id = ${a.id}`;
  assert.equal(Number(cb.amount_kop), Number(payA.amount_kop), 'долг — выплаченные 80%');
  assert.equal(cb.executor_user_id, tr3.user.id);
  assert.equal(cb.closed_at, null);
  assert.ok((await S.sql`select 1 from notifications where order_id = ${a.id} and user_id = ${tr3.user.id} and event = 'clawback'`).length);
  const ma = (await tr3.req('GET', `/api/orders/${a.id}/money`)).body.money;
  assert.deepEqual(ma.clawback, { amount_kop: Number(payA.amount_kop), withheld_kop: 0, closed: false });
  const sum1 = (await dispatcher.req('GET', '/api/money')).body.totals;
  assert.ok(sum1.clawback_open_kop >= Number(payA.amount_kop));
  assert.ok(sum1.refunds_after_payout_kop > 0);

  // Следующий перевод: из выплаты сначала гасится долг — отчёт агента это показывает; выплата может уйти в ноль.
  const b = await order(tr3);
  assert.equal((await submit(tr3, b)).status, 200);
  await allOkDone(b);
  const [payB] = await S.sql`select * from payouts where order_id = ${b.id}`;
  const gross = Number(payB.amount_kop) + Number(payB.withheld_kop);
  assert.equal(Number(payB.withheld_kop), Math.min(gross, Number(payA.amount_kop)));
  assert.equal(payB.status, 'succeeded', 'выплата прошла (или ушла в ноль без перевода)');
  const [cb2] = await S.sql`select * from clawbacks where order_id = ${a.id}`;
  assert.equal(Number(cb2.withheld_kop), Number(payB.withheld_kop));
  assert.equal(cb2.closed_at !== null, Number(cb2.withheld_kop) === Number(cb2.amount_kop));
  const mb = (await tr3.req('GET', `/api/orders/${b.id}/money`)).body.money;
  assert.equal(mb.payout.withheld_kop, Number(payB.withheld_kop));
  const rep = mb.documents.find((d) => d.kind === 'agent_report');
  assert.equal(rep.data.withheld_kop, Number(payB.withheld_kop));
  assert.equal(rep.data.withheld[0].order_ref, `№ ${a.id.slice(0, 8).toUpperCase()}`);
  // Заказчику удержание не показывается.
  const mc = (await owner.req('GET', `/api/orders/${b.id}/money`)).body.money;
  assert.ok(mc.documents.every((d) => d.kind !== 'agent_report' && d.data.withheld_kop === undefined));
  // Отчёт агента файлом Word собирается.
  const w = await tr3.req('GET', `/api/orders/${b.id}/closing/${rep.id}`, undefined, { raw: true });
  assert.equal(w.status, 200);
});

test('у экспертизы возврата после выплаты нет: выданное дело диспетчер не отменяет', () => {
  assert.ok(!availableActions('done', ['dispatcher']).some((a) => a.to === 'cancelled'));
  assert.ok(availableActions('done', ['dispatcher'], ['redo']).some((a) => a.to === 'cancelled'));
  assert.equal(findTransition('done', 'cancelled', ['dispatcher']), null);
});
