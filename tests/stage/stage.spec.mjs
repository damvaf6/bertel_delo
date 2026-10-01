// Проверка на адресе контура stage после выкладки (телефон 412×915): страница входа открывается, помечена как
// проверочная, без прокрутки вбок, ошибок JavaScript и запросов к чужим адресам. Код входа здесь не запрашивается —
// полный прогон на stage отдельной задачей. Скриншот — test-results/screens/stage-vhod.png.
import { test, expect } from '@playwright/test';

test('stage: страница входа на телефоне', async ({ page, baseURL }) => {
  const problems = [];
  const origin = new URL(baseURL).origin;
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['data:', 'blob:'].includes(u.protocol) && u.origin !== origin) problems.push(`внешний запрос: ${r.url()}`);
  });

  const health = await page.request.get('/api/health');
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
