// Задача штаба 40317197-…-8127: экраны «Дела» на дизайн-системе v2 — светлая и тёмная тема (по настройке телефона и
// кнопкой в шапке, выбор запоминается), «меньше движения». Телефон 412×915. Номер +7 999 000-09-99 — только эта проверка.
import { test, expect } from '@playwright/test';
import { TEST_TOKEN } from '../helpers.mjs';

const CONTROL = process.env.UI_TEST_CONTROL_TOKEN || TEST_TOKEN;

// Код читается, когда сервер его уже отправил: после нажатия «Получить код» запрос может ещё идти (на большой базе
// полного прогона — дольше), поэтому ждём, а не берём список сразу.
async function smsCode(request, phone) {
  let code;
  await expect.poll(async () => {
    const calls = (await (await request.get('/__test/fakes/sms/calls', { headers: { 'x-test-control': CONTROL } })).json()).calls;
    code = calls.filter((c) => c.method === 'sendCode' && c.args.phone === phone).at(-1)?.args.code;
    return code;
  }, { message: 'код из СМС не пришёл' }).toBeTruthy();
  return code;
}
const bg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test('тема: светлая по умолчанию, кнопка в шапке включает тёмную и запоминает выбор; кабинет в тёмной теме', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const toggle = page.locator('header.top #theme-toggle');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-label', 'Тёмная тема');
  expect(await bg(page)).toBe('rgb(244, 245, 247)');
  await page.screenshot({ path: 'test-results/screens/theme-01-vhod-svetlaya.png', fullPage: true });

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await bg(page)).toBe('rgb(11, 17, 29)');
  await page.screenshot({ path: 'test-results/screens/theme-02-vhod-temnaya.png', fullPage: true });

  // Выбор запомнился: после входа кабинет — тоже в тёмной теме, без горизонтальной прокрутки.
  await page.getByLabel('Номер мобильного телефона').fill('+79990000999');
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код из СМС').fill(await smsCode(page.request, '+79990000999'));
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/kabinet/);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Выйти' })).toBeVisible();
  await expect(page.locator('#theme-toggle')).toHaveAttribute('aria-label', 'Светлая тема');
  expect(await bg(page)).toBe('rgb(11, 17, 29)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await page.screenshot({ path: 'test-results/screens/theme-03-kabinet-temnaya.png', fullPage: true });

  await page.locator('#theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await bg(page)).toBe('rgb(244, 245, 247)');
  await page.screenshot({ path: 'test-results/screens/theme-04-kabinet-svetlaya.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('тема: без выбора — как в настройке телефона; «меньше движения» выключает анимацию', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('/ekspertiza');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
  expect(await bg(page)).toBe('rgb(11, 17, 29)');
  await expect(page.locator('#theme-toggle')).toHaveAttribute('aria-label', 'Светлая тема');
  const move = await page.evaluate(() => getComputedStyle(document.querySelector('#theme-toggle')).transitionDuration);
  expect(move.split(',').every((d) => parseFloat(d) === 0)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await page.screenshot({ path: 'test-results/screens/theme-05-vitrina-temnaya.png', fullPage: true });
});
