// Задача 2.530 — телефон 412×915: оценка жилого дома, участок в аренде. У эксперта в списке документов — выписка ЕГРН на
// участок, технический план дома и договор аренды участка (без поэтажного плана квартиры); выписка на участок старше 30 дней —
// подсказка «на участок под домом» и «Запросить свежую выписку на участок»; заказчик видит запрос с пояснением.
// Номера +7 999 000-59-10…11 — только здесь.
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

test('2.530: документы по дому — выписка на участок, техплан дома, договор аренды участка; старая выписка на участок', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005910');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Жилой дом: участок в аренде' }, headers: H })).json()).order;
  const day = (n) => new Date(Date.now() + n * 86400_000 + 3 * 3600_000).toISOString().slice(0, 10);
  const fields = { purpose: 'deal', region: 'mo', object_type: 'house', house_land: 'lease', land_area: 10, house_walls: 'wood', address: 'Московская обл., д. Тестовая, ул. Луговая, д. 3', area: 90 };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline: day(9), fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 900000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_housedocs_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005911');
  await db(async (c) => {
    await c.query("update users set full_name = 'Домов Иван Петрович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);

  // Заказчик приложил к заявке старую выписку на участок (45 дней) — и свежую на дом.
  const put = async (text, name) => expect((await page.request.post(`/api/orders/${o.id}/documents`, {
    data: Buffer.from(text), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) } })).status()).toBe(201);
  await put(`Выписка из Единого государственного реестра недвижимости об объекте недвижимости\n${ru(day(-3))} № КУВИ-001/2026-59100001\nВид объекта недвижимости: Здание`, 'Выписка ЕГРН дом.txt');
  await put(`Выписка из Единого государственного реестра недвижимости об объекте недвижимости\n${ru(day(-45))} № КУВИ-001/2026-59100002\nВид объекта недвижимости: Земельный участок`, 'Выписка ЕГРН участок.txt');

  await ep.goto(`/kabinet#order=${o.id}`);
  await expect(ep.locator('#docreq-box')).toBeVisible();
  const items = ep.locator('#docreq-items');
  await expect(items).toContainText('Выписка из ЕГРН на земельный участок под домом');
  await expect(items).toContainText('Технический план или технический паспорт дома');
  await expect(items).toContainText('Договор аренды земельного участка под домом');
  await expect(items).not.toContainText('Технический паспорт БТИ или поэтажный план');
  await expect(ep.locator('#docreq-egrn-text')).toContainText('Выписка ЕГРН на участок под домом «Выписка ЕГРН участок.txt»');
  await expect(ep.locator('#docreq-egrn-text')).toContainText('(45 дн.)');
  await expect(ep.locator('#docreq-egrn-ask')).toHaveText('Запросить свежую выписку на участок');
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.locator('#docreq-egrn').scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/hs02-dokumenty-dom.png', fullPage: false });

  await ep.locator('#docreq-egrn-ask').click();
  await expect(ep.locator('#docreq-msg')).toContainText('Свежая выписка ЕГРН на участок запрошена');
  await expect(ep.locator('#docreq-egrn-text')).toContainText('Свежая выписка на участок запрошена — ждём заказчика.');
  await expect(ep.locator('#docreq-list')).toContainText('Выписка из ЕГРН на земельный участок под домом');

  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto(`/kabinet#order=${o.id}`);
  await expect(page.locator('#docreq-list')).toContainText('Выписка из ЕГРН на земельный участок под домом');
  await expect(page.locator('#docreq-list')).toContainText('Дом и участок оцениваются вместе');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await page.locator('#docreq-box').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/screens/hs03-dokumenty-dom-zakazchik.png', fullPage: false });
  expect(problems).toEqual([]);
  await ectx.close();
});
