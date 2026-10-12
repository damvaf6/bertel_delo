// ЮKassa — проверка перед подключением (задача 2а.10, задача штаба 3f417197-…-ae86): публичный адрес HTTPS для уведомлений,
// адрес возврата, ключи, реквизиты, частые ошибки; контакт покупателя для чека (почта из профиля, без неё — телефон).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startApp, login, setPlatformRole } from '../helpers.mjs';
import { loadConfig } from '../../src/config.mjs';
import { NOTIFY_EVENTS, paymentsReadiness, probeWebhook, publicUrlProblems } from '../../src/money/yookassa-check.mjs';

let S, admin, owner, dispatcher, mock;
const created = [];

before(async () => {
  // Подставная ЮKassa: только создание платежа — запоминаем тело запроса.
  mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v3/payments') {
        created.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: `pay-${created.length}`, status: 'pending', confirmation: { confirmation_url: 'https://yoomoney.test/checkout' } }));
      }
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  S = await startApp({
    PAYMENTS_PROVIDER: 'yookassa', YOOKASSA_URL: `http://127.0.0.1:${mock.address().port}/v3`, YOOKASSA_RECEIPTS: '1',
    YOOKASSA_SHOP_ID: '123456', YOOKASSA_SECRET_KEY: 'test_secret', PUBLIC_URL: 'https://delo.example.ru',
  });
  admin = await login(S, '+79990000981');
  owner = await login(S, '+79990000982');
  dispatcher = await login(S, '+79990000983');
  await setPlatformRole(S.sql, admin.user.id, 'admin');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
});
after(async () => { await S?.close(); await new Promise((r) => mock?.close(r)); });

const cfgOf = (env) => loadConfig({ APP_ENV: 'dev', DATABASE_URL: 'postgres://x/y', ...env });
const item = (check, key) => check.items.find((i) => i.key === key);

test('адрес сайта для ЮKassa: только https, публичное имя, порт 443/8443, без пути; на боевом — не адрес площадки', () => {
  assert.deepEqual(publicUrlProblems('https://delo.example.ru'), []);
  assert.deepEqual(publicUrlProblems('https://delo.example.ru:8443'), []);
  assert.match(publicUrlProblems('')[0], /не задан/);
  assert.match(publicUrlProblems('http://delo.example.ru').join(), /не https/);
  assert.match(publicUrlProblems('https://delo.example.ru:3000').join(), /порт 3000/);
  assert.match(publicUrlProblems('https://localhost').join(), /не публичное/);
  assert.match(publicUrlProblems('https://192.168.1.5').join(), /не публичное/);
  assert.match(publicUrlProblems('https://84.201.1.2').join(), /не публичное/);
  assert.match(publicUrlProblems('https://delo.example.ru/app').join(), /без пути/);
  assert.match(publicUrlProblems('https://stage.delo.example.ru', 'prod').join(), /площадку/);
  assert.deepEqual(publicUrlProblems('https://stage.delo.example.ru', 'stage'), []);
});

test('проверка по пунктам: поддельная оплата — к сведению, ЮKassa — адрес уведомлений, события, ключ не показывается', () => {
  const fake = paymentsReadiness(cfgOf({}));
  assert.equal(fake.ready, false);
  assert.equal(item(fake, 'provider').ok, null);
  assert.equal(item(fake, 'keys').ok, null);
  assert.equal(item(fake, 'webhook').ok, false, 'без PUBLIC_URL уведомления слать некуда');
  assert.equal(fake.webhook_url, null);

  const yk = paymentsReadiness(cfgOf({ PAYMENTS_PROVIDER: 'yookassa', YOOKASSA_SHOP_ID: '123456', YOOKASSA_SECRET_KEY: 'test_secret_key', PUBLIC_URL: 'https://delo.example.ru/' }));
  assert.equal(yk.webhook_url, 'https://delo.example.ru/api/payments/notify');
  assert.deepEqual(yk.events, NOTIFY_EVENTS);
  assert.equal(item(yk, 'webhook').ok, true);
  assert.match(item(yk, 'webhook').text, /payment\.succeeded, payment\.canceled, refund\.succeeded/);
  assert.match(item(yk, 'return_url').text, /^https:\/\/delo\.example\.ru\/kabinet\.html#order=/);
  assert.match(item(yk, 'keys').text, /магазин 123456, ключ тестовый/);
  assert.ok(!JSON.stringify(yk).includes('test_secret_key'), 'ключ в ответе не показывается');
  assert.equal(item(yk, 'receipts').ok, null, 'чеки — по решению Дамира');
  assert.equal(item(yk, 'operator').ok, false, 'реквизитов юрлица ещё нет');
  assert.match(item(yk, 'operator').text, /ИНН, ОГРН, адрес, банк/);
  assert.equal(yk.ready, false);
  const full = paymentsReadiness(cfgOf({ PAYMENTS_PROVIDER: 'yookassa', YOOKASSA_SHOP_ID: '123456', YOOKASSA_SECRET_KEY: 'test_x', PUBLIC_URL: 'https://delo.example.ru',
    OPERATOR_INN: '7700000000', OPERATOR_OGRN: '1027700000000', OPERATOR_ADDRESS: 'г. Москва, тестовая ул., 1', OPERATOR_BANK: 'р/с тестовый' }));
  assert.equal(full.ready, true);
  for (const k of ['webhook_http', 'webhook_events', 'return_url', 'receipt_contact', 'moderation_site']) assert.ok(full.mistakes.some((m) => m.key === k), k);
});

test('«проверить адрес уведомлений»: пустое уведомление доходит и отвечает 200; переадресация, ошибка, сертификат — понятно', async () => {
  // Настоящий сервер ядра вместо публичного адреса: тот же путь и то же тело, что шлёт проверка.
  const viaLocal = (url, opts) => fetch(url.replace('https://delo.example.ru', S.base), opts);
  const ok = await probeWebhook('https://delo.example.ru', viaLocal);
  assert.equal(ok.ok, true, ok.text);
  assert.match(ok.text, /отвечает 200/);
  assert.match((await probeWebhook('https://delo.example.ru', async () => ({ status: 301 }))).text, /переадресацией/);
  assert.match((await probeWebhook('https://delo.example.ru', async () => ({ status: 403 }))).text, /отвечает 403/);
  const certErr = Object.assign(new Error('fetch failed'), { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } });
  assert.match((await probeWebhook('https://delo.example.ru', async () => { throw certErr; })).text, /сертификата/);
  assert.match((await probeWebhook('https://delo.example.ru', async () => { throw new Error('ECONNREFUSED'); })).text, /не отвечает/);
  assert.match((await probeWebhook('http://localhost:3000')).text, /PUBLIC_URL/);
  // Пустое уведомление ничего не создало и не поменяло.
  assert.equal((await S.sql`select count(*)::int as n from payments`)[0].n, 0);
});

test('операция проверки — только администратор; ключ не показывается', async () => {
  for (const c of [owner, dispatcher]) assert.equal((await c.req('GET', '/api/admin/payments-check')).status, 404);
  const r = await admin.req('GET', '/api/admin/payments-check');
  assert.equal(r.status, 200);
  assert.equal(r.body.check.webhook_url, 'https://delo.example.ru/api/payments/notify');
  assert.equal(item(r.body.check, 'receipts').ok, true);
  assert.ok(!JSON.stringify(r.body).includes('test_secret'));
  assert.equal(r.body.check.probe, undefined, 'адрес проверяется только по кнопке');
});

test('чек 54-ФЗ включён: контакт покупателя — подтверждённая почта из профиля, без неё — телефон входа', async () => {
  const pay = async () => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Квартира, чек' })).body.order;
    await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10),
      fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 4' } });
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
    assert.equal((await dispatcher.req('PUT', `/api/orders/${o.id}/price`, { price: '1000' })).status, 200);
    const r = await owner.req('POST', `/api/orders/${o.id}/payments`);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return created.at(-1);
  };
  const byPhone = await pay();
  assert.deepEqual(byPhone.receipt.customer, { phone: '79990000982' });
  assert.equal(byPhone.receipt.items[0].agent_type, 'agent');
  // Неподтверждённая почта не годится.
  await S.sql`insert into mail_addresses (user_id, email) values (${owner.user.id}, 'owner@example.ru')`;
  assert.deepEqual((await pay()).receipt.customer, { phone: '79990000982' });
  await S.sql`update mail_addresses set confirmed_at = now() where user_id = ${owner.user.id}`;
  assert.deepEqual((await pay()).receipt.customer, { email: 'owner@example.ru' });
});
