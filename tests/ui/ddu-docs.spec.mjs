// Задача 2.540 — телефон 412×915: квартира в новостройке (права по ДДУ). У эксперта в списке документов — договор с отметкой
// о регистрации, справка об оплате, план квартиры из договора и разрешение на ввод; выписки ЕГРН на квартиру, документа о
// собственности и техпаспорта нет. Эксперт отмечает три пункта — заказчик видит их с пояснениями. Старая выписка о
// регистрации договора «запросите свежую» не вызывает. Номера +7 999 000-59-15…16 — только здесь.
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

test('2.540: документы по ДДУ — договор, справка об оплате, план, разрешение на ввод; без выписки на квартиру', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005915');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Новостройка: документы' }, headers: H })).json()).order;
  const day = (n) => new Date(Date.now() + n * 86400_000 + 3 * 3600_000).toISOString().slice(0, 10);
  const fields = { purpose: 'deal', region: 'moscow', object_type: 'ddu', address: 'г. Москва, ЖК «Тестовый», корп. 3 (строительный адрес)',
    ddu_number: 'ЖК-12/3-145', ddu_date: '14.03.2025', ddu_developer: 'ООО «СЗ Тестовый»', ddu_area: 41.3 };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline: day(9), fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 900000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_ddudocs_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005916');
  await db(async (c) => {
    await c.query("update users set full_name = 'Новостроев Иван Петрович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);

  // Заказчик приложил выписку о регистрации договора двухмесячной давности — свежую выписку не просим.
  expect((await page.request.post(`/api/orders/${o.id}/documents`, {
    data: Buffer.from(`Выписка из Единого государственного реестра недвижимости\n${ru(day(-60))} № КУВИ-001/2026-59150001\nДоговор участия в долевом строительстве`),
    headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('Выписка о регистрации ДДУ.txt') } })).status()).toBe(201);

  await ep.goto(`/kabinet#order=${o.id}`);
  await expect(ep.locator('#docreq-box')).toBeVisible();
  const items = ep.locator('#docreq-items');
  await expect(items).toContainText('Договор участия в долевом строительстве с отметкой о регистрации');
  await expect(items).toContainText('Справка застройщика об оплате по договору');
  await expect(items).toContainText('План квартиры из договора');
  await expect(items).toContainText('Разрешение на ввод дома в эксплуатацию');
  await expect(items).not.toContainText('Выписка из ЕГРН');
  await expect(items).not.toContainText('Документ о праве собственности');
  await expect(items).not.toContainText('Технический паспорт БТИ');
  await expect(ep.locator('#docreq-egrn')).toBeHidden();
  for (const id of ['ddu_contract', 'ddu_payment', 'ddu_plan']) await ep.locator(`#docreq-item-${id}`).check();
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await items.scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/du02-dokumenty-ddu.png', fullPage: false });
  await ep.locator('#docreq-form').getByRole('button', { name: /Запросить/ }).click();
  await expect(ep.locator('#docreq-msg')).toContainText('Запрошено документов: 3');

  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto(`/kabinet#order=${o.id}`);
  const list = page.locator('#docreq-list');
  await expect(list).toContainText('Договор участия в долевом строительстве с отметкой о регистрации');
  await expect(list).toContainText('со штампом Росреестра');
  await expect(list).toContainText('Справка застройщика об оплате по договору');
  await expect(list).toContainText('План квартиры из договора');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await page.locator('#docreq-box').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/screens/du03-dokumenty-ddu-zakazchik.png', fullPage: false });
  expect(problems).toEqual([]);
  await ectx.close();
});
