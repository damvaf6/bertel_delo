// Задача 2.52: подсказки первого входа по ролям и раздел «Как работать» — телефон 412×915.
// Номера +7 999 000-07-xx — только эта проверка.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DB_URL, TEST_TOKEN } from '../helpers.mjs';

const CONTROL = process.env.UI_TEST_CONTROL_TOKEN || TEST_TOKEN;

async function signIn(page, phone) {
  const h = { 'x-delo-request': '1' };
  expect((await page.request.post('/api/auth/code', { data: { phone }, headers: h })).status()).toBe(200);
  const calls = (await (await page.request.get('/__test/fakes/sms/calls', { headers: { 'x-test-control': CONTROL } })).json()).calls;
  const code = calls.filter((c) => c.method === 'sendCode' && c.args.phone === phone).at(-1).args.code;
  const r = await page.request.post('/api/auth/verify', { data: { phone, code }, headers: h });
  expect(r.status()).toBe(200);
  return (await r.json()).user;
}

async function db(fn) {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

// «Понятно» — и дождаться, пока сервер запомнит закрытую подсказку (иначе перезагрузка успевает раньше).
async function gotIt(page) {
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/me/hints') && r.request().method() === 'POST' && r.ok()),
    page.getByRole('button', { name: 'Понятно' }).click(),
  ]);
}

async function shot(page, name) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, `${name}: страница шире экрана`).toBeLessThanOrEqual(412);
  await page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: true });
}

test('первый вход заказчика: «С чего начать» один раз, затем «Как работать»', async ({ page }) => {
  await signIn(page, '+79990000701');
  await page.goto('/kabinet');
  const box = page.locator('#hint-box');
  await expect(box).toBeVisible();
  await expect(page.locator('#hint-title')).toHaveText('С чего начать: заказчик');
  await expect(page.locator('#hint-steps li')).toHaveCount(4);
  await shot(page, 'help-01-pervyj-vhod-zakazchik');
  await gotIt(page);
  await expect(box).toBeHidden();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Мои заявки' })).toBeVisible();
  await expect(box).toBeHidden();

  await page.getByRole('link', { name: 'Как работать' }).first().click();
  await expect(page.getByRole('heading', { name: 'Как работать', level: 1 })).toBeVisible();
  await expect(page.locator('details[data-role="customer"]')).toHaveAttribute('open', '');
  await expect(page.locator('details[data-role="expert"]')).not.toHaveAttribute('open', '');
  await expect(page.locator('details[data-role="customer"]')).toContainText('Принять и закрыть');
  await shot(page, 'help-02-kak-rabotat');
  // Без технических слов.
  const text = await page.locator('#help-view').innerText();
  for (const w of ['API', 'статус', 'сервер', 'токен', 'база данных', 'логин']) expect(text.toLowerCase()).not.toContain(w.toLowerCase());
});

test('эксперт и руководитель: подсказки по каждой роли по очереди; диспетчер — своя', async ({ page, browser, baseURL }) => {
  const u = await signIn(page, '+79990000702');
  await db(async (c) => {
    await c.query('insert into specialists (user_id, regions, capacity) values ($1, $2, 5)', [u.id, ['moscow']]);
    const o = await c.query("insert into organizations (name) values ('ООО «Тестовая подсказка»') returning id");
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head')", [o.rows[0].id, u.id]);
  });
  await page.goto('/kabinet');
  await expect(page.locator('#hint-title')).toHaveText('С чего начать: руководитель организации');
  await shot(page, 'help-03-pervyj-vhod-rukovoditel');
  await gotIt(page);
  await expect(page.locator('#hint-title')).toHaveText('С чего начать: эксперт');
  await expect(page.locator('#hint-steps')).toContainText('Моё досье');
  await shot(page, 'help-04-pervyj-vhod-ekspert');
  await gotIt(page);
  await expect(page.locator('#hint-title')).toHaveText('С чего начать: заказчик');
  await gotIt(page);
  await expect(page.locator('#hint-box')).toBeHidden();
  // На другом устройстве (новый вход) подсказки уже закрыты.
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' });
  const other = await ctx.newPage();
  await db((c) => c.query("update login_codes set created_at = created_at - interval '2 minutes' where phone = '+79990000702'"));
  await signIn(other, '+79990000702');
  await other.goto('/kabinet');
  await expect(other.getByRole('heading', { name: 'Мои заявки' })).toBeVisible();
  await expect(other.locator('#hint-box')).toBeHidden();
  await other.goto('/kabinet#help');
  await expect(other.locator('details[open]')).toHaveCount(3);
  await ctx.close();

  const d = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' });
  const dp = await d.newPage();
  const du = await signIn(dp, '+79990000703');
  await db((c) => c.query("update users set platform_role = 'dispatcher' where id = $1", [du.id]));
  await dp.goto('/kabinet');
  await expect(dp.locator('#hint-title')).toHaveText('С чего начать: диспетчер');
  await shot(dp, 'help-05-pervyj-vhod-dispetcher');
  await d.close();
});
