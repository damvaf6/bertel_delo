// Товароведческая — заявка (2.480) — телефон 412×915: заказчик в своей заявке заполняет «Что за товар», модель,
// недостатки, когда обнаружен, гарантийный срок, кто проверял — и видит «Обратите внимание: недостаток обнаружен … — в
// гарантийный срок (…)»; гарантия 1 месяц — «после гарантийного срока». Номер +7 999 000-48-03 — только здесь.
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

test('товароведческая (2.480): новые поля заявки и подсказка о гарантии', async ({ page }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  await page.setViewportSize({ width: 412, height: 915 });
  await signIn(page, '+79990004803');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'goods', title: 'Ноутбук: гарантия' }, headers: H })).json()).order;
  await page.goto(`/kabinet#order=${o.id}`);
  const form = page.locator('#details-form');
  await expect(form).toBeVisible();
  await form.getByLabel('Какой товар и что случилось').fill('Ноутбук перестал включаться через месяц');
  await form.getByLabel('Какие вопросы поставить эксперту').fill('Есть ли недостаток? Производственный или эксплуатационный?');
  await form.getByLabel('Когда и где куплен, цена по чеку').fill('12.03.2026, магазин, 54 990 ₽');
  await form.getByLabel('Что за товар').selectOption({ label: 'Телефон, планшет, ноутбук, компьютер' });
  await form.getByLabel('Модель, артикул, серийный номер или IMEI').fill('Тестовый ноутбук X1, s/n TEST0001');
  await form.getByLabel('Какие недостатки').fill('не включается\nтрещина на крышке');
  await form.getByLabel('Когда обнаружен недостаток').fill('20.04.2026');
  await form.getByLabel('Гарантийный срок, месяцев').fill('12');
  await form.getByLabel('Проверял ли товар продавец или сервис').selectOption({ label: 'Да — сказали, что виноват покупатель' });
  await form.getByRole('button', { name: 'Сохранить' }).click();

  const box = page.locator('#quote-box');
  await expect(box).toBeVisible();
  await expect(box.locator('h2')).toHaveText('Обратите внимание');
  await expect(box.locator('[data-notice="warranty_in"]')).toHaveText('Недостаток обнаружен 20.04.2026 — в гарантийный срок (гарантия 12 мес. с 12.03.2026 — до 12.03.2027).');
  await expect(box.locator('#quote-note')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await box.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/screens/gw01-tovar-garantiya.png', fullPage: false });

  // Гарантия 1 месяц — «после гарантийного срока».
  await form.getByLabel('Гарантийный срок, месяцев').fill('1');
  await form.getByRole('button', { name: 'Сохранить' }).click();
  await expect(box.locator('[data-notice="warranty_out"]')).toContainText('после гарантийного срока (гарантия 1 мес. с 12.03.2026 — до 12.04.2026)');
  expect(problems).toEqual([]);
});
