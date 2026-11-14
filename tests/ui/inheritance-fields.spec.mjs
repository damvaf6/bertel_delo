// Оценка для наследства — заявка (2.500) — телефон 412×915: заказчик выбирает «Наследство, нотариус» и видит «Обратите
// внимание: нотариусу нужна стоимость на день открытия наследства…»; пишет дату и нотариуса — «дата оценки — день открытия
// наследства …». Номер +7 999 000-53-05 — только здесь.
import { test, expect } from '@playwright/test';
import { TEST_TOKEN } from '../helpers.mjs';

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

test('оценка для наследства (2.500): дата открытия наследства и подсказка в деле', async ({ page }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  await page.setViewportSize({ width: 412, height: 915 });
  await signIn(page, '+79990005305');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Квартира: наследство' }, headers: H })).json()).order;
  await page.goto(`/kabinet#order=${o.id}`);
  const form = page.locator('#details-form');
  await expect(form).toBeVisible();
  await form.getByLabel('Для чего нужна оценка').selectOption({ label: 'Наследство, нотариус' });
  await form.getByLabel('Где находится объект').selectOption({ label: 'Москва' });
  await form.getByLabel('Что оцениваем').selectOption({ label: 'Квартира' });
  await form.getByLabel('Адрес объекта').fill('г. Москва, Тестовая ул., д. 1, кв. 1');
  await form.getByRole('button', { name: 'Сохранить' }).click();

  const box = page.locator('#quote-box');
  await expect(box).toBeVisible();
  await expect(box.locator('[data-notice="inheritance_missing"]')).toContainText('нотариусу нужна стоимость на день открытия наследства');

  await form.getByLabel('Если наследство — дата открытия наследства (день смерти)').fill('03.06.2026');
  await form.getByLabel('Если наследство — нотариус или номер наследственного дела').fill('Нотариус г. Москвы Тестова Т. Т., дело № 1/2026');
  await form.getByRole('button', { name: 'Сохранить' }).click();
  await expect(box.locator('[data-notice="inheritance_ok"]')).toHaveText('Оценка для наследства: дата оценки — день открытия наследства 03.06.2026, а не день осмотра. Цены и аналоги — на эту дату.');
  await expect(box.locator('[data-notice="inheritance_missing"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await box.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/screens/nh01-nasledstvo-data.png', fullPage: false });

  // Неверная дата — не сохраняется.
  await form.getByLabel('Если наследство — дата открытия наследства (день смерти)').fill('2026-06-03');
  await form.getByRole('button', { name: 'Сохранить' }).click();
  await expect(box.locator('[data-notice="inheritance_ok"]')).toBeVisible();
  expect(problems).toEqual([]);
});
