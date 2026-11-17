// Жилой дом — заявка (2.529) — телефон 412×915: заказчик выбирает «Жилой дом» и видит «Обратите внимание: не указано,
// оформлен ли участок под домом»; отмечает «Оформлен в собственность» без кадастрового номера участка — подсказки об
// оценке дома с участком и о номере участка; вписывает номер — вторая подсказка уходит; после обновления страницы значения
// на месте. Номер +7 999 000-59-04 — только здесь.
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

test('жилой дом (2.529): материал стен, участок, газ, подсказка в деле', async ({ page }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  await page.setViewportSize({ width: 412, height: 915 });
  await signIn(page, '+79990005904');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Дом для банка' }, headers: H })).json()).order;
  await page.goto(`/kabinet#order=${o.id}`);
  const form = page.locator('#details-form');
  await expect(form).toBeVisible();
  await form.getByLabel('Для чего нужна оценка').selectOption({ label: 'Ипотека, залог, банк' });
  await form.getByLabel('Где находится объект').selectOption({ label: 'Московская область' });
  await form.getByLabel('Что оцениваем').selectOption({ label: 'Жилой дом' });
  await form.getByLabel('Адрес объекта').fill('Московская обл., д. Тестовая, ул. Садовая, д. 7');
  await form.getByRole('button', { name: 'Сохранить' }).click();

  const box = page.locator('#quote-box');
  await expect(box).toBeVisible();
  await expect(box.locator('[data-notice="house_land_ask"]')).toContainText('оформлен ли участок под домом');

  await form.getByLabel('Если жилой дом — материал стен').selectOption({ label: 'Кирпич, блоки' });
  await form.getByLabel('Если жилой дом — участок под домом').selectOption({ label: 'Оформлен в собственность' });
  await form.getByLabel('Если жилой дом — площадь участка, сот.').fill('12');
  await form.getByLabel('Если жилой дом — газ').selectOption({ label: 'Магистральный' });
  await form.getByLabel('Если жилой дом — для круглогодичного проживания').selectOption({ label: 'Да, отапливается зимой' });
  await form.getByRole('button', { name: 'Сохранить' }).click();
  await expect(box.locator('[data-notice="house_land_own"]')).toContainText('единый объект');
  await expect(box.locator('[data-notice="house_land_cad"]')).toContainText('кадастровый номер участка');
  await expect(box.locator('[data-notice="house_land_ask"]')).toHaveCount(0);

  await form.getByLabel('Если жилой дом — кадастровый номер участка').fill('50:20:0010101:55');
  await form.getByRole('button', { name: 'Сохранить' }).click();
  await expect(box.locator('[data-notice="house_land_cad"]')).toHaveCount(0);
  await expect(box.locator('[data-notice="house_land_own"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await box.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/screens/hs01-dom-zayavka.png', fullPage: false });

  await page.reload();
  await expect(form.getByLabel('Если жилой дом — участок под домом')).toHaveValue('own');
  await expect(form.getByLabel('Если жилой дом — площадь участка, сот.')).toHaveValue('12');
  await expect(form.getByLabel('Если жилой дом — кадастровый номер участка')).toHaveValue('50:20:0010101:55');
  expect(problems).toEqual([]);
});
