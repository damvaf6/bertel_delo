// Срок дела в выходной или праздник (задача 2.382) — телефон 412×915: в «Сегодня» эксперта у строки «Срок близко — нет
// файла результата» — «нерабочий день — сдайте лучше до него» с последним рабочим днём. Какие дела «близко» — считает
// сервер (тесты «2.382» в tests/server/today.test.mjs, по фиксированным дням); здесь — как это видно на экране: ответ
// «Сегодня» для настоящего дела подменён на фиксированный день (четверг 29 октября 2026, срок — воскресенье 1 ноября).
// Номера +7 999 000-88-2x — только здесь.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DB_URL, TEST_TOKEN } from '../helpers.mjs';
import { calendarWarning, yearCalendar } from '../../src/orders/holidays.mjs';

const CONTROL = process.env.UI_TEST_CONTROL_TOKEN || TEST_TOKEN;
const H = { 'x-delo-request': '1' };
const inDays = (n) => new Date(Date.now() + 3 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);

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
function phoneContext(browser, baseURL) {
  return browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU',
    storageState: { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'delo.folds', value: 'open' }] }] } });
}
async function shot(page, name) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, `${name}: страница шире экрана`).toBeLessThanOrEqual(412);
  await page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: true });
}

test('2.382: срок в воскресенье — «Срок близко» с последним рабочим днём перед ним', async ({ browser, baseURL }) => {
  const problems = [];
  const watch = (p) => {
    p.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
    p.on('request', (r) => { const u = new URL(r.url()); if (u.protocol.startsWith('http') && u.origin !== new URL(baseURL).origin && !process.env.UI_ALLOWED_ORIGINS?.includes(u.origin)) problems.push(`внешний запрос: ${r.url()}`); });
  };
  const dctx = await phoneContext(browser, baseURL);
  const dp = await dctx.newPage();
  const sctx = await phoneContext(browser, baseURL);
  const sp = await sctx.newPage();
  watch(dp); watch(sp);
  const disp = await signIn(dp, '+79990008821');
  const spec = await signIn(sp, '+79990008822');
  await db(async (c) => {
    await c.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]);
    await c.query('insert into specialists (user_id) values ($1)', [spec.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [spec.id]);
  });
  const id = (await (await dp.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Квартира: срок в воскресенье' }, headers: H })).json()).order.id;
  expect((await dp.request.patch(`/api/orders/${id}`, {
    data: { deadline: inDays(9), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, Выходная ул., 1' } }, headers: H,
  })).status()).toBe(200);
  expect((await dp.request.post(`/api/orders/${id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 1500000, paid_at = now() where id = $1', [id]);
    await c.query("insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at) values ($1, 1500000, 'succeeded', $2, $3, now())", [id, `pay_ui_${id}`, disp.id]);
  });
  expect((await dp.request.post(`/api/orders/${id}/offer`, { data: { specialist_id: spec.id, from: 'matching' }, headers: H })).status()).toBe(200);
  expect((await sp.request.post(`/api/orders/${id}/status`, { data: { from: 'awaiting_executor', to: 'in_work' }, headers: H })).status()).toBe(200);

  // Четверг 29 октября: срок в воскресенье 1 ноября — сдавать в пятницу 30-го, дело уже «близко».
  await sp.route('**/api/today', async (route) => {
    const r = await route.fetch();
    const j = await r.json();
    const row = { id, title: 'Квартира: срок в воскресенье', service: 'Оценка недвижимости', deadline: '2026-11-01', overdue: false,
      has_draft: false, extend: null, work_before: '2026-10-30' };
    j.today = '2026-10-29';
    j.expert.no_result = [row, ...(j.expert.no_result ?? []).filter((x) => x.id !== id)];
    await route.fulfill({ response: r, json: j });
  });
  await sp.goto('/kabinet');
  const line = sp.locator('li[data-today-item="no-result"]').filter({ hasText: 'Квартира: срок в воскресенье' });
  await expect(line).toBeVisible();
  await expect(line).toContainText('срок 1 ноября · осталось 3 дн. · нерабочий день — сдайте лучше до него, последний рабочий день — пт, 30 октября');
  await line.scrollIntoViewIfNeeded();
  await shot(sp, 'wd1-2382-segodnya-srok-v-vyhodnoy');
  expect(problems, problems.join('\n')).toEqual([]);
  await sctx.close();
  await dctx.close();
});

// 2.390: напоминание «срок завтра» приходит в последний рабочий день перед сроком (срок в понедельник — в пятницу).
// Когда приходит — считает сервер (тесты «2.390» в tests/server/reminders.test.mjs, по фиксированным дням); здесь — как
// это напоминание читается в ленте на телефоне. Номера +7 999 000-88-3x — только здесь.
test('2.390: «Срок по делу — завтра или сразу после выходных» в ленте эксперта', async ({ browser, baseURL }) => {
  const problems = [];
  const sctx = await phoneContext(browser, baseURL);
  const sp = await sctx.newPage();
  sp.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const spec = await signIn(sp, '+79990008831');
  await db((c) => c.query("insert into notifications (user_id, type, event) values ($1, 'executor_work', 'deadline_tomorrow')", [spec.id]));
  await sp.goto('/kabinet#notifications');
  await expect(sp.locator('#notifications li').first())
    .toContainText('Срок по делу — завтра или сразу после выходных: сегодня последний рабочий день перед ним');
  await shot(sp, 'wd2-2390-lenta-srok-posle-vyhodnyh');
  expect(problems, problems.join('\n')).toEqual([]);
  await sctx.close();
});

test('2.399: «Праздники и переносы» в «Управлении» — год одной страницей, в декабре — «дописать постановление»', async ({ browser, baseURL }) => {
  const problems = [];
  const ctx = await phoneContext(browser, baseURL);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const adm = await signIn(page, '+79990008839');
  await db((c) => c.query("update users set platform_role = 'admin' where id = $1", [adm.id]));
  await page.goto('/kabinet#admin');
  const box = page.locator('#holidays-box');
  const y = Number(inDays(0).slice(0, 4));
  await expect(box.locator('#hd-years button')).toHaveCount(2);
  await expect(box.locator(`#hd-years button[data-year="${y}"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(box.locator('[data-hd-run]').first()).toBeVisible();
  // Следующий год: 2027 — с переносами по постановлению № 1187 и рабочей субботой 20 февраля.
  if (y === 2026) {
    await expect(box.locator('#hd-warn')).toBeHidden();
    await box.locator('#hd-years button[data-year="2027"]').click();
    await expect(box.locator('#hd-source')).toContainText('№ 1187');
    await expect(box.locator('[data-hd-run="2027-11-04"]')).toContainText('4 ноября, чт — 7 ноября, вс · 4 дня');
    await expect(box.locator('[data-hd-move="2027-02-20"]')).toContainText('рабочая суббота (перенос)');
    await expect(box.locator('[data-hd-move="2027-11-05"]')).toContainText('перенос выходного с 2 января');
    await box.scrollIntoViewIfNeeded();
    await shot(page, 'wd3-2399-prazdniki-2027');
  }
  // Декабрь 2027, а на 2028 переносов нет: ответ подменён на этот день.
  await page.route('**/api/admin/holidays', (route) => route.fulfill({ json: { today: '2027-12-01',
    warning: calendarWarning('2027-12-01'), years: [yearCalendar(2027), yearCalendar(2028)] } }));
  await page.reload();
  await expect(box.locator('#hd-warn')).toBeVisible();
  await expect(box.locator('#hd-warn')).toContainText('Скоро 2028 год, а переносы выходных на него не записаны');
  await expect(box.locator('#hd-years button[data-year="2028"]')).toHaveText('2028 · не записан');
  await box.locator('#hd-years button[data-year="2028"]').click();
  await expect(box.locator('#hd-source')).toHaveAttribute('data-decree', 'false');
  await expect(box.locator('#hd-moves-empty')).toBeHidden();
  await box.scrollIntoViewIfNeeded();
  await shot(page, 'wd3-2399-prazdniki-dekabr');
  expect(problems, problems.join('\n')).toEqual([]);
  await ctx.close();
});
