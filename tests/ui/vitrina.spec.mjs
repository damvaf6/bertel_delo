// Задача 2.53: витрина «Дело: Экспертиза» (/ekspertiza) на телефоне 412×915 — разделы, кнопки ведут в кабинет
// (после входа — в нужный раздел), без внешних ресурсов. Номера +7 999 000-07-5x — только эта проверка.
import { test, expect } from '@playwright/test';
import { TEST_TOKEN } from '../helpers.mjs';

const CONTROL = process.env.UI_TEST_CONTROL_TOKEN || TEST_TOKEN;
const EXTRA_ORIGINS = (process.env.UI_ALLOWED_ORIGINS || '').split(',').filter(Boolean);

async function smsCode(request, phone) {
  const calls = (await (await request.get('/__test/fakes/sms/calls', { headers: { 'x-test-control': CONTROL } })).json()).calls;
  return calls.filter((c) => c.method === 'sendCode' && c.args.phone === phone).at(-1).args.code;
}

test('витрина: что это, как заказать, юрфирмам и банкам, экспертам; кнопки ведут в кабинет', async ({ page, baseURL }) => {
  const allowed = new Set([new URL(baseURL).origin, ...EXTRA_ORIGINS]);
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  page.on('request', (r) => { const u = new URL(r.url()); if (!['data:', 'blob:'].includes(u.protocol) && !allowed.has(u.origin)) problems.push(`внешний запрос: ${r.url()}`); });

  await page.goto('/ekspertiza');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Оценка и экспертиза');
  for (const h of ['Что можно заказать', 'Как заказать', 'Оплата и возврат', 'Юрфирмам и банкам', 'Экспертам и экспертным организациям', 'Частые вопросы']) {
    await expect(page.getByRole('heading', { name: h })).toBeVisible();
  }
  await expect(page.locator('#what li')).toHaveCount(8);
  // Цены «от … ₽» — из одного места (public/site-prices.js, решение Дамира 02.11.2026); «₽» не отрывается от суммы.
  const prices = { realty: 'от 4 000 ₽', land: 'от 8 000 ₽', vehicle: 'от 4 000 ₽', dtp: 'от 6 000 ₽', movable: 'от 3 500 ₽',
    goods: 'от 6 000 ₽', building: 'от 9 000 ₽', handwriting: 'от 15 000 ₽' };
  for (const [key, text] of Object.entries(prices)) {
    expect((await page.locator(`#what li[data-price="${key}"] .price`).textContent()).replace(/\u00a0/g, ' ')).toBe(`— ${text}`);
  }
  await expect(page.locator('#price-note')).toContainText('Точную цену по Вашей заявке назначает диспетчер');
  // Порядок оплаты и возврата — открыто на странице (сайт проверяет ЮKassa, ответ Дамира 30.10.2026).
  await expect(page.locator('#pay')).toContainText('вся сумма возвращается автоматически');
  await expect(page.getByText('Проверочная версия · только тестовые данные')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await page.screenshot({ path: 'test-results/screens/vitrina-01.png', fullPage: true });
  for (const id of ['cta-order', 'cta-how', 'cta-business', 'top-enter']) await expect(page.locator(`#${id}`)).toHaveAttribute('href', '/kabinet');

  await expect(page.locator('#cta-expert')).toHaveAttribute('href', '/kabinet#specialist');
  // «Не знаю, что нужно» → вход → сразу помощник (раздел, с которого пришли, не теряется).
  await page.locator('#cta-ask').click();
  await expect(page).toHaveURL(/\/\?next=%23assistant$/);
  await page.getByLabel('Номер мобильного телефона').fill('+79990000751');
  await page.getByRole('button', { name: 'Получить код' }).click();
  await expect(page.getByText('Код отправлен на +7 999 000-07-51')).toBeVisible();
  await page.getByLabel('Код из СМС').fill(await smsCode(page.request, '+79990000751'));
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/kabinet#assistant$/);
  await expect(page.locator('#assistant-view')).toBeVisible();

  // Вошедшему на витрине — «В кабинет», кнопки сразу открывают кабинет.
  await page.goto('/ekspertiza');
  await expect(page.locator('#top-enter')).toHaveText('В кабинет');
  await page.locator('#cta-order').click();
  await expect(page.getByRole('heading', { name: 'Мои заявки' })).toBeVisible();
  // Чужой адрес после входа не подставляется.
  await page.goto('/?next=https://example.com');
  await expect(page).toHaveURL(/\/kabinet$/);
  expect(problems, problems.join('\n')).toEqual([]);
});
