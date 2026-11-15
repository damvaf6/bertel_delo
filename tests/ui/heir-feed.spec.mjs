// Прогон 2.509 (пачка «Оценка для наследства») — телефон 412×915: в ленте заказов эксперт до «Взять заказ» видит, что заказ
// для нотариуса, оценка на прошлую дату (сколько месяцев назад — без самой даты) и сколько объектов в составе наследства.
// Номера +7 999 000-46-93/94 — только здесь.
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

test('прогон 2.509: в ленте — оценка для наследства на прошлую дату и несколько объектов', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  const cctx = await browser.newContext(ctx);
  const cp = await cctx.newPage();
  await signIn(cp, '+79990004693');
  const o = (await (await cp.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Квартира мамы' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 12 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'inheritance', region: 'moscow', object_type: 'flat', address: 'г. Москва, Наследная ул., 3, кв. 4',
    death_date: '10.01.2025', notary: 'Нотариус Тестова', heir_objects: 'Гараж в ГСК «Тестовый»\nАвтомобиль Лада Гранта 2018' };
  expect((await cp.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H })).status()).toBe(200);
  expect((await cp.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 900000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_heirfeed_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });
  await cctx.close();

  const me = await signIn(page, '+79990004694');
  await db(async (c) => {
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [me.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [me.id]);
  });
  await page.goto('/kabinet');
  const row = page.locator(`#feed-box li[data-order="${o.id}"]`);
  await expect(row).toBeVisible();
  const heir = row.locator('[data-role="feed-heir"]');
  await expect(heir).toContainText('Для нотариуса: оценка на прошлую дату');
  await expect(heir).toContainText('месяц');
  await expect(heir).toContainText('в составе наследства 3 объекта — стоимость каждого');
  await expect(page.locator('#feed-box')).not.toContainText('10.01.2025');
  await expect(page.locator('#feed-box')).not.toContainText('Гараж');
  await expect(page.locator('#feed-box')).not.toContainText('Наследная');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/screens/nh14-lenta-nasledstvo.png', fullPage: true });
  expect(problems).toEqual([]);
});
