// Товароведческая — ИИ-проверка «Стоимость устранения недостатков» (2.487) — телефон 412×915: в заявке спросили о стоимости,
// а в заключении у цен нет даты и источника, в выводах сумма не как в расчёте — ИИ-проверка в пункте «Стоимость устранения
// недостатков: …» называет каждое. Номера +7 999 000-48-17…18 — только здесь.
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

test('товароведческая (2.487): ИИ-проверка — стоимость устранения недостатков: дата и источник цен, сумма в выводах', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990004817');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'goods', title: 'Ноутбук: стоимость устранения' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'court', region: 'moscow', subject: 'Ноутбук не включается',
    questions: '1. Есть ли недостатки и каков их характер?\n2. Какова стоимость устранения недостатков?',
    goods_kind: 'gadget', defects: 'Не включается', purchase: '12.03.2026, Магазин-1, 84 990 ₽' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 600000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_gcost_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990004818');
  await db(async (c) => {
    await c.query("update users set full_name = 'Сметов Олег Павлович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'goods') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);

  const report = [
    'ЗАКЛЮЧЕНИЕ ЭКСПЕРТА № 12/2026',
    '5. Исследование',
    'Ноутбук не включается: отказ контроллера питания. Недостаток производственный по ГОСТ Р 52705.',
    '6. Стоимость устранения недостатков',
    'Расчёт выполнен затратным методом.',
    'Замена контроллера питания — 6 500 руб., работа — 2 000 руб.',
    'Итого стоимость устранения — 8 500 руб.',
    '7. Выводы',
    '1. Недостаток «не включается» — производственный.',
    '2. Стоимость устранения недостатка составляет 9 000 руб. (девять тысяч рублей).',
  ].join('\n');
  expect((await ep.request.post(`/api/orders/${o.id}/results`, {
    data: Buffer.from(report), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('заключение.txt') },
  })).status()).toBe(201);
  await ep.goto(`/kabinet#order=${o.id}`);
  await ep.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(ep.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  const item = ep.locator('#review-checks > li[data-check="goods_cost"]');
  await expect(item).toContainText('Стоимость устранения недостатков: только если о ней спросили');
  await expect(item.locator('.ai-found li')).toHaveCount(3);
  await expect(item).toContainText('не сказано, на какую дату взяты цены');
  await expect(item).toContainText('не указан источник');
  await expect(item).toContainText('В выводах стоимость 9 000 руб., а в расчёте итог — 8 500 руб.');
  await item.scrollIntoViewIfNeeded();
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.screenshot({ path: 'test-results/screens/gw10-stoimost-ii-proverka.png', fullPage: false });

  // Заказчик подсказок ИИ не видит.
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto(`/kabinet#order=${o.id}`);
  await expect(page.locator('#details-form, #order-view').first()).toBeVisible();
  await expect(page.locator('li[data-check="goods_cost"]')).toHaveCount(0);
  expect(problems).toEqual([]);
  await ectx.close();
});
