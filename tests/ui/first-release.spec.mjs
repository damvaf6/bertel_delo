// Первый выпуск «Экспертизы» (2.462, решение Дамира 02.11.2026) — телефон 412×915: заказчик в новой заявке видит 4 вида
// (оценка недвижимости, транспорта, ущерб после ДТП, товароведческая); заявка с видом «позже» открывается как была;
// диспетчер видит все виды с пометкой «позже». Номера +7 999 000-46-2x — только здесь.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DB_URL, TEST_TOKEN } from '../helpers.mjs';

const CONTROL = process.env.UI_TEST_CONTROL_TOKEN || TEST_TOKEN;
const H = { 'x-delo-request': '1' };
const FIRST = ['Оценка недвижимости', 'Оценка транспортного средства', 'Ущерб автомобилю после ДТП', 'Товароведческая экспертиза'];

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

test('первый выпуск (2.462): заказчику 4 вида экспертизы; заявка с видом «позже» открывается; диспетчер видит все', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));

  await signIn(page, '+79990004621');
  await page.goto('/kabinet');
  const sel = '#new-order select';
  await expect(page.locator(sel).first()).toBeVisible();
  const group = 'Экспертиза и оценка';
  const list = await page.locator(`${sel} optgroup[label="${group}"] option`).allTextContents();
  expect(list).toEqual(FIRST);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await page.screenshot({ path: 'test-results/screens/fr01-4-vida.png', fullPage: true });

  // Заявка на участок, заведённая раньше, — в форме её вид остаётся выбранным с пометкой «позже».
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'land', title: 'Участок, заведён раньше' }, headers: H })).json()).order;
  await page.goto(`/kabinet#order=${o.id}`);
  await expect(page.locator('#d-service')).toHaveValue('expertise/land');
  await expect(page.locator('#d-service option[value="expertise/land"]')).toHaveText('Оценка земельного участка (позже)');
  await expect(page.locator('#d-service option[value="expertise/handwriting"]')).toHaveCount(0);

  // Диспетчер видит все 8 — четыре с пометкой «позже».
  const dctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' });
  const dp = await dctx.newPage();
  const disp = await signIn(dp, '+79990004622');
  await db((c) => c.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]));
  await dp.goto('/kabinet');
  const all = await dp.locator(`${sel} optgroup[label="${group}"] option`).allTextContents();
  expect(all).toHaveLength(8);
  expect(all.filter((x) => x.endsWith('(позже)'))).toEqual(['Оценка земельного участка (позже)', 'Оценка движимого имущества (позже)',
    'Строительно-техническая экспертиза (позже)', 'Почерковедческая экспертиза (позже)']);
  await dctx.close();
  expect(problems).toEqual([]);
});
