// Задача 2.491 — телефон 412×915: эксперт по оценке машины отмечает проверку в реестре залогов (залог есть — номер
// уведомления и залогодержатель), вставляет строку в раздел «Описание объекта» черновика; заказчик видит итог без кнопок;
// ИИ-проверка: залог отмечен, а в отчёте ни слова. Номера +7 999 000-49-51…52 — только здесь.
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

test('2.491: проверка в реестре залогов — отметка, строка в черновик, заказчик видит, ИИ-проверка', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990004951');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'vehicle', title: 'Машина: залог' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'deal', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая Модель', year: 2020,
    vin: 'XTA00000000000001', reg_number: 'А001АА777', mileage: 120000 };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 800000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_pledge_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990004952');
  await db(async (c) => {
    await c.query("update users set full_name = 'Залогов Иван Петрович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'vehicle') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  expect((await ep.request.post(`/api/orders/${o.id}/draft/ai`, { data: {}, headers: H })).status()).toBe(201);

  await ep.goto(`/kabinet#order=${o.id}`);
  const box = ep.locator('#pledge-box');
  await expect(box).toBeVisible();
  await expect(ep.locator('#pledge-lead')).toContainText('по VIN XTA00000000000001 в реестре уведомлений о залоге');
  await ep.locator('#pledge-open').click();
  await expect(ep.locator('#pledge-found')).toBeHidden();
  await ep.locator('#pledge-result label', { hasText: 'залог есть' }).click();
  await expect(ep.locator('#pledge-found')).toBeVisible();
  await ep.locator('#pledge-save').click();
  await expect(ep.locator('#pledge-msg')).toContainText('Номер уведомления о залоге');
  await ep.locator('#pledge-notice').fill('2026-001-123456-789');
  await ep.locator('#pledge-pledgee').fill('ООО «Тестовый Банк»');
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.locator('#pledge-form').scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/vt02-zalog-forma.png', fullPage: false });
  await ep.locator('#pledge-save').click();
  await expect(ep.locator('#pledge-form')).toBeHidden();
  await expect(ep.locator('#pledge-line')).toContainText('объект оценки находится в залоге — уведомление о возникновении залога № 2026-001-123456-789, залогодержатель — ООО «Тестовый Банк».');

  // В черновик — сразу под заголовком «7. Описание объекта оценки»; второй раз — «уже есть»; изменил итог — строка заменилась.
  const line = await ep.locator('#pledge-line').textContent();
  await ep.locator('#pledge-draft').click();
  await expect(ep.locator('#pledge-msg')).toContainText('вставлена в раздел «Описание объекта»');
  const text = await ep.locator('#draft-text').inputValue();
  expect(text).toMatch(new RegExp(`7\\. Описание объекта оценки\\n${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  await ep.locator('#pledge-draft').click();
  await expect(ep.locator('#pledge-msg')).toHaveText('Эта строка уже есть в черновике.');
  await box.scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/vt03-zalog-v-chernovik.png', fullPage: false });

  // Заказчик видит итог, без кнопок.
  await page.goto(`/kabinet#order=${o.id}`);
  await expect(page.locator('#pledge-line')).toContainText('находится в залоге');
  await expect(page.locator('#pledge-open')).toBeHidden();
  await expect(page.locator('#pledge-draft-row')).toBeHidden();

  // ИИ-проверка: залог отмечен, а в отчёте о нём ни слова — находка в «Права и обременения».
  const report = ['ОТЧЁТ ОБ ОЦЕНКЕ № 12/2026', '7. Описание объекта оценки', 'Легковой автомобиль Тестовая Модель, 2020 г. в., VIN XTA00000000000001.',
    '13. Итоговая величина', 'Рыночная стоимость — 1 000 000 руб.'].join('\n');
  expect((await ep.request.post(`/api/orders/${o.id}/results`, {
    data: Buffer.from(report), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') },
  })).status()).toBe(201);
  await ep.goto(`/kabinet#order=${o.id}`);
  await ep.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(ep.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  const hit = ep.locator('#review-checks > li[data-check="rights"] .ai-found li', { hasText: 'в реестре залогов' });
  await expect(hit).toHaveCount(1);
  await expect(hit).toContainText('а в отчёте о залоге ни слова');
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await hit.scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/vt04-zalog-ii-proverka.png', fullPage: false });
  expect(problems).toEqual([]);
  await ectx.close();
});
