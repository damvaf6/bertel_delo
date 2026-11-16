// Прогон 2.518 (пачка «Оценка доли и раздел имущества») — телефон 412×915: в «Перечне отчётов для СРО» у отчёта об оценке
// доли — стоимость доли, а не всей квартиры (в отчёте есть обе). Логика — tests/server/share-run.test.mjs.
// Номер +7 999 000-51-80 — только здесь.
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

test('прогон 2.518: перечень для СРО — у оценки доли стоимость доли, а не всей квартиры', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU',
    storageState: { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'delo.folds', value: 'open' }] }] } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(page, '+79990005180');
  const id = await db(async (c) => {
    await c.query("update users set full_name = 'Долева Дарья' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, created_at) values ($1, now() - interval '2 years') on conflict do nothing", [expert.id]);
    const oid = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields)
      values ($1, '1/3 доли квартиры на Садовой', 'expertise', 'realty', 'done', $1, current_date, $2) returning id`,
      [expert.id, { object_type: 'share', share_size: '1/3', share_method: 'market', purpose: 'division', address: 'г. Москва, Садовая ул., д. 5, кв. 8' }])).rows[0].id;
    await c.query("insert into order_status_history (order_id, from_status, to_status, side) values ($1, 'review', 'done', 'dispatcher')", [oid]);
    return oid;
  });
  const text = ['ОТЧЁТ ОБ ОЦЕНКЕ № 31/2026 от 10.11.2026', 'Объект оценки: 1/3 доли в праве на квартиру',
    'Итоговая величина рыночной стоимости квартиры в целом составляет 9 000 000 руб.',
    '| Стоимость объекта целиком, руб. | 9 000 000 |', '| Размер доли | 1/3 |', '| Часть стоимости объекта (целое × 1/3), руб. | 3 000 000 |',
    '| Скидка на долю, % | 15 (источник — справочник Лейфера) |', '| Рыночная стоимость доли (часть × (1 − скидка)), руб. | 2 550 000 |',
    'Выводы: рыночная стоимость 1/3 доли в праве на квартиру составляет 2 550 000 руб.'].join('\n');
  const up = await page.request.post(`/api/orders/${id}/documents`, { data: Buffer.from(text), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') } });
  expect(up.status()).toBe(201);
  await db((c) => c.query("update documents set kind = 'result' where order_id = $1", [id]));

  await page.goto('/kabinet#specialist');
  const box = page.locator('#registry-box');
  await expect(box.getByRole('heading', { name: 'Перечень отчётов для СРО' })).toBeVisible();
  const row = page.locator('#registry-rows > li').first();
  await expect(row).toContainText('Отчёт № 31/2026 от 10 ноября 2026');
  await expect(row).toContainText('Стоимость доли: 2 550 000');
  await expect(row).not.toContainText('9 000 000');
  await box.scrollIntoViewIfNeeded();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, 'страница шире экрана').toBeLessThanOrEqual(412);
  await page.screenshot({ path: 'test-results/screens/dl12-2518-perechen-stoimost-doli.png', fullPage: true });
  expect(problems).toEqual([]);
  await ctx.close();
});
