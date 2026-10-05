// Задача 2.54: «Сообщить о проблеме» внутри кабинета — запись в журнал, уведомление диспетчеру, раздел «Проблемы»
// (только служебным), отметка «Разобрано». Телефон 412×915. Номера +7 999 000-07-6x — только эта проверка.
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
  const user = (await r.json()).user;
  for (const hint of ['customer', 'expert', 'head', 'dispatcher']) await page.request.post('/api/me/hints', { data: { hint }, headers: h });
  return user;
}

async function shot(page, name) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), `${name}: шире экрана`).toBeLessThanOrEqual(412);
  await page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: true });
}

test('сообщить о проблеме: заказчик пишет из кабинета, диспетчер видит в журнале и разбирает', async ({ page, browser, baseURL }) => {
  await signIn(page, '+79990000761');
  await page.goto('/kabinet#help');
  await expect(page.getByRole('heading', { name: 'Как работать', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Сообщить о проблеме' }).click();
  await page.getByLabel('Опишите проблему').fill('Не понимаю, где кнопка оплаты');
  await shot(page, 'problem-01-forma');
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page.locator('#report-done')).toContainText('Спасибо! Сообщение №');
  await expect(page.locator('#report-form')).toBeHidden();
  // Заказчику раздела «Проблемы» нет.
  await expect(page.getByRole('link', { name: 'Проблемы' })).toBeHidden();

  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' });
  const dp = await ctx.newPage();
  const d = await signIn(dp, '+79990000762');
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try { await c.query("update users set platform_role = 'dispatcher' where id = $1", [d.id]); } finally { await c.end(); }
  // Уведомление пришло только после назначения роли — сообщим ещё раз от заказчика.
  await page.getByRole('button', { name: 'Сообщить о проблеме' }).click();
  await page.getByLabel('Опишите проблему').fill('Второй вопрос: не вижу документы');
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page.locator('#report-done')).toContainText('Спасибо!');

  await dp.goto('/kabinet#notifications');
  await dp.locator('#notifications li').filter({ hasText: 'Новое сообщение о проблеме' }).first().getByRole('button').first().click();
  await expect(dp).toHaveURL(/#problems$/);
  const item = dp.locator('#problems li').filter({ hasText: 'Не понимаю, где кнопка оплаты' });
  await expect(item).toContainText('новое');
  await expect(item.getByRole('link', { name: 'Открыть место в кабинете' })).toHaveAttribute('href', '#help');
  await expect(item).toContainText('экран 412×915');
  await shot(dp, 'problem-02-zhurnal');
  await item.getByRole('textbox').fill('Показали кнопку «Оплатить» в заявке');
  await item.getByRole('button', { name: 'Разобрано' }).click();
  await expect(dp.locator('#problems li').filter({ hasText: 'Не понимаю, где кнопка оплаты' })).toContainText('разобрано');
  await expect(dp.locator('#problems-count')).toHaveText('Не разобрано: 1');
  await shot(dp, 'problem-03-razobrano');
  await ctx.close();
});
