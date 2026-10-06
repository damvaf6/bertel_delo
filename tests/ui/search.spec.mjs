// Задача 2.73: поиск по своим делам одной строкой — у эксперта (номер, адрес, услуга, заказчик) и у руководителя
// (номер, услуга, эксперт). Телефон 412×915. Данные — демо-площадка (tests/tools/demo-seed.mjs).
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DB_URL, TEST_TOKEN } from '../helpers.mjs';
import { seedDemo, codeLogin, DEMO_PEOPLE } from '../tools/demo-seed.mjs';

const CONTROL = process.env.UI_TEST_CONTROL_TOKEN || TEST_TOKEN;
const ADMIN = '+79990009510';

async function phoneAs(browser, baseURL, cookie) {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' });
  const [name, ...rest] = cookie.split('=');
  await ctx.addCookies([{ name, value: rest.join('='), url: new URL(baseURL).origin }]);
  return ctx.newPage();
}

test('поиск по своим делам: эксперт, заказчик-юрист, руководитель', async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try { await c.query("insert into users (phone, platform_role) values ($1, 'admin') on conflict (phone) do update set platform_role = 'admin'", [ADMIN]);
    await c.query("update login_codes set created_at = created_at - interval '2 minutes' where phone like '+79990001%'");
  } finally { await c.end(); }
  const r = await seedDemo({ base: baseURL, login: codeLogin(baseURL, CONTROL), adminPhone: ADMIN });
  const ref = (id) => id.slice(0, 8).toUpperCase();

  // Частный оценщик: два участка — ищет по части адреса (без учёта регистра и знаков), по номеру дела.
  const page = await phoneAs(browser, baseURL, r.sessions.morozova);
  await page.goto('/kabinet');
  const list = page.locator('#orders > li:not(.group)');
  await expect(list).toHaveCount(2);
  const search = page.locator('#orders-search');
  await expect(search).toBeVisible();
  // Номер дела виден в строке списка — по нему и ищут.
  await expect(page.locator(`#orders button[data-id="${r.cases.land}"]`)).toContainText(`№ ${ref(r.cases.land)}`);
  await search.fill('одинцовский');
  await expect(list).toHaveCount(1);
  await expect(page.locator(`#orders button[data-id="${r.cases.land}"]`)).toBeVisible();
  await search.fill(`№ ${ref(r.cases.garden).toLowerCase()}`);
  await expect(list).toHaveCount(1);
  await expect(page.locator(`#orders button[data-id="${r.cases.garden}"]`)).toBeVisible();
  // Слова в любом порядке; вариант выбора — названием, как на экране («Садоводство», а не код).
  await search.fill('снт демо');
  await expect(list).toHaveCount(1);
  await search.fill('квартира на луне');
  await expect(list).toHaveCount(0);
  await expect(page.locator('#orders-none')).toHaveText('Ничего не найдено по «квартира на луне». Ищите по номеру дела, адресу, виду услуги или заказчику.');
  await expect(page.locator('#orders-empty')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await page.locator('#orders').locator('..').screenshot({ path: 'test-results/screens/search-01-nichego.png' });
  // Окончания не мешают: «участок» находит «…участка…».
  await search.fill('участок');
  await expect(list).toHaveCount(2);
  await search.fill('');
  await expect(list).toHaveCount(2);
  await expect(page.locator('#orders-none')).toBeHidden();
  await page.context().close();

  // Эксперт организации: заказчик — организация (юрфирма) ищется по названию.
  const bp = await phoneAs(browser, baseURL, r.sessions.zakharova);
  await bp.goto('/kabinet');
  await expect(bp.locator('#orders > li:not(.group)')).toHaveCount(2);
  await bp.locator('#orders-search').fill('право и дело');
  await expect(bp.locator('#orders > li:not(.group)')).toHaveCount(1);
  await expect(bp.locator(`#orders button[data-id="${r.cases.signature}"]`)).toBeVisible();
  await bp.locator('#orders').locator('..').screenshot({ path: 'test-results/screens/search-02-ekspert-zakazchik.png' });
  await bp.context().close();

  // Руководитель: по эксперту (ё = е) и по номеру; адресов и заказчика в его списке нет — по ним не находится.
  const hp = await phoneAs(browser, baseURL, r.sessions.headB);
  await hp.goto(`/kabinet#org=${r.orgs.B}`);
  const cases = hp.locator('#org-cases > li:not(.group)');
  await expect(cases.first()).toBeVisible();
  const total = await cases.count();
  expect(total).toBeGreaterThanOrEqual(3);
  const box = hp.locator('#org-cases-search');
  await box.scrollIntoViewIfNeeded();
  await box.fill('тихонов');
  await expect(cases).not.toHaveCount(total);
  for (const t of await cases.allTextContents()) expect(t).toContain(DEMO_PEOPLE.tikhonov.name);
  await box.fill('захарова');
  await expect(cases).toHaveCount(2);
  await box.fill(ref(r.cases.signature));
  await expect(cases).toHaveCount(1);
  await expect(hp.locator(`#org-cases li[data-case="№ ${ref(r.cases.signature)}"]`)).toBeVisible();
  await box.fill('Лесная');
  await expect(cases).toHaveCount(0);
  await expect(hp.locator('#org-cases-none')).toContainText('Ничего не найдено по «Лесная»');
  await box.fill('тихонов');
  expect(await hp.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await hp.locator('#org-cases').locator('..').screenshot({ path: 'test-results/screens/search-03-rukovoditel.png' });
  await hp.context().close();
});
