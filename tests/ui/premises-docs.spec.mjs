// Задача 2.520 — телефон 412×915: оценка нежилого помещения (офис сдаётся). У эксперта в списке документов — поэтажный
// план с экспликацией и договор аренды; заказчик видит запрошенное с подсказками. Номера +7 999 000-55-80…81 — только здесь.
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
const ru = (iso) => iso.split('-').reverse().join('.');

test('2.520: документы по нежилому — поэтажный план с экспликацией и договор аренды', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005580');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Нежилое помещение: офис сдаётся' }, headers: H })).json()).order;
  const day = (n) => new Date(Date.now() + n * 86400_000 + 3 * 3600_000).toISOString().slice(0, 10);
  const fields = { purpose: 'deal', region: 'moscow', object_type: 'commercial', premises_use: 'office', lease: 'full', lease_rent: 150000, address: 'г. Москва, Тестовая ул., д. 11, пом. 3', area: 120 };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline: day(9), fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 800000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_premdocs_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005581');
  await db(async (c) => {
    await c.query("update users set full_name = 'Нежилов Пётр Ильич' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);

  await ep.goto(`/kabinet#order=${o.id}`);
  await expect(ep.locator('#docreq-box')).toBeVisible();
  const items = ep.locator('#docreq-items');
  await expect(items).toContainText('Поэтажный план и экспликация помещения (БТИ)');
  await expect(items).toContainText('Договор аренды и дополнительные соглашения к нему');
  await expect(items).not.toContainText('Технический паспорт БТИ или поэтажный план');
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.locator('#docreq-item-lease_contract').scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/np02-dokumenty-nezhiloe.png', fullPage: false });

  await ep.locator('#docreq-item-premises_plan').check();
  await ep.locator('#docreq-item-lease_contract').check();
  await ep.locator('#docreq-send').click();
  await expect(ep.locator('#docreq-list')).toContainText('Договор аренды и дополнительные соглашения к нему');

  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto(`/kabinet#order=${o.id}`);
  await expect(page.locator('#docreq-list')).toContainText('кто платит расходы');
  await expect(page.locator('#docreq-list')).toContainText('назначение каждой части помещения');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await page.locator('#docreq-box').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/screens/np03-dokumenty-nezhiloe-zakazchik.png', fullPage: false });
  expect(problems).toEqual([]);
  await ectx.close();
});
