// Задача 2.543 — телефон 412×915: аналоги для квартиры по ДДУ. В деле о правах по ДДУ у аналога — стадия строительства, срок
// сдачи дома, кто продаёт и отделка; третий аналог сдаётся через год после срока по договору — у него «нужна корректировка
// «Срок сдачи дома»», над списком — строки о сроке и о застройщике с переуступкой. Эксперт добавляет корректировку «Срок сдачи
// дома» — предупреждение уходит. Номера +7 999 000-59-74…75 — только здесь.
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

test('2.543: аналоги для ДДУ — стадия, срок сдачи, кто продаёт, отделка', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005974');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'ДДУ: аналоги' }, headers: H })).json()).order;
  const day = (n) => new Date(Date.now() + n * 86400_000 + 3 * 3600_000).toISOString().slice(0, 10);
  const fields = { purpose: 'bank', region: 'moscow', object_type: 'ddu', address: 'г. Москва, ЖК «Тестовый», корп. 3, кв. 74 (усл.)', ddu_area: 54.3, ddu_handover: '31.12.2027', ddu_complex: 'ЖК «Тестовый», корп. 3' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline: day(9), fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 800000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_addu_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005975');
  await db(async (c) => {
    await c.query("update users set full_name = 'Новостроев Иван Петрович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  const ids = [];
  const base = (n) => ({ price_rub: 15000000 + n * 100000, region: 'moscow', listed_on: day(-n), address: `г. Москва, ЖК «Тестовый», корп. ${n}`, area: 54, ddu_stage: 'frame', ddu_finish: 'none' });
  for (const [n, due, seller] of [[1, 'IV кв. 2027', 'developer'], [2, '31.12.2027', 'developer'], [3, 'IV кв. 2028', 'assignment']]) {
    const a = (await (await ep.request.post(`/api/orders/${o.id}/analogs`, { data: { url: `https://www.cian.ru/sale/flat/test-ddu-${n}/` }, headers: H })).json()).id;
    const put = await ep.request.put(`/api/orders/${o.id}/analogs/${a}`, { data: { fields: { ...base(n), ddu_due: due, ddu_seller: seller } }, headers: H });
    expect(put.status(), await put.text()).toBe(200);
    ids.push(a);
  }

  await db((c) => c.query("update order_analogs set file_key = 'analogs/test/' || id, file_name = 'Скриншот.png', file_mime = 'image/png', file_size = 1, file_sha256 = repeat('a', 64), received_at = now(), confirmed_at = now() where order_id = $1", [o.id]));
  await ep.goto(`/kabinet#order=${o.id}`);
  await expect(ep.locator('#analogs-box')).toBeVisible();
  const third = ep.locator(`[data-analog="${ids[2]}"]`);
  await expect(third.locator('select[data-field="ddu_stage"]')).toHaveValue('frame');
  await expect(third.locator('[data-field="ddu_due"]')).toHaveValue('IV кв. 2028');
  await expect(third.locator('select[data-field="ddu_seller"]')).toHaveValue('assignment');
  await expect(third.locator('select[data-field="ddu_finish"]')).toHaveValue('none');
  await expect(third.locator('.analog-warn')).toContainText('Срок сдачи: IV кв. 2028 у аналога, IV кв. 2027 по договору — позже на 4 квартала, нужна корректировка «Срок сдачи дома»');
  await expect(ep.locator('#analogs-hints')).toContainText('Срок сдачи далеко от срока передачи по договору (IV кв. 2027) у аналога 3 — нет корректировки «Срок сдачи дома»');
  await expect(ep.locator('#analogs-hints')).toContainText('Продают: застройщик — аналоги 1, 2, переуступка — аналог 3');
  await expect(ep.locator('#analogs-box')).toContainText('Квартиры в новостройках (права по ДДУ)');
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.locator('#analogs-hints').scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/du06-analogi-ddu.png', fullPage: false });
  await third.locator('select[data-field="ddu_stage"]').scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/du07-analog-ddu.png', fullPage: false });

  // Корректировка «Срок сдачи дома» с источником — предупреждения нет.
  const adj = await ep.request.put(`/api/orders/${o.id}/analogs/${ids[2]}`, { data: { fields: { ...base(3), ddu_due: 'IV кв. 2028', ddu_seller: 'assignment' }, adjustments: [{ kind: 'ddu_due', pct: 6, book: 'Справочник оценщика', year: 2026, table: '14' }] }, headers: H });
  expect(adj.status(), await adj.text()).toBe(200);
  await ep.reload();
  await expect(ep.locator(`[data-analog="${ids[2]}"] .analog-warn`)).not.toContainText('Срок сдачи:');
  await expect(ep.locator('#analogs-hints')).not.toContainText('Срок сдачи далеко');
  expect(problems).toEqual([]);
  await ectx.close();
});
