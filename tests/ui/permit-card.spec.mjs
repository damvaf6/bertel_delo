// Карточка допуска исполнителя (задача штаба 3f817197-…-81b2) — телефон 412×915: администратор выдаёт карточку (срок,
// сверка документов), исполнитель видит её с QR-кодом и кодом проверки, любой открывает страницу проверки без входа;
// администратор отзывает с причиной — страница показывает «отозвана» и общую причину, без пояснения платформы.
// Номера +7 999 000-78-xx — только здесь.
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
function phoneContext(browser, baseURL) {
  return browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU',
    storageState: { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'delo.folds', value: 'open' }] }] } });
}
async function shot(page, name) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, `${name}: страница шире экрана`).toBeLessThanOrEqual(412);
  await page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: true });
}

test('карточка допуска: выдача, QR у исполнителя, страница проверки, отзыв с причиной', async ({ page, browser, baseURL }) => {
  const problems = [];
  const watch = (p) => {
    p.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
    p.on('request', (r) => { const u = new URL(r.url()); if (u.protocol.startsWith('http') && u.origin !== new URL(baseURL).origin && !process.env.UI_ALLOWED_ORIGINS?.includes(u.origin)) problems.push(`внешний запрос: ${r.url()}`); });
  };
  watch(page);
  const admin = await signIn(page, '+79990007801');
  await db((c) => c.query("update users set platform_role = 'admin' where id = $1", [admin.id]));
  const sctx = await phoneContext(browser, baseURL);
  const sp = await sctx.newPage();
  watch(sp);
  const spec = await signIn(sp, '+79990007802');
  await db(async (c) => {
    await c.query("update users set full_name = 'Тестова Карточка Ивановна' where id = $1", [spec.id]);
    await c.query("insert into specialists (user_id, tax_status) values ($1, 'self_employed') on conflict do nothing", [spec.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [spec.id]);
  });

  // Администратор: выдать карточку.
  await page.goto('/kabinet#admin');
  await page.getByLabel('Номер телефона пользователя').fill('8 999 000-78-02');
  await page.getByRole('button', { name: 'Найти' }).click();
  await expect(page.locator('#admin-specialist-state')).toContainText('Этот человек — специалист');
  await expect(page.getByRole('button', { name: 'Выдать карточку' })).toBeVisible();
  await page.getByLabel('Документы об образовании и квалификации сверены по копиям').check();
  await page.getByRole('button', { name: 'Выдать карточку' }).click();
  await expect(page.getByText('Карточка допуска выдана')).toBeVisible();
  await expect(page.locator('#sp-card-state')).toContainText('Карточка действует');
  await expect(page.locator('#sp-card-facts')).toContainText('пройдено проверок: 3 из 4');
  await page.locator('#sp-card-box').scrollIntoViewIfNeeded();
  await shot(page, 'dopusk-01-upravlenie-vydana');

  // Исполнитель: своя карточка с QR.
  await sp.goto('/kabinet#specialist');
  await expect(sp.locator('#mycard-state')).toHaveText('Карточка действует');
  await expect(sp.locator('#mycard-number')).toContainText(/Д-\d{4}-\d{6}/);
  await expect(sp.locator('#mycard-level')).toHaveText('Пройдено проверок: 3 из 4');
  await expect(sp.locator('#mycard-checks li[data-ok="false"]')).toContainText('Подпись КЭП');
  await expect(sp.locator('#mycard-qr')).toBeVisible();
  expect(await sp.locator('#mycard-qr').evaluate((img) => img.naturalWidth)).toBeGreaterThan(100);
  const code = (await sp.locator('#mycard-code').textContent()).trim();
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const url = await sp.locator('#mycard-url').getAttribute('href');
  expect(url).toContain('/dopusk.html#');
  const dl = sp.waitForEvent('download');
  await sp.getByRole('button', { name: 'Скачать карточку (Word, с QR-кодом)' }).click();
  expect((await dl).suggestedFilename()).toMatch(/^Карточка допуска Д-.*\.docx$/);
  await sp.locator('#mycard-box').scrollIntoViewIfNeeded();
  await shot(sp, 'dopusk-02-specialist-kartochka');

  // Любой без входа: страница проверки по ссылке из QR и по коду вручную.
  const actx = await phoneContext(browser, baseURL);
  const anon = await actx.newPage();
  watch(anon);
  await anon.goto(new URL(url).pathname + new URL(url).hash);
  await expect(anon.locator('#state')).toHaveText('Карточка действует');
  await expect(anon.locator('#name')).toHaveText('Тестова Карточка Ивановна');
  await expect(anon.locator('#services')).toContainText('Экспертиза');
  await expect(anon.locator('#level')).toHaveText('Пройдено проверок: 3 из 4');
  await expect(anon.locator('body')).not.toContainText('7802');
  await shot(anon, 'dopusk-03-stranica-proverki');
  await anon.goto('/dopusk.html');
  await anon.getByLabel('Код с карточки').fill('AAAA-AAAA-AAAA');
  await anon.getByRole('button', { name: 'Проверить' }).click();
  await expect(anon.locator('#code-msg')).toContainText('не найдена');

  // Администратор: отозвать с причиной.
  await page.getByLabel('Причина отзыва').selectOption('rules');
  await page.getByLabel('Пояснение (видит только платформа)').fill('Тестовое пояснение для платформы');
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Отозвать карточку' }).click();
  await expect(page.getByText('Карточка отозвана', { exact: true })).toBeVisible();
  await expect(page.locator('#sp-card-state')).toContainText('отозвана');
  await expect(page.locator('#sp-card-history')).toContainText('Нарушение правил платформы: Тестовое пояснение для платформы');
  await expect(page.getByRole('button', { name: 'Выдать новую карточку' })).toBeVisible();
  await page.locator('#sp-card-box').scrollIntoViewIfNeeded();
  await shot(page, 'dopusk-04-upravlenie-otozvana');

  await anon.goto(new URL(url).pathname + new URL(url).hash);
  await expect(anon.locator('#state')).toContainText('Карточка отозвана');
  await expect(anon.locator('#state')).toContainText('по решению платформы');
  await expect(anon.locator('#services-box')).toBeHidden();
  await expect(anon.locator('body')).not.toContainText('Тестовое пояснение');
  await shot(anon, 'dopusk-05-stranica-otozvana');

  await sp.reload();
  await expect(sp.locator('#mycard-state')).toContainText('Карточка отозвана');
  await expect(sp.locator('#mycard-share')).toBeHidden();
  await expect(sp.locator('body')).not.toContainText('Тестовое пояснение');
  await shot(sp, 'dopusk-06-specialist-otozvana');
  expect(problems).toEqual([]);
  await sctx.close();
  await actx.close();
});
