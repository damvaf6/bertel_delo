// Задача 2.513 — телефон 412×915: аналоги для доли. В деле об оценке доли у аналога — «Продаётся доля или целый объект»;
// два аналога — целые квартиры, третий — доля без корректировки: у него предупреждение, над списком — «Аналоги смешаны».
// Эксперт отмечает у третьего «Доля в праве» на экране и добавляет корректировку «Доля / целый объект» — предупреждение уходит.
// Номера +7 999 000-55-34…35 — только здесь.
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

test('2.513: аналоги для доли — доли и целые объекты смешаны без корректировки', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005534');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Доля: аналоги' }, headers: H })).json()).order;
  const day = (n) => new Date(Date.now() + n * 86400_000 + 3 * 3600_000).toISOString().slice(0, 10);
  const fields = { purpose: 'division', region: 'moscow', object_type: 'share', address: 'г. Москва, Тестовая ул., д. 9, кв. 4', area: 60, share_size: '1/3', share_method: 'market' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline: day(9), fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 800000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_ashare_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005535');
  await db(async (c) => {
    await c.query("update users set full_name = 'Долин Иван Петрович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  const ids = [];
  for (const [n, kind] of [[1, 'whole'], [2, 'whole'], [3, '']]) {
    const a = (await (await ep.request.post(`/api/orders/${o.id}/analogs`, { data: { url: `https://www.cian.ru/sale/flat/test-share-${n}/` }, headers: H })).json()).id;
    const put = await ep.request.put(`/api/orders/${o.id}/analogs/${a}`, { data: { fields: { price_rub: 15000000 + n * 100000, region: 'moscow', listed_on: day(-n), address: `Москва, Тестовая ул., д. ${n}`, area: 60, ...(kind ? { share_kind: kind } : {}) } }, headers: H });
    expect(put.status(), await put.text()).toBe(200);
    ids.push(a);
  }

  await db((c) => c.query("update order_analogs set file_key = 'analogs/test/' || id, file_name = 'Скриншот.png', file_mime = 'image/png', file_size = 1 where order_id = $1", [o.id]));
  await ep.goto(`/kabinet#order=${o.id}`);
  await expect(ep.locator('#analogs-box')).toBeVisible();
  const third = ep.locator(`[data-analog="${ids[2]}"]`);
  await expect(third.locator('.analog-warn')).toContainText('Отметьте, что продаётся — доля или целый объект');
  // Эксперт отмечает на экране: третий — доля.
  await third.locator('select[data-field="share_kind"]').selectOption('share');
  await third.locator('[data-action="analog-confirm"]').click();
  await expect(ep.locator('#analogs-hints')).toContainText('Аналоги смешаны: доли — 3, целые объекты — 1, 2; без корректировки «Доля / целый объект» — аналог 3');
  await expect(third.locator('.analog-warn')).toContainText('Аналог — доля, а аналоги 1, 2 — целые объекты: цены несравнимы, нужна корректировка «Доля / целый объект»');
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.locator('#analogs-hints').scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/dl05-analogi-doli.png', fullPage: false });
  await third.locator('.analog-warn').scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/dl06-analog-dolya.png', fullPage: false });

  // Корректировка «Доля / целый объект» с источником — предупреждения нет.
  const adj = await ep.request.put(`/api/orders/${o.id}/analogs/${ids[2]}`, { data: { fields: { price_rub: 15300000, region: 'moscow', listed_on: day(-3), address: 'Москва, Тестовая ул., д. 3', area: 60, share_kind: 'share' }, adjustments: [{ kind: 'share_kind', pct: 40, book: 'Справочник оценщика', year: 2026, table: '12' }] }, headers: H });
  expect(adj.status(), await adj.text()).toBe(200);
  await ep.reload();
  await expect(ep.locator(`[data-analog="${ids[2]}"] .analog-warn`)).not.toContainText('целые объекты');
  await expect(ep.locator('#analogs-hints')).not.toContainText('смешаны');
  expect(problems).toEqual([]);
  await ectx.close();
});
