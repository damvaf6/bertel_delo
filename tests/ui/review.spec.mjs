// Отзыв заказчика (2.467) — телефон 412×915: после выдачи заказчик видит в «Что дальше» шаг «Оставить отзыв», ставит
// 4 звезды из 5 и пишет пару слов; диспетчер видит отзыв в заявке и в карточке эксперта, эксперт — нет.
// Номера +7 999 000-46-77…79 — только здесь.
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

test('отзыв (2.467): после выдачи заказчик ставит 4 из 5 и пишет пару слов; диспетчер видит в заявке и в карточке эксперта', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990004677');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Квартира для продажи' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  expect((await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, Отзывная ул., 5' } }, headers: H })).status()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 600000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_review_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  // Эксперт берёт заказ из ленты; путь до выдачи проверяют свои сценарии — здесь статус «готово» ставится напрямую.
  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  const expert = await signIn(ep, '+79990004678');
  await db(async (c) => {
    await c.query("update users set full_name = 'Отзывов Пётр Сергеевич' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  await db((c) => c.query("update orders set status = 'done' where id = $1", [o.id]));

  // Заказчик: «Что дальше» — шаг «Оставить отзыв», форма со звёздами.
  await page.goto(`/kabinet#order=${o.id}`);
  await expect(page.locator('#next-steps [data-step="review"]')).toBeVisible();
  const box = page.locator('#rate-box');
  await expect(box).toBeVisible();
  await expect(box.locator('h2')).toHaveText('Ваш отзыв');
  await page.locator('#rate-send').click();
  await expect(page.locator('#rate-msg')).toContainText('Поставьте оценку');
  await page.locator('#rate-stars button[data-n="4"]').click();
  await expect(page.locator('#rate-msg')).toHaveText('');
  await expect(page.locator('#rate-stars button[aria-pressed="true"]')).toHaveCount(4);
  await expect(page.locator('#rate-stars-name')).toHaveText('4 из 5 — Хорошо');
  await page.locator('#rate-text').fill('Всё понятно объяснили, отчёт приняли в банке.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await box.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/screens/rv01-otzyv.png', fullPage: false });
  await page.locator('#rate-send').click();
  await expect(page.locator('#rate-msg')).toContainText('Спасибо');
  await expect(page.locator('#rate-form')).toBeHidden();
  await expect(page.locator('#rate-done-stars')).toHaveText(/★★★★☆\s+4 из 5/);
  await expect(page.locator('#rate-done-text')).toContainText('«Всё понятно объяснили, отчёт приняли в банке.»');
  await box.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/screens/rv02-otzyv-ostavlen.png', fullPage: false });

  // Эксперт отзыва не видит (по схеме — позже).
  await ep.goto(`/kabinet#order=${o.id}`);
  await expect(ep.locator('#order-title')).toBeVisible();
  await expect(ep.locator('#rate-box')).toBeHidden();
  await ectx.close();

  // Диспетчер: в заявке и в карточке эксперта.
  const dctx = await browser.newContext(ctx);
  const dp = await dctx.newPage();
  dp.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const disp = await signIn(dp, '+79990004679');
  await db((c) => c.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]));
  await dp.goto(`/kabinet#order=${o.id}`);
  await expect(dp.locator('#rate-box h2')).toHaveText('Отзыв заказчика');
  await expect(dp.locator('#rate-done-text')).toContainText('отчёт приняли в банке');
  await dp.goto(`/kabinet#expert=${expert.id}`);
  await expect(dp.locator('#expert-reviews-box')).toBeVisible();
  await expect(dp.locator('#expert-reviews-note')).toHaveText('Средняя оценка 4 из 5, отзывов: 1. В подборе учитывается от трёх отзывов.');
  await expect(dp.locator('#expert-reviews')).toContainText('★★★★☆ 4 из 5');
  await dp.locator('#expert-reviews-box').scrollIntoViewIfNeeded();
  expect(await dp.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await dp.screenshot({ path: 'test-results/screens/rv03-otzyvy-v-kartochke.png', fullPage: false });
  await dctx.close();
  expect(problems).toEqual([]);
});
