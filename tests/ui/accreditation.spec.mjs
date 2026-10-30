// Аккредитация в банке (задача 2.451) — телефон 412×915: эксперт вносит аккредитацию в досье (банк из списка — без названия,
// свой — с названием), руководитель — аккредитацию организации с копией, сотрудник видит список без правки. Что разрешено и
// кому — считает сервер (tests/server/accreditation.test.mjs). Номера +7 999 000-45-2x — только здесь.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DB_URL, TEST_TOKEN } from '../helpers.mjs';

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
async function db(fn) {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
async function shot(page, name) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, `${name}: страница шире экрана`).toBeLessThanOrEqual(412);
  await page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: true });
}
async function phone(browser, baseURL) {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU',
    storageState: { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'delo.folds', value: 'open' }] }] } });
  const page = await ctx.newPage();
  page.problems = [];
  page.on('pageerror', (e) => page.problems.push(`ошибка JS: ${e.message}`));
  return page;
}
const plusDays = (n) => new Date(Date.now() + 3 * 3600 * 1000 + n * 86400000).toISOString().slice(0, 10);

test('2.451: эксперт вносит аккредитацию в банке в досье — банк из списка или свой', async ({ browser, baseURL }) => {
  const sp = await phone(browser, baseURL);
  const expert = await signIn(sp, '+79990004521');
  await db((c) => c.query('insert into specialists (user_id) values ($1)', [expert.id]));
  await sp.goto('/kabinet#specialist');
  await expect(sp.locator('#dossier-box')).toBeVisible();
  await sp.getByLabel('Документ', { exact: true }).selectOption({ label: 'Аккредитация в банке' });
  // Банк из списка — название не нужно; полей полиса нет; дата — решения банка.
  await expect(sp.getByLabel('Банк', { exact: true })).toBeVisible();
  await expect(sp.locator('#dossier-title-box')).toBeHidden();
  await expect(sp.getByLabel('Страховая сумма, руб.', { exact: true })).toBeHidden();
  await sp.getByLabel('Банк', { exact: true }).selectOption({ label: 'Сбербанк' });
  await sp.getByLabel('Номер решения банка', { exact: true }).fill('АК-4521');
  await sp.getByLabel('Дата решения банка', { exact: true }).fill(plusDays(-200));
  await sp.getByLabel('Действует до', { exact: true }).fill(plusDays(20));
  await sp.locator('#dossier-save').click();
  await expect(sp.locator('#dossier-msg')).toHaveText('Документ добавлен — загрузите копию');
  const sber = sp.locator('#dossier-items li').filter({ hasText: 'Аккредитация в банке: Сбербанк' });
  await expect(sber).toContainText('№ АК-4521');
  await expect(sber).toContainText('решение от');
  await expect(sber).toContainText('срок кончается');
  // Свой банк — без названия не сохранится.
  await sp.getByLabel('Документ', { exact: true }).selectOption({ label: 'Аккредитация в банке' });
  await sp.getByLabel('Банк', { exact: true }).selectOption({ label: 'Другой банк' });
  await expect(sp.getByLabel('Название банка', { exact: true })).toBeVisible();
  await sp.locator('#dossier-save').click();
  await expect(sp.locator('#dossier-msg')).toContainText('Название банка');
  await sp.getByLabel('Название банка', { exact: true }).fill('Тестовый банк «Пример»');
  await sp.getByLabel('Действует до', { exact: true }).fill(plusDays(300));
  await sp.locator('#dossier-save').click();
  await expect(sp.locator('#dossier-items li').filter({ hasText: 'Аккредитация в банке: Тестовый банк «Пример»' })).toBeVisible();
  await sber.getByLabel('Копия: Аккредитация в банке').setInputFiles({ name: 'Решение Сбербанка.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF решение') });
  await expect(sp.locator('#dossier-msg')).toHaveText('Копия сохранена');
  await expect(sber).toContainText('Копия: Решение Сбербанка.pdf');
  // Изменить: свой банк открывается с названием.
  await sp.locator('#dossier-items li').filter({ hasText: 'Тестовый банк' }).getByRole('button', { name: 'Изменить' }).click();
  await expect(sp.getByLabel('Название банка', { exact: true })).toHaveValue('Тестовый банк «Пример»');
  await sp.locator('#dossier-cancel').click();
  await sp.locator('#dossier-box').scrollIntoViewIfNeeded();
  await shot(sp, 'ak01-2451-dosie-akkreditaciya');
  expect(sp.problems).toEqual([]);
});

test('2.451: руководитель вносит аккредитацию организации с копией, сотрудник видит без правки', async ({ browser, baseURL }) => {
  const hp = await phone(browser, baseURL);
  const mp = await phone(browser, baseURL);
  const head = await signIn(hp, '+79990004522');
  const member = await signIn(mp, '+79990004523');
  const orgId = await db(async (c) => {
    const org = (await c.query("insert into organizations (name) values ('Тестовая оценочная организация 4522') returning id")).rows[0];
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head'), ($1, $3, 'member')", [org.id, head.id, member.id]);
    return org.id;
  });
  await hp.goto(`/kabinet#org=${orgId}`);
  const box = hp.locator('#org-accr-box');
  await expect(box).toBeVisible();
  await expect(hp.locator('#org-accr-empty')).toBeVisible();
  await expect(hp.locator('#org-accr-title-box')).toBeHidden();
  await hp.getByLabel('Какой банк').selectOption({ label: 'Другой банк' });
  await expect(hp.getByLabel('Название своего банка')).toBeVisible();
  await hp.locator('#org-accr-save').click();
  await expect(hp.locator('#org-accr-msg')).toContainText('Название банка');
  await hp.getByLabel('Название своего банка').fill('Тестовый банк «Залог»');
  await hp.getByLabel('Аккредитация действует до').fill(plusDays(-3));
  await hp.locator('#org-accr-save').click();
  await expect(hp.locator('#org-accr-msg')).toHaveText('Аккредитация добавлена — загрузите копию решения банка');
  await hp.getByLabel('Какой банк').selectOption({ label: 'Сбербанк' });
  await hp.getByLabel('Номер решения').fill('Р-2026/45');
  await hp.getByLabel('Дата решения').fill(plusDays(-60));
  await hp.getByLabel('Аккредитация действует до').fill(plusDays(300));
  await hp.locator('#org-accr-save').click();
  const sber = hp.locator('#org-accr-items li').filter({ hasText: 'Сбербанк' });
  await expect(sber).toContainText('№ Р-2026/45');
  await expect(hp.locator('#org-accr-items li').filter({ hasText: 'Тестовый банк «Залог»' })).toContainText('срок истёк');
  await sber.getByLabel('Копия: Сбербанк').setInputFiles({ name: 'Решение банка.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF решение') });
  await expect(hp.locator('#org-accr-msg')).toHaveText('Копия сохранена');
  await box.scrollIntoViewIfNeeded();
  await shot(hp, 'ak02-2451-organizaciya-akkreditacii');

  await mp.goto(`/kabinet#org=${orgId}`);
  await expect(mp.locator('#org-accr-box')).toBeVisible();
  await expect(mp.locator('#org-accr-items li')).toHaveCount(2);
  await expect(mp.locator('#org-accr-form')).toBeHidden();
  const msb = mp.locator('#org-accr-items li').filter({ hasText: 'Сбербанк' });
  await expect(msb.getByRole('button', { name: 'Скачать' })).toBeVisible();
  await expect(msb.getByRole('button', { name: 'Изменить' })).toHaveCount(0);
  await mp.locator('#org-accr-box').scrollIntoViewIfNeeded();
  await shot(mp, 'ak03-2451-sotrudnik-vidit');
  expect([...hp.problems, ...mp.problems]).toEqual([]);
});
