// Задача 2.490 — телефон 412×915: помощник на выезде записал пробег по прибору 131 512 км и отметил «VIN на кузове не
// совпадает», а в отчёте пробег из заявки и о VIN ни слова. ИИ-проверка в пункте «Транспорт» называет оба места.
// Номера +7 999 000-49-31…32 — только здесь.
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


test('2.490: пробег в отчёте — как по прибору при осмотре, расхождение VIN с выезда сказано в отчёте', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  const owner = await signIn(page, '+79990004931');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'vehicle', title: 'Машина: пробег по прибору' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'deal', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая Модель', year: 2020,
    vin: 'XTA00000000000001', reg_number: 'А001АА777', mileage: 120000 };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 800000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_vonsite_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990004932');
  await db(async (c) => {
    await c.query("update users set full_name = 'Машинов Иван Петрович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'vehicle') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  // Выезд помощника завершён: пробег по прибору и отметка о VIN (как после «Готово» на странице выезда).
  await db((c) => c.query(`insert into onsite_visits (order_id, helper_id, assigned_by, planned_at, data, finished_at)
                           values ($1, $2, $3, now(), $4, now())`, [o.id, owner.id, expert.id, JSON.stringify({ condition: 'normal', match_order: 'yes', mileage: 131512, vin_match: 'no' })]));
  const report = ['ОТЧЁТ ОБ ОЦЕНКЕ № 12/2026', '7. Описание объекта оценки', 'Легковой автомобиль Тестовая Модель, 2020 г. в., VIN XTA00000000000001, госномер А001АА777.',
    'Пробег по показаниям одометра: 120 000 км.', '13. Итоговая величина', 'Рыночная стоимость — 1 000 000 руб.'].join('\n');
  expect((await ep.request.post(`/api/orders/${o.id}/results`, {
    data: Buffer.from(report), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') },
  })).status()).toBe(201);

  await ep.goto(`/kabinet#order=${o.id}`);
  await ep.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(ep.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  const item = ep.locator('#review-checks > li[data-check="vehicle_identity"]');
  const km = item.locator('.ai-found li', { hasText: 'по прибору при осмотре' });
  await expect(km).toHaveCount(1);
  await expect(km).toContainText('Пробег 120 000 км не совпадает с пробегом по прибору при осмотре (131 512 км)');
  const vin = item.locator('.ai-found li', { hasText: 'VIN на кузове не совпадает' });
  await expect(vin).toHaveCount(1);
  await expect(vin).toContainText('в отчёте об этом ни слова');
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await km.scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/vt01-probeg-po-priboru.png', fullPage: false });
  expect(problems).toEqual([]);
  await ectx.close();
});
