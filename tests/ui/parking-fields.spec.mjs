// Машино-место или кладовая — заявка (2.549) — телефон 412×915: заказчик выбирает «Машино-место или кладовая», видит
// «Обратите внимание: машино-место — отдельный объект» и «не указан номер места»; отмечает долю в праве на паркинг — подсказка
// о доле; вписывает номер и размер доли — подсказки «не указан» уходят; после обновления страницы значения на месте.
// Номер +7 999 000-60-14 — только здесь.
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

test('машино-место (2.549): вид, паркинг, уровень, номер, доля в паркинге, подсказка в деле', async ({ page }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  await page.setViewportSize({ width: 412, height: 915 });
  await signIn(page, '+79990006014');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Машино-место для ипотеки' }, headers: H })).json()).order;
  await page.goto(`/kabinet#order=${o.id}`);
  const form = page.locator('#details-form');
  await expect(form).toBeVisible();
  await form.getByLabel('Для чего нужна оценка').selectOption({ label: 'Ипотека, залог, банк' });
  await form.getByLabel('Где находится объект').selectOption({ label: 'Москва' });
  await form.getByLabel('Что оцениваем').selectOption({ label: 'Машино-место или кладовая' });
  await form.getByLabel('Адрес объекта').fill('г. Москва, ул. Тестовая, д. 5, машино-место 17');
  await form.getByRole('button', { name: 'Сохранить' }).click();

  const box = page.locator('#quote-box');
  await expect(box).toBeVisible();
  await expect(box.locator('[data-notice="parking_object"]')).toContainText('отдельный объект недвижимости');
  await expect(box.locator('[data-notice="parking_number"]')).toContainText('Не указан номер места');

  await form.getByLabel('Если машино-место или кладовая — что именно').selectOption({ label: 'Машино-место' });
  await form.getByLabel('Если машино-место или кладовая — паркинг').selectOption({ label: 'Подземный' });
  await form.getByLabel('Если машино-место или кладовая — уровень').fill('−2');
  await form.getByLabel('Если машино-место или кладовая — как оформлено').selectOption({ label: 'Доля в праве на паркинг' });
  await form.getByLabel('Если машино-место или кладовая — вместе с квартирой').selectOption({ label: 'Да, с квартирой в этом доме' });
  await form.getByRole('button', { name: 'Сохранить' }).click();
  await expect(box.locator('[data-notice="parking_share"]')).toContainText('доля в праве на паркинг, а не машино-место');
  await expect(box.locator('[data-notice="parking_share_size"]')).toBeVisible();
  await expect(box.locator('[data-notice="parking_flat"]')).toContainText('вместе с квартирой');

  await form.getByLabel('Если машино-место или кладовая — номер места').fill('17');
  await form.getByLabel('Если доля в паркинге — размер доли').fill('1/120');
  await form.getByRole('button', { name: 'Сохранить' }).click();
  await expect(box.locator('[data-notice="parking_number"]')).toHaveCount(0);
  await expect(box.locator('[data-notice="parking_share_size"]')).toHaveCount(0);
  await expect(box.locator('[data-notice="parking_share"]')).toContainText('(1/120)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await box.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/screens/pk01-parking-zayavka.png', fullPage: false });

  await page.reload();
  await expect(form.getByLabel('Если машино-место или кладовая — номер места')).toHaveValue('17');
  await expect(form.getByLabel('Если доля в паркинге — размер доли')).toHaveValue('1/120');
  await expect(form.getByLabel('Если машино-место или кладовая — уровень')).toHaveValue('−2');
  expect(problems).toEqual([]);
});
