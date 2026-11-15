// Задача 2.504 — телефон 412×915: оценка квартиры для наследства, день открытия наследства 200 дней назад, выписка ЕГРН
// в деле — за 90 дней до него. У эксперта в «Документах от заказчика» — «раньше дня открытия наследства …» и «Запросить
// выписку о переходе прав»; в списке — справка нотариуса и запрос нотариуса. Номера +7 999 000-53-26…27 — только здесь.
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
const ru = (iso) => iso.split('-').reverse().join('.');

test('2.504: документы по наследству — справка нотариуса и выписка о правах на день открытия наследства', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005326');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Квартира: документы по наследству' }, headers: H })).json()).order;
  const day = (n) => new Date(Date.now() + n * 86400_000 + 3 * 3600_000).toISOString().slice(0, 10);
  const death = day(-200);
  const early = day(-290);
  const fields = { purpose: 'inheritance', region: 'moscow', object_type: 'flat', address: 'г. Москва, Тестовая ул., д. 9, кв. 4', area: 41, death_date: ru(death) };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline: day(9), fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 800000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_heirdocs_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });
  const egrn = `Выписка из Единого государственного реестра недвижимости об объекте недвижимости\n${ru(early)} № КУВИ-001/2026-32345678\nВид объекта недвижимости: Помещение`;
  const up = await page.request.post(`/api/orders/${o.id}/documents`, { data: Buffer.from(egrn), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('Выписка ЕГРН.txt') } });
  expect(up.status(), await up.text()).toBe(201);

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005327');
  await db(async (c) => {
    await c.query("update users set full_name = 'Наследов Иван Петрович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);

  await ep.goto(`/kabinet#order=${o.id}`);
  await expect(ep.locator('#docreq-box')).toBeVisible();
  await expect(ep.locator('#docreq-egrn-text')).toHaveText(`Выписка ЕГРН «Выписка ЕГРН.txt» от ${ru(early)} — раньше дня открытия наследства ${ru(death)} на 90 дн.: не видно, кому принадлежал объект на этот день. Нужна выписка о переходе прав — запросите её у заказчика.`);
  await expect(ep.locator('#docreq-egrn-ask')).toHaveText('Запросить выписку о переходе прав');
  await expect(ep.locator('#docreq-items')).toContainText('Справка нотариуса об открытии наследственного дела или свидетельство о смерти');
  await expect(ep.locator('#docreq-items')).toContainText('Запрос нотариуса об оценке');
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.locator('#docreq-egrn').scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/nh07-dokumenty-nasledstvo.png', fullPage: false });

  // Запросить справку нотариуса и выписку — заказчик видит оба пункта с подсказками.
  await ep.locator('#docreq-item-heir_opening').check();
  await ep.locator('#docreq-send').click();
  await expect(ep.locator('#docreq-list')).toContainText('Справка нотариуса об открытии наследственного дела');
  await ep.locator('#docreq-egrn-ask').click();
  await expect(ep.locator('#docreq-egrn-text')).toContainText('Выписка о переходе прав запрошена — ждём заказчика.');
  await expect(ep.locator('#docreq-egrn-ask')).toBeHidden();

  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto(`/kabinet#order=${o.id}`);
  await expect(page.locator('#docreq-list')).toContainText('По ней сверяется дата оценки — день открытия наследства');
  await expect(page.locator('#docreq-list')).toContainText('по ней не видно, кому принадлежал объект на этот день');
  await page.locator('#docreq-box').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/screens/nh08-dokumenty-zakazchik.png', fullPage: false });
  expect(problems).toEqual([]);
  await ectx.close();
});
