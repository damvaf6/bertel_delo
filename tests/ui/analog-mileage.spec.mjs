// Задача 2.493 — телефон 412×915: в заявке пробег 100 000 км, помощник на выезде записал по прибору 190 000 км; у аналога —
// 110 000 км и корректировки на пробег нет. У аналога и в подсказках раздела «Аналоги» — «нужна корректировка «Пробег»»;
// корректировка «Пробег» снимает предупреждение. Номера +7 999 000-49-38…39 — только здесь.
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


test('2.493: пробег аналога далеко от пробега по прибору — нужна корректировка «Пробег»', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  const owner = await signIn(page, '+79990004938');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'vehicle', title: 'Машина: пробег аналогов' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'deal', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая Модель', year: 2020,
    vin: 'XTA00000000000001', reg_number: 'А001АА777', mileage: 100000 };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 800000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_amileage_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990004939');
  await db(async (c) => {
    await c.query("update users set full_name = 'Машинов Иван Петрович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'vehicle') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  // Выезд помощника завершён: пробег по прибору 190 000 км (как после «Готово» на странице выезда).
  await db((c) => c.query(`insert into onsite_visits (order_id, helper_id, assigned_by, planned_at, data, finished_at)
                           values ($1, $2, $3, now(), $4, now())`, [o.id, owner.id, expert.id, JSON.stringify({ condition: 'normal', match_order: 'yes', mileage: 190000 })]));
  const a = (await (await ep.request.post(`/api/orders/${o.id}/analogs`, { data: { url: 'https://auto.ru/cars/used/sale/test/camry/1/' }, headers: H })).json()).id;
  const listed = new Date().toISOString().slice(0, 10);
  const put = await ep.request.put(`/api/orders/${o.id}/analogs/${a}`, { data: { fields: { make_model: 'Тестовая Модель', price_rub: 1500000, year: 2020, region: 'moscow', listed_on: listed, mileage_km: 110000 } }, headers: H });
  expect(put.status(), await put.text()).toBe(200);

  await ep.goto(`/kabinet#order=${o.id}`);
  await expect(ep.locator('#analogs-box')).toBeVisible();
  const card = ep.locator('#analogs-list li.analog').first();
  await expect(card.locator('.analog-warn')).toContainText('Пробег, км: 110 000 у аналога, 190 000 у объекта (по прибору при осмотре) — нужна корректировка «Пробег»');
  await expect(ep.locator('#analogs-hints')).toContainText('Пробег далеко от объекта (по прибору при осмотре) у аналога 1 — нет корректировки «Пробег»');
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await card.locator('.analog-warn').scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/vt06-probeg-analoga.png', fullPage: false });

  // Корректировка «Пробег» с источником — предупреждения нет.
  const adj = await ep.request.put(`/api/orders/${o.id}/analogs/${a}`, { data: { adjustments: [{ kind: 'mileage', pct: 12, book: 'Справочник оценщика', year: 2026, table: '7' }] }, headers: H });
  expect(adj.status(), await adj.text()).toBe(200);
  await ep.reload();
  await expect(ep.locator('#analogs-list li.analog').first().locator('.analog-warn')).not.toContainText('Пробег');
  await expect(ep.locator('#analogs-hints')).not.toContainText('Пробег');
  expect(problems).toEqual([]);
  await ectx.close();
});
