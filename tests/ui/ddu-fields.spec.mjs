// Квартира в новостройке — права по ДДУ — заявка (2.539) — телефон 412×915: заказчик выбирает «Квартира в новостройке (права
// по ДДУ)» и видит «Обратите внимание: оценивается право требования» и «не указаны номер или дата ДДУ»; вписывает договор,
// застройщика, корпус, проектную площадь, срок передачи и цену — вторая подсказка уходит; после обновления страницы значения
// на месте. Номер +7 999 000-59-14 — только здесь.
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

test('квартира в новостройке (2.539): номер и дата ДДУ, застройщик, проектная площадь, подсказка в деле', async ({ page }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  await page.setViewportSize({ width: 412, height: 915 });
  await signIn(page, '+79990005914');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Новостройка для ипотеки' }, headers: H })).json()).order;
  await page.goto(`/kabinet#order=${o.id}`);
  const form = page.locator('#details-form');
  await expect(form).toBeVisible();
  await form.getByLabel('Для чего нужна оценка').selectOption({ label: 'Ипотека, залог, банк' });
  await form.getByLabel('Где находится объект').selectOption({ label: 'Москва' });
  await form.getByLabel('Что оцениваем').selectOption({ label: 'Квартира в новостройке (права по ДДУ)' });
  await form.getByLabel('Адрес объекта').fill('г. Москва, ЖК «Тестовый», корп. 3 (строительный адрес)');
  await form.getByRole('button', { name: 'Сохранить' }).click();

  const box = page.locator('#quote-box');
  await expect(box).toBeVisible();
  await expect(box.locator('[data-notice="ddu_right"]')).toContainText('право требования по ДДУ');
  await expect(box.locator('[data-notice="ddu_doc"]')).toContainText('номер или дата ДДУ');

  await form.getByLabel('Если новостройка — номер ДДУ').fill('ЖК-12/3-145');
  await form.getByLabel('Если новостройка — дата ДДУ').fill('14.03.2025');
  await form.getByLabel('Если новостройка — застройщик').fill('ООО «СЗ Тестовый»');
  await form.getByLabel('Если новостройка — ЖК, корпус, секция').fill('ЖК «Тестовый», корп. 3, секция 2');
  await form.getByLabel('Если новостройка — условный номер квартиры').fill('145');
  await form.getByLabel('Если новостройка — проектная площадь, кв. м').fill('41,3');
  await form.getByLabel('Если новостройка — срок передачи квартиры по договору').fill('IV квартал 2027');
  await form.getByLabel('Если новостройка — цена по договору, руб.').fill('9850000');
  await form.getByRole('button', { name: 'Сохранить' }).click();
  await expect(box.locator('[data-notice="ddu_doc"]')).toHaveCount(0);
  await expect(box.locator('[data-notice="ddu_right"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await box.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/screens/du01-ddu-zayavka.png', fullPage: false });

  await page.reload();
  await expect(form.getByLabel('Если новостройка — номер ДДУ')).toHaveValue('ЖК-12/3-145');
  await expect(form.getByLabel('Если новостройка — дата ДДУ')).toHaveValue('14.03.2025');
  await expect(form.getByLabel('Если новостройка — проектная площадь, кв. м')).toHaveValue('41.3');
  expect(problems).toEqual([]);
});
