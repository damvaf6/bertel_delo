// Справка для нотариуса (задача 2.507) — телефон 412×915: заказчик после выдачи отчёта об оценке для наследства видит в
// документах дела «Справка для нотариуса (Word)» и скачивает её; стоимость и номер — из файла отчёта
// (tests/server/heir-note.test.mjs). Номера +7 999 000-53-6x — только здесь.
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
async function shot(page, name) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, `${name}: страница шире экрана`).toBeLessThanOrEqual(412);
  await page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: true });
}
async function phone(browser, baseURL) {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU',
    storageState: { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'delo.folds', value: 'open' }] }] } });
  const page = await ctx.newPage();
  page.problems = [];
  page.on('pageerror', (e) => page.problems.push(`ошибка JS: ${e.message}`));
  return page;
}

test('2.507: справка для нотариуса — заказчик скачивает её после выдачи вместе с отчётом', async ({ browser, baseURL }) => {
  const cp = await phone(browser, baseURL);
  const sp = await phone(browser, baseURL);
  const customer = await signIn(cp, '+79990005361');
  const expert = await signIn(sp, '+79990005362');
  const id = await db(async (c) => {
    await c.query("update users set full_name = 'Наследникова Вера' where id = $1", [customer.id]);
    await c.query("update users set full_name = 'Оценщикова Нина' where id = $1", [expert.id]);
    await c.query('insert into specialists (user_id) values ($1)', [expert.id]);
    return (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields)
      values ($1, 'Квартира для нотариуса', 'expertise', 'realty', 'in_work', $2, current_date + 5, $3) returning id`,
    [customer.id, expert.id, { purpose: 'inheritance', region: 'moscow', object_type: 'flat', address: 'г. Москва, ул. Наследная, д. 5, кв. 2',
      area: '48', death_date: '03.06.2026', notary: 'нотариус г. Москвы Тестова Т. Т.' }])).rows[0].id;
  });
  const report = 'ОТЧЁТ ОБ ОЦЕНКЕ № 512/2026 от 10.11.2026\nДата оценки: 03.06.2026\nИтоговая рыночная стоимость объекта оценки составляет 9 120 000 руб.';
  const up = await sp.request.post(`/api/orders/${id}/results`, { data: Buffer.from(report),
    headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('Отчёт об оценке.txt') } });
  expect(up.status()).toBe(201);
  await db((c) => c.query("update orders set status = 'done', paid_at = now() where id = $1", [id]));

  await cp.goto(`/kabinet#order=${id}`);
  const box = cp.locator('#heir-note-box');
  await expect(box).toBeVisible();
  await expect(box).toContainText('рыночная стоимость цифрами и прописью');
  await box.scrollIntoViewIfNeeded();
  await shot(cp, 'nh12-2507-spravka-notariusu');
  const [dl] = await Promise.all([cp.waitForEvent('download'), box.getByRole('button', { name: 'Справка для нотариуса (Word)' }).click()]);
  expect(dl.suggestedFilename()).toBe('Справка для нотариуса 512-2026.docx');
  await expect(cp.locator('#heir-note-msg')).toHaveText('Справка скачана');
  expect(cp.problems).toEqual([]);
});
