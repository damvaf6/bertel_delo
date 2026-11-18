// Задача 2.534 — телефон 412×915: аналоги для дома. В деле о жилом доме у аналога — площадь участка, материал стен и газ,
// без этажа и типа дома; третий аналог — без газа, а у дома газ магистральный: у него «нужна корректировка», над списком —
// строка. Эксперт добавляет корректировку «Газ, коммуникации» — предупреждение уходит.
// Номера +7 999 000-59-44…45 — только здесь.
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

test('2.534: аналоги для дома — участок, стены, газ', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005944');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Дом: аналоги' }, headers: H })).json()).order;
  const day = (n) => new Date(Date.now() + n * 86400_000 + 3 * 3600_000).toISOString().slice(0, 10);
  const fields = { purpose: 'deal', region: 'mo', object_type: 'house', address: 'Московская обл., Тестовый пос., ул. Садовая, д. 44', area: 120, house_walls: 'brick', house_land: 'own', land_area: 10, house_gas: 'main' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline: day(9), fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 800000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_ahouse_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005945');
  await db(async (c) => {
    await c.query("update users set full_name = 'Домов Иван Петрович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  const ids = [];
  const base = (n) => ({ price_rub: 12000000 + n * 100000, region: 'mo', listed_on: day(-n), address: `МО, Тестовый пос., д. ${n}`, area: 120, land_area: 10, walls: 'brick' });
  for (const [n, gas] of [[1, 'main'], [2, 'main'], [3, 'none']]) {
    const a = (await (await ep.request.post(`/api/orders/${o.id}/analogs`, { data: { url: `https://www.cian.ru/sale/suburban/test-house-${n}/` }, headers: H })).json()).id;
    const put = await ep.request.put(`/api/orders/${o.id}/analogs/${a}`, { data: { fields: { ...base(n), gas } }, headers: H });
    expect(put.status(), await put.text()).toBe(200);
    ids.push(a);
  }

  await db((c) => c.query("update order_analogs set file_key = 'analogs/test/' || id, file_name = 'Скриншот.png', file_mime = 'image/png', file_size = 1, file_sha256 = repeat('a', 64), received_at = now(), confirmed_at = now() where order_id = $1", [o.id]));
  await ep.goto(`/kabinet#order=${o.id}`);
  await expect(ep.locator('#analogs-box')).toBeVisible();
  const third = ep.locator(`[data-analog="${ids[2]}"]`);
  await expect(third.locator('select[data-field="gas"]')).toHaveValue('none');
  await expect(third.locator('select[data-field="walls"]')).toHaveValue('brick');
  await expect(third.locator('[data-field="land_area"]')).toHaveValue('10');
  await expect(third.locator('[data-field="floor"]')).toHaveCount(0);
  await expect(third.locator('[data-field="house_type"]')).toHaveCount(0);
  await expect(third.locator('.analog-warn')).toContainText('Газ: Нет у аналога, Магистральный у объекта — нужна корректировка «Газ, коммуникации»');
  await expect(ep.locator('#analogs-hints')).toContainText('Газ не как у объекта (Магистральный) у аналога 3 — нет корректировки «Газ, коммуникации»');
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.locator('#analogs-hints').scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/hs09-analogi-doma.png', fullPage: false });
  await third.locator('select[data-field="gas"]').scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/hs10-analog-doma.png', fullPage: false });

  // Корректировка «Газ, коммуникации» с источником — предупреждения нет.
  const adj = await ep.request.put(`/api/orders/${o.id}/analogs/${ids[2]}`, { data: { fields: { ...base(3), gas: 'none' }, adjustments: [{ kind: 'gas', pct: 8, book: 'Справочник оценщика', year: 2026, table: '21' }] }, headers: H });
  expect(adj.status(), await adj.text()).toBe(200);
  await ep.reload();
  await expect(ep.locator(`[data-analog="${ids[2]}"] .analog-warn`)).not.toContainText('Газ:');
  await expect(ep.locator('#analogs-hints')).not.toContainText('Газ не как у объекта');
  expect(problems).toEqual([]);
  await ectx.close();
});
