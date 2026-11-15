// Оценка доли — заявка (2.510) — телефон 412×915: заказчик выбирает «Доля в квартире или доме» и «Раздел имущества» и видит
// «Обратите внимание: не указано, как оценивать долю … решает суд»; выбирает способ — подсказка меняется, после обновления
// страницы значения на месте. Номер +7 999 000-54-04 — только здесь.
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

test('оценка доли (2.510): как оценивать, порядок пользования, подсказка в деле', async ({ page }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  await page.setViewportSize({ width: 412, height: 915 });
  await signIn(page, '+79990005404');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Доля: раздел' }, headers: H })).json()).order;
  await page.goto(`/kabinet#order=${o.id}`);
  const form = page.locator('#details-form');
  await expect(form).toBeVisible();
  await form.getByLabel('Для чего нужна оценка').selectOption({ label: 'Раздел имущества' });
  await form.getByLabel('Где находится объект').selectOption({ label: 'Москва' });
  await form.getByLabel('Что оцениваем').selectOption({ label: 'Доля в квартире или доме' });
  await form.getByLabel('Адрес объекта').fill('г. Москва, Тестовая ул., д. 1, кв. 3');
  await form.getByLabel('Размер доли (если оценивается доля)').fill('1/3');
  await form.getByRole('button', { name: 'Сохранить' }).click();

  const box = page.locator('#quote-box');
  await expect(box).toBeVisible();
  await expect(box.locator('[data-notice="share_ask"]')).toContainText('Для суда это решает суд');

  await form.getByLabel('Если доля — как оценивать').selectOption({ label: 'Рыночная стоимость доли (со скидкой на долю)' });
  await form.getByLabel('Если доля — порядок пользования').selectOption({ label: 'Не определён' });
  await form.getByLabel('Если доля — другие собственники и кто живёт').fill('брат — 2/3, живёт в квартире');
  await form.getByRole('button', { name: 'Сохранить' }).click();
  await expect(box.locator('[data-notice="share_market"]')).toContainText('Оценивается рыночная стоимость доли (1/3)');
  await expect(box.locator('[data-notice="share_ask"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await box.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/screens/dl01-dolya-zayavka.png', fullPage: false });

  await page.reload();
  await expect(form.getByLabel('Если доля — как оценивать')).toHaveValue('market');
  await expect(form.getByLabel('Если доля — порядок пользования')).toHaveValue('none');
  expect(problems).toEqual([]);
});
