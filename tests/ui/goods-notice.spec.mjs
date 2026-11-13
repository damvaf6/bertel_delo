// Извещение продавца об осмотре товара (2.485) — телефон 412×915: эксперт товароведческой экспертизы записывает продавца,
// дату, время и место осмотра, скачивает образец Word, отмечает «Извещены» и вставляет строку в раздел «4. Осмотр»
// черновика. Номера +7 999 000-48-51…52 — только здесь.
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


test('извещение продавца об осмотре товара (2.485): продавец, Word, «Извещены», строка в «4. Осмотр»', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990004851');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'goods', title: 'Ноутбук: извещение' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'court', region: 'moscow', subject: 'Ноутбук перестал включаться', questions: 'Есть ли недостаток?',
    purchase: '12.03.2026, магазин, 54 990 ₽', goods_kind: 'gadget', model: 'Тестовый ноутбук X1, s/n TEST0001',
    defects: 'не включается\nтрещина на крышке', found_date: '20.04.2026', location: 'у истца, г. Москва' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 600000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_gnotice_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990004852');
  await db(async (c) => {
    await c.query("update users set full_name = 'Товаров Иван Петрович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'goods') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  expect((await ep.request.post(`/api/orders/${o.id}/draft/ai`, { data: {}, headers: H })).status()).toBe(201);

  await ep.goto(`/kabinet#order=${o.id}`);
  const box = ep.locator('#inspnotice-box');
  await expect(box).toBeVisible();
  await expect(ep.locator('#inspnotice-lead')).toContainText('продавцу (изготовителю, импортёру) дату, время и место осмотра товара');
  await ep.locator('#inspnotice-open').click();
  await expect(ep.locator('#inspnotice-party option')).toHaveText(['Продавец', 'Изготовитель', 'Импортёр']);
  await expect(ep.locator('#inspnotice-name-label')).toHaveText('Кому — название продавца, изготовителя или импортёра');
  await ep.locator('#inspnotice-name').fill('ООО «Тест-Магазин»');
  const day = new Date(Date.now() + 3 * 3600_000 + 2 * 86400_000).toISOString().slice(0, 10);
  await ep.locator('#inspnotice-date').fill(day);
  await ep.locator('#inspnotice-time').fill('11:00');
  await ep.locator('#inspnotice-place').fill('г. Москва, ул. Тестовая, 5, офис эксперта');
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.locator('#inspnotice-form').scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/gw07-izveshchenie-prodavca.png', fullPage: false });
  await ep.locator('#inspnotice-save').click();
  await expect(ep.locator('#inspnotice-msg')).toContainText('Записано');
  const li = ep.locator('#inspnotice-list li');
  await expect(li).toHaveCount(1);
  await expect(li).toContainText('Продавец: ООО «Тест-Магазин»');

  const [dl] = await Promise.all([ep.waitForEvent('download'), li.getByRole('button', { name: 'Скачать извещение Word' }).click()]);
  expect(dl.suggestedFilename()).toBe('Извещение об осмотре — ООО Тест-Магазин.docx');

  await li.locator('select').selectOption('letter');
  await li.locator('[data-action="notice-mark"]').click();
  await expect(ep.locator('#inspnotice-msg')).toHaveText('Отмечено: извещены');
  await expect(li.locator('.notice-state')).toContainText('Извещены заказным письмом с уведомлением');
  await ep.locator('#inspnotice-draft').click();
  await expect(ep.locator('#inspnotice-msg')).toContainText('вставлена в раздел «Осмотр»');
  const text = await ep.locator('#draft-text').inputValue();
  expect(text).toMatch(/## 4\. Осмотр\nИзвещение об осмотре: об осмотре .* в 11:00, место — г\. Москва, ул\. Тестовая, 5, офис эксперта, извещены: ООО «Тест-Магазин» \(продавец\) — заказным письмом с уведомлением /);
  await box.scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/gw08-prodavec-izveshchen.png', fullPage: false });

  // Заказчик видит, но не пишет.
  await page.goto(`/kabinet#order=${o.id}`);
  await expect(page.locator('#inspnotice-list li')).toContainText('Извещены заказным письмом');
  await expect(page.locator('#inspnotice-open')).toBeHidden();
  expect(problems).toEqual([]);
  await ectx.close();
});
