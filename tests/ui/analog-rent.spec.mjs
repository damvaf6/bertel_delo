// Задача 2.523 — телефон 412×915: аналоги для нежилого. У аналога — «Продажа или аренда»; у аренды — ставка за кв. м в месяц;
// над списком — аналоги аренды не в счёт сравнительного подхода и их средняя ставка; в черновике у таблицы доходного подхода —
// подсказка со средней ставкой. Номера +7 999 000-55-76…77 — только здесь.
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

test('2.523: аналоги для нежилого — продажа или аренда', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005576');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Нежилое: аналоги аренды' }, headers: H })).json()).order;
  const day = (n) => new Date(Date.now() + n * 86400_000 + 3 * 3600_000).toISOString().slice(0, 10);
  const fields = { purpose: 'bank', bank: 'other', region: 'moscow', object_type: 'commercial', address: 'г. Москва, Тестовая ул., д. 5, пом. 1', area: 120, premises_use: 'office', lease: 'no' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline: day(9), fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 800000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_arent_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005577');
  await db(async (c) => {
    await c.query("update users set full_name = 'Арендов Пётр Ильич' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  const ids = [];
  for (const [n, deal, price] of [[1, 'sale', 30000000], [2, 'rent', 150000], [3, '', 200000]]) {
    const a = (await (await ep.request.post(`/api/orders/${o.id}/analogs`, { data: { url: `https://www.cian.ru/rent/commercial/test-rent-${n}/` }, headers: H })).json()).id;
    const put = await ep.request.put(`/api/orders/${o.id}/analogs/${a}`, { data: { fields: { price_rub: price, region: 'moscow', listed_on: day(-n), address: `Москва, Тестовая ул., д. ${n}`, area: 100, ...(deal ? { deal } : {}) } }, headers: H });
    expect(put.status(), await put.text()).toBe(200);
    ids.push(a);
  }
  await db((c) => c.query("update order_analogs set file_key = 'analogs/test/' || id, file_name = 'Скриншот.png', file_mime = 'image/png', file_size = 1, file_sha256 = repeat('a', 64), received_at = now(), confirmed_at = case when id = $2 then null else now() end where order_id = $1", [o.id, ids[2]]));

  await ep.goto(`/kabinet#order=${o.id}`);
  await expect(ep.locator('#analogs-box')).toBeVisible();
  const third = ep.locator(`[data-analog="${ids[2]}"]`);
  await expect(third.locator('.analog-warn')).toContainText('Отметьте: продажа или аренда');
  await expect(ep.locator(`[data-analog="${ids[1]}"] [data-rent]`)).toHaveText('Аренда: 1 500 руб. за кв. м в месяц — для доходного подхода, в сравнительный не идёт');
  // Эксперт отмечает на экране: третий — аренда, и подтверждает.
  await third.locator('select[data-field="deal"]').selectOption('rent');
  await third.locator('[data-action="analog-confirm"]').click();
  await expect(ep.locator('#analogs-hints')).toContainText('Нужно не меньше 3 аналогов продажи — подтверждено 1 (аналоги аренды не в счёт)');
  await expect(ep.locator('#analogs-hints')).toContainText('Аналоги аренды 2, 3 — в сравнительный подход не идут. Средняя ставка аренды аналогов 2, 3 — 1 750 руб. за кв. м в месяц (21 000 руб. за кв. м в год)');
  await expect(third.locator('[data-rent]')).toContainText('2 000 руб. за кв. м в месяц');
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.locator('#analogs-hints').scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/np07-analogi-arendy.png', fullPage: false });

  // Черновик: у таблицы доходного подхода — средняя ставка аналогов аренды.
  const d = await ep.request.post(`/api/orders/${o.id}/draft/ai`, { data: {}, headers: H });
  expect(d.status(), await d.text()).toBe(201);
  await ep.reload();
  const hint = ep.locator('#draft-income-rent');
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText(/^Средняя ставка аренды аналогов 2, 3 из раздела «Аналоги» — 1\s750 руб\. за кв\. м в месяц \(21\s000 руб\. за кв\. м в год\): впишите её в строку «Рыночная ставка аренды»/);
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await hint.scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/np08-stavka-arendy.png', fullPage: false });
  expect(problems).toEqual([]);
  await ectx.close();
});
