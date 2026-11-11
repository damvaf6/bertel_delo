// Проверка организации эксперта перед выдачей (2.466) — телефон 412×915. На стенде проверка выключена (ORG_CHECK — только
// боевой сайт), поэтому ответ сервера «нужна организация» (org_check_missing) подставляется перехватом: в деле у эксперта
// без организации «Что дальше» и «Готово к сдаче?» говорят, что заключение проверяет организация, главная кнопка неактивна.
// Сами правила сервера — tests/server/org-check.test.mjs. Номера +7 999 000-46-6x — только здесь.
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

test('проверка организации (2.466): эксперт без организации видит, что сдать нельзя, пока не укажет организацию', async ({ page, browser, baseURL }) => {
  const problems = [];
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  // Заказчик: заявка на оценку квартиры, отправлена и оплачена.
  await signIn(page, '+79990004666');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Квартира для суда' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  expect((await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields: { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, Проверочная ул., 6' } }, headers: H })).status()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 600000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_orgcheck_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  // Эксперт без организации берёт заказ, прикладывает и подписывает файл результата.
  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990004667');
  await db(async (c) => {
    await c.query("update users set full_name = 'Одиночкин Илья Петрович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  const up = await ep.request.post(`/api/orders/${o.id}/results`, { data: Buffer.from('заключение'), headers: { ...H, 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('Заключение.pdf') } });
  expect(up.status()).toBe(201);
  const doc = (await up.json()).document;
  expect((await ep.request.post(`/api/documents/${doc.id}/sign`, { data: { confirm: true }, headers: H })).status()).toBe(201);

  // Ответ сервера при включённой проверке организации.
  await ep.route(`**/api/orders/${o.id}/documents`, async (route) => {
    const r = await route.fetch();
    const body = await r.json();
    await route.fulfill({ response: r, json: { ...body, org_check_missing: true } });
  });
  await ep.goto(`/kabinet#order=${o.id}`);
  const step = ep.locator('#next-steps [data-step="org_none"]');
  await expect(step).toContainText('Проверка организации эксперта: укажите в профиле организацию');
  await expect(step).not.toHaveClass(/done/);
  await expect(ep.locator('#next-main button')).toHaveText('Нужна организация эксперта');
  await expect(ep.locator('#next-main button')).toBeDisabled();
  const ready = ep.locator('#ready-box [data-ready="org_none"]');
  await expect(ready).toContainText('заключение проверяет и подписывает организация');
  await expect(ep.locator('#ready-lead')).toContainText('Пока сдать нельзя');
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.locator('#next-box').scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/oc01-nuzhna-organizaciya.png', fullPage: false });
  await ready.scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/oc02-gotovo-k-sdache.png', fullPage: false });

  // Без проверки организации (как на стенде) — строки нет, сдать можно.
  await ep.unroute(`**/api/orders/${o.id}/documents`);
  await ep.reload();
  await expect(ep.locator('#next-steps [data-step="sign"]')).toHaveClass(/done/);
  await expect(ep.locator('#next-steps [data-step="org_none"]')).toHaveCount(0);
  await ectx.close();
  expect(problems).toEqual([]);
});
