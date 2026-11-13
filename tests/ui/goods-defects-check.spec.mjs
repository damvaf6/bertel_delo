// Товароведческая — ИИ-проверка «Недостатки» (2.484) — телефон 412×915: в заключении один недостаток из заявки не исследован,
// характер без ссылки на ГОСТ, в выводах другой характер, «подлежит возврату» — ИИ-проверка в пункте «Недостатки: …» называет
// каждое; у недостатка из таблицы дела без признаков — своя находка. Номера +7 999 000-48-15…16 — только здесь.
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

test('товароведческая (2.484): ИИ-проверка — недостатки исследованы, характер с ГОСТ, без выводов о праве', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990004815');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'goods', title: 'Ноутбук: недостатки' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'court', region: 'moscow', subject: 'Ноутбук не включается, трещина на крышке', questions: 'Есть ли недостатки и каков их характер?',
    goods_kind: 'gadget', defects: 'Не включается\nТрещина на крышке\nСкрипит петля', purchase: '12.03.2026, Магазин-1, 84 990 ₽' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 600000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_gdef_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990004816');
  await db(async (c) => {
    await c.query("update users set full_name = 'Дефектов Пётр Ильич' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'goods') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  // В таблице недостатков дела: «Скрипит петля» — эксплуатационный, без признаков.
  const d = await ep.request.post(`/api/orders/${o.id}/defects`, { data: { defect: 'Скрипит петля', place: 'левая петля крышки', nature: 'operation' }, headers: H });
  expect(d.status(), await d.text()).toBe(201);
  expect((await ep.request.post(`/api/orders/${o.id}/draft/ai`, { data: {}, headers: H })).status()).toBe(201);

  const report = [
    'ЗАКЛЮЧЕНИЕ ЭКСПЕРТА № 11/2026',
    '5. Исследование',
    'Недостаток 1. Ноутбук не включается: индикатор питания не загорается, отказ контроллера питания.',
    'Следов вскрытия и ремонта нет. Недостаток производственный.',
    'Петля крышки скрипит при открывании.',
    '7. Выводы',
    '1. Недостаток «не включается» — эксплуатационный.',
    '2. Товар подлежит возврату продавцу.',
  ].join('\n');
  expect((await ep.request.post(`/api/orders/${o.id}/results`, {
    data: Buffer.from(report), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('заключение.txt') },
  })).status()).toBe(201);
  await ep.goto(`/kabinet#order=${o.id}`);
  await ep.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(ep.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  const item = ep.locator('#review-checks > li[data-check="goods_defects"]');
  await expect(item).toContainText('Недостатки: каждый заявленный исследован');
  await expect(item.locator('.ai-found li')).toHaveCount(5);
  await expect(item).toContainText('В заявке указан недостаток «Трещина на крышке», а в исследовании его нет');
  await expect(item).toContainText('У недостатка «Скрипит петля» в таблице недостатков характер «эксплуатационный», а признаков нет');
  await expect(item).toContainText('ссылки на ГОСТ, технический регламент, ТУ или техническую документацию');
  await expect(item).toContainText('«подлежит возврату» — это вывод о праве');
  await item.scrollIntoViewIfNeeded();
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.screenshot({ path: 'test-results/screens/gw06-nedostatki-ii-proverka.png', fullPage: false });

  // Заказчик подсказок ИИ не видит.
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto(`/kabinet#order=${o.id}`);
  await expect(page.locator('#details-form, #order-view').first()).toBeVisible();
  await expect(page.locator('li[data-check="goods_defects"]')).toHaveCount(0);
  expect(problems).toEqual([]);
  await ectx.close();
});
