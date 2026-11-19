// Задача 2.551 — телефон 412×915: машино-место (доля в праве на паркинг). Черновик от ИИ: в «2. Задание на оценку» сразу под
// заголовком — «Объект оценки в паркинге: доля … в праве на паркинг; по порядку пользования закреплено машино-место № …», в
// «5. Допущения» — «Границы места: …». Номера +7 999 000-60-18…19 — только здесь.
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

test('2.551: черновик по машино-месту — объект и вид права, допущение о границах', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990006018');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Машино-место: черновик' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'bank', region: 'moscow', object_type: 'parking', address: 'г. Москва, ул. Тестовая, д. 5, паркинг',
    parking_kind: 'space', parking_type: 'underground', parking_level: '−2', parking_number: '47', parking_right: 'share', parking_share: '1/120', parking_with_flat: 'no' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 600000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_parkDraft_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990006019');
  await db(async (c) => {
    await c.query("update users set full_name = 'Паркингов Семён Ильич' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  const d = await ep.request.post(`/api/orders/${o.id}/draft/ai`, { data: {}, headers: H });
  expect(d.status(), await d.text()).toBe(201);
  const lines = (await d.json()).draft.body.split('\n');
  const t = lines.findIndex((l) => /^#{1,3}\s*2\. Задание на оценку/.test(l));
  expect(lines[t + 1]).toContain('Объект оценки в паркинге: доля 1/120 в праве общей долевой собственности на нежилое помещение (подземный паркинг, уровень −2)');
  expect(lines[t + 1]).toContain('закреплено машино-место № 47');
  expect(lines[t + 1]).toContain('не право собственности на машино-место как отдельный объект');
  const a = lines.findIndex((l) => /^#{1,3}\s*5\. Допущения/.test(l));
  expect(lines[a + 1]).toMatch(/^Границы места: доля в праве на паркинг в натуре не выделена/);

  await ep.goto(`/kabinet#order=${o.id}`);
  const text = ep.locator('#draft-text');
  await expect(text).toBeVisible();
  await expect(text).toHaveValue(/Объект оценки в паркинге: /);
  await expect(text).toHaveValue(/Границы места: /);
  await text.evaluate((el) => {
    const at = el.value.indexOf('Объект оценки в паркинге');
    el.focus(); el.setSelectionRange(at, at);
    const before = el.value.slice(0, at).split('\n').length - 2;
    el.scrollTop = Math.max(0, before) * (parseFloat(getComputedStyle(el).lineHeight) || 20);
  });
  await text.scrollIntoViewIfNeeded();
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.screenshot({ path: 'test-results/screens/pk04-chernovik-parking.png', fullPage: false });
  expect(problems).toEqual([]);
  await ectx.close();
});
