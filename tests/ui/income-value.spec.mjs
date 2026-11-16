// Задача 2.522 — телефон 412×915: ИИ-проверка «Доходный подход». Эксперт сдал отчёт об оценке нежилого помещения, где
// стоимость доходным подходом не сходится с расчётом (1 600 000 / 10% = 16 000 000, а в отчёте 15 000 000), — в ИИ-проверке
// пункт «Доходный подход» с находкой и «Исправить в черновике», которое находит сумму в черновике. Номера +7 999 000-54-34…35 —
// только здесь.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DB_URL, TEST_TOKEN } from '../helpers.mjs';

const CONTROL = process.env.UI_TEST_CONTROL_TOKEN || TEST_TOKEN;
const H = { 'x-delo-request': '1' };
const HEAD = '| Расчёт доходным подходом | Значение |';

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

test('2.522: ИИ-проверка «Доходный подход» — стоимость не сходится, «Исправить в черновике»', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005434');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Нежилое: доходный подход' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'bank', region: 'moscow', object_type: 'commercial', address: 'г. Москва, Тестовая ул., д. 5, пом. 1', area: 120,
    premises_use: 'office', lease: 'no' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 800000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_incomevalue_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005435');
  await db(async (c) => {
    await c.query("update users set full_name = 'Доходов Пётр Иванович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  const d = await ep.request.post(`/api/orders/${o.id}/draft/ai`, { data: {}, headers: H });
  expect(d.status(), await d.text()).toBe(201);
  const draft = (await d.json()).draft;

  // Эксперт заполнил таблицу в черновике с ошибкой в стоимости доли.
  const vals = ['18 000', 'аналоги аренды 1–4', '2 160 000', '8', 'справочник Лейфера 2025, табл. 40', '1 987 200', '387 200', 'налог, управление, ремонт',
    '1 600 000', '10', 'метод рыночной экстракции по аналогам', '15 000 000'];
  const lines = draft.body.split('\n');
  const at = lines.indexOf(HEAD);
  expect(at).toBeGreaterThan(0);
  let i = 0;
  for (let k = at + 1; k < at + 12; k += 1) lines[k] = lines[k].replace(/\[заполнить\]/g, () => vals[i++]);
  const body = lines.join('\n');
  expect((await ep.request.put(`/api/orders/${o.id}/draft`, { data: { body, from: draft.id }, headers: H })).status()).toBe(200);

  const report = [
    'ОТЧЁТ ОБ ОЦЕНКЕ № 31/2026',
    'Объект оценки: нежилое помещение, г. Москва, Тестовая ул., д. 5, пом. 1',
    '13. Доходный подход',
    ...lines.slice(at, at + 12),
    '14. Согласование результатов',
  ].join('\n');
  expect((await ep.request.post(`/api/orders/${o.id}/results`, {
    data: Buffer.from(report), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') },
  })).status()).toBe(201);
  await ep.goto(`/kabinet#order=${o.id}`);
  await ep.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(ep.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  const item = ep.locator('#review-checks > li[data-check="income_value"]');
  await expect(item).toContainText('Доходный подход: ПВД → ДВД → ЧОД → стоимость сходятся, у ставки капитализации и недозагрузки — источник');
  await expect(item).toContainText('Стоимость доходным подходом 15 000 000 руб. не сходится с расчётом: 1 600 000 / 10% = 16 000 000 руб.');
  const fix = item.locator('[data-action="fix-draft"]');
  await expect(fix).toHaveCount(1);
  await item.scrollIntoViewIfNeeded();
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.screenshot({ path: 'test-results/screens/np06-dohodny-podhod-proverka.png', fullPage: false });
  // «Исправить в черновике» находит сумму в черновике — сообщения «нет в черновике» нет.
  await fix.click();
  await expect(item.locator('[data-role="fix-draft-miss"]')).toBeHidden();
  const sel = await ep.locator('#draft-text').evaluate((t) => t.value.slice(t.selectionStart, t.selectionEnd));
  expect(sel).toBe('15 000 000');

  // Заказчик подсказок ИИ не видит.
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto(`/kabinet#order=${o.id}`);
  await expect(page.locator('#details-form, #order-view').first()).toBeVisible();
  await expect(page.locator('li[data-check="income_value"]')).toHaveCount(0);
  expect(problems).toEqual([]);
  await ectx.close();
});
