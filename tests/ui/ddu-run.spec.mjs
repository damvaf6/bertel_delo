// Прогон 2.548 (пачка «Квартира в новостройке: права по ДДУ») — телефон 412×915: договор участия в долевом строительстве в
// «Перечне использованных документов» черновика — с номером и датой из самого договора, а не «Документ — файл …».
// Логика — tests/server/ddu-run.test.mjs. Номера +7 999 000-54-84…85 — только здесь.
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

test('прогон 2.548: ДДУ — договор в перечне документов с номером и датой', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005484');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'ДДУ: прогон пачки' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'bank', region: 'moscow', object_type: 'ddu', address: 'г. Москва, ул. Тестовая, вл. 5, корп. 3',
    ddu_number: 'ЖК-12/3-145', ddu_date: '14.03.2025', ddu_developer: 'ООО «СЗ Тестовый»', ddu_unit: '145', ddu_area: 41.5,
    ddu_handover: '31.12.2027', ddu_price: 9000000, ddu_finish: 'white' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 800000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_ddurun_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005485');
  await db(async (c) => {
    await c.query("update users set full_name = 'Долев Иван Петрович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  const d = await ep.request.post(`/api/orders/${o.id}/draft/ai`, { data: {}, headers: H });
  expect(d.status(), await d.text()).toBe(201);

  // Договор пришёл после черновика — сканом с невнятным именем файла.
  expect((await page.request.post(`/api/orders/${o.id}/documents`, {
    data: Buffer.from(['ДОГОВОР УЧАСТИЯ В ДОЛЕВОМ СТРОИТЕЛЬСТВЕ № ЖК-12/3-145 от «14» марта 2025 г.',
      'Объект долевого строительства — квартира, условный номер 145, проектная общая площадь 41,5 кв. м.'].join('\n')),
    headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('Скан 001.txt') } })).status()).toBe(201);

  await ep.goto(`/kabinet#order=${o.id}`);
  const text = ep.locator('#draft-text');
  await expect(text).toBeVisible();
  const btn = ep.getByRole('button', { name: 'Обновить перечень документов' });
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  await expect(ep.locator('#draft-msg')).toContainText('Перечень обновлён: документов в нём — 1');
  await expect(text).toHaveValue(/\n1\. Договор участия в долевом строительстве № ЖК-12\/3-145 от 14\.03\.2025 — файл «Скан 001\.txt», получен /);
  // Показать строку перечня в поле черновика.
  await text.evaluate((el) => {
    const at = el.value.indexOf('1. Договор участия');
    el.focus();
    el.setSelectionRange(at, at);
    el.scrollTop = Math.max(0, (at / el.value.length) * el.scrollHeight - el.clientHeight / 2);
  });
  await text.scrollIntoViewIfNeeded();
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await text.screenshot({ path: 'test-results/screens/du13-2548-dogovor-v-perechne.png' });

  expect(problems).toEqual([]);
  await ectx.close();
});
