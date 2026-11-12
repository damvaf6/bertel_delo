// Готовые фразы эксперта по ДТП (2.477) — телефон 412×915: в деле «Ущерб после ДТП» над полем сообщения — «Документы
// ГИБДД», «Европротокол», «Акт и расчёт страховой», «Заказ-наряд»; нажатие подставляет текст (со страховой из заявки),
// ничего не отправлено; документ страховой получен — кнопки нет. Номера +7 999 000-47-75…76 — только здесь.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DB_URL, TEST_TOKEN } from '../helpers.mjs';

const CONTROL = process.env.UI_TEST_CONTROL_TOKEN || TEST_TOKEN;
const H = { 'x-delo-request': '1' };

async function signIn(page, phone) {
  expect((await page.request.post('/api/auth/code', { data: { phone }, headers: H })).status()).toBe(200);
  const calls = (await (await page.request.get('/__test/fakes/sms/calls', { headers: { 'x-test-control': CONTROL } })).json()).calls;
  const code = calls.filter((c) => c.method === 'sendCode' && c.args.phone === phone).at(-1).args.code;
  const r = await page.request.post('/api/auth/verify', { data: { phone, code }, headers: H });
  expect(r.status()).toBe(200);
  return (await r.json()).user;
}
async function db(fn) {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

test('фразы по ДТП (2.477): эксперт подставляет просьбу о документах, полученный документ — без фразы', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990004775');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'car_damage', title: 'ДТП: фразы' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'damage', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая Модель', year: 2021,
    accident_date: '14.09.2026', damage: 'Задний бампер', method: 'osago', insurer: 'Тестовая страховая, убыток 0001' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 600000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_cdp_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990004776');
  await db(async (c) => {
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'car_damage') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);

  await ep.goto(`/kabinet#order=${o.id}`);
  const chat = ep.locator('#chat-box');
  await expect(chat.locator('#message-phrase-list button')).toHaveText([
    'Доступ на осмотр', 'Уточнить адрес', 'Срок документов', 'Документы ГИБДД', 'Европротокол', 'Акт и расчёт страховой', 'Заказ-наряд',
  ]);
  await chat.getByRole('button', { name: 'Акт и расчёт страховой' }).click();
  await expect(chat.locator('#message-text')).toHaveValue(/акт осмотра страховой, её расчёт[\s\S]*В заявке указано: «Тестовая страховая, убыток 0001»\./);
  await chat.getByRole('button', { name: 'Европротокол' }).click();
  await expect(chat.locator('#message-text')).toHaveValue(/убыток 0001»[\s\S]*\n\nЕсли ДТП оформляли без ГИБДД, по европротоколу/);
  await expect(chat.locator('#messages li')).toHaveCount(0);
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await chat.locator('#message-form').scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/dq01-dtp-frazy.png', fullPage: false });

  // Заказчик прислал акт и расчёт страховой по запросу — кнопки «Акт и расчёт страховой» больше нет.
  expect((await ep.request.post(`/api/orders/${o.id}/doc-requests`, { data: { items: ['insurer_docs'] }, headers: H })).status()).toBe(201);
  const req = (await (await page.request.get(`/api/orders/${o.id}/doc-requests`, { headers: H })).json()).requests[0];
  const up = await page.request.post(`/api/orders/${o.id}/documents`, { data: Buffer.from('скан'),
    headers: { ...H, 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('акт-страховой.pdf') } });
  expect(up.status(), await up.text()).toBe(201);
  const doc = (await up.json()).document;
  expect((await page.request.post(`/api/orders/${o.id}/doc-requests/${req.id}/attach`, { data: { document_id: doc.id }, headers: H })).status()).toBe(200);
  await ep.reload();
  await expect(chat.locator('#message-phrase-list button')).toHaveText([
    'Доступ на осмотр', 'Уточнить адрес', 'Срок документов', 'Документы ГИБДД', 'Европротокол', 'Заказ-наряд',
  ]);

  // Заказчик фраз не видит.
  await page.goto(`/kabinet#order=${o.id}`);
  await expect(page.locator('#message-phrases')).toBeHidden();
  expect(problems).toEqual([]);
  await ectx.close();
});
