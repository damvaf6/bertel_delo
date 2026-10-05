// Проверка на адресе контура stage после выкладки (телефон 412×915). Площадка закрыта от посторонних (решение Дамира
// 02.10.2026, вариант А): браузер подставляет IAM-токен технического пользователя только для адреса площадки, служебный
// вход тестовыми номерами — по ключу STAGE_LOGIN_KEY. Скриншоты — test-results/screens/stage-*.png.
import { test as base, expect, request as pwRequest } from '@playwright/test';

const TOKEN = process.env.STAGE_INVOKE_TOKEN;
const LOGIN_KEY = process.env.STAGE_LOGIN_KEY;
if (!TOKEN || !LOGIN_KEY) throw new Error('STAGE_INVOKE_TOKEN и STAGE_LOGIN_KEY — ключи прогона (workflow Deploy core)');
const AUTH = { authorization: `Bearer ${TOKEN}` };

// Токен уходит только на адрес площадки (не в хранилище файлов и никуда больше).
const test = base.extend({
  context: async ({ context, baseURL }, use) => {
    const origin = new URL(baseURL).origin;
    await context.route((u) => u.origin === origin, async (route) => route.continue({ headers: { ...(await route.request().allHeaders()), ...AUTH } }));
    await use(context);
  },
});

// Ошибки JavaScript и запросы к чужим адресам на странице.
function watch(page, baseURL) {
  const problems = [];
  const origin = new URL(baseURL).origin;
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['data:', 'blob:'].includes(u.protocol) && u.origin !== origin) problems.push(`внешний запрос: ${r.url()}`);
  });
  return problems;
}

test('stage: без ключа площадка закрыта', async ({ baseURL }) => {
  const anon = await pwRequest.newContext({ baseURL });
  for (const path of ['/', '/api/health', '/kabinet']) {
    const r = await anon.get(path, { maxRedirects: 0 });
    expect([401, 403], `${path}: ${r.status()}`).toContain(r.status());
  }
  await anon.dispose();
});

test('stage: страница входа на телефоне', async ({ page, baseURL }) => {
  const problems = watch(page, baseURL);
  const health = await page.request.get('/api/health', { headers: AUTH });
  expect(await health.json()).toEqual({ ok: true, test_data: true });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Вход' })).toBeVisible();
  await expect(page.getByText('Проверочная версия · только тестовые данные')).toBeVisible();
  await expect(page.getByLabel('Номер мобильного телефона')).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, 'страница шире экрана').toBeLessThanOrEqual(412);
  await page.screenshot({ path: 'test-results/screens/stage-vhod.png', fullPage: true });
  expect(problems, problems.join('\n')).toEqual([]);
});

test('stage: служебный вход — только тестовые номера и только с ключом', async ({ page, baseURL }) => {
  const problems = watch(page, baseURL);
  const post = (data, key = LOGIN_KEY) => page.request.post('/__stage/login', {
    data, headers: { ...AUTH, 'x-delo-request': '1', ...(key ? { 'x-stage-login': key } : {}) },
  });
  expect((await post({ phone: '+79990009001' }, 'wrong-key-0123456789abcdef0123456789')).status()).toBe(404);
  expect((await post({ phone: '+79161234567' })).status()).toBe(403);
  const r = await post({ phone: '+79990009001' });
  expect(r.status()).toBe(200);
  expect((await r.json()).user.phone).toBe('+79990009001');

  await page.goto('/kabinet');
  await expect(page.getByRole('heading', { name: 'Мои заявки' })).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, 'страница шире экрана').toBeLessThanOrEqual(412);
  await page.screenshot({ path: 'test-results/screens/stage-kabinet.png', fullPage: true });
  expect(problems, problems.join('\n')).toEqual([]);
});

test('stage: первый вход — «С чего начать» и «Как работать» (2.52)', async ({ page, baseURL }) => {
  const problems = watch(page, baseURL);
  // Новый человек каждый прогон: +7 999 000-90-10…99 (9001 — проверка входа выше).
  const phone = `+799900090${10 + Math.floor(Math.random() * 90)}`;
  const r = await page.request.post('/__stage/login', { data: { phone }, headers: { ...AUTH, 'x-delo-request': '1', 'x-stage-login': LOGIN_KEY } });
  expect(r.status()).toBe(200);
  await page.goto('/kabinet');
  await expect(page.getByRole('heading', { name: 'Мои заявки' })).toBeVisible();
  const box = page.locator('#hint-box');
  // Номер мог уже встречаться в прошлых прогонах — тогда подсказка закрыта раньше.
  const seen = (await (await page.request.get('/api/me', { headers: AUTH })).json()).hints_seen;
  if (!seen.includes('customer')) {
    await expect(page.locator('#hint-title')).toHaveText('С чего начать: заказчик');
    await page.screenshot({ path: 'test-results/screens/stage-podskazka.png', fullPage: true });
    await page.getByRole('button', { name: 'Понятно' }).click();
    await expect(box).toBeHidden();
  }
  await page.getByRole('link', { name: 'Как работать' }).first().click();
  await expect(page.getByRole('heading', { name: 'Как работать', level: 1 })).toBeVisible();
  await expect(page.locator('details[data-role="customer"]')).toHaveAttribute('open', '');
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, 'страница шире экрана').toBeLessThanOrEqual(412);
  await page.screenshot({ path: 'test-results/screens/stage-kak-rabotat.png', fullPage: true });
  expect(problems, problems.join('\n')).toEqual([]);
});

test('stage: витрина «Дело: Экспертиза» (2.53)', async ({ page, baseURL }) => {
  const problems = watch(page, baseURL);
  await page.goto('/ekspertiza');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Оценка и экспертиза');
  await expect(page.getByRole('heading', { name: 'Юрфирмам и банкам' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Экспертам и экспертным организациям' })).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, 'страница шире экрана').toBeLessThanOrEqual(412);
  await page.screenshot({ path: 'test-results/screens/stage-vitrina.png', fullPage: true });
  await page.locator('#cta-order').click();
  await expect(page).toHaveURL(/\/(kabinet)?(\?.*)?$/);
  expect(problems, problems.join('\n')).toEqual([]);
});
