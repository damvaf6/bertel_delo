// Задача 2.503 — телефон 412×915: оценка квартиры для наследства, дата открытия наследства 5 месяцев назад; у аналога
// объявление сегодняшнее. У аналога — «Объявление позже даты оценки … — нужен архив объявлений на дату оценки или
// корректировка на дату», над списком — «Оценка на прошлую дату …»; корректировка «На дату оценки» снимает предупреждение.
// Номера +7 999 000-53-24…25 — только здесь.
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

test('2.503: объявление аналога намного позже даты оценки — нужен архив или корректировка на дату', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005324');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Квартира: аналоги для наследства' }, headers: H })).json()).order;
  const day = (n) => new Date(Date.now() + n * 86400_000 + 3 * 3600_000).toISOString().slice(0, 10);
  const death = day(-150);
  const fields = { purpose: 'inheritance', region: 'moscow', object_type: 'flat', address: 'г. Москва, Тестовая ул., д. 7, кв. 8', area: 45, death_date: ru(death) };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline: day(9), fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 800000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_aretro_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005325');
  await db(async (c) => {
    await c.query("update users set full_name = 'Наследов Пётр Иванович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  const a = (await (await ep.request.post(`/api/orders/${o.id}/analogs`, { data: { url: 'https://www.cian.ru/sale/flat/test-retro-1/' }, headers: H })).json()).id;
  const put = await ep.request.put(`/api/orders/${o.id}/analogs/${a}`, { data: { fields: { price_rub: 9500000, region: 'moscow', listed_on: day(0) } }, headers: H });
  expect(put.status(), await put.text()).toBe(200);

  await ep.goto(`/kabinet#order=${o.id}`);
  await expect(ep.locator('#analogs-box')).toBeVisible();
  const card = ep.locator('#analogs-list li.analog').first();
  await expect(card.locator('.analog-warn')).toContainText(`Объявление позже даты оценки (${ru(death)}) на `);
  await expect(card.locator('.analog-warn')).toContainText('нужен архив объявлений на дату оценки или корректировка на дату');
  await expect(ep.locator('#analogs-hints')).toContainText(`Оценка на прошлую дату (${ru(death)}): объявление аналога 1 позже неё больше чем на 3 месяца`);
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.locator('#analogs-hints').scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/nh06-analogi-zadnim-chislom.png', fullPage: false });

  // Корректировка «На дату оценки» с источником — предупреждения нет.
  const adj = await ep.request.put(`/api/orders/${o.id}/analogs/${a}`, { data: { adjustments: [{ kind: 'date', pct: -6, book: 'Справочник оценщика', year: 2026, table: '3' }] }, headers: H });
  expect(adj.status(), await adj.text()).toBe(200);
  await ep.reload();
  await expect(ep.locator('#analogs-list li.analog').first().locator('.analog-warn')).not.toContainText('позже даты оценки');
  await expect(ep.locator('#analogs-hints')).not.toContainText('прошлую дату');
  expect(problems).toEqual([]);
  await ectx.close();
});
