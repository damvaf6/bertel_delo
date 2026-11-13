// Товароведческая — ИИ-проверка «товар как в заявке» (2.481) — телефон 412×915: в заключении эксперта модель и IMEI другого
// телефона, дата обнаружения недостатка и гарантийный срок не как в заявке — ИИ-проверка в пункте «Товар: …» называет
// каждое расхождение, у даты и срока — «Исправить в черновике». Номера +7 999 000-48-13…14 — только здесь.
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

test('товароведческая (2.481): ИИ-проверка — товар, дата обнаружения и гарантия как в заявке', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990004813');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'goods', title: 'Телефон: недостаток' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'court', region: 'moscow', subject: 'Телефон перестал включаться', questions: 'Есть ли недостаток?',
    goods_kind: 'gadget', model: 'Смартфон SM-A556, IMEI 350000000000001', found_date: '14.09.2026', warranty_months: 12,
    purchase: '12.03.2026, Магазин-1, 54 990 ₽' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 600000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_goods_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990004814');
  await db(async (c) => {
    await c.query("update users set full_name = 'Товаров Иван Петрович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'goods') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  expect((await ep.request.post(`/api/orders/${o.id}/draft/ai`, { data: {}, headers: H })).status()).toBe(201);

  const report = [
    'ЗАКЛЮЧЕНИЕ ЭКСПЕРТА № 7/2026',
    '3. Объект и исходные данные',
    'Объект исследования: смартфон, модель SM-A325, IMEI: 350000000000002.',
    'Со слов истца, недостаток обнаружен 04.09.2026: телефон не включается.',
    'Гарантийный срок — 24 месяца.',
    '7. Выводы',
    'Недостаток производственный.',
  ].join('\n');
  expect((await ep.request.post(`/api/orders/${o.id}/results`, {
    data: Buffer.from(report), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('заключение.txt') },
  })).status()).toBe(201);
  await ep.goto(`/kabinet#order=${o.id}`);
  await ep.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(ep.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  const item = ep.locator('#review-checks > li[data-check="goods_identity"]');
  await expect(item).toContainText('Товар: модель, серийный номер, дата обнаружения недостатка и гарантия — как в заявке');
  await expect(item.locator('.ai-found li')).toHaveCount(4);
  await expect(item).toContainText('Модель SM-A325 не совпадает с заявкой');
  await expect(item).toContainText('IMEI 350000000000002 не совпадает с заявкой');
  await expect(item).toContainText('Дата обнаружения недостатка 04.09.2026 не совпадает с заявкой (14.09.2026)');
  await expect(item).toContainText('Гарантийный срок 24 месяца не совпадает с заявкой (12 месяцев)');
  await expect(item.locator('[data-action="fix-draft"]')).toHaveCount(2);
  await item.scrollIntoViewIfNeeded();
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.screenshot({ path: 'test-results/screens/gw02-tovar-ii-proverka.png', fullPage: false });

  // Заказчик подсказок ИИ не видит.
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto(`/kabinet#order=${o.id}`);
  await expect(page.locator('#details-form, #order-view').first()).toBeVisible();
  await expect(page.locator('li[data-check="goods_identity"]')).toHaveCount(0);
  expect(problems).toEqual([]);
  await ectx.close();
});
