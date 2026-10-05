// Открытая демо-площадка (решение Дамира 05.10.2026, вопрос 21, вариант Б) на телефоне 412×915: вход кнопками
// «Войти как …», входа по телефону нет, всё вымышленное, закрыта от поисковиков, оплата — только тестовая.
// Снимки — test-results/screens/demo-site-*.png. Против облака — после выкладки (workflow «Demo (Yandex Cloud)»).
import { test, expect } from '@playwright/test';
import fs from 'node:fs';

fs.mkdirSync('test-results/screens', { recursive: true });
const shot = async (page, name) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), `${name}: шире экрана`).toBeLessThanOrEqual(412);
  await page.screenshot({ path: `test-results/screens/demo-site-${name}.png`, fullPage: true });
};

test('демо-площадка: вход кнопками за каждую роль, без телефона; закрыта от поисковиков', async ({ page, request, baseURL }) => {
  const problems = [];
  const origin = new URL(baseURL).origin;
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  page.on('request', (r) => { const u = new URL(r.url()); if (!['data:', 'blob:'].includes(u.protocol) && u.origin !== origin) problems.push(`внешний запрос: ${r.url()}`); });

  const robots = await request.get('/robots.txt');
  expect(await robots.text()).toContain('Disallow: /');
  expect((await request.get('/')).headers()['x-robots-tag']).toContain('noindex');
  expect((await request.post('/api/auth/code', { data: { phone: '+79161234567' }, headers: { 'x-delo-request': '1' } })).status()).toBe(404);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Демо-площадка' })).toBeVisible();
  await expect(page.locator('#test-mark')).toHaveText('Демо-площадка · всё вымышленное · данные сбрасываются каждую ночь');
  await expect(page.getByLabel('Номер мобильного телефона')).toBeHidden();
  await expect(page.locator('#demo-roles button')).toHaveCount(5);
  await shot(page, '01-vhod');

  const cases = [
    ['Юрист фирмы', 'Оценка автомобиля для суда (раздел имущества)'],
    ['Частный заказчик', 'Экспертиза стиральной машины: заводской брак или нет'],
    ['Эксперт-оценщик', 'Оценка участка ИЖС для раздела имущества'],
    ['Диспетчер платформы', 'Оценка оборудования в залог (типография)'],
  ];
  for (const [i, [role, title]] of cases.entries()) {
    await page.goto('/');
    await page.locator('#demo-roles button').filter({ hasText: role }).click();
    await expect(page).toHaveURL(/\/kabinet$/);
    await expect(page.locator('#orders li').filter({ hasText: title })).toHaveCount(1);
    await expect(page.locator('#test-mark')).toContainText('Демо-площадка');
    await shot(page, `0${i + 2}-${['yurist', 'zakazchik', 'ekspert', 'dispetcher'][i]}`);
    await page.getByRole('button', { name: 'Выйти' }).click();
    await expect(page.getByRole('heading', { name: 'Демо-площадка' })).toBeVisible();
  }
  // Руководитель экспертной организации — дела экспертов.
  await page.locator('#demo-roles button').filter({ hasText: 'Руководитель экспертной организации' }).click();
  await expect(page).toHaveURL(/\/kabinet$/);
  await page.goto('/kabinet#orgs');
  await page.getByRole('button', { name: /Центр оценки «Пример» \(демо\)/ }).click();
  await expect(page.locator('#org-cases-box')).toContainText('Строительно-техническая экспертиза');
  await shot(page, '06-rukovoditel');
  expect(problems, problems.join('\n')).toEqual([]);
});
