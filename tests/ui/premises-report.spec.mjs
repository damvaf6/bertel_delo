// Сводка руководителя за месяц: нежилые помещения (задача 2.527) — телефон 412×915: сколько нежилых сдано, по назначению,
// сдаётся ли в аренду, с доходным подходом и средняя ставка капитализации из черновика; по экспертам. Цифры —
// tests/server/premises-report.test.mjs. Номера +7 999 000-52-75…76 — только здесь.
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

test('2.527: сводка за месяц — нежилые по назначению, доходный подход и средняя ставка капитализации', async ({ browser, baseURL }) => {
  const hp = await phone(browser, baseURL);
  const head = await signIn(hp, '+79990005275');
  const { orgId, expert } = await db(async (c) => {
    const expert = (await c.query("insert into users (phone, full_name) values ('+79990005276', 'Тестова-Нежилая Анна') returning id")).rows[0].id;
    const { rows: [org] } = await c.query("insert into organizations (name) values ('ООО «Нежилое в сводке 2.527»') returning id");
    await c.query("insert into org_members (org_id, user_id, role, created_at) values ($1, $2, 'head', now() - interval '40 days'), ($1, $3, 'member', now() - interval '40 days')", [org.id, head.id, expert]);
    await c.query('insert into specialists (user_id, org_id) values ($1, $2)', [expert, org.id]);
    const done = async (title, fields, cap) => {
      const id = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields)
        values ($1, $2, 'expertise', 'realty', 'done', $1, current_date + 5, $3) returning id`,
      [expert, title, { address: 'г. Москва, ул. Тестовая, д. 9, пом. 1', object_type: 'commercial', ...fields }])).rows[0].id;
      await c.query("insert into order_status_history (order_id, from_status, to_status, side, at) values ($1, 'review', 'done', 'dispatcher', now() - interval '1 minute')", [id]);
      if (cap) await c.query("insert into result_drafts (order_id, author_id, source, body) values ($1, $2, 'edit', $3)", [id, expert,
        `| Расчёт доходным подходом | Значение |\n| Ставка капитализации, % | ${cap} (источник — справочник) |\n| Стоимость доходным подходом (ЧОД / ставка), руб. | 9 000 000 |`]);
    };
    await done('Офис в аренде', { premises_use: 'office', lease: 'full' }, '12');
    await done('Склад в аренде', { premises_use: 'warehouse', lease: 'part' }, '9');
    await done('Магазин в аренде без расчёта', { premises_use: 'retail', lease: 'full' });
    await done('Квартира', { object_type: 'flat' });
    return { orgId: org.id, expert };
  });

  await hp.goto(`/kabinet#org=${orgId}`);
  const box = hp.locator('#org-report-prem-box');
  await expect(box).toBeVisible();
  await expect(hp.locator('#org-report-prem-total')).toHaveText('Сдано: нежилые: 3 дела (офис: 1, магазин, общепит, услуги: 1, склад, производство: 1)'
    + ' · сдаётся в аренду: 3 · доходный подход: 2, средняя ставка капитализации 10,5% · сдаётся, а доходного подхода в черновике нет: 1.');
  await expect(box.locator(`li[data-report-prem-expert="${expert}"] .title`)).toHaveText('Тестова-Нежилая Анна');
  await box.scrollIntoViewIfNeeded();
  await shot(hp, 'np12-2527-svodka-nezhiloe');
  expect(hp.problems).toEqual([]);
});
