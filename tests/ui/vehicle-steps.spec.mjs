// Задача 2.496 — телефон 412×915: в заявке на оценку три машины («Если машин несколько» — по строке на каждую). Владелец по
// ссылке видит «VIN» и «Пробег» на каждую машину, основная — с маркой; эксперт в деле — «не снято» по конкретной машине.
// Номера +7 999 000-52-41…42 — только здесь.
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

test('2.496: VIN и пробег на каждую машину в деле — у владельца по ссылке и «не снято» у эксперта', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005241');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'vehicle', title: 'Три машины' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'deal', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая Модель', year: 2020, vin: 'XTA00000000000001',
    more_vehicles: 'Тестовый Фургон, 2019, XTA00000000000002\nТестовый Прицеп, 2015' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 800000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_vsteps_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005242');
  await db(async (c) => {
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'vehicle') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  const r1 = await ep.request.post(`/api/orders/${o.id}/inspection`, { data: {}, headers: H });
  expect(r1.status(), await r1.text()).toBe(201);
  const url = new URL((await r1.json()).path, baseURL).toString();

  // Владелец: по шагу на каждую машину, основная — с маркой.
  const octx = await browser.newContext({ ...ctx, permissions: ['geolocation'], geolocation: { latitude: 55.75, longitude: 37.61, accuracy: 10 } });
  const op = await octx.newPage();
  op.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  await op.goto(url);
  await op.getByRole('button', { name: 'Начать: разрешить определение места' }).click();
  await expect(op.locator('#steps li[data-step="car_vin"]')).toContainText('VIN: Тестовая Модель');
  await expect(op.locator('#steps li[data-step="car_vin-1"]')).toContainText('VIN: Тестовый Фургон, 2019, XTA00000000000002');
  await expect(op.locator('#steps li[data-step="car_vin-2"]')).toContainText('VIN: Тестовый Прицеп, 2015');
  await expect(op.locator('#steps li[data-step="car_odometer-2"]')).toContainText('Пробег: Тестовый Прицеп, 2015');
  expect(await op.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await op.locator('#steps li[data-step="car_vin"]').scrollIntoViewIfNeeded();
  await op.screenshot({ path: 'test-results/screens/vt10-osmotr-neskolko-mashin.png', fullPage: false });

  // Снято всё, кроме пробега прицепа; «Готово» — эксперт видит, чего не хватает, по машине.
  const token = url.split('#')[1];
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.from('JFIF-тест-машины-ui')]);
  for (const st of ['car_front', 'car_rear', 'car_left', 'car_right', 'car_vin', 'car_vin-1', 'car_vin-2', 'car_odometer', 'car_odometer-1', 'car_interior']) {
    const r = await op.request.post('/api/inspect/photos', { data: jpeg, headers: { ...H, 'x-inspect-token': token, 'content-type': 'image/jpeg', 'x-step': st } });
    expect(r.status(), `${st}: ${await r.text()}`).toBe(201);
  }
  expect((await op.request.post('/api/inspect/finish', { data: {}, headers: { ...H, 'x-inspect-token': token } })).status()).toBe(200);
  await ep.goto(`/kabinet#order=${o.id}`);
  await expect(ep.locator('#inspect-box')).toContainText('Пробег: Тестовый Прицеп, 2015');
  await ep.locator('#inspect-box').getByText('Пробег: Тестовый Прицеп, 2015').first().scrollIntoViewIfNeeded();
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.screenshot({ path: 'test-results/screens/vt11-ne-snyato-mashina.png', fullPage: false });
  expect(problems).toEqual([]);
  await octx.close();
  await ectx.close();
});
