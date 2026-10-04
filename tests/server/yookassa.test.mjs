// ЮKassa (задача 2.46): драйвер оплаты и возврата по API v3 — против подставного сервера ЮKassa (настоящий тестовый
// магазин — после ключей Дамира). Вне prod — только тестовый ключ «test_…»; состоянию платежа верим только из ответа ЮKassa.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startApp, login, setPlatformRole, makeSpecialist, signResults } from '../helpers.mjs';
import { loadConfig, ConfigError } from '../../src/config.mjs';

let S, owner, dispatcher, spec, mock;
const seen = [];
const pays = new Map();
let refundReply = { status: 'succeeded' };

before(async () => {
  // Подставная ЮKassa: принимает платежи (pending → «оплачено» при первом запросе состояния) и возвраты.
  mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, key: req.headers['idempotence-key'], body });
      const send = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.headers.authorization !== `Basic ${Buffer.from('123456:test_secret').toString('base64')}`) return send(401, { type: 'error', code: 'invalid_credentials' });
      if (req.method === 'POST' && req.url === '/v3/payments') {
        const id = `2f${String(pays.size).padStart(6, '0')}-000f-5000-8000-000000000000`;
        pays.set(id, 'pending');
        return send(200, { id, status: 'pending', confirmation: { type: 'redirect', confirmation_url: `https://yoomoney.test/checkout?orderId=${id}` } });
      }
      const m = req.url.match(/^\/v3\/payments\/(.+)$/);
      if (req.method === 'GET' && m) {
        if (!pays.has(m[1])) return send(404, { type: 'error', code: 'not_found' });
        if (pays.get(m[1]) === 'pending') pays.set(m[1], 'succeeded');
        return send(200, { id: m[1], status: pays.get(m[1]) });
      }
      if (req.method === 'POST' && req.url === '/v3/refunds') return send(200, { id: `rf-${seen.length}`, ...refundReply });
      return send(404, { type: 'error', code: 'not_found' });
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  S = await startApp({
    PAYMENTS_PROVIDER: 'yookassa', YOOKASSA_URL: `http://127.0.0.1:${mock.address().port}/v3`,
    YOOKASSA_SHOP_ID: '123456', YOOKASSA_SECRET_KEY: 'test_secret', PUBLIC_URL: 'https://delo.test',
  });
  owner = await login(S, '+79990000621');
  dispatcher = await login(S, '+79990000622');
  spec = await login(S, '+79990000623');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id);
});
after(async () => { await S?.close(); await new Promise((r) => mock?.close(r)); });

const READY = { deadline: new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 3' } };
const step = (c, o, to, from, extra = {}) => c.req('POST', `/api/orders/${o.id}/status`, { to, from, ...extra });

test('настройки ЮKassa: вне prod — только тестовый ключ, на prod — только боевой; без ключа сервер не стартует', () => {
  const base = { APP_ENV: 'dev', DATABASE_URL: 'postgres://x/y', PAYMENTS_PROVIDER: 'yookassa', PUBLIC_URL: 'https://delo.test', YOOKASSA_SHOP_ID: '123456' };
  assert.throws(() => loadConfig(base), ConfigError);
  assert.throws(() => loadConfig({ ...base, YOOKASSA_SECRET_KEY: 'live_xxx' }), /только тестовый магазин/);
  assert.equal(loadConfig({ ...base, YOOKASSA_SECRET_KEY: 'test_xxx' }).providers.payments, 'yookassa');
  assert.throws(() => loadConfig({ ...base, YOOKASSA_SECRET_KEY: 'test_xxx', PUBLIC_URL: '' }), /PUBLIC_URL/);
});

test('оплата через ЮKassa: платёж с ключом идемпотентности и адресом возврата, оплата — по ответу ЮKassa; возврат при отмене; выплата без шлюза — «не прошла»', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Квартира через ЮKassa' })).body.order;
  await owner.req('PATCH', `/api/orders/${o.id}`, READY);
  assert.equal((await step(owner, o, 'matching', 'new')).status, 200);
  assert.equal((await dispatcher.req('PUT', `/api/orders/${o.id}/price`, { price: '15000,50' })).status, 200);
  const r = await owner.req('POST', `/api/orders/${o.id}/payments`);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.confirmation_url, /^https:\/\/yoomoney\.test\/checkout/);
  const create = seen.find((x) => x.method === 'POST' && x.url === '/v3/payments');
  assert.deepEqual(create.body.amount, { value: '15000.50', currency: 'RUB' });
  assert.equal(create.body.capture, true);
  assert.equal(create.body.confirmation.return_url, `https://delo.test/kabinet.html#order=${o.id}`);
  assert.equal(create.body.metadata.order_id, o.id);
  assert.ok(create.key, 'ключ идемпотентности');
  assert.equal(create.body.receipt, undefined, 'чек 54-ФЗ — только по решению Дамира');
  // Уведомление ЮKassa с «succeeded» в теле ничего не решает — ядро спрашивает состояние само.
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/payments/refresh`)).body.money.paid, true);
  assert.ok(seen.some((x) => x.method === 'GET' && x.url.startsWith('/v3/payments/')));

  // Отмена диспетчером до начала работ — полный возврат через ЮKassa.
  assert.equal((await step(dispatcher, o, 'cancelled', 'matching', { reason: 'Тест возврата' })).status, 200);
  const refund = seen.find((x) => x.url === '/v3/refunds');
  assert.deepEqual(refund.body.amount, { value: '15000.50', currency: 'RUB' });
  assert.equal(refund.body.payment_id, create.body ? [...pays.keys()][0] : null);
  const m = (await owner.req('GET', `/api/orders/${o.id}/money`)).body.money;
  assert.equal(m.refund.status, 'succeeded');

  // Выдача результата: выплата исполнителю без шлюза выплат — «не прошла» с понятной причиной; повторит диспетчер.
  const o2 = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Квартира 2' })).body.order;
  await owner.req('PATCH', `/api/orders/${o2.id}`, READY);
  await step(owner, o2, 'matching', 'new');
  await dispatcher.req('PUT', `/api/orders/${o2.id}/price`, { price: '10000' });
  await owner.req('POST', `/api/orders/${o2.id}/payments`);
  assert.equal((await owner.req('POST', `/api/orders/${o2.id}/payments/refresh`)).body.money.paid, true);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o2.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec, o2, 'in_work', 'awaiting_executor')).status, 200);
  await spec.req('POST', `/api/orders/${o2.id}/results`, Buffer.from('отчёт'), { raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': 'r.pdf' } });
  await signResults(S, spec, o2.id);
  assert.equal((await step(spec, o2, 'review', 'in_work')).status, 200);
  const rv = (await dispatcher.req('GET', `/api/orders/${o2.id}/review`)).body;
  for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${o2.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
  assert.equal((await step(dispatcher, o2, 'done', 'review')).status, 200);
  const sm = (await spec.req('GET', `/api/orders/${o2.id}/money`)).body.money;
  assert.equal(sm.payout.status, 'failed');
  assert.match(sm.payout.failure, /шлюз выплат/);
});

test('ЮKassa отклонила или не ответила — понятная ошибка, заявка не ломается', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Квартира: отказ ЮKassa' })).body.order;
  await owner.req('PATCH', `/api/orders/${o.id}`, READY);
  await step(owner, o, 'matching', 'new');
  await dispatcher.req('PUT', `/api/orders/${o.id}/price`, { price: '5000' });
  const real = S.cfg.yookassa.secretKey;
  // Неверный ключ — ЮKassa отвечает 401: оплата недоступна, платёж не висит.
  const { yookassa } = await import('../../src/providers/yookassa.mjs');
  const bad = yookassa({ ...S.cfg.yookassa, secretKey: 'test_wrong' });
  await assert.rejects(bad.createPayment({ idempotenceKey: 'k', orderId: o.id, amountKop: 500000, description: 'x', returnUrl: 'https://delo.test' }), /ЮKassa: 401 invalid_credentials/);
  assert.equal(real, 'test_secret');
  refundReply = { status: 'canceled', cancellation_details: { reason: 'insufficient_funds' } };
  const ref = await yookassa(S.cfg.yookassa).createRefund({ idempotenceKey: 'k2', paymentId: 'p1', amountKop: 100, description: 'x' });
  assert.deepEqual([ref.status, ref.failure], ['failed', 'ЮKassa отклонила возврат: insufficient_funds']);
  refundReply = { status: 'succeeded' };
});
