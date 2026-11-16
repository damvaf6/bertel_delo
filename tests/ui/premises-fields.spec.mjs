// Нежилое помещение — заявка (2.519) — телефон 412×915: заказчик выбирает «Нежилое помещение» и видит «Обратите внимание:
// не указано, сдаётся ли помещение»; отмечает «Сдаётся целиком» и арендную плату — подсказка о доходном подходе и договоре
// аренды; после обновления страницы значения на месте. Номер +7 999 000-55-74 — только здесь.
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

test('нежилое помещение (2.519): назначение, аренда, вход, подсказка в деле', async ({ page }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  await page.setViewportSize({ width: 412, height: 915 });
  await signIn(page, '+79990005574');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Офис для банка' }, headers: H })).json()).order;
  await page.goto(`/kabinet#order=${o.id}`);
  const form = page.locator('#details-form');
  await expect(form).toBeVisible();
  await form.getByLabel('Для чего нужна оценка').selectOption({ label: 'Ипотека, залог, банк' });
  await form.getByLabel('Где находится объект').selectOption({ label: 'Москва' });
  await form.getByLabel('Что оцениваем').selectOption({ label: 'Нежилое помещение' });
  await form.getByLabel('Адрес объекта').fill('г. Москва, Тестовая ул., д. 5, пом. I');
  await form.getByRole('button', { name: 'Сохранить' }).click();

  const box = page.locator('#quote-box');
  await expect(box).toBeVisible();
  await expect(box.locator('[data-notice="premises_ask"]')).toContainText('сдаётся ли помещение в аренду');

  await form.getByLabel('Если нежилое — назначение').selectOption({ label: 'Офис' });
  await form.getByLabel('Если нежилое — сдаётся ли в аренду').selectOption({ label: 'Сдаётся целиком' });
  await form.getByLabel('Если сдаётся — арендная плата в месяц, руб.').fill('180000');
  await form.getByLabel('Если нежилое — вход').selectOption({ label: 'Отдельный, с улицы' });
  await form.getByRole('button', { name: 'Сохранить' }).click();
  await expect(box.locator('[data-notice="premises_lease"]')).toContainText('арендная плата — 180 000 руб. в месяц');
  await expect(box.locator('[data-notice="premises_ask"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await box.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/screens/np01-nezhiloe-zayavka.png', fullPage: false });

  await page.reload();
  await expect(form.getByLabel('Если нежилое — сдаётся ли в аренду')).toHaveValue('full');
  await expect(form.getByLabel('Если сдаётся — арендная плата в месяц, руб.')).toHaveValue('180000');
  expect(problems).toEqual([]);
});
