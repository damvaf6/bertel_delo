// Задача 2.55: журнал действий по делу и «Скачать дело архивом» — телефон 412×915. Данные — демо-площадка
// (tests/tools/demo-seed.mjs): закрытое дело частного заказчика.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DB_URL, TEST_TOKEN } from '../helpers.mjs';
import { seedDemo, codeLogin, DEMO_PEOPLE } from '../tools/demo-seed.mjs';

const CONTROL = process.env.UI_TEST_CONTROL_TOKEN || TEST_TOKEN;
const ADMIN = '+79990009510';

async function phoneAs(browser, baseURL, cookie) {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU', acceptDownloads: true });
  const [name, ...rest] = cookie.split('=');
  await ctx.addCookies([{ name, value: rest.join('='), url: new URL(baseURL).origin }]);
  return ctx.newPage();
}

test('журнал действий и архив дела: заказчик и диспетчер', async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try { await c.query("insert into users (phone, platform_role) values ($1, 'admin') on conflict (phone) do update set platform_role = 'admin'", [ADMIN]);
    // Демо-люди могли входить в другой проверке минуту назад — новый код без ожидания.
    await c.query("update login_codes set created_at = created_at - interval '2 minutes' where phone like '+79990001%'");
  } finally { await c.end(); }
  const r = await seedDemo({ base: baseURL, login: codeLogin(baseURL, CONTROL), adminPhone: ADMIN });

  const page = await phoneAs(browser, baseURL, r.sessions.petrov);
  await page.goto(`/kabinet#order=${r.cases.flat}`);
  await expect(page.locator('#order-status')).toHaveText('Закрыта');
  await page.locator('#journal-details summary').click();
  await expect(page.locator('#journal li').first()).toBeVisible();
  await expect(page.locator('#journal')).toContainText('Создана заявка');
  await expect(page.locator('#journal')).not.toContainText(DEMO_PEOPLE.orlov.name);
  await page.locator('#journal-box').scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await page.locator('#journal-box').screenshot({ path: 'test-results/screens/case-01-zhurnal-zakazchik.png' });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Выгрузить дело архивом' }).click()]);
  expect(dl.suggestedFilename()).toMatch(/^Дело № [0-9A-F]{8} \(\d{4}-\d{2}-\d{2}\)\.zip$/);
  await page.context().close();

  const dp = await phoneAs(browser, baseURL, r.sessions.dispatcher);
  await dp.goto(`/kabinet#order=${r.cases.flat}`);
  await dp.locator('#journal-details summary').click();
  await expect(dp.locator('#journal')).toContainText(DEMO_PEOPLE.orlov.name);
  await expect(dp.locator('#journal')).toContainText('Дело выгружено архивом');
  await dp.locator('#journal-box').screenshot({ path: 'test-results/screens/case-02-zhurnal-dispetcher.png' });
  await dp.context().close();

  // Исполнитель журнал видит, архив — нет.
  const ep = await phoneAs(browser, baseURL, r.sessions.orlov);
  await ep.goto(`/kabinet#order=${r.cases.flat}`);
  await ep.locator('#journal-details summary').click();
  await expect(ep.locator('#journal li').first()).toBeVisible();
  await expect(ep.getByRole('button', { name: 'Выгрузить дело архивом' })).toBeHidden();
  await ep.context().close();
});
