// 2.546 (пачка «Квартира в новостройке: права по ДДУ») — телефон 412×915: в ленте заказов эксперт до «Взять заказ» видит у
// квартиры по ДДУ срок сдачи, проектную площадь и отделку — одной строкой; номера ДДУ, застройщика, ЖК и адреса — нет.
// Номера +7 999 000-54-61/62 — только здесь.
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

test('2.546: в ленте у ДДУ — срок сдачи, площадь, отделка', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  const cctx = await browser.newContext(ctx);
  const cp = await cctx.newPage();
  await signIn(cp, '+79990005461');
  const o = (await (await cp.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Новостройка' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 12 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'bank', region: 'moscow', object_type: 'ddu', address: 'г. Москва, ЖК «Лентовый», корп. 3',
    ddu_number: 'ЖК-77/3-145', ddu_date: '14.03.2025', ddu_developer: 'ООО «СЗ Лентовый»', ddu_complex: 'ЖК «Лентовый», корп. 3',
    ddu_unit: '145', ddu_area: 54.3, ddu_handover: 'IV квартал 2030', ddu_price: 9800000, ddu_finish: 'white' };
  expect((await cp.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H })).status()).toBe(200);
  expect((await cp.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 1500000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_ddufeed_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });
  await cctx.close();

  const me = await signIn(page, '+79990005462');
  await db(async (c) => {
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [me.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [me.id]);
  });
  await page.goto('/kabinet');
  const row = page.locator(`#feed-box li[data-order="${o.id}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator('[data-role="feed-ddu"]')).toHaveText('Новостройка, права по ДДУ: срок сдачи IV кв. 2030 · проектная 54,3 кв. м · предчистовая отделка');
  await expect(row.locator('[data-role="feed-facts"]')).toContainText('Квартира в новостройке (права по ДДУ)');
  await expect(row.locator('[data-role="feed-facts"]')).not.toContainText('white box');
  await expect(page.locator('#feed-box')).not.toContainText('Лентов');
  await expect(page.locator('#feed-box')).not.toContainText('ЖК-77');
  await expect(page.locator('#feed-box')).not.toContainText('СЗ');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/screens/du11-lenta-ddu.png', fullPage: true });
  expect(problems).toEqual([]);
});
