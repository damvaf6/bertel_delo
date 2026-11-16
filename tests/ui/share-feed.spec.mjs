// 2.516 (пачка «Оценка доли и раздел имущества») — телефон 412×915: в ленте заказов эксперт до «Взять заказ» видит, что
// оценивается доля, её размер и способ (часть стоимости целого — без скидки), а о собственниках — ничего.
// Номера +7 999 000-55-61/62 — только здесь.
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

test('2.516: в ленте у доли — размер и способ оценки', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  const cctx = await browser.newContext(ctx);
  const cp = await cctx.newPage();
  await signIn(cp, '+79990005561');
  const o = (await (await cp.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Доля в квартире' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 12 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'deal', region: 'moscow', object_type: 'share', address: 'г. Москва, Долевая ул., 5, кв. 6',
    share_size: '1/3', share_method: 'pro_rata', share_use: 'none', share_owners: 'Брат Долевой — 2/3, живёт в квартире' };
  expect((await cp.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H })).status()).toBe(200);
  expect((await cp.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 900000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_sharefeed_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });
  await cctx.close();

  const me = await signIn(page, '+79990005562');
  await db(async (c) => {
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [me.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [me.id]);
  });
  await page.goto('/kabinet');
  const row = page.locator(`#feed-box li[data-order="${o.id}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator('[data-role="feed-share"]')).toHaveText('Оценка доли: доля 1/3 · часть стоимости целого — целое × доля, без скидки · порядок пользования не определён');
  await expect(row.locator('[data-role="feed-facts"]')).not.toContainText('Не определён');
  await expect(row.locator('[data-role="feed-facts"]')).not.toContainText('Часть стоимости всего объекта');
  await expect(page.locator('#feed-box')).not.toContainText('Долев');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/screens/dl10-lenta-dolya.png', fullPage: true });
  expect(problems).toEqual([]);
});
