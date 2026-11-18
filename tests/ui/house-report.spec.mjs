// Сводка руководителя за месяц: жилые дома (задача 2.537) — телефон 412×915: сколько домов сдано, участок под домом по заявке,
// средняя доля участка в итоге из черновика; по экспертам. Цифры — tests/server/house-report.test.mjs.
// Номера +7 999 000-53-75…76 — только здесь.
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

test('2.537: сводка за месяц — дома, участок по заявке и средняя доля участка в итоге', async ({ browser, baseURL }) => {
  const hp = await phone(browser, baseURL);
  const head = await signIn(hp, '+79990005375');
  const { orgId, expert } = await db(async (c) => {
    const expert = (await c.query("insert into users (phone, full_name) values ('+79990005376', 'Тестова-Домова Анна') returning id")).rows[0].id;
    const { rows: [org] } = await c.query("insert into organizations (name) values ('ООО «Дома в сводке 2.537»') returning id");
    await c.query("insert into org_members (org_id, user_id, role, created_at) values ($1, $2, 'head', now() - interval '40 days'), ($1, $3, 'member', now() - interval '40 days')", [org.id, head.id, expert]);
    await c.query('insert into specialists (user_id, org_id) values ($1, $2)', [expert, org.id]);
    const done = async (title, fields, land, total) => {
      const id = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields)
        values ($1, $2, 'expertise', 'realty', 'done', $1, current_date + 5, $3) returning id`,
      [expert, title, { address: 'Московская обл., пос. Тестовый, ул. Садовая, д. 9', object_type: 'house', ...fields }])).rows[0].id;
      await c.query("insert into order_status_history (order_id, from_status, to_status, side, at) values ($1, 'review', 'done', 'dispatcher', now() - interval '1 minute')", [id]);
      if (land) await c.query("insert into result_drafts (order_id, author_id, source, body) values ($1, $2, 'edit', $3)", [id, expert,
        `| Стоимость дома и участка | Значение |\n| Жилой дом, руб. | ${total - land} |\n| Земельный участок под домом, руб. | ${land} |\n| Итого: дом и участок, руб. | ${total} |`]);
    };
    await done('Дом с участком', { house_land: 'own' }, 2000000, 10000000);
    await done('Дом с участком побольше', { house_land: 'own' }, 3000000, 10000000);
    await done('Дом с участком без расчёта', { house_land: 'own' });
    await done('Дом на участке в аренде', { house_land: 'lease' });
    await done('Квартира', { object_type: 'flat' });
    return { orgId: org.id, expert };
  });

  await hp.goto(`/kabinet#org=${orgId}`);
  const box = hp.locator('#org-report-house-box');
  await expect(box).toBeVisible();
  await expect(hp.locator('#org-report-house-total')).toHaveText('Сдано: дома: 4 дела (участок в собственности: 3, в аренде: 1)'
    + ' · средняя доля участка в итоге 25% · участок в собственности, а его стоимости в черновике нет: 1.');
  await expect(box.locator(`li[data-report-house-expert="${expert}"] .title`)).toHaveText('Тестова-Домова Анна');
  await box.scrollIntoViewIfNeeded();
  await shot(hp, 'hs13-2537-svodka-doma');
  await box.screenshot({ path: 'test-results/screens/hs13b-2537-blok-doma.png' });
  expect(hp.problems).toEqual([]);
});
