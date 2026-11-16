// Сводка руководителя за месяц: доли и раздел имущества (задача 2.517) — телефон 412×915: сколько долей сдано, каким
// способом, средняя скидка на долю из черновика, раздел имущества; по экспертам. Цифры — tests/server/share-report.test.mjs.
// Номера +7 999 000-51-75…76 — только здесь.
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

test('2.517: сводка за месяц — доли по способу, средняя скидка и раздел имущества', async ({ browser, baseURL }) => {
  const hp = await phone(browser, baseURL);
  const head = await signIn(hp, '+79990005175');
  const { orgId, expert } = await db(async (c) => {
    const expert = (await c.query("insert into users (phone, full_name) values ('+79990005176', 'Тестова-Долевая Ирина') returning id")).rows[0].id;
    const { rows: [org] } = await c.query("insert into organizations (name) values ('ООО «Доли в сводке 2.517»') returning id");
    await c.query("insert into org_members (org_id, user_id, role, created_at) values ($1, $2, 'head', now() - interval '40 days'), ($1, $3, 'member', now() - interval '40 days')", [org.id, head.id, expert]);
    await c.query('insert into specialists (user_id, org_id) values ($1, $2)', [expert, org.id]);
    const done = async (title, fields, pct) => {
      const id = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields)
        values ($1, $2, 'expertise', 'realty', 'done', $1, current_date + 5, $3) returning id`,
      [expert, title, { address: 'г. Москва, ул. Тестовая, д. 7, кв. 3', ...fields }])).rows[0].id;
      await c.query("insert into order_status_history (order_id, from_status, to_status, side, at) values ($1, 'review', 'done', 'dispatcher', now() - interval '1 minute')", [id]);
      if (pct) await c.query("insert into result_drafts (order_id, author_id, source, body) values ($1, $2, 'edit', $3)", [id, expert, `| Расчёт стоимости доли | Значение |\n| Скидка на долю, % | ${pct} (источник — справочник) |`]);
    };
    await done('Доля 1/3 на продажу', { object_type: 'share', share_size: '1/3', purpose: 'deal', share_method: 'market' }, '20');
    await done('Доля 1/2 для суда', { object_type: 'share', share_size: '1/2', purpose: 'court', share_method: 'market' }, '15');
    await done('Доля 1/4 для раздела', { object_type: 'share', share_size: '1/4', purpose: 'division', share_method: 'pro_rata' });
    await done('Квартира для раздела', { object_type: 'flat', purpose: 'division' });
    return { orgId: org.id, expert };
  });

  await hp.goto(`/kabinet#org=${orgId}`);
  const box = hp.locator('#org-report-share-box');
  await expect(box).toBeVisible();
  await expect(hp.locator('#org-report-share-total')).toHaveText('Сдано: доли: 3 дела (рыночная со скидкой: 2, часть стоимости целого: 1)'
    + ' · средняя скидка на долю 17,5% · раздел имущества: 2 дела, из них доли: 1.');
  await expect(box.locator(`li[data-report-share-expert="${expert}"] .title`)).toHaveText('Тестова-Долевая Ирина');
  await box.scrollIntoViewIfNeeded();
  await shot(hp, 'dl11-2517-svodka-doli');
  expect(hp.problems).toEqual([]);
});
