// Задача 2.514 — телефон 412×915: оценка доли в квартире для раздела имущества. У эксперта в списке документов —
// соглашение о порядке пользования, свидетельство о браке, иск или соглашение о разделе; заказчик видит запрошенное с
// подсказками. Номера +7 999 000-55-36…37 — только здесь.
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

test('2.514: документы по доле и разделу имущества — порядок пользования, свидетельство о браке, иск о разделе', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005536');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Доля в квартире: раздел имущества' }, headers: H })).json()).order;
  const day = (n) => new Date(Date.now() + n * 86400_000 + 3 * 3600_000).toISOString().slice(0, 10);
  const fields = { purpose: 'division', region: 'moscow', object_type: 'share', share_size: '1/2', share_use: 'agreement', address: 'г. Москва, Тестовая ул., д. 11, кв. 8', area: 52 };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline: day(9), fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 800000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_sharedocs_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005537');
  await db(async (c) => {
    await c.query("update users set full_name = 'Долев Пётр Ильич' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);

  await ep.goto(`/kabinet#order=${o.id}`);
  await expect(ep.locator('#docreq-box')).toBeVisible();
  const items = ep.locator('#docreq-items');
  await expect(items).toContainText('Соглашение о порядке пользования или решение суда о нём');
  await expect(items).toContainText('Свидетельство о браке или о расторжении брака');
  await expect(items).toContainText('Исковое заявление или соглашение о разделе имущества');
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.locator('#docreq-item-share_use_doc').scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/dl07-dokumenty-dolya.png', fullPage: false });

  await ep.locator('#docreq-item-share_use_doc').check();
  await ep.locator('#docreq-item-marriage_doc').check();
  await ep.locator('#docreq-send').click();
  await expect(ep.locator('#docreq-list')).toContainText('Свидетельство о браке или о расторжении брака');

  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto(`/kabinet#order=${o.id}`);
  await expect(page.locator('#docreq-list')).toContainText('от этого зависит скидка на долю');
  await expect(page.locator('#docreq-list')).toContainText('с какого дня имущество общее');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await page.locator('#docreq-box').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/screens/dl08-dokumenty-dolya-zakazchik.png', fullPage: false });
  expect(problems).toEqual([]);
  await ectx.close();
});
