// Акт осмотра и заключение в PDF (задача штаба 41c17197) — телефон 412×915: эксперт рядом с кнопками Word скачивает тот же
// акт и черновик заключения в PDF. В контейнере CI PDF собирает LibreOffice (PDF_PROVIDER=soffice), на локальном стенде —
// поддельный. Номера +7 999 000-54-1x — только здесь.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { DB_URL, TEST_TOKEN } from '../helpers.mjs';

const CONTROL = process.env.UI_TEST_CONTROL_TOKEN || TEST_TOKEN;
const H = { 'x-delo-request': '1' };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.from('JFIF-тест-pdf')]);

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
  // Дело длинное — снимок экрана там, где кнопки, а не всей страницы.
  await page.screenshot({ path: `test-results/screens/${name}.png` });
}
async function phone(browser, baseURL) {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU',
    storageState: { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'delo.folds', value: 'open' }] }] } });
  const page = await ctx.newPage();
  page.problems = [];
  page.on('pageerror', (e) => page.problems.push(`ошибка JS: ${e.message}`));
  return page;
}

test('41c17197: акт осмотра и заключение в PDF — рядом с Word, файл PDF скачивается', async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const sp = await phone(browser, baseURL);
  const owner = await signIn(await phone(browser, baseURL), '+79990005411');
  const expert = await signIn(sp, '+79990005412');
  const id = await db(async (c) => {
    await c.query("update users set full_name = 'Пдфова Эксперт' where id = $1", [expert.id]);
    await c.query('insert into specialists (user_id) values ($1)', [expert.id]);
    return (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields)
      values ($1, 'ДТП: акт и заключение в PDF', 'expertise', 'car_damage', 'in_work', $2, current_date + 5, $3) returning id`,
    [owner.id, expert.id, { purpose: 'damage', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая Модель', year: 2019,
      accident_date: '02.11.2026', damage: 'Передний бампер', method: 'market' }])).rows[0].id;
  });
  // Владелец снял один шаг по ссылке.
  const link = await sp.request.post(`/api/orders/${id}/inspection`, { data: {}, headers: H });
  expect(link.status()).toBe(201);
  const token = (await link.json()).path.split('#')[1];
  const step = (await (await sp.request.get(`/api/orders/${id}/inspection`)).json()).steps[0].id;
  expect((await sp.request.post('/api/inspect/photos', { data: JPEG,
    headers: { ...H, 'x-inspect-token': token, 'content-type': 'image/jpeg', 'x-step': step, 'x-lat': '55.75', 'x-lon': '37.61' } })).status()).toBe(201);
  expect((await sp.request.post(`/api/orders/${id}/draft/ai`, { data: {}, headers: H })).status()).toBeLessThan(300);

  await sp.goto(`/kabinet#order=${id}`);
  const actPdf = sp.locator('#inspect-act-pdf');
  await expect(actPdf).toBeVisible();
  await expect(sp.locator('#inspect-act')).toBeVisible();
  await actPdf.evaluate((n) => n.scrollIntoView({ block: 'center' }));
  await shot(sp, 'pdf01-41c1-akt-pdf');
  const [a] = await Promise.all([sp.waitForEvent('download', { timeout: 120_000 }), actPdf.click()]);
  expect(a.suggestedFilename()).toMatch(/^Акт осмотра автомобиля [0-9A-F]{8}\.pdf$/);
  expect(readFileSync(await a.path()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  await expect(sp.locator('#inspect-msg')).toHaveText('Акт в PDF скачан');

  const draftPdf = sp.locator('#draft-pdf');
  await expect(draftPdf).toBeVisible();
  await expect(sp.locator('#draft-word')).toBeVisible();
  await draftPdf.evaluate((n) => n.scrollIntoView({ block: 'center' }));
  const [d] = await Promise.all([sp.waitForEvent('download', { timeout: 120_000 }), draftPdf.click()]);
  expect(d.suggestedFilename()).toBe('Заключение эксперта.pdf');
  expect(readFileSync(await d.path()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  await expect(sp.locator('#draft-msg')).toHaveText('Файл PDF скачан');
  await shot(sp, 'pdf02-41c1-zaklyuchenie-pdf');
  expect(sp.problems).toEqual([]);
});
