// Деньги (задачи 1.6 и 1.6а): расчёт 80/20; оплата при заказе — до предложения исполнителю; выплата исполнителю и
// закрывающие документы — при выдаче результата; возврат при отмене (полный до начала работ и по вине исполнителя,
// за вычетом сделанной части при отказе заказчика); передача другому исполнителю; отменённый платёж; отказ поставщика;
// повторные уведомления ЮKassa — одна оплата, одна выплата и один возврат на заявку (Б-16).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, client, setPlatformRole, makeSpecialist } from '../helpers.mjs';
import { cancelSplit, splitAmount } from '../../src/money/money.mjs';

let S, owner, dispatcher, spec, spec2;
const READY = { deadline: new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 1' } };
const step = (c, o, to, from, reason, extra = {}) => c.req('POST', `/api/orders/${o.id}/status`, { to, from, reason, ...extra });
const money = async (c, o) => (await c.req('GET', `/api/orders/${o.id}/money`)).body.money;
const pdf = (c, o, text = 'отчёт') => c.req('POST', `/api/orders/${o.id}/results`, Buffer.from(text), { raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': 'r.pdf' } });

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990000601');
  dispatcher = await login(S, '+79990000602');
  spec = await login(S, '+79990000603');
  spec2 = await login(S, '+79990000604');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { capacity: 50 });
  await makeSpecialist(S.sql, spec2.user.id, { capacity: 50 });
});
after(async () => { await S?.close(); });

// Заявка в подборе с назначенной ценой (рубли строкой).
async function priced(price = '10000') {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty' })).body.order;
  await owner.req('PATCH', `/api/orders/${o.id}`, READY);
  assert.equal((await step(owner, o, 'matching', 'new')).status, 200);
  assert.equal((await dispatcher.req('PUT', `/api/orders/${o.id}/price`, { price })).status, 200);
  return o;
}
// Оплата заказчиком через поддельную ЮKassa (возврат со страницы оплаты — проверка у поставщика).
async function pay(o) {
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/payments`)).status, 201);
  const m = (await owner.req('POST', `/api/orders/${o.id}/payments/refresh`)).body.money;
  assert.equal(m.paid, true);
  return m;
}
async function inWork(o, who = spec) {
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: who.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(who, o, 'in_work', 'awaiting_executor')).status, 200);
}
async function toDone(o, who = spec) {
  assert.equal((await pdf(who, o)).status, 201);
  assert.equal((await step(who, o, 'review', 'in_work')).status, 200);
  const rv = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
  return step(dispatcher, o, 'done', 'review');
}
const payoutsOf = (o) => S.sql`select amount_kop, commission_kop, status, executor_user_id from payouts where order_id = ${o.id}`;
const refundsOf = (o) => S.sql`select amount_kop, status from refunds where order_id = ${o.id}`;
const docsOf = (o) => S.sql`select kind, data from closing_documents where order_id = ${o.id} order by number`;

test('расчёт: 20% платформе с округлением до копейки, остальное исполнителю; при отмене — доля работы и остаток', () => {
  assert.deepEqual(splitAmount(1_000_000), { priceKop: 1_000_000, commissionKop: 200_000, payoutKop: 800_000 });
  assert.deepEqual(splitAmount(1_001), { priceKop: 1_001, commissionKop: 200, payoutKop: 801 });
  assert.deepEqual(splitAmount(1_003), { priceKop: 1_003, commissionKop: 201, payoutKop: 802 });
  for (const p of [100, 101, 333, 999_999, 1_000_000_000]) {
    const s = splitAmount(p);
    assert.equal(s.commissionKop + s.payoutKop, p);
    for (const pct of [0, 1, 33, 50, 99, 100]) {
      const c = cancelSplit(p, pct);
      assert.equal(c.workKop + c.refundKop, p, 'возврат и оплата работы сходятся до копейки');
    }
  }
  assert.deepEqual(cancelSplit(1_000_000, 40), { workKop: 400_000, refundKop: 600_000 });
});

test('цена — диспетчер в подборе; оплата — при заказе; без оплаты дело не предложить; после оплаты цена не меняется', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty' })).body.order;
  await owner.req('PATCH', `/api/orders/${o.id}`, READY);
  assert.equal((await dispatcher.req('PUT', `/api/orders/${o.id}/price`, { price: '5000' })).status, 409, '«новая» — ещё не в подборе');
  await step(owner, o, 'matching', 'new');
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/payments`)).body.error, 'no_price', 'без цены не оплатить');
  const r = await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' });
  assert.equal(r.body.error, 'no_price');
  assert.equal((await dispatcher.req('PUT', `/api/orders/${o.id}/price`, { price: '5000' })).status, 200);
  assert.equal((await dispatcher.req('PUT', `/api/orders/${o.id}/price`, { price: '6000.5' })).body.money.price_kop, 600050, 'до оплаты цену можно поправить');
  const r2 = await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' });
  assert.equal(r2.status, 409);
  assert.equal(r2.body.error, 'not_paid', 'неоплаченное дело исполнителю не предлагается');
  const m0 = await money(owner, o);
  assert.equal(m0.can_pay, true);
  assert.equal((await money(dispatcher, o)).can_set_price, true);

  // Заказчик начал оплату — цену уже не поменять (сумма платежа должна совпасть с ценой).
  S.providers.payments.nextOutcome = 'succeeded';
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/payments`)).status, 201);
  assert.equal((await dispatcher.req('PUT', `/api/orders/${o.id}/price`, { price: '1' })).status, 409);
  assert.equal((await money(dispatcher, o)).can_set_price, false);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/payments/refresh`)).body.money.paid, true);
  assert.equal((await dispatcher.req('PUT', `/api/orders/${o.id}/price`, { price: '1' })).status, 409, 'после оплаты цена не меняется');
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/payments`)).body.error, 'already_paid');
  // Оплата не создаёт ни выплаты, ни документов — деньги ждут у платформы до выдачи результата.
  assert.deepEqual(await payoutsOf(o), []);
  assert.deepEqual(await docsOf(o), []);
  const held = (await dispatcher.req('GET', '/api/money')).body.totals;
  assert.ok(held.held_kop >= 600050, 'оплаченное до выдачи результата числится «у платформы»');
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await money(owner, o)).can_pay, false);
});

test('отменённый платёж: можно заплатить заново; пока не оплачено, исполнителю не предложить', async () => {
  const o = await priced();
  S.providers.payments.nextOutcome = 'canceled';
  const p1 = (await owner.req('POST', `/api/orders/${o.id}/payments`)).body.payment;
  const m1 = (await owner.req('POST', `/api/orders/${o.id}/payments/refresh`)).body.money;
  S.providers.payments.nextOutcome = 'succeeded';
  assert.equal(m1.paid, false);
  assert.equal(m1.payment.status, 'canceled');
  assert.equal(m1.can_pay, true);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).body.error, 'not_paid');
  const p2 = await owner.req('POST', `/api/orders/${o.id}/payments`);
  assert.equal(p2.status, 201);
  assert.notEqual(p2.body.payment.id, p1.id);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/payments/refresh`)).body.money.paid, true);
});

test('поставщик оплаты недоступен: понятная ошибка, платёж не висит, можно повторить', async () => {
  const o = await priced('10000');
  S.providers.payments.script({ kind: 'fail', message: 'нет связи' });
  const r = await owner.req('POST', `/api/orders/${o.id}/payments`);
  assert.equal(r.status, 502);
  assert.match(r.body.message, /Оплата сейчас недоступна/);
  S.providers.payments.script({ kind: 'ok' });
  const [p] = await S.sql`select status from payments where order_id = ${o.id}`;
  assert.equal(p.status, 'canceled');
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/payments`)).status, 201);
  // Ссылка на оплату ведёт обратно в кабинет; сумма и описание — из заявки.
  const call = S.providers.payments.calls.filter((c) => c.method === 'createPayment').at(-1);
  assert.equal(call.args.amountKop, 1_000_000);
  assert.match(call.args.description, /Оценка/);
});

test('уведомления ЮKassa: содержимому не верим; выплата и документы — один раз, при выдаче результата (Б-16)', async () => {
  const o = await priced('12345,67');
  await owner.req('POST', `/api/orders/${o.id}/payments`);
  const [p] = await S.sql`select provider_id from payments where order_id = ${o.id}`;
  const anon = client(S);
  // Одновременно: уведомление, ещё уведомление и проверка заказчиком.
  const rs = await Promise.all([
    anon.req('POST', '/api/payments/notify', { event: 'payment.succeeded', object: { id: p.provider_id, amount: { value: '1.00' } } }, { csrf: false }),
    anon.req('POST', '/api/payments/notify', { event: 'payment.succeeded', object: { id: p.provider_id } }, { csrf: false }),
    owner.req('POST', `/api/orders/${o.id}/payments/refresh`),
  ]);
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
  const pays = await S.sql`select status, amount_kop from payments where order_id = ${o.id}`;
  assert.deepEqual(pays.map((x) => [x.status, Number(x.amount_kop)]), [['succeeded', 1_234_567]], 'сумма — из нашей записи, не из уведомления');
  assert.deepEqual(await payoutsOf(o), [], 'при оплате выплаты ещё нет');

  await inWork(o);
  // Пока результат не выдан, заказчик его не видит, а исполнитель ждёт выплату.
  const sp0 = await money(spec, o);
  assert.equal(sp0.payout, null);
  assert.equal((await toDone(o)).status, 200);
  const outs = await payoutsOf(o);
  assert.equal(outs.length, 1);
  assert.deepEqual([Number(outs[0].amount_kop), Number(outs[0].commission_kop), outs[0].status], [987_654, 246_913, 'succeeded']);
  // Повторное уведомление после выдачи ничего не меняет.
  await anon.req('POST', '/api/payments/notify', { event: 'payment.succeeded', object: { id: p.provider_id } }, { csrf: false });
  const payoutCalls = S.providers.payments.calls.filter((c) => c.method === 'createPayout' && c.args.description.includes(o.id.slice(0, 8).toUpperCase()));
  assert.equal(payoutCalls.length, 1, 'поставщику выплата отправлена один раз');
  const docs = await docsOf(o);
  assert.deepEqual(docs.map((d) => d.kind), ['act', 'agent_report']);
  assert.equal(docs[0].data.test, true, 'документ помечен как проверочный (поддельная оплата)');
  assert.equal((await owner.req('GET', `/api/orders/${o.id}/documents`)).body.results_hidden, false, 'результат выдан заказчику');
  // Без входа уведомление ничего не открывает, а неверный вид данных — просто пропускается.
  assert.equal((await anon.req('POST', '/api/payments/notify', { object: { id: 'x'.repeat(500) } }, { csrf: false })).status, 200);
  assert.equal((await anon.req('POST', '/api/payments/notify', {}, { csrf: false })).status, 200);
});

test('неудавшаяся выплата при выдаче: результат всё равно выдан; диспетчер повторяет; успешную второй раз не провести', async () => {
  const o = await priced('10000');
  await pay(o);
  await inWork(o);
  S.providers.payments.payoutOutcome = 'failed';
  try {
    assert.equal((await toDone(o)).status, 200);
  } finally { S.providers.payments.payoutOutcome = 'succeeded'; }
  const sp = await money(spec, o);
  assert.equal(sp.payout.status, 'failed');
  assert.equal(sp.can_retry_payout, false);
  const dm = await money(dispatcher, o);
  assert.equal(dm.can_retry_payout, true);
  assert.equal(dm.payout.failure, 'тестовый отказ выплаты');
  const sum = (await dispatcher.req('GET', '/api/money')).body.totals;
  assert.ok(sum.to_pay_kop >= 800_000, 'неудавшаяся выплата числится «к выплате»');
  const r = (await dispatcher.req('POST', `/api/orders/${o.id}/payout/retry`)).body.money;
  assert.equal(r.payout.status, 'succeeded');
  assert.equal(r.payout.attempts, 2);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/payout/retry`)).status, 409);
  const mine = (await spec.req('GET', '/api/payouts')).body;
  assert.ok(mine.totals.paid_out_kop >= 800_000);
});

test('отмена до начала работ — полный возврат: заказчиком в подборе, диспетчером при ожидании исполнителя', async () => {
  const a = await priced('10000');
  await pay(a);
  assert.equal((await step(owner, a, 'cancelled', 'matching')).status, 200);
  assert.deepEqual((await refundsOf(a)).map((r) => [Number(r.amount_kop), r.status]), [[1_000_000, 'succeeded']]);
  assert.deepEqual(await payoutsOf(a), []);
  const ma = await money(owner, a);
  assert.equal(ma.refund.status, 'succeeded');
  assert.deepEqual(ma.documents.map((d) => d.kind), ['refund'], 'заказчику — документ о возврате');
  assert.equal(ma.documents[0].data.refund_kop, 1_000_000);
  const refundCall = S.providers.payments.calls.filter((c) => c.method === 'createRefund').at(-1);
  assert.equal(refundCall.args.amountKop, 1_000_000);
  assert.match(refundCall.args.paymentId, /^pay_/, 'возврат — по платежу у поставщика');

  const b = await priced('10000');
  await pay(b);
  assert.equal((await dispatcher.req('POST', `/api/orders/${b.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(dispatcher, b, 'cancelled', 'awaiting_executor', 'Заказчик передумал')).status, 200);
  assert.deepEqual((await refundsOf(b)).map((r) => Number(r.amount_kop)), [1_000_000]);
  assert.equal((await spec.req('GET', `/api/orders/${b.id}/money`)).status, 404, 'исполнитель, не начавший работу, дело больше не видит');

  // Неоплаченную заявку отменяют без возврата.
  const c = await priced('10000');
  assert.equal((await step(owner, c, 'cancelled', 'matching')).status, 200);
  assert.deepEqual(await refundsOf(c), []);
});

test('виноват исполнитель: дело передаётся другому, оплата в силе; файлы прежнего не в счёт; выплата — новому', async () => {
  const o = await priced('10000');
  await pay(o);
  await inWork(o, spec);
  assert.equal((await pdf(spec, o, 'плохой отчёт')).status, 201);
  assert.equal((await step(spec, o, 'review', 'in_work')).status, 200);
  assert.deepEqual((await dispatcher.req('GET', `/api/orders/${o.id}`)).body.actions.map((a) => a.to), ['in_work', 'matching', 'done', 'cancelled']);
  assert.equal((await step(dispatcher, o, 'matching', 'review')).status, 400, 'передать — с причиной');
  assert.equal((await step(spec, o, 'matching', 'review', 'сам')).status, 403, 'передаёт диспетчер, не исполнитель');
  assert.equal((await step(dispatcher, o, 'matching', 'review', 'Отчёт с грубыми ошибками, исполнитель не исправляет')).status, 200);
  assert.equal((await spec.req('GET', `/api/orders/${o.id}`)).status, 404, 'прежний исполнитель теряет доступ');
  const m = await money(owner, o);
  assert.equal(m.paid, true, 'оплата заказчика в силе');
  assert.equal(m.can_pay, false);
  assert.deepEqual(await refundsOf(o), []);

  await inWork(o, spec2);
  assert.equal((await step(spec2, o, 'review', 'in_work')).status, 400, 'файл прежнего исполнителя не в счёт');
  assert.equal((await toDone(o, spec2)).status, 200);
  const outs = await payoutsOf(o);
  assert.deepEqual(outs.map((x) => [x.executor_user_id, Number(x.amount_kop)]), [[spec2.user.id, 800_000]]);
});

test('отмена после начала работ: по вине исполнителя — полный возврат; отказ заказчика — оплата сделанной части', async () => {
  // По вине исполнителя (заказчик не хочет ждать другого): полный возврат, исполнителю ничего.
  const a = await priced('10000');
  await pay(a);
  await inWork(a);
  assert.equal((await step(dispatcher, a, 'cancelled', 'in_work', 'Сорваны сроки')).body.error, 'fault_required');
  assert.equal((await step(dispatcher, a, 'cancelled', 'in_work', 'Сорваны сроки', { fault: 'кто-то' })).status, 400);
  assert.equal((await step(dispatcher, a, 'cancelled', 'in_work', 'Сорваны сроки', { fault: 'executor' })).status, 200);
  assert.deepEqual((await refundsOf(a)).map((r) => Number(r.amount_kop)), [1_000_000]);
  assert.deepEqual(await payoutsOf(a), []);
  assert.equal((await money(owner, a)).cancel_fault, 'executor');
  assert.equal((await spec.req('GET', `/api/orders/${a.id}`)).status, 404);

  // Отказ заказчика: сделано 40% — исполнителю 80% от 4 000 ₽, платформе 20%, заказчику возврат 6 000 ₽.
  const b = await priced('10000');
  await pay(b);
  await inWork(b);
  for (const bad of [undefined, '', 101, -1, 12.5, 'сорок']) {
    assert.equal((await step(dispatcher, b, 'cancelled', 'in_work', 'Заказчик отказался', { fault: 'customer', done_percent: bad })).body.error, 'bad_percent', String(bad));
  }
  assert.equal((await step(dispatcher, b, 'cancelled', 'in_work', 'Заказчик отказался', { fault: 'customer', done_percent: 40 })).status, 200);
  assert.deepEqual((await payoutsOf(b)).map((x) => [Number(x.amount_kop), Number(x.commission_kop), x.status]), [[320_000, 80_000, 'succeeded']]);
  assert.deepEqual((await refundsOf(b)).map((r) => [Number(r.amount_kop), r.status]), [[600_000, 'succeeded']]);
  const mo = await money(owner, b);
  assert.deepEqual([mo.cancel_fault, mo.done_percent], ['customer', 40]);
  assert.deepEqual(mo.documents.map((d) => d.kind), ['act', 'refund']);
  assert.equal(mo.documents[0].data.partial_percent, 40);
  assert.equal(mo.documents[0].data.price_kop, 400_000, 'акт — на сделанную часть');
  // Исполнитель сохраняет доступ к отменённому делу: видит свою выплату и отчёт агента, но не имя заказчика.
  const ms = await money(spec, b);
  assert.equal(ms.payout.amount_kop, 320_000);
  assert.deepEqual(ms.documents.map((d) => d.kind), ['agent_report']);
  assert.equal(ms.documents[0].data.customer, undefined);
  assert.equal(ms.refund, null, 'возврат заказчику исполнителю не показывается');

  // Отказ заказчика, сделано 100% — возврата нет; 0% — полный возврат, выплаты нет.
  const c = await priced('10000');
  await pay(c);
  await inWork(c);
  assert.equal((await step(dispatcher, c, 'cancelled', 'in_work', 'Отказ после выполнения', { fault: 'customer', done_percent: 100 })).status, 200);
  assert.deepEqual(await refundsOf(c), []);
  assert.deepEqual((await payoutsOf(c)).map((x) => Number(x.amount_kop)), [800_000]);
  const d = await priced('10000');
  await pay(d);
  await inWork(d);
  assert.equal((await step(dispatcher, d, 'cancelled', 'in_work', 'Отказ сразу', { fault: 'customer', done_percent: 0 })).status, 200);
  assert.deepEqual((await refundsOf(d)).map((r) => Number(r.amount_kop)), [1_000_000]);
  assert.deepEqual(await payoutsOf(d), []);
});

test('оплата пришла уже после отмены — сразу полный возврат', async () => {
  const o = await priced('10000');
  await owner.req('POST', `/api/orders/${o.id}/payments`);
  assert.equal((await step(owner, o, 'cancelled', 'matching')).status, 200);
  assert.deepEqual(await refundsOf(o), [], 'пока оплата не пришла — возвращать нечего');
  const m = (await owner.req('POST', `/api/orders/${o.id}/payments/refresh`)).body.money;
  assert.equal(m.paid, false, 'отменённая заявка оплаченной не становится');
  assert.equal(m.refund.status, 'succeeded');
  assert.equal(m.refund.amount_kop, 1_000_000);
});

test('неудавшийся возврат: виден заказчику, повторяет только диспетчер; успешный второй раз не провести', async () => {
  const o = await priced('10000');
  await pay(o);
  S.providers.payments.refundOutcome = 'failed';
  try {
    assert.equal((await step(owner, o, 'cancelled', 'matching')).status, 200, 'сбой возврата не мешает отменить');
  } finally { S.providers.payments.refundOutcome = 'succeeded'; }
  const mo = await money(owner, o);
  assert.equal(mo.refund.status, 'failed');
  assert.equal(mo.can_retry_refund, false);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/refund/retry`)).status, 403);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/refund/retry`)).status, 404);
  assert.equal((await money(dispatcher, o)).can_retry_refund, true);
  assert.ok((await dispatcher.req('GET', '/api/money')).body.totals.to_refund_kop >= 1_000_000);
  const r = (await dispatcher.req('POST', `/api/orders/${o.id}/refund/retry`)).body.money;
  assert.equal(r.refund.status, 'succeeded');
  assert.equal(r.refund.attempts, 2);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/refund/retry`)).status, 409);
  const [{ n }] = await S.sql`select count(*)::int as n from refunds where order_id = ${o.id}`;
  assert.equal(n, 1, 'один возврат на заявку');
});
