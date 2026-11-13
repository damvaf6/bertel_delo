// Прогон 2.489 — телефон 412×915: продавца известили об осмотре товара на вчера, а в заключении дата осмотра — позавчера.
// ИИ-проверка в пункте «Реквизиты» называет расхождение с извещением. Номера +7 999 000-48-91…92 — только здесь.
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


test('прогон 2.489: дата осмотра в заключении не та, на которую извещён продавец', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990004891');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'goods', title: 'Ноутбук: дата осмотра' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'court', region: 'moscow', subject: 'Ноутбук перестал включаться', questions: 'Есть ли недостаток?',
    purchase: '12.03.2026, магазин, 54 990 ₽', goods_kind: 'gadget', model: 'Тестовый ноутбук X1', defects: 'не включается',
    found_date: '20.04.2026', location: 'г. Москва' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 600000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_gndate_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990004892');
  await db(async (c) => {
    await c.query("update users set full_name = 'Товаров Иван Петрович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'goods') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);

  const msk = (days) => new Date(Date.now() + 3 * 3600_000 + days * 86400_000).toISOString().slice(0, 10);
  const ru = (d) => d.split('-').reverse().join('.');
  const n = await ep.request.post(`/api/orders/${o.id}/notices`, { data: { party: 'seller', name: 'ООО «Тест-Магазин»', date: msk(-1), time: '11:00', place: 'г. Москва' }, headers: H });
  expect(n.status(), await n.text()).toBe(201);
  const id = (await n.json()).notices[0].id;
  expect((await ep.request.put(`/api/orders/${o.id}/notices/${id}/mark`, { data: { how: 'letter', sent_on: msk(-4) }, headers: H })).status()).toBe(200);
  const report = ['ЗАКЛЮЧЕНИЕ ЭКСПЕРТА № 9/2026', '4. Осмотр', `Дата осмотра: ${ru(msk(-2))}.`, '7. Выводы', 'Недостаток производственный.'].join('\n');
  expect((await ep.request.post(`/api/orders/${o.id}/results`, {
    data: Buffer.from(report), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('заключение.txt') },
  })).status()).toBe(201);

  await ep.goto(`/kabinet#order=${o.id}`);
  await ep.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(ep.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  const item = ep.locator('#review-checks > li[data-check="requisites"]');
  const found = item.locator('.ai-found li', { hasText: 'извещали об осмотре' });
  await expect(found).toHaveCount(1);
  await expect(found).toContainText(`Дата осмотра в отчёте — ${ru(msk(-2))}, а извещали об осмотре на другой день (ООО «Тест-Магазин» — на ${ru(msk(-1))})`);
  await expect(found).toContainText('отправьте новое извещение');
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await found.scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/gw12-data-osmotra-izveshchenie.png', fullPage: false });
  expect(problems).toEqual([]);
  await ectx.close();
});
