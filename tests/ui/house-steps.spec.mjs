// Задача 2.533 — телефон 412×915: осмотр жилого дома по шагам. Владелец по ссылке видит фасады со всех сторон, кровлю,
// фундамент, котёл и счётчики, участок и подъезд к дому (подъезда и двери квартиры нет); после «Готово» без кровли и
// фундамента эксперт в деле видит «не снято» по ним. Номера +7 999 000-59-33…34 — только здесь.
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

test('2.533: осмотр дома по шагам — фасады, кровля, фундамент, котёл, участок; эксперту «не снято»', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005933');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Жилой дом: осмотр' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'deal', region: 'mo', object_type: 'house', address: 'Московская обл., д. Тестовая, ул. Садовая, д. 3', area: 95,
    house_land: 'own', land_area: 10, house_gas: 'main', house_walls: 'wood' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 900000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_hsteps_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005934');
  await db(async (c) => {
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  const r1 = await ep.request.post(`/api/orders/${o.id}/inspection`, { data: {}, headers: H });
  expect(r1.status(), await r1.text()).toBe(201);
  const url = new URL((await r1.json()).path, baseURL).toString();

  // Владелец: шаги дома, подъезда и двери квартиры нет.
  const octx = await browser.newContext({ ...ctx, permissions: ['geolocation'], geolocation: { latitude: 55.75, longitude: 37.61, accuracy: 10 } });
  const op = await octx.newPage();
  op.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  await op.goto(url);
  await op.getByRole('button', { name: 'Начать: разрешить определение места' }).click();
  for (const [id, t] of [['house_front', 'Дом спереди'], ['house_back', 'Дом сзади'], ['house_left', 'Дом слева'], ['house_right', 'Дом справа'],
    ['house_roof', 'Кровля'], ['house_foundation', 'Фундамент и цоколь'], ['house_heating', 'Котёл, отопление и счётчики'],
    ['house_land', 'Участок целиком'], ['house_access', 'Подъезд к дому']]) {
    await expect(op.locator(`#steps li[data-step="${id}"]`)).toContainText(t);
  }
  await expect(op.locator('#steps li[data-step="house_front"]')).toContainText('номер дома');
  await expect(op.locator('#steps li[data-step="entrance"]')).toHaveCount(0);
  await expect(op.locator('#steps li[data-step="door"]')).toHaveCount(0);
  expect(await op.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await op.locator('#steps li[data-step="house_front"]').scrollIntoViewIfNeeded();
  await op.screenshot({ path: 'test-results/screens/hs07-osmotr-doma.png', fullPage: false });

  // Снято всё обязательное, кроме кровли и фундамента; «Готово» — эксперт видит, чего не хватает.
  const token = url.split('#')[1];
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.from('JFIF-тест-дом-ui')]);
  for (const st of ['house_front', 'house_back', 'house_left', 'house_right', 'rooms', 'kitchen', 'bathroom', 'window_view', 'house_heating',
    'house_land', 'house_access', 'surroundings']) {
    const r = await op.request.post('/api/inspect/photos', { data: jpeg, headers: { ...H, 'x-inspect-token': token, 'content-type': 'image/jpeg', 'x-step': st } });
    expect(r.status(), `${st}: ${await r.text()}`).toBe(201);
  }
  expect((await op.request.post('/api/inspect/finish', { data: {}, headers: { ...H, 'x-inspect-token': token } })).status()).toBe(200);
  await ep.goto(`/kabinet#order=${o.id}`);
  await expect(ep.locator('#inspect-box')).toContainText('Кровля');
  await expect(ep.locator('#inspect-box')).toContainText('Фундамент и цоколь');
  await ep.locator('#inspect-box').getByText('Фундамент и цоколь').first().scrollIntoViewIfNeeded();
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.screenshot({ path: 'test-results/screens/hs08-ne-snyato-dom.png', fullPage: false });
  expect(problems).toEqual([]);
  await octx.close();
  await ectx.close();
});
