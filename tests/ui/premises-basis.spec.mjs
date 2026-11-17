// Задача 2.524 — телефон 412×915: ИИ-проверка нежилого. Эксперт сдал отчёт об оценке нежилого помещения, которое по
// заявке сдаётся в аренду, а в отчёте ни слова об аренде и не сказано, с НДС ли стоимость, — в ИИ-проверке пункт «Нежилое: с НДС
// или без — сказано; аренда — как в заявке» с двумя находками. Номера +7 999 000-58-01…02 — только здесь.
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

test('2.524: ИИ-проверка нежилого — НДС не оговорён, аренды в отчёте нет', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005801');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Нежилое: НДС и аренда' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'bank', region: 'moscow', object_type: 'commercial', address: 'г. Москва, Тестовая ул., д. 7, пом. 2', area: 120,
    premises_use: 'retail', lease: 'full', lease_rent: 300000 };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 800000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_premisesbasis_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005802');
  await db(async (c) => {
    await c.query("update users set full_name = 'Арендов Олег Петрович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);

  const report = [
    'ОТЧЁТ ОБ ОЦЕНКЕ № 32/2026',
    'Объект оценки: нежилое помещение (магазин), г. Москва, Тестовая ул., д. 7, пом. 2',
    'Обременения: не зарегистрированы',
    'Рыночная ставка аренды по аналогам: 18 000 руб. за кв. м в год, без НДС',
    'Итоговая рыночная стоимость объекта оценки: 16 000 000 руб.',
  ].join('\n');
  expect((await ep.request.post(`/api/orders/${o.id}/results`, {
    data: Buffer.from(report), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') },
  })).status()).toBe(201);
  await ep.goto(`/kabinet#order=${o.id}`);
  await ep.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(ep.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  const item = ep.locator('#review-checks > li[data-check="premises_basis"]');
  await expect(item).toContainText('Нежилое: с НДС или без — сказано; аренда — как в заявке');
  await expect(item).toContainText('Не сказано, с НДС или без НДС итоговая стоимость нежилого помещения');
  await expect(item).toContainText('В заявке помещение сдаётся целиком, арендная плата 300 000 руб. в месяц, а в отчёте об аренде ни слова');
  await item.scrollIntoViewIfNeeded();
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.screenshot({ path: 'test-results/screens/np09-nezhiloe-nds-arenda.png', fullPage: false });

  // Заказчик подсказок ИИ не видит.
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto(`/kabinet#order=${o.id}`);
  await expect(page.locator('#details-form, #order-view').first()).toBeVisible();
  await expect(page.locator('li[data-check="premises_basis"]')).toHaveCount(0);
  expect(problems).toEqual([]);
  await ectx.close();
});
