// Модуль «Переводы» (задача штаба 3f617197): заявка на перевод на телефоне 412×915 — три услуги, «Куда подаёте»,
// предупреждение «нужен нотариальный», расчёт по таблице цен; диспетчеру цена подставлена из расчёта.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DB_URL, TEST_TOKEN } from '../helpers.mjs';

const CONTROL = process.env.UI_TEST_CONTROL_TOKEN || TEST_TOKEN;
const H = { 'x-delo-request': '1' };
const inDays = (n) => new Date(Date.now() + 3 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);

async function signIn(page, phone) {
  expect((await page.request.post('/api/auth/code', { data: { phone }, headers: H })).status()).toBe(200);
  const r = await page.request.get('/__test/fakes/sms/calls', { headers: { 'x-test-control': CONTROL } });
  const code = (await r.json()).calls.filter((c) => c.method === 'sendCode' && c.args.phone === phone).at(-1).args.code;
  const v = await page.request.post('/api/auth/verify', { data: { phone, code }, headers: H });
  expect(v.status()).toBe(200);
  return (await v.json()).user;
}

async function shot(page, name) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), `${name}: страница шире экрана`).toBeLessThanOrEqual(412);
  await page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: true });
}

test('заявка на перевод: «Куда подаёте», предупреждение, расчёт по таблице цен; диспетчеру цена подставлена', async ({ page, browser, baseURL }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page, '+79990000961');
  await page.goto('/kabinet');
  await page.locator('#new-order').getByLabel('Услуга').selectOption({ label: 'Перевод без нотариуса (с сертификатом платформы)' });
  await page.getByRole('button', { name: 'Создать заявку' }).click();
  await expect(page.locator('#order-status')).toHaveText('Новая');
  await expect(page.locator('#quote-box')).toBeHidden();

  await page.getByLabel('Куда подаёте перевод').selectOption({ label: 'МВД, миграционная служба' });
  await page.getByLabel('Язык (кроме русского)').selectOption({ label: 'Английский' });
  await page.getByLabel('Направление перевода').selectOption({ label: 'С языка на русский' });
  await page.getByLabel('Что переводим').selectOption({ label: 'Паспорт, удостоверение личности' });
  await page.getByLabel('Документов, шт.').fill('1');
  await page.getByLabel('Страниц всего').fill('1');
  await page.getByLabel('Срочность').selectOption({ label: '1–2 дня' });
  await page.getByLabel('Бумажный экземпляр').selectOption({ label: 'Не нужен, только PDF' });
  await page.getByLabel('Срок: результат нужен к').fill(inDays(5));
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.locator('#details-msg')).toHaveText('Сохранено');

  await expect(page.locator('#quote-box')).toBeVisible();
  await expect(page.locator('[data-notice="notary_needed"]')).toContainText('только нотариальный перевод');
  await expect(page.locator('#quote-total')).toHaveText('Итого по таблице цен: 750 ₽');
  await expect(page.locator('#quote-lines')).toContainText('Сертификат платформы');
  await page.locator('#quote-box').scrollIntoViewIfNeeded();
  await shot(page, 'perevod-01-bez-notariusa-preduprezhdenie');

  // Клиент послушался подсказки — нотариальный на бумаге: предупреждения нет, нотариус отдельной строкой.
  await page.locator('#d-service').selectOption({ label: 'Нотариальный перевод (бумага)' });
  await page.getByLabel('Срочность').selectOption({ label: '3–5 рабочих дней' });
  await page.getByLabel('Как передадите оригинал').selectOption({ label: 'Курьером' });
  await page.getByLabel('Как получить бумажный перевод').selectOption({ label: 'Заберу сам' });
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.locator('#details-msg')).toHaveText('Сохранено');
  await expect(page.locator('[data-notice]')).toHaveCount(0);
  await expect(page.locator('#quote-total')).toHaveText('Итого по таблице цен: 1 550 ₽');
  await expect(page.locator('#quote-lines')).toContainText('Нотариус — подпись переводчика');
  await expect(page.locator('#quote-note')).toContainText('Тарифы нотариуса и доставка (550 ₽) — без наценки платформы');
  await page.locator('#quote-box').scrollIntoViewIfNeeded();
  await shot(page, 'perevod-02-notarialnyj-raschet');

  await page.getByRole('button', { name: 'Отправить заявку' }).click();
  await expect(page.locator('#order-status')).toHaveText('Подбор исполнителя');
  const id = new URL(page.url()).hash.match(/order=([\w-]+)/)[1];

  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' });
  const dp = await ctx.newPage();
  dp.on('pageerror', (e) => errors.push(e.message));
  const disp = await signIn(dp, '+79990000962');
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try { await c.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]); } finally { await c.end(); }
  await dp.goto(`/kabinet#order=${id}`);
  await expect(dp.locator('#price')).toHaveValue('1550');
  await expect(dp.locator('#price-quoted')).toContainText('550 ₽ — тарифы нотариуса и доставка');
  await dp.locator('#price-form').scrollIntoViewIfNeeded();
  await shot(dp, 'perevod-03-dispetcher-cena');
  // Деньги перевода (2а.2): 80/20 — только от услуг (1 000 ₽), нотариус 550 ₽ — без вознаграждения.
  await dp.getByRole('button', { name: 'Назначить цену' }).click();
  const facts = dp.locator('#money-facts');
  await expect(facts).toContainText('Нотариус и доставка');
  await expect(facts).toContainText('550 ₽ — по тарифам, без вознаграждения платформы');
  await expect(facts).toContainText(/Исполнителю \(80% от услуг\)\s*800 ₽/);
  await expect(facts).toContainText(/Платформе \(20% от услуг\)\s*200 ₽/);
  await facts.scrollIntoViewIfNeeded();
  await shot(dp, 'perevod-04-dispetcher-dengi');
  await ctx.close();

  await page.reload();
  await expect(page.locator('#money-facts')).toContainText('550 ₽ — по тарифам, без вознаграждения платформы');
  await expect(page.locator('#money-facts')).not.toContainText('Платформе');
  await page.locator('#money-facts').scrollIntoViewIfNeeded();
  await shot(page, 'perevod-05-zakazchik-oplata');
  expect(errors).toEqual([]);
});
