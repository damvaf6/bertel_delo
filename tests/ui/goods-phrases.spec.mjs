// Готовые фразы эксперта по товару (2.486) — телефон 412×915: в деле товароведческой экспертизы над полем сообщения —
// «Чек и договор», «Гарантийный талон», «Претензия и ответ продавца», «Акт проверки качества», «Не ремонтируйте товар»;
// нажатие подставляет текст (выбор из заявки — словами), ничего не отправлено; талон получен — кнопок о нём нет.
// Номера +7 999 000-48-65…66 — только здесь.
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

test('фразы по товару (2.486): чек, талон, претензия, акт проверки, «не ремонтируйте»', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990004865');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'goods', title: 'Товар: фразы' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'court', region: 'moscow', subject: 'Телефон не включается', goods_kind: 'gadget', model: 'Тестофон 5',
    defects: 'не включается', found_date: '14.09.2026', warranty_months: 12, seller_check: 'denied', questions: 'Есть ли недостатки?',
    location: 'у заказчика, г. Москва', purchase: '12.03.2026, Тестовый магазин, 54 990 ₽' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 600000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_gph_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990004866');
  await db(async (c) => {
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'goods') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);

  await ep.goto(`/kabinet#order=${o.id}`);
  const chat = ep.locator('#chat-box');
  await expect(chat.locator('#message-phrase-list button')).toHaveText([
    'Доступ на осмотр', 'Уточнить адрес', 'Срок документов', 'Чек и договор', 'Гарантийный талон', 'Претензия и ответ продавца',
    'Акт проверки качества', 'Не ремонтируйте товар',
  ]);
  await chat.getByRole('button', { name: 'Акт проверки качества' }).click();
  await expect(chat.locator('#message-text')).toHaveValue(/акт проверки качества или техническое заключение[\s\S]*В заявке указано: «Да — сказали, что виноват покупатель»\./);
  await chat.getByRole('button', { name: 'Не ремонтируйте товар' }).click();
  await expect(chat.locator('#message-text')).toHaveValue(/покупатель»[\s\S]*\n\nДо осмотра, пожалуйста, не ремонтируйте товар[\s\S]*«у заказчика, г\. Москва»\.$/);
  await expect(chat.locator('#messages li')).toHaveCount(0);
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await chat.locator('#message-form').scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/gw09-tovar-frazy.png', fullPage: false });

  // Заказчик прислал гарантийный талон и претензию по запросу — кнопок о них больше нет.
  expect((await ep.request.post(`/api/orders/${o.id}/doc-requests`, { data: { items: ['warranty'] }, headers: H })).status()).toBe(201);
  const req = (await (await page.request.get(`/api/orders/${o.id}/doc-requests`, { headers: H })).json()).requests[0];
  const up = await page.request.post(`/api/orders/${o.id}/documents`, { data: Buffer.from('скан'),
    headers: { ...H, 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('талон.pdf') } });
  expect(up.status(), await up.text()).toBe(201);
  const doc = (await up.json()).document;
  expect((await page.request.post(`/api/orders/${o.id}/doc-requests/${req.id}/attach`, { data: { document_id: doc.id }, headers: H })).status()).toBe(200);
  await ep.reload();
  await expect(chat.locator('#message-phrase-list button')).toHaveText([
    'Доступ на осмотр', 'Уточнить адрес', 'Срок документов', 'Чек и договор', 'Акт проверки качества', 'Не ремонтируйте товар',
  ]);

  await page.goto(`/kabinet#order=${o.id}`);
  await expect(page.locator('#message-phrases')).toBeHidden();
  expect(problems).toEqual([]);
  await ectx.close();
});
