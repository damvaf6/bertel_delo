// Задача 2.550 — телефон 412×915: машино-место (доля в праве на паркинг, вместе с квартирой). У эксперта в списке документов —
// выписка ЕГРН, план паркинга с местом, порядок пользования местами и выписка на квартиру; техпаспорта квартиры нет. Эксперт
// отмечает четыре пункта — заказчик видит их с пояснениями. Номера +7 999 000-60-16…17 — только здесь.
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

test('2.550: документы по машино-месту — план паркинга, порядок пользования, выписка на квартиру; без техпаспорта', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990006016');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Машино-место: документы' }, headers: H })).json()).order;
  const day = (n) => new Date(Date.now() + n * 86400_000 + 3 * 3600_000).toISOString().slice(0, 10);
  const fields = { purpose: 'deal', region: 'moscow', object_type: 'parking', address: 'г. Москва, ул. Тестовая, д. 5, машино-место 17', area: 13.3,
    parking_kind: 'space', parking_type: 'underground', parking_level: '−2', parking_number: '17', parking_right: 'share', parking_share: '1/120', parking_with_flat: 'yes' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline: day(9), fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 600000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_pkdocs_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990006017');
  await db(async (c) => {
    await c.query("update users set full_name = 'Паркингов Иван Петрович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);

  await ep.goto(`/kabinet#order=${o.id}`);
  await expect(ep.locator('#docreq-box')).toBeVisible();
  const items = ep.locator('#docreq-items');
  await expect(items).toContainText('Выписка из ЕГРН');
  await expect(items).toContainText('Поэтажный план паркинга с отмеченным местом');
  await expect(items).toContainText('Соглашение о порядке пользования машино-местами');
  await expect(items).toContainText('Выписка из ЕГРН на квартиру в этом доме');
  await expect(items).not.toContainText('Технический паспорт БТИ');
  for (const id of ['egrn', 'parking_plan', 'parking_use', 'parking_flat_egrn']) await ep.locator(`#docreq-item-${id}`).check();
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await items.scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/pk02-dokumenty-parking.png', fullPage: false });
  await ep.locator('#docreq-form').getByRole('button', { name: /Запросить/ }).click();
  await expect(ep.locator('#docreq-msg')).toContainText('Запрошено документов: 4');

  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto(`/kabinet#order=${o.id}`);
  const list = page.locator('#docreq-list');
  await expect(list).toContainText('Поэтажный план паркинга с отмеченным местом');
  await expect(list).toContainText('номер, уровень и границы места');
  await expect(list).toContainText('Соглашение о порядке пользования машино-местами');
  await expect(list).toContainText('Выписка из ЕГРН на квартиру в этом доме');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await page.locator('#docreq-box').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/screens/pk03-dokumenty-parking-zakazchik.png', fullPage: false });
  expect(problems).toEqual([]);
  await ectx.close();
});
