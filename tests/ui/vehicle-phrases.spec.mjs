// Готовые фразы эксперта по транспорту (2.495) — телефон 412×915: в деле оценки машины над полем сообщения — «ПТС и СТС»,
// «Машина на осмотр», «Сервисная книжка», «Договор лизинга или залога»; нажатие подставляет текст, ничего не отправлено;
// ПТС и СТС получены по запросу — кнопки о них нет. Номера +7 999 000-95-85…86 — только здесь.
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

test('фразы по транспорту (2.495): ПТС и СТС, машина на осмотр, сервисная книжка, лизинг или залог', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990009585');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'vehicle', title: 'Машина: фразы' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'deal', region: 'moscow', vehicle_type: 'car', make_model: 'Тестомобиль 3', year: 2019, mileage: 84000 };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 600000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_vph_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990009586');
  await db(async (c) => {
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'vehicle') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);

  await ep.goto(`/kabinet#order=${o.id}`);
  const chat = ep.locator('#chat-box');
  await expect(chat.locator('#message-phrase-list button')).toHaveText([
    'Доступ на осмотр', 'Уточнить адрес', 'Срок документов', 'ПТС и СТС', 'Машина на осмотр', 'Сервисная книжка',
    'Договор лизинга или залога',
  ]);
  await chat.getByRole('button', { name: 'Машина на осмотр' }).click();
  await expect(chat.locator('#message-text')).toHaveValue(/^Здравствуйте! К осмотру, пожалуйста, подготовьте машину: вымытую[\s\S]*дневном свете[\s\S]*ключи/);
  await chat.getByRole('button', { name: 'Договор лизинга или залога' }).click();
  await expect(chat.locator('#message-text')).toHaveValue(/стоит\.\n\nЕсли машина в лизинге или в залоге[\s\S]*Приложить можно в деле или ответом здесь\.$/);
  await expect(chat.locator('#messages li')).toHaveCount(0);
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await chat.locator('#message-form').scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/vt09-mashina-frazy.png', fullPage: false });

  // Заказчик прислал ПТС и СТС по запросу — кнопки «ПТС и СТС» больше нет.
  expect((await ep.request.post(`/api/orders/${o.id}/doc-requests`, { data: { items: ['pts', 'sts'] }, headers: H })).status()).toBe(201);
  const reqs = (await (await page.request.get(`/api/orders/${o.id}/doc-requests`, { headers: H })).json()).requests;
  for (const req of reqs) {
    const up = await page.request.post(`/api/orders/${o.id}/documents`, { data: Buffer.from('скан'),
      headers: { ...H, 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(`${req.item_id}.pdf`) } });
    expect(up.status(), await up.text()).toBe(201);
    const doc = (await up.json()).document;
    expect((await page.request.post(`/api/orders/${o.id}/doc-requests/${req.id}/attach`, { data: { document_id: doc.id }, headers: H })).status()).toBe(200);
  }
  await ep.reload();
  await expect(chat.locator('#message-phrase-list button')).toHaveText([
    'Доступ на осмотр', 'Уточнить адрес', 'Срок документов', 'Машина на осмотр', 'Сервисная книжка', 'Договор лизинга или залога',
  ]);

  await page.goto(`/kabinet#order=${o.id}`);
  await expect(page.locator('#message-phrases')).toBeHidden();
  expect(problems).toEqual([]);
  await ectx.close();
});
