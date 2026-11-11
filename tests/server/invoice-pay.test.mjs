// Оплата по счёту (2.464, схема 5 экранов — решение Дамира 31.10/02.11.2026): в первом выпуске «Экспертизы» заказчик платит
// по счёту ООО «АИС Переводчик» по реквизитам и может сообщить «оплатил»; поступление отмечает диспетчер. Возврат при отмене
// до начала работы — вручную, отметка диспетчера. Картой — только при включённой оплате картой (CARD_PAY=1, после ЮKassa).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, signResults } from '../helpers.mjs';
import { loadConfig } from '../../src/config.mjs';
import { testEnv } from '../helpers.mjs';

let S, owner, dispatcher, dispatcher2, spec;
const READY = { deadline: new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 5' } };
const step = (c, o, to, from, extra = {}) => c.req('POST', `/api/orders/${o.id}/status`, { to, from, ...extra });
const money = async (c, o) => (await c.req('GET', `/api/orders/${o.id}/money`)).body.money;
const events = async (userId, orderId) => (await S.sql`select event from notifications where user_id = ${userId} and order_id = ${orderId} order by created_at`).map((r) => r.event);

before(async () => {
  S = await startApp({ CARD_PAY: '0' });
  owner = await login(S, '+79990000671');
  dispatcher = await login(S, '+79990000672');
  dispatcher2 = await login(S, '+79990000674');
  spec = await login(S, '+79990000673');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await setPlatformRole(S.sql, dispatcher2.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { capacity: 50 });
});
after(async () => { await S?.close(); });

async function priced(price = '10000', { module = 'expertise', service = 'realty' } = {}) {
  const o = (await owner.req('POST', '/api/orders', { module, service, title: 'Оценка по счёту' })).body.order;
  await owner.req('PATCH', `/api/orders/${o.id}`, READY);
  assert.equal((await step(owner, o, 'matching', 'new')).status, 200);
  assert.equal((await dispatcher.req('PUT', `/api/orders/${o.id}/price`, { price })).status, 200);
  return o;
}

test('настройка: картой у «Экспертизы» — по умолчанию нет на prod и демо, есть на проверках; CARD_PAY — только 0 или 1', () => {
  assert.equal(loadConfig(testEnv()).cardPay, true);
  assert.equal(loadConfig(testEnv({ CARD_PAY: '0' })).cardPay, false);
  const { TEST_CONTROL_TOKEN, ...dev } = testEnv();
  assert.equal(loadConfig({ ...dev, APP_ENV: 'dev' }).cardPay, true);
  assert.throws(() => loadConfig(testEnv({ CARD_PAY: 'да' })), /CARD_PAY/);
});

test('заказчик: счёт, «Я оплатил(а)» — диспетчерам уведомление; картой нельзя; диспетчер отмечает «оплачено» — заказчику «оплата получена»', async () => {
  const o = await priced('10000');
  let m = await money(owner, o);
  assert.equal(m.price_kop, 1_200_000, 'цена эксперта 10 000 — заказчику 12 000');
  assert.deepEqual([m.pay_invoice, m.can_pay, m.can_claim_invoice, m.can_mark_paid], [true, false, true, false]);
  const card = await owner.req('POST', `/api/orders/${o.id}/payments`);
  assert.equal(card.status, 409);
  assert.equal(card.body.error, 'pay_by_invoice');

  // Счёт: оплата по реквизитам, номер счёта в назначении платежа, без «кнопкой Оплатить».
  const { extractPages } = await import('../../src/ai/extract.mjs');
  const r = await fetch(`${S.base}/api/orders/${o.id}/invoice`, { headers: { cookie: owner.cookie } });
  assert.equal(r.status, 200);
  const text = (await extractPages(Buffer.from(await r.arrayBuffer()), 'c.docx')).pages.join('\n');
  assert.match(text, /Оплата — по банковским реквизитам агента выше, в назначении платежа укажите номер счёта СЧ-[0-9A-F]{8}/);
  assert.match(text, /Я оплатил\(а\) по счёту/);
  assert.doesNotMatch(text, /кнопкой «Оплатить»/);
  assert.match(text, /Итого к оплате: 12\s000,00 ₽/);

  // Сообщить об оплате — один раз, с пометкой до 200 знаков.
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/payments/claim`, { note: 'x'.repeat(201) })).status, 400);
  m = (await owner.req('POST', `/api/orders/${o.id}/payments/claim`, { note: '  оплатили  11.11, п/п 15 ' })).body.money;
  assert.equal(m.invoice_claim_note, 'оплатили 11.11, п/п 15');
  assert.ok(m.invoice_claimed_at);
  assert.equal(m.can_claim_invoice, false);
  assert.equal(m.paid, false, '«оплатил» — ещё не «оплачено»');
  for (const d of [dispatcher, dispatcher2]) assert.ok((await events(d.user.id, o.id)).includes('invoice_claimed_staff'));

  // «Деньги»: ждёт поступления — первой строкой (сообщил об оплате), с пометкой заказчика.
  const o2 = await priced('5000');
  const sum = (await dispatcher.req('GET', '/api/money')).body;
  const ids = sum.invoices.map((x) => x.order_id);
  assert.ok(ids.indexOf(o.id) < ids.indexOf(o2.id), 'сообщившие об оплате — первыми');
  const row = sum.invoices.find((x) => x.order_id === o.id);
  assert.deepEqual([row.amount_kop, row.claim_note], [1_200_000, 'оплатили 11.11, п/п 15']);

  // Диспетчер отмечает поступление: платёж «по счёту» с пометкой, заявка оплачена; уведомления заказчику и другим диспетчерам.
  assert.equal((await money(dispatcher, o)).can_mark_paid, true);
  const paid = await dispatcher.req('POST', `/api/orders/${o.id}/payments/invoice`, { note: 'п/п 15 от 11.11' });
  assert.equal(paid.status, 201);
  m = await money(owner, o);
  assert.equal(m.paid, true);
  assert.deepEqual([m.payment.method, m.payment.note, m.payment.amount_kop, m.payment.status], ['invoice', 'п/п 15 от 11.11', 1_200_000, 'succeeded']);
  assert.deepEqual([m.pay_invoice, m.can_claim_invoice], [false, false]);
  assert.deepEqual(await events(owner.user.id, o.id), ['priced', 'paid']);
  assert.ok((await events(dispatcher2.user.id, o.id)).includes('paid_staff'));
  assert.ok(!(await events(dispatcher.user.id, o.id)).includes('paid_staff'), 'отметившему — не нужно');
  assert.ok(!(await dispatcher.req('GET', '/api/money')).body.invoices.some((x) => x.order_id === o.id), 'из списка ушла');
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/payments/claim`)).status, 403);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/payments/claim`)).body.error, 'already_paid');

  // Дальше — как при оплате картой: предложение эксперту, работа, выдача, выплата вручную 100% цены эксперта.
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec, o, 'in_work', 'awaiting_executor')).status, 200);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/results`, Buffer.from('отчёт'), { raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': 'r.pdf' } })).status, 201);
  await signResults(S, spec, o.id);
  assert.equal((await step(spec, o, 'review', 'in_work')).status, 200);
  const rv = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
  assert.equal((await step(dispatcher, o, 'done', 'review')).status, 200);
  const sp = await money(spec, o);
  assert.deepEqual([sp.payout.amount_kop, sp.payout.manual], [1_000_000, true]);
  assert.deepEqual((await money(owner, o)).documents.map((d) => d.kind), ['act']);
  assert.equal((await dispatcher.req('GET', '/api/money')).body.totals.received_kop >= 1_200_000, true, 'поступление по счёту — в «Получено»');
});

test('отмена до начала работ после оплаты по счёту — возврат вручную: «Вернуть вручную», отметка диспетчера, заказчику «возвращены»', async () => {
  const o = await priced('8000');
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/payments/invoice`, {})).status, 201);
  assert.equal((await money(owner, o)).payment.note, null, 'пометка необязательна');
  assert.equal((await step(owner, o, 'cancelled', 'matching')).status, 200);
  let m = await money(dispatcher, o);
  assert.deepEqual([m.refund.status, m.refund.manual, m.refund.amount_kop], ['pending', true, 960_000], 'поставщику не уходит');
  assert.deepEqual([m.can_mark_refund, m.can_retry_refund], [true, false]);
  assert.ok((await events(dispatcher.user.id, o.id)).includes('refund_manual_staff'));
  const list = (await dispatcher.req('GET', '/api/money')).body.refunds_manual;
  const row = list.find((x) => x.order_id === o.id);
  assert.equal(row.amount_kop, 960_000);
  assert.equal(row.customer_phone, '+79990000671');
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/refund/retry`)).status, 409, 'повтор через поставщика — нет');
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/refund/paid`)).status, 403);
  m = (await dispatcher.req('POST', `/api/orders/${o.id}/refund/paid`, { note: 'п/п 20 на карту заказчика' })).body.money;
  assert.deepEqual([m.refund.status, m.refund.manual_note, m.can_mark_refund], ['succeeded', 'п/п 20 на карту заказчика', false]);
  assert.ok((await events(owner.user.id, o.id)).includes('refund_succeeded'));
  assert.ok(!(await dispatcher.req('GET', '/api/money')).body.refunds_manual.some((x) => x.order_id === o.id));
  const cm = await money(owner, o);
  assert.deepEqual(cm.documents.map((d) => d.kind), ['refund'], 'документ о возврате — заказчику');
});

test('без цены, после предложения, во время оплаты картой — отметить нельзя; переводы — не по счёту', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Без цены' })).body.order;
  await owner.req('PATCH', `/api/orders/${o.id}`, READY);
  assert.equal((await step(owner, o, 'matching', 'new')).status, 200);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/payments/invoice`)).body.error, 'not_payable');
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/payments/claim`)).body.error, 'not_payable');
  // Заказчик начал платить картой (оплата картой включена) — отметка ждёт.
  const S2 = S;
  await S2.sql`update orders set price_kop = 100000 where id = ${o.id}`;
  await S2.sql`insert into payments (order_id, amount_kop, created_by) values (${o.id}, 100000, ${owner.user.id})`;
  assert.equal((await money(dispatcher, o)).can_mark_paid, false);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/payments/invoice`)).body.error, 'payment_pending');
  const t = (await owner.req('POST', '/api/orders', { module: 'translation', service: 'notary_paper', title: 'Перевод' })).body.order;
  assert.ok(t, 'заявка на перевод');
  assert.equal((await dispatcher.req('POST', `/api/orders/${t.id}/payments/invoice`)).body.error, 'no_invoice_pay');
  assert.equal((await owner.req('POST', `/api/orders/${t.id}/payments/claim`)).body.error, 'no_invoice_pay');
});
