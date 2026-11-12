// Извещение об осмотре (2.470) — телефон 412×915: эксперт по делу «Ущерб после ДТП» записывает страховую, дату, время и
// место осмотра, скачивает образец Word, отмечает «Извещены» и вставляет строку в раздел «Осмотр» черновика; заказчик видит
// список и Word, но не пишет. Номера +7 999 000-47-01…02 — только здесь.
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

test('извещение об осмотре (2.470): записать страховую, Word, «Извещены», строка в черновик; заказчик только видит', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990004701');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'car_damage', title: 'Ущерб после ДТП' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'damage', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая Модель', year: 2021, reg_number: 'А001АА777',
    accident_date: '14.09.2026', accident_place: 'г. Москва, Тестовый пр-т', damage: 'Задний бампер, крышка багажника', method: 'osago' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 600000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_notice_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990004702');
  await db(async (c) => {
    await c.query("update users set full_name = 'Извещалов Пётр Сергеевич' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'car_damage') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  expect((await ep.request.post(`/api/orders/${o.id}/draft/ai`, { data: {}, headers: H })).status()).toBe(201);

  // Эксперт: блок с подсказкой, форма — кого, кому, дата, время, место.
  await ep.goto(`/kabinet#order=${o.id}`);
  const box = ep.locator('#inspnotice-box');
  await expect(box).toBeVisible();
  await expect(ep.locator('#inspnotice-lead')).toContainText('страховой и второму участнику ДТП');
  await ep.locator('#inspnotice-open').click();
  await expect(ep.locator('#inspnotice-party option')).toHaveText(['Страховая', 'Второй участник ДТП']);
  await ep.locator('#inspnotice-name').fill('АО «Тест-Страх»');
  const day = new Date(Date.now() + 3 * 3600_000 + 2 * 86400_000).toISOString().slice(0, 10);
  await ep.locator('#inspnotice-date').fill(day);
  await ep.locator('#inspnotice-time').fill('10.30');
  await ep.locator('#inspnotice-place').fill('г. Москва, ул. Тестовая, 1, автосервис');
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.locator('#inspnotice-form').scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/dn01-izveshchenie-forma.png', fullPage: false });
  await ep.locator('#inspnotice-save').click();
  await expect(ep.locator('#inspnotice-msg')).toContainText('Записано');
  const li = ep.locator('#inspnotice-list li');
  await expect(li).toHaveCount(1);
  await expect(li).toContainText('Страховая: АО «Тест-Страх»');
  await expect(li).toContainText('в 10:30, г. Москва, ул. Тестовая, 1, автосервис');
  await expect(li.locator('.notice-state')).toHaveText('Ещё не отмечено, как и когда известили');
  await expect(ep.locator('#inspnotice-draft-row')).toBeHidden();

  // Образец Word.
  const [dl] = await Promise.all([ep.waitForEvent('download'), li.getByRole('button', { name: 'Скачать извещение Word' }).click()]);
  expect(dl.suggestedFilename()).toBe('Извещение об осмотре — АО Тест-Страх.docx');

  // «Извещены» телеграммой сегодня → строка в черновик.
  await li.locator('select').selectOption('telegram');
  await li.locator('[data-action="notice-mark"]').click();
  await expect(ep.locator('#inspnotice-msg')).toHaveText('Отмечено: извещены');
  await expect(li.locator('.notice-state')).toContainText('Извещены телеграммой');
  await expect(ep.locator('#inspnotice-draft-row')).toBeVisible();
  await box.scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/dn02-izveshcheny.png', fullPage: false });
  await ep.locator('#inspnotice-draft').click();
  await expect(ep.locator('#inspnotice-msg')).toContainText('вставлена в раздел «Осмотр»');
  const text = await ep.locator('#draft-text').inputValue();
  expect(text).toMatch(/## 4\. Осмотр\nИзвещение об осмотре: об осмотре .* в 10:30, место — г\. Москва, ул\. Тестовая, 1, автосервис, извещены: АО «Тест-Страх» \(страховая\) — телеграммой /);
  await ep.locator('#inspnotice-draft').click();
  await expect(ep.locator('#inspnotice-msg')).toHaveText('Эта строка уже есть в черновике.');
  const saved = await (await ep.request.get(`/api/orders/${o.id}/draft`, { headers: H })).json();
  expect(saved.draft.body.split('Извещение об осмотре:').length).toBe(2);

  // Заказчик: видит извещение и Word, кнопок записи нет.
  await page.goto(`/kabinet#order=${o.id}`);
  await expect(page.locator('#inspnotice-box')).toBeVisible();
  await expect(page.locator('#inspnotice-list li')).toContainText('Извещены телеграммой');
  await expect(page.locator('#inspnotice-open')).toBeHidden();
  await expect(page.locator('#inspnotice-list [data-action="notice-mark"]')).toHaveCount(0);
  await expect(page.locator('#inspnotice-list').getByRole('button', { name: 'Скачать извещение Word' })).toBeVisible();
  expect(problems).toEqual([]);
  await ectx.close();
});
