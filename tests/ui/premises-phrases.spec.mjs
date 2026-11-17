// Готовые фразы эксперта по нежилому (2.525) — телефон 412×915: в деле оценки нежилого помещения над полем сообщения —
// «Договор аренды и арендаторы», «Осмотр при арендаторе», «Расходы на содержание», «Поэтажный план»; нажатие подставляет
// текст, ничего не отправлено; договор аренды получен по запросу — кнопки о нём нет. Номера +7 999 000-58-07…08 — только здесь.
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

test('фразы по нежилому (2.525): договор аренды, осмотр при арендаторе, расходы, поэтажный план', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005807');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Нежилое: фразы' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'deal', region: 'moscow', object_type: 'commercial', address: 'г. Москва, Тестовая ул., д. 5, пом. 2', area: 120, premises_use: 'retail', lease: 'full', lease_rent: 150000, entrance: 'street' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 900000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_npp_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005808');
  await db(async (c) => {
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);

  await ep.goto(`/kabinet#order=${o.id}`);
  const chat = ep.locator('#chat-box');
  await expect(chat.locator('#message-phrase-list button')).toHaveText([
    'Доступ на осмотр', 'Уточнить адрес', 'Срок документов', 'Договор аренды и арендаторы', 'Осмотр при арендаторе',
    'Расходы на содержание', 'Поэтажный план',
  ]);
  await chat.getByRole('button', { name: 'Договор аренды и арендаторы' }).click();
  await expect(chat.locator('#message-text')).toHaveValue(/^Здравствуйте! Если помещение или его часть сдаётся[\s\S]*В заявке указано: «Сдаётся целиком»\. Приложить можно в деле или ответом здесь\.$/);
  await chat.getByRole('button', { name: 'Расходы на содержание' }).click();
  await expect(chat.locator('#message-text')).toHaveValue(/ответом здесь\.\n\nДля доходного подхода нужны расходы[\s\S]*напишите, какие\.$/);
  await expect(chat.locator('#messages li')).toHaveCount(0);
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await chat.locator('#message-form').scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/np10-nezhiloe-frazy.png', fullPage: false });

  // Заказчик прислал договор аренды по запросу — кнопки о нём больше нет.
  expect((await ep.request.post(`/api/orders/${o.id}/doc-requests`, { data: { items: ['lease_contract'] }, headers: H })).status()).toBe(201);
  const req = (await (await page.request.get(`/api/orders/${o.id}/doc-requests`, { headers: H })).json()).requests.find((x) => x.item_id === 'lease_contract');
  const up = await page.request.post(`/api/orders/${o.id}/documents`, { data: Buffer.from('договор'),
    headers: { ...H, 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('аренда.pdf') } });
  expect(up.status(), await up.text()).toBe(201);
  const doc = (await up.json()).document;
  expect((await page.request.post(`/api/orders/${o.id}/doc-requests/${req.id}/attach`, { data: { document_id: doc.id }, headers: H })).status()).toBe(200);
  await ep.reload();
  await expect(chat.locator('#message-phrase-list button')).toHaveText([
    'Доступ на осмотр', 'Уточнить адрес', 'Срок документов', 'Осмотр при арендаторе', 'Расходы на содержание', 'Поэтажный план',
  ]);

  await page.goto(`/kabinet#order=${o.id}`);
  await expect(page.locator('#message-phrases')).toBeHidden();
  expect(problems).toEqual([]);
  await ectx.close();
});
