// Задача 2.494 — телефон 412×915: черновик от ИИ по оценке машины — в «7. Описание объекта» таблица «Характеристики объекта
// оценки» из заявки (пробег по заявке). Помощник съездил и записал пробег по прибору и состояние — в деле «таблица устарела»,
// «Обновить таблицу в черновике» заменяет её целиком. Номера +7 999 000-52-21…22 — только здесь.
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


test('2.494: таблица «Характеристики объекта оценки» в черновике и её обновление после выезда', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  const owner = await signIn(page, '+79990005221');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'vehicle', title: 'Машина: характеристики' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'deal', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая Модель', year: 2020,
    vin: 'XTA00000000000001', reg_number: 'А001АА777', mileage: 100000 };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 800000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_vspecs_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005222');
  await db(async (c) => {
    await c.query("update users set full_name = 'Машинов Иван Петрович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'vehicle') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  // Черновик от ИИ: таблица из заявки, пробег — по заявке.
  const d = await ep.request.post(`/api/orders/${o.id}/draft/ai`, { data: {}, headers: H });
  expect(d.status(), await d.text()).toBe(201);
  await ep.goto(`/kabinet#order=${o.id}`);
  const text = ep.locator('#draft-text');
  await expect(text).toBeVisible();
  await expect(text).toHaveValue(/\| Характеристика объекта оценки \| Значение \| Откуда \|\n/);
  await expect(text).toHaveValue(/\| Пробег \| 100 000 км \| заявка \|/);
  await expect(ep.locator('#draft-specs')).toBeHidden();

  // Помощник съездил: по прибору 190 000 км, состояние обычное. В деле — «таблица устарела», одно нажатие — новая.
  await db((c) => c.query(`insert into onsite_visits (order_id, helper_id, assigned_by, planned_at, data, finished_at)
                           values ($1, $2, $3, now(), $4, now())`, [o.id, owner.id, expert.id, JSON.stringify({ condition: 'normal', match_order: 'yes', mileage: 190000, vin_match: 'yes' })]));
  await ep.reload();
  const box = ep.locator('#draft-specs');
  await expect(box).toBeVisible();
  await expect(box).toContainText('устарела');
  await expect(box.getByRole('button', { name: 'Обновить таблицу в черновике' })).toBeVisible();
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await box.scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/vt07-harakteristiki-ustarela.png', fullPage: false });
  await box.getByRole('button', { name: 'Обновить таблицу в черновике' }).click();
  await expect(ep.locator('#draft-msg')).toContainText('Таблица «Характеристики объекта оценки» в черновике, черновик сохранён');
  await expect(box).toBeHidden();
  await expect(text).toHaveValue(/\| Пробег \| 190 000 км \(в заявке — 100 000 км\) \| по осмотру, выезд помощника \d{2}\.\d{2}\.\d{4} \|/);
  await expect(text).toHaveValue(/\| Состояние по осмотру \| Обычное, без явных недостатков \|/);
  expect((await text.inputValue()).split('\n').filter((l) => l.startsWith('| Характеристика объекта оценки')).length).toBe(1);
  await ep.screenshot({ path: 'test-results/screens/vt08-harakteristiki-v-chernovike.png', fullPage: false });
  // Сохранено на сервере.
  const saved = await (await ep.request.get(`/api/orders/${o.id}/draft`)).json();
  expect(saved.draft.body).toContain('| Пробег | 190 000 км (в заявке — 100 000 км) |');
  expect(problems).toEqual([]);
  await ectx.close();
});
