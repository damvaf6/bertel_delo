// Деньги (задача 1.6): расчёт 80/20, отменённый платёж, отказ поставщика, неудавшаяся выплата и повтор,
// повторные уведомления ЮKassa — одна оплата и одна выплата на заявку (Б-16).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, client, setPlatformRole, makeSpecialist, ensurePrice } from '../helpers.mjs';
import { splitAmount } from '../../src/money/money.mjs';

let S, owner, dispatcher, spec;
const READY = { deadline: new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 1' } };
const step = (c, o, to, from, reason) => c.req('POST', `/api/orders/${o.id}/status`, { to, from, reason });

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990000601');
  dispatcher = await login(S, '+79990000602');
  spec = await login(S, '+79990000603');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id);
});
after(async () => { await S?.close(); });

// Заявка, проверенная и готовая к оплате.
async function doneOrder(price = 1_000_000) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty' })).body.order;
  await owner.req('PATCH', `/api/orders/${o.id}`, READY);
  await step(owner, o, 'matching', 'new');
  await ensurePrice(S.sql, o.id, price);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  await step(spec, o, 'in_work', 'awaiting_executor');
  await spec.req('POST', `/api/orders/${o.id}/results`, Buffer.from('отчёт'), { raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': 'r.pdf' } });
  await step(spec, o, 'review', 'in_work');
  const rv = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
  assert.equal((await step(dispatcher, o, 'done', 'review')).status, 200);
  return o;
}

test('расчёт: 20% платформе с округлением до копейки, остальное исполнителю; сумма сходится', () => {
  assert.deepEqual(splitAmount(1_000_000), { priceKop: 1_000_000, commissionKop: 200_000, payoutKop: 800_000 });
  assert.deepEqual(splitAmount(1_001), { priceKop: 1_001, commissionKop: 200, payoutKop: 801 });
  assert.deepEqual(splitAmount(1_003), { priceKop: 1_003, commissionKop: 201, payoutKop: 802 });
  for (const p of [100, 101, 333, 999_999, 1_000_000_000]) {
    const s = splitAmount(p);
    assert.equal(s.commissionKop + s.payoutKop, p);
  }
});

test('цена без диспетчера не назначается; без цены дело не предложить', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty' })).body.order;
  await owner.req('PATCH', `/api/orders/${o.id}`, READY);
  assert.equal((await dispatcher.req('PUT', `/api/orders/${o.id}/price`, { price: '5000' })).status, 409, '«новая» — ещё не в подборе');
  await step(owner, o, 'matching', 'new');
  const r = await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'no_price');
  assert.equal((await dispatcher.req('PUT', `/api/orders/${o.id}/price`, { price: '5000' })).status, 200);
  assert.equal((await dispatcher.req('PUT', `/api/orders/${o.id}/price`, { price: '6000.5' })).body.money.price_kop, 600050, 'в подборе цену можно поправить');
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
});

test('отменённый платёж: результат не выдаётся, можно заплатить заново; выплаты нет', async () => {
  const o = await doneOrder();
  S.providers.payments.nextOutcome = 'canceled';
  const p1 = (await owner.req('POST', `/api/orders/${o.id}/payments`)).body.payment;
  const m1 = (await owner.req('POST', `/api/orders/${o.id}/payments/refresh`)).body.money;
  assert.equal(m1.paid, false);
  assert.equal(m1.payment.status, 'canceled');
  assert.equal(m1.can_pay, true);
  assert.equal((await owner.req('GET', `/api/orders/${o.id}/documents`)).body.results_hidden, true);
  const [{ n: none }] = await S.sql`select count(*)::int as n from payouts where order_id = ${o.id}`;
  assert.equal(none, 0);
  S.providers.payments.nextOutcome = 'succeeded';
  const p2 = await owner.req('POST', `/api/orders/${o.id}/payments`);
  assert.equal(p2.status, 201);
  assert.notEqual(p2.body.payment.id, p1.id);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/payments/refresh`)).body.money.paid, true);
  assert.equal((await owner.req('GET', `/api/orders/${o.id}/documents`)).body.results_hidden, false);
});

test('поставщик оплаты недоступен: понятная ошибка, платёж не висит, можно повторить', async () => {
  const o = await doneOrder();
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

test('уведомления ЮKassa: содержимому не верим, повтор не создаёт вторую выплату и второй акт (Б-16)', async () => {
  const o = await doneOrder(1_234_567);
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
  const outs = await S.sql`select amount_kop, commission_kop, status from payouts where order_id = ${o.id}`;
  assert.equal(outs.length, 1);
  assert.deepEqual([Number(outs[0].amount_kop), Number(outs[0].commission_kop), outs[0].status], [987_654, 246_913, 'succeeded']);
  const payoutCalls = S.providers.payments.calls.filter((c) => c.method === 'createPayout' && c.args.description.includes(o.id.slice(0, 8).toUpperCase()));
  assert.equal(payoutCalls.length, 1, 'поставщику выплата отправлена один раз');
  const docs = await S.sql`select kind, data from closing_documents where order_id = ${o.id} order by number`;
  assert.deepEqual(docs.map((d) => d.kind), ['act', 'agent_report']);
  assert.equal(docs[0].data.test, true, 'документ помечен как проверочный (поддельная оплата)');
  // Без входа уведомление ничего не открывает, а неверный вид данных — просто пропускается.
  assert.equal((await anon.req('POST', '/api/payments/notify', { object: { id: 'x'.repeat(500) } }, { csrf: false })).status, 200);
  assert.equal((await anon.req('POST', '/api/payments/notify', {}, { csrf: false })).status, 200);
});

test('неудавшаяся выплата: видна исполнителю и диспетчеру, диспетчер повторяет; успешную второй раз не провести', async () => {
  const o = await doneOrder();
  S.providers.payments.payoutOutcome = 'failed';
  await owner.req('POST', `/api/orders/${o.id}/payments`);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/payments/refresh`)).body.money.paid, true);
  const sp = (await spec.req('GET', `/api/orders/${o.id}/money`)).body.money;
  assert.equal(sp.payout.status, 'failed');
  assert.equal(sp.can_retry_payout, false);
  const dm = (await dispatcher.req('GET', `/api/orders/${o.id}/money`)).body.money;
  assert.equal(dm.can_retry_payout, true);
  assert.equal(dm.payout.failure, 'тестовый отказ выплаты');
  const sum = (await dispatcher.req('GET', '/api/money')).body.totals;
  assert.ok(sum.to_pay_kop >= 800_000, 'неудавшаяся выплата числится «к выплате»');
  S.providers.payments.payoutOutcome = 'succeeded';
  const r = (await dispatcher.req('POST', `/api/orders/${o.id}/payout/retry`)).body.money;
  assert.equal(r.payout.status, 'succeeded');
  assert.equal(r.payout.attempts, 2);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/payout/retry`)).status, 409);
  const mine = (await spec.req('GET', '/api/payouts')).body;
  assert.ok(mine.totals.paid_out_kop >= 800_000);
});
