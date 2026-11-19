// Задача 2.544 — телефон 412×915: осмотр по ДДУ. Эксперт в черновике дела о квартире в новостройке видит свою фразу
// «Осмотр квартиры не проводился: дом не введён…» и вставляет её; владелец по ссылке видит стройплощадку, щит застройщика
// и корпус снаружи (комнат, подъезда и двери нет). Номера +7 999 000-54-46…47 — только здесь.
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

test('2.544: осмотр по ДДУ — своя фраза «осмотр квартиры не проводился», шаги стройплощадки у владельца', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005446');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Новостройка: осмотр' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'deal', region: 'mo', object_type: 'ddu', address: 'Московская обл., г. Тестовск, ЖК «Тестовый», корп. 3',
    ddu_number: 'ЖК-12/3-145', ddu_date: '14.03.2025', ddu_developer: 'ООО «СЗ Пример»', ddu_complex: 'ЖК «Тестовый», корп. 3',
    ddu_unit: '145', ddu_area: 41.5, ddu_handover: '31.12.2027', ddu_price: 9800000 };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005447');
  await db(async (c) => {
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
    await c.query("update orders set price_kop = 1500000, paid_at = now(), status = 'in_work', executor_user_id = $2 where id = $1", [o.id, expert.id]);
    await c.query("insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at) values ($1, 1500000, 'succeeded', $2, $3, now())", [o.id, `pay_ui_ddu_${o.id}`, expert.id]);
  });

  // Эксперт: осмотра нет — своя фраза ДДУ, вставка в черновик.
  await ep.goto(`/kabinet#order=${o.id}`);
  await ep.getByRole('button', { name: 'Подготовить черновик с помощью ИИ' }).click();
  await expect(ep.locator('#draft-msg')).toHaveText('Черновик готов — проверьте и поправьте');
  const box = ep.locator('#draft-noinsp');
  await expect(box).toBeVisible();
  await expect(box).toContainText('«Осмотр квартиры не проводился: дом не введён в эксплуатацию, квартира участнику долевого строительства не передана');
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await box.scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/du08-ddu-osmotra-net.png', fullPage: false });
  await box.getByRole('button', { name: 'Вставить фразу в черновик' }).click();
  await expect(box).toBeHidden();
  const body = (await (await ep.request.get(`/api/orders/${o.id}/draft`, { headers: H })).json()).draft.body;
  expect(body.split('Осмотр квартиры не проводился: дом не введён в эксплуатацию').length).toBe(2);
  expect(body).not.toContain('Осмотр объекта не проводился, сведения об объекте — по документам, представленным заказчиком.');

  // Владелец по ссылке: стройплощадка, щит, корпус; комнат, подъезда и двери нет.
  const r1 = await ep.request.post(`/api/orders/${o.id}/inspection`, { data: {}, headers: H });
  expect(r1.status(), await r1.text()).toBe(201);
  const url = new URL((await r1.json()).path, baseURL).toString();
  const octx = await browser.newContext({ ...ctx, permissions: ['geolocation'], geolocation: { latitude: 55.75, longitude: 37.61, accuracy: 10 } });
  const op = await octx.newPage();
  op.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  await op.goto(url);
  await op.getByRole('button', { name: 'Начать: разрешить определение места' }).click();
  for (const [id, t] of [['ddu_site', 'Стройплощадка целиком'], ['ddu_board', 'Щит застройщика (паспорт объекта)'], ['ddu_building', 'Корпус снаружи'],
    ['ddu_section', 'Секция и этаж квартиры снаружи'], ['surroundings', 'Окружение']]) {
    await expect(op.locator(`#steps li[data-step="${id}"]`)).toContainText(t);
  }
  await expect(op.locator('#steps li[data-step="ddu_board"]')).toContainText('разрешения на строительство');
  for (const id of ['facade', 'entrance', 'door', 'rooms', 'kitchen', 'bathroom']) await expect(op.locator(`#steps li[data-step="${id}"]`)).toHaveCount(0);
  expect(await op.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await op.locator('#steps li[data-step="ddu_site"]').scrollIntoViewIfNeeded();
  await op.screenshot({ path: 'test-results/screens/du09-osmotr-strojki.png', fullPage: false });
  expect(problems).toEqual([]);
  await octx.close();
  await ectx.close();
});
