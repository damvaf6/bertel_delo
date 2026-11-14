// Оценка транспорта — заявка (2.492) — телефон 412×915: заказчик в своей заявке заполняет двигатель (объём, мощность),
// коробку, привод, цвет, ДТП, владельца и балансовую стоимость — все необязательны; после «Сохранить» и обновления страницы
// значения на месте. Номер +7 999 000-52-04 — только здесь.
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

test('оценка транспорта (2.492): двигатель, коробка, привод, цвет, ДТП, владелец', async ({ page }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  await page.setViewportSize({ width: 412, height: 915 });
  await signIn(page, '+79990005204');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'vehicle', title: 'Машина: сведения' }, headers: H })).json()).order;
  await page.goto(`/kabinet#order=${o.id}`);
  const form = page.locator('#details-form');
  await expect(form).toBeVisible();
  await form.getByLabel('Вид транспорта').selectOption({ label: 'Легковой автомобиль' });
  await form.getByLabel('Марка и модель').fill('Тестовая Модель');
  await form.getByLabel('Объём двигателя, куб. см').fill('1998');
  await form.getByLabel('Мощность двигателя, л. с.').fill('150');
  await form.getByLabel('Коробка передач').selectOption({ label: 'Автоматическая' });
  await form.getByLabel('Привод').selectOption({ label: 'Полный' });
  await form.getByLabel('Цвет').fill('белый');
  await form.getByLabel('ДТП', { exact: true }).selectOption({ label: 'Был, отремонтирован' });
  await form.getByLabel('Владелец').selectOption({ label: 'Организация' });
  await form.getByLabel('Балансовая стоимость, руб.').fill('1250000');
  await form.getByRole('button', { name: 'Сохранить' }).click();
  await expect.poll(async () => (await (await page.request.get(`/api/orders/${o.id}`)).json()).order.fields?.book_value).toBe(1250000);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await form.getByLabel('Коробка передач').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/screens/vt05-zayavka-transport.png', fullPage: false });

  await page.reload();
  await expect(form.getByLabel('Привод')).toHaveValue('full');
  await expect(form.getByLabel('ДТП', { exact: true })).toHaveValue('repaired');
  await expect(form.getByLabel('Объём двигателя, куб. см')).toHaveValue('1998');
  expect(problems).toEqual([]);
});
