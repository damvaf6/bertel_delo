// Сверка с актом и расчётом страховой (2.475) — телефон 412×915: эксперт по делу «Ущерб после ДТП» вносит детали и сумму
// страховой, видит, что добавил и что исключил, и разницу; таблица деталей меняется — сверка пересчитывается; вставляет
// сверку в черновик под таблицей деталей; заказчик видит итог, но не пишет. Номера +7 999 000-47-95…96 — только здесь.
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

test('сверка со страховой (2.475): внести, сравнение с таблицей деталей, в черновик; заказчик только видит', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990004795');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'car_damage', title: 'ДТП: страховая' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'damage', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая Модель', year: 2021, reg_number: 'А001АА777',
    accident_date: '14.09.2026', accident_place: 'г. Москва, Тестовый пр-т', damage: 'Задний бампер, крышка багажника', method: 'osago' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 600000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_ins_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990004796');
  await db(async (c) => {
    await c.query("update users set full_name = 'Сверкин Иван Петрович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'car_damage') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  for (const part of ['Бампер задний', 'Крышка багажника']) {
    expect((await ep.request.post(`/api/orders/${o.id}/parts`, { data: { part, damage: 'Вмятина', actions: ['repair'], photos: [] }, headers: H })).status()).toBe(201);
  }
  expect((await ep.request.post(`/api/orders/${o.id}/draft/ai`, { data: {}, headers: H })).status()).toBe(201);

  await ep.goto(`/kabinet#order=${o.id}`);
  const box = ep.locator('#insurer-box');
  await expect(box).toBeVisible();
  await expect(ep.locator('#insurer-lead')).toContainText('что Вы добавили, что исключили');
  await ep.locator('#insurer-open').click();
  await ep.locator('#insurer-basis').fill('акт осмотра и калькуляция № 12 от 20.09.2026');
  await ep.locator('#insurer-parts').fill('бампера заднего\nФонарь задний левый');
  await ep.locator('#insurer-sum').fill('сто тысяч');
  await ep.locator('#insurer-save').click();
  await expect(ep.locator('#insurer-msg')).toContainText('Сумма страховой — в рублях');
  await ep.locator('#insurer-sum').fill('84 500');
  await ep.locator('#insurer-own').fill('112 300');
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.locator('#insurer-form').scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/di01-strahovaya-forma.png', fullPage: false });
  await ep.locator('#insurer-save').click();
  await expect(ep.locator('#insurer-msg')).toHaveText('Сравнено с Вашей таблицей деталей');
  await expect(ep.locator('#insurer-form')).toBeHidden();
  await expect(ep.locator('#insurer-line')).toContainText('деталей совпадает — 1, добавлено экспертом — 1, исключено экспертом — 1');
  await expect(ep.locator('#insurer-line')).toContainText('разница — +27\u00a0800\u00a0руб.');
  const li = ep.locator('#insurer-list li');
  await expect(li).toHaveCount(3);
  await expect(li.nth(0)).toContainText('совпадает (у страховой — «бампера заднего»)');
  await expect(li.nth(1)).toContainText('Крышка багажника');
  await expect(li.nth(1)).toContainText('добавлено Вами');
  await expect(li.nth(2)).toContainText('Фонарь задний левый');
  await expect(li.nth(2)).toContainText('исключено Вами');

  // Добавил деталь в таблицу — сверка пересчиталась без перезагрузки.
  await ep.locator('#parts-open').click();
  await ep.locator('#parts-part').fill('Фонарь задний левый');
  await ep.locator('#parts-damage').fill('Трещина рассеивателя');
  await ep.locator('#parts-actions label', { hasText: 'замена' }).click();
  await ep.locator('#parts-save').click();
  await expect(ep.locator('#parts-msg')).toHaveText('Деталь записана');
  await expect(ep.locator('#insurer-line')).toContainText('деталей совпадает — 2, добавлено экспертом — 1, исключено экспертом — 0');

  // В черновик — под таблицей повреждённых деталей; второй раз — «уже есть».
  await ep.locator('#parts-draft').click();
  await expect(ep.locator('#parts-msg')).toContainText('вставлена');
  await box.scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/di02-strahovaya-sverka.png', fullPage: false });
  await ep.locator('#insurer-draft').click();
  await expect(ep.locator('#insurer-msg')).toContainText('вставлена в раздел «Исследование повреждений»');
  const text = await ep.locator('#draft-text').inputValue();
  expect(text).toContain([
    '| 3 | Фонарь задний левый | Трещина рассеивателя | замена | нет фото |',
    '',
    'Сравнение с расчётом страховой (акт осмотра и калькуляция № 12 от 20.09.2026): деталей совпадает — 2, добавлено экспертом — 1, исключено экспертом — 0. Сумма с учётом износа: у страховой — 84 500 руб., по расчёту эксперта — 112 300 руб., разница — +27 800 руб.',
    '',
    '| № | Деталь | У страховой | У эксперта | Итог |',
    '| 1 | Бампер задний (у страховой — «бампера заднего») | есть | есть | совпадает |',
    '| 2 | Крышка багажника | нет | есть | добавлено экспертом |',
    '| 3 | Фонарь задний левый | есть | есть | совпадает |',
  ].join('\n'));
  await ep.locator('#insurer-draft').click();
  await expect(ep.locator('#insurer-msg')).toHaveText('Эта сверка уже есть в черновике.');

  // Изменить сумму → «Вставить» заменяет прежний блок целиком.
  await ep.locator('#insurer-open').click();
  await expect(ep.locator('#insurer-sum')).toHaveValue(/84\s500/);
  await ep.locator('#insurer-sum').fill('90000');
  await ep.locator('#insurer-save').click();
  await expect(ep.locator('#insurer-line')).toContainText('разница — +22\u00a0300\u00a0руб.');
  await ep.locator('#insurer-draft').click();
  await expect(ep.locator('#insurer-msg')).toContainText('вставлена');
  const text2 = await ep.locator('#draft-text').inputValue();
  expect(text2.match(/^Сравнение с расчётом страховой/gm)).toHaveLength(1);
  expect(text2).toContain('у страховой — 90 000 руб.');
  expect(text2.match(/^\| № \| Деталь \| У страховой/gm)).toHaveLength(1);

  // Заказчик видит итог, но не правит.
  await page.goto(`/kabinet#order=${o.id}`);
  await expect(page.locator('#insurer-box')).toBeVisible();
  await expect(page.locator('#insurer-line')).toContainText('у страховой — 90\u00a0000\u00a0руб.');
  await expect(page.locator('#insurer-open')).toBeHidden();
  await expect(page.locator('#insurer-draft-row')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  expect(problems).toEqual([]);
  await ectx.close();
});
