// Задача 2.532 — телефон 412×915: ИИ-проверка «Дом с участком». Участок под домом по заявке в собственности, к делу приложена
// выписка ЕГРН на участок; в отчёте итог «дом и участок» не равен сумме, а кадастровый номер участка — не как в выписке, — в
// ИИ-проверке пункт «Дом с участком: …» с двумя находками. Номера +7 999 000-59-30…31 — только здесь.
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

test('2.532: ИИ-проверка дома с участком — итог не равен дому + участку, номер участка не как в выписке', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005930');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Жилой дом с участком: проверка' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'deal', region: 'mo', object_type: 'house', address: 'Московская обл., д. Тестовая, ул. Луговая, д. 5', area: 120,
    house_land: 'own', land_cadastral: '50:20:0010203:45', land_area: 15, house_walls: 'brick' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 900000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_houseland_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });
  // Заказчик приложил выписку ЕГРН на участок под домом.
  expect((await page.request.post(`/api/orders/${o.id}/documents`, {
    data: Buffer.from('Выписка из Единого государственного реестра недвижимости об объекте недвижимости\nВид объекта недвижимости: Земельный участок\nКадастровый номер: 50:20:0010203:45\nПлощадь: 1500 +/- 14 кв. м'),
    headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('Выписка ЕГРН участок.txt') } })).status()).toBe(201);

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005931');
  await db(async (c) => {
    await c.query("update users set full_name = 'Участков Пётр Ильич' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);

  const report = [
    'ОТЧЁТ ОБ ОЦЕНКЕ № 41/2026',
    'Объект оценки: жилой дом с земельным участком, Московская обл., д. Тестовая, ул. Луговая, д. 5',
    'Земельный участок: кадастровый номер 50:20:0010203:46, площадь 1500 кв. м',
    '| Стоимость дома и участка | Значение |',
    '| Жилой дом, руб. | 8 000 000 |',
    '| Земельный участок под домом, руб. | 2 000 000 |',
    '| Итого: дом и участок (единый объект, ст. 35 ЗК РФ), руб. | 10 500 000 |',
  ].join('\n');
  expect((await ep.request.post(`/api/orders/${o.id}/results`, {
    data: Buffer.from(report), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') },
  })).status()).toBe(201);
  await ep.goto(`/kabinet#order=${o.id}`);
  await ep.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(ep.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  const item = ep.locator('#review-checks > li[data-check="house_land"]');
  await expect(item).toContainText('Дом с участком: стоимость участка есть, дом + участок = итог, участок — как в выписке ЕГРН');
  await expect(item).toContainText('Итог «дом и участок» 10 500 000 руб. не равен сумме: дом 8 000 000 + участок 2 000 000 = 10 000 000 руб.');
  await expect(ep.locator('#review-checks')).not.toContainText('Площадь 1 500 кв. м не совпадает');
  await expect(item).toContainText('Кадастровый номер участка под домом в отчёте 50:20:0010203:46, а в выписке ЕГРН на участок — 50:20:0010203:45');
  await item.scrollIntoViewIfNeeded();
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.screenshot({ path: 'test-results/screens/hs06-dom-uchastok-proverka.png', fullPage: false });

  // Заказчик подсказок ИИ не видит.
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto(`/kabinet#order=${o.id}`);
  await expect(page.locator('#details-form, #order-view').first()).toBeVisible();
  await expect(page.locator('li[data-check="house_land"]')).toHaveCount(0);
  expect(problems).toEqual([]);
  await ectx.close();
});
