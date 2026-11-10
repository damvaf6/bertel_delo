// Лента заказов эксперта (2.468, решение Дамира 10.11.2026) — телефон 412×915: эксперт на главной видит оплаченный заказ
// по своей услуге (без адреса), нажимает «Взять заказ» — дело открывается в работе, адрес виден; заказ из ленты пропадает.
// Заказчик видит «В работе». Номера +7 999 000-46-9x — только здесь.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DB_URL, TEST_TOKEN } from '../helpers.mjs';

const CONTROL = process.env.UI_TEST_CONTROL_TOKEN || TEST_TOKEN;
const H = { 'x-delo-request': '1' };
const ADDRESS = 'г. Москва, Учебная ул., 5, кв. 8';

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

test('лента заказов (2.468): эксперт видит оплаченный заказ без адреса, берёт его — дело в работе у него', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  // Заказчик: заявка на оценку квартиры, отправлена; оплата и цена — как после оплаты (поддельная оплата).
  const cctx = await browser.newContext(ctx);
  const cp = await cctx.newPage();
  await signIn(cp, '+79990004691');
  const o = (await (await cp.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Квартира для сделки' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  expect((await cp.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: ADDRESS } }, headers: H })).status()).toBe(200);
  expect((await cp.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 600000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_feed_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  // Эксперт с допуском на оценку недвижимости в Москве.
  const me = await signIn(page, '+79990004692');
  await db(async (c) => {
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [me.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [me.id]);
  });
  await page.goto('/kabinet');
  const box = page.locator('#feed-box');
  await expect(box).toBeVisible();
  const row = box.locator(`li[data-order="${o.id}"]`);
  await expect(row.locator('.title')).toHaveText('Оценка недвижимости');
  await expect(row.locator('[data-role="feed-facts"]')).toContainText('Квартира');
  await expect(row.locator('[data-role="feed-due"]')).toContainText('Вам — 4 800 ₽');
  await expect(box).not.toContainText('Учебная');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await box.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/screens/fd01-lenta.png', fullPage: true });

  await row.locator('[data-role="feed-take"]').click();
  await expect(page).toHaveURL(new RegExp(`#order=${o.id}`));
  await expect(page.locator('#order-view')).toBeVisible();
  await expect(page.locator('#order-view')).toContainText('В работе');
  await expect(page.locator('#order-view')).toContainText('Учебная');
  await page.screenshot({ path: 'test-results/screens/fd02-vzyal.png', fullPage: true });

  // Из ленты пропал; заказчик видит «В работе».
  await page.goto('/kabinet');
  await expect(page.locator('#feed-box')).toBeVisible();
  await expect(page.locator(`#feed-list li[data-order="${o.id}"]`)).toHaveCount(0);
  await cp.goto(`/kabinet#order=${o.id}`);
  await expect(cp.locator('#order-view')).toContainText('В работе');
  await cctx.close();
  expect(problems).toEqual([]);
});
