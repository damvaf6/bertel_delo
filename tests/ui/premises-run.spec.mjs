// Прогон 2.528 (пачка «Нежилое помещение и доходный подход») — телефон 412×915: в отчёте об оценке нежилого два аналога
// продажи и два аналога аренды (2.523). Раньше ИИ-проверка считала их «четырьмя аналогами» и молчала; теперь в пункте
// «Аналоги …» — «два аналога продажи — нужно не меньше трёх (аналоги аренды не в счёт)». Логика —
// tests/server/premises-run.test.mjs. Номера +7 999 000-58-09…10 — только здесь.
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

test('прогон 2.528: аналоги аренды в отчёте не в счёт «не меньше трёх»', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005809');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Нежилое: аналоги аренды в отчёте' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'bank', region: 'moscow', object_type: 'commercial', address: 'г. Москва, Тестовая ул., д. 7, пом. 2', area: 120,
    premises_use: 'retail', lease: 'full', lease_rent: 300000 };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 800000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_premisesrun_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005810');
  await db(async (c) => {
    await c.query("update users set full_name = 'Арендов Олег Петрович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);

  const report = [
    'ОТЧЁТ ОБ ОЦЕНКЕ № 33/2026',
    'Объект оценки: нежилое помещение (магазин), г. Москва, Тестовая ул., д. 7, пом. 2',
    'Сравнительный подход',
    '| № | Источник | Цена, руб. | Площадь, кв. м | Регион |',
    '| 1 | cian.ru | 16 500 000 | 118 | Москва |',
    '| 2 | avito.ru | 15 800 000 | 125 | Москва |',
    'Аналоги аренды (для доходного подхода; в сравнительный подход не идут):',
    '| № | Источник | Плата в месяц, руб. | Площадь, кв. м | Ставка, руб. за кв. м в месяц | Регион |',
    '| 3 | cian.ru | 180 000 | 120 | 1 500 | Москва |',
    '| 4 | avito.ru | 240 000 | 120 | 2 000 | Москва |',
    'Итоговая рыночная стоимость объекта оценки без учёта НДС: 16 000 000 руб.',
    'Приложение. Скриншоты объявлений-аналогов',
    'Аналог 1 — cian.ru', 'Ссылка: https://www.cian.ru/sale/commercial/1/',
    'Аналог 2 — avito.ru', 'Ссылка: https://www.avito.ru/moskva/kommercheskaya_nedvizhimost/2',
    'Аналог 3 — cian.ru (аренда)', 'Ссылка: https://www.cian.ru/rent/commercial/3/',
    'Аналог 4 — avito.ru (аренда)', 'Ссылка: https://www.avito.ru/moskva/kommercheskaya_nedvizhimost/4',
  ].join('\n');
  expect((await ep.request.post(`/api/orders/${o.id}/results`, {
    data: Buffer.from(report), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') },
  })).status()).toBe(201);
  await ep.goto(`/kabinet#order=${o.id}`);
  await ep.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(ep.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  const item = ep.locator('#review-checks > li[data-check="analogs"]');
  await expect(item).toContainText('В сравнительном подходе два аналога продажи — нужно не меньше трёх (аналоги аренды не в счёт)');
  await item.scrollIntoViewIfNeeded();
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.screenshot({ path: 'test-results/screens/np13-2528-analogi-arendy-ne-v-schet.png', fullPage: false });

  expect(problems).toEqual([]);
  await ectx.close();
});
