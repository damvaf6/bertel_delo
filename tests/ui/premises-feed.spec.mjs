// 2.526 (пачка «Нежилое помещение и доходный подход») — телефон 412×915: в ленте заказов эксперт до «Взять заказ» видит у
// нежилого назначение, сдаётся ли помещение и вход — одной строкой; суммы аренды и адреса — нет.
// Номера +7 999 000-58-21/22 — только здесь.
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

test('2.526: в ленте у нежилого — назначение, аренда и вход', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  const cctx = await browser.newContext(ctx);
  const cp = await cctx.newPage();
  await signIn(cp, '+79990005821');
  const o = (await (await cp.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Офис на первом этаже' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 12 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'bank', region: 'moscow', object_type: 'commercial', address: 'г. Москва, Арендная ул., 9, пом. II',
    premises_use: 'office', lease: 'full', lease_rent: 187500, entrance: 'street' };
  expect((await cp.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H })).status()).toBe(200);
  expect((await cp.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 1500000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_premfeed_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });
  await cctx.close();

  const me = await signIn(page, '+79990005822');
  await db(async (c) => {
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [me.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [me.id]);
  });
  await page.goto('/kabinet');
  const row = page.locator(`#feed-box li[data-order="${o.id}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator('[data-role="feed-premises"]')).toHaveText('Нежилое: офис · сдаётся целиком — доходный подход, договор аренды в дело · вход с улицы');
  await expect(row.locator('[data-role="feed-facts"]')).not.toContainText('Офис');
  await expect(row.locator('[data-role="feed-facts"]')).not.toContainText('Сдаётся');
  await expect(page.locator('#feed-box')).not.toContainText('Арендн');
  await expect(page.locator('#feed-box')).not.toContainText('187');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/screens/np11-lenta-nezhiloe.png', fullPage: true });
  expect(problems).toEqual([]);
});
