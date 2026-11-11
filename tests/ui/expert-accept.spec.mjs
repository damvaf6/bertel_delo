// «Ваш эксперт» и «Принять» (2.465) — телефон 412×915: эксперт взял дело из ленты; заказчик видит карточку эксперта
// (имя, аттестат и полис со сроками, сданные дела) и «Что дальше» — «Посмотреть эксперта»; нажимает «Принять» — строка
// «Вы приняли эксперта». Эксперт видит в шапке дела, что заказчик его принял. Номера +7 999 000-46-5x — только здесь.
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

test('«Ваш эксперт» (2.465): заказчик видит карточку взявшего дело эксперта и нажимает «Принять»', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  // Заказчик: заявка на оценку квартиры, отправлена и оплачена.
  const customer = await signIn(page, '+79990004656');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Квартира для банка' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  expect((await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, Карточная ул., 3' } }, headers: H })).status()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 600000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_accept_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  // Эксперт с досье берёт заказ из ленты.
  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  const expert = await signIn(ep, '+79990004657');
  await db(async (c) => {
    await c.query("update users set full_name = 'Карточкин Пётр Сергеевич' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
    await c.query(`insert into dossier_items (user_id, kind, title, number, valid_until) values
      ($1, 'certificate', 'Оценка недвижимости', '000999-1', current_date + 300),
      ($1, 'sro', 'Тестовая СРО оценщиков', '1111', null)`, [expert.id]);
    await c.query(`insert into dossier_items (user_id, kind, title, number, valid_until, amount_kop) values
      ($1, 'policy', 'Тестовое страхование', 'ТП-9', current_date + 200, 500000000)`, [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  await ep.goto(`/kabinet#order=${o.id}`);
  await expect(ep.locator('#order-accept-line')).toHaveText(/Заказчик ещё не нажал «Принять»/);

  // Заказчик: «Что дальше» ведёт к карточке.
  await page.goto(`/kabinet#order=${o.id}`);
  await expect(page.locator('#next-lead')).toContainText('нажмите «Принять»');
  const box = page.locator('#expert-box');
  await expect(box).toBeVisible();
  await expect(page.locator('#expert-box-name')).toHaveText('Карточкин Пётр Сергеевич');
  await expect(page.locator('#expert-box-docs')).toContainText('Квалификационный аттестат');
  await expect(page.locator('#expert-box-docs')).toContainText('страховая сумма 5 000 000 ₽');
  await expect(box).not.toContainText('000999-1');
  await expect(page.locator('#expert-box-stats')).toHaveText('Через платформу дел пока не сдавал.');
  await expect(page.locator('#terms-box')).toBeVisible();
  await expect(page.locator('#order-accept-line')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await box.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/screens/ea01-vash-ekspert.png', fullPage: false });

  await page.locator('#expert-box-accept').click();
  await expect(page.locator('#expert-box-accepted')).toContainText('Вы приняли эксперта');
  await expect(page.locator('#expert-box-accept')).toBeHidden();
  await expect(page.locator('#expert-box-msg')).toContainText('эксперт принят');
  await box.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/screens/ea02-prinyal.png', fullPage: false });

  // Эксперт видит, что его приняли.
  await ep.reload();
  await expect(ep.locator('#order-accept-line')).toHaveText(/Заказчик принял Вас/);
  await expect(ep.locator('#expert-box')).toBeHidden();
  await ep.screenshot({ path: 'test-results/screens/ea03-ekspert-prinyat.png', fullPage: false });
  await ectx.close();
  expect(customer.id).toBeTruthy();
  expect(problems).toEqual([]);
});
