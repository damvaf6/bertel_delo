// Задача 2.542 — телефон 412×915: ИИ-проверка «Права по ДДУ». К делу приложен договор участия в долевом строительстве, номер
// и проектная площадь в нём не те, что в отчёте (отчёт писали по заявке), а у квартиры в отчёте кадастровый номер — в ИИ-проверке
// пункт «Права по ДДУ: …» с тремя находками. Номера +7 999 000-59-42…43 — только здесь.
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

test('2.542: ИИ-проверка по ДДУ — номер и площадь не как в договоре из дела, кадастровый номер квартиры', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005942');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Новостройка: ИИ-проверка' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'bank', region: 'moscow', object_type: 'ddu', address: 'г. Москва, ЖК «Тестовый», корп. 3 (строительный адрес)',
    ddu_number: 'ЖК-12/3-145', ddu_date: '14.03.2025', ddu_developer: 'ООО «СЗ Тестовый»', ddu_complex: 'ЖК «Тестовый», корп. 3, секция 2',
    ddu_unit: '145', ddu_area: 41.3, ddu_handover: '31.12.2027' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 900000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_dducheck_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });
  // Заказчик приложил договор: номер и площадь в нём не те, что он написал в заявке.
  expect((await page.request.post(`/api/orders/${o.id}/documents`, {
    data: Buffer.from('ДОГОВОР УЧАСТИЯ В ДОЛЕВОМ СТРОИТЕЛЬСТВЕ № ЖК-12/3-146 от 14.03.2025\nОбъект долевого строительства — квартира, условный номер 145, проектная общая площадь 42,3 кв. м.'),
    headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('ДДУ ЖК-12-3-146.txt') } })).status()).toBe(201);

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005943');
  await db(async (c) => {
    await c.query("update users set full_name = 'Долевой Иван Петрович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);

  const report = [
    'ОТЧЁТ ОБ ОЦЕНКЕ № 77/2026',
    'Объект оценки — право требования по ДДУ: договор участия в долевом строительстве № ЖК-12/3-145 от 14.03.2025 (214-ФЗ); квартира с условным номером 145; проектная площадь — 41,3 кв. м; срок передачи по договору — 31.12.2027.',
    'Кадастровый номер квартиры: 77:01:0001001:1234',
    'Итоговая рыночная стоимость права требования: 9 800 000 руб.',
  ].join('\n');
  expect((await ep.request.post(`/api/orders/${o.id}/results`, {
    data: Buffer.from(report), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') },
  })).status()).toBe(201);
  await ep.goto(`/kabinet#order=${o.id}`);
  await ep.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(ep.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  const item = ep.locator('#review-checks > li[data-check="ddu_right"]');
  await expect(item).toContainText('Права по ДДУ: объект — право требования, договор и проектная площадь — как в ДДУ, срок передачи');
  await expect(item).toContainText('Номер ДДУ в отчёте ЖК-12/3-145, а в договоре из дела — ЖК-12/3-146');
  await expect(item).toContainText('Проектная площадь в отчёте 41,3 кв. м, а в договоре из дела — 42,3 кв. м');
  await expect(item).toContainText('В отчёте у квартиры кадастровый номер 77:01:0001001:1234, а у квартиры по ДДУ его ещё нет');
  await expect(item).not.toContainText('Дата ДДУ');
  await item.scrollIntoViewIfNeeded();
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.screenshot({ path: 'test-results/screens/du05-ddu-proverka.png', fullPage: false });

  // Заказчик подсказок ИИ не видит.
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto(`/kabinet#order=${o.id}`);
  await expect(page.locator('#details-form, #order-view').first()).toBeVisible();
  await expect(page.locator('li[data-check="ddu_right"]')).toHaveCount(0);
  expect(problems).toEqual([]);
  await ectx.close();
});
