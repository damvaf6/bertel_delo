// Задача 2.541 — телефон 412×915: квартира в новостройке (права по ДДУ). Черновик от ИИ: в «2. Задание на оценку» сразу под
// заголовком — «Объект оценки — право требования по ДДУ: …» (номер и дата договора, застройщик, условный номер, проектная
// площадь, вид стоимости), в «5. Допущения» — «Дом не введён в эксплуатацию: …». Номера +7 999 000-59-17…18 — только здесь.
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

test('2.541: черновик по ДДУ — объект право требования и допущение «дом не введён»', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005917');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Новостройка: черновик' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'bank', region: 'moscow', object_type: 'ddu', address: 'г. Москва, ЖК «Тестовый», корп. 3 (строительный адрес)',
    ddu_number: 'ЖК-12/3-145', ddu_date: '14.03.2025', ddu_developer: 'ООО «СЗ Тестовый»', ddu_complex: 'ЖК «Тестовый», корп. 3, секция 2',
    ddu_unit: '145', ddu_area: 41.3, ddu_handover: 'IV квартал 2027' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 900000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_dduDraft_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005918');
  await db(async (c) => {
    await c.query("update users set full_name = 'Новостроев Пётр Ильич' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  const d = await ep.request.post(`/api/orders/${o.id}/draft/ai`, { data: {}, headers: H });
  expect(d.status(), await d.text()).toBe(201);
  const lines = (await d.json()).draft.body.split('\n');
  const t = lines.findIndex((l) => /^#{1,3}\s*2\. Задание на оценку/.test(l));
  expect(lines[t + 1]).toContain('Объект оценки — право требования по ДДУ: договор участия в долевом строительстве № ЖК-12/3-145 от 14.03.2025 (214-ФЗ)');
  expect(lines[t + 1]).toContain('проектная площадь — 41,3 кв. м');
  expect(lines[t + 1]).toContain('Вид стоимости — рыночная стоимость права требования.');
  const a = lines.findIndex((l) => /^#{1,3}\s*5\. Допущения/.test(l));
  expect(lines[a + 1]).toMatch(/^Дом не введён в эксплуатацию: /);

  await ep.goto(`/kabinet#order=${o.id}`);
  const text = ep.locator('#draft-text');
  await expect(text).toBeVisible();
  await expect(text).toHaveValue(/Объект оценки — право требования по ДДУ: /);
  await expect(text).toHaveValue(/Дом не введён в эксплуатацию: квартира как объект недвижимости ещё не образована/);
  // Показать место строки в поле черновика, как его видит эксперт.
  await text.evaluate((el) => {
    const at = el.value.indexOf('Объект оценки — право требования по ДДУ');
    el.focus(); el.setSelectionRange(at, at);
    const before = el.value.slice(0, at).split('\n').length - 2;
    el.scrollTop = Math.max(0, before) * (parseFloat(getComputedStyle(el).lineHeight) || 20);
  });
  await text.scrollIntoViewIfNeeded();
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.screenshot({ path: 'test-results/screens/du04-chernovik-ddu.png', fullPage: false });
  expect(problems).toEqual([]);
  await ectx.close();
});
