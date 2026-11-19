// Сводка руководителя за месяц: квартиры в новостройке, права по ДДУ (задача 2.547) — телефон 412×915: сколько сдано, сколько
// для банка и доля от дел для банка, средняя разница итога в черновике с ценой по договору; по экспертам. Цифры —
// tests/server/ddu-report.test.mjs. Номера +7 999 000-54-75…76 — только здесь.
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

test('2.547: сводка за месяц — права по ДДУ, доля от дел для банка, разница с ценой по договору', async ({ browser, baseURL }) => {
  const hp = await phone(browser, baseURL);
  const head = await signIn(hp, '+79990005475');
  const { orgId, expert } = await db(async (c) => {
    const expert = (await c.query("insert into users (phone, full_name) values ('+79990005476', 'Тестова-Новострой Анна') returning id")).rows[0].id;
    const { rows: [org] } = await c.query("insert into organizations (name) values ('ООО «ДДУ в сводке 2.547»') returning id");
    await c.query("insert into org_members (org_id, user_id, role, created_at) values ($1, $2, 'head', now() - interval '40 days'), ($1, $3, 'member', now() - interval '40 days')", [org.id, head.id, expert]);
    await c.query('insert into specialists (user_id, org_id) values ($1, $2)', [expert, org.id]);
    const done = async (title, fields, value) => {
      const id = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields)
        values ($1, $2, 'expertise', 'realty', 'done', $1, current_date + 5, $3) returning id`,
      [expert, title, { address: 'Московская обл., г. Тестовый, ЖК «Тестовый», корп. 3', object_type: 'ddu', ...fields }])).rows[0].id;
      await c.query("insert into order_status_history (order_id, from_status, to_status, side, at) values ($1, 'review', 'done', 'dispatcher', now() - interval '1 minute')", [id]);
      if (value) await c.query("insert into result_drafts (order_id, author_id, source, body) values ($1, $2, 'edit', $3)", [id, expert,
        `## 14. Согласование результатов\nИтоговая рыночная стоимость права требования составляет ${value} руб.`]);
    };
    await done('ДДУ для банка', { purpose: 'bank', ddu_price: 6000000 }, '6 600 000');
    await done('ДДУ для банка, дешевле', { purpose: 'bank', ddu_price: 5000000 }, '4 750 000');
    await done('ДДУ без расчёта', { purpose: 'sale', ddu_price: 7000000 });
    await done('Квартира для банка', { object_type: 'flat', purpose: 'bank' });
    return { orgId: org.id, expert };
  });

  await hp.goto(`/kabinet#org=${orgId}`);
  const box = hp.locator('#org-report-ddu-box');
  await expect(box).toBeVisible();
  await expect(hp.locator('#org-report-ddu-total')).toHaveText('Сдано: права по ДДУ: 3 дела · для банка: 2 (67% дел для банка)'
    + ' · итог против цены по договору: в среднем +2,5% (+175 000 ₽), сравнено 2 · цена есть, а итоговой стоимости в черновике нет: 1.');
  await expect(box.locator(`li[data-report-ddu-expert="${expert}"] .title`)).toHaveText('Тестова-Новострой Анна');
  await expect(hp.locator('#org-report-house-box')).toBeHidden();
  await box.scrollIntoViewIfNeeded();
  await shot(hp, 'du12-2547-svodka-ddu');
  await box.screenshot({ path: 'test-results/screens/du12b-2547-blok-ddu.png' });
  expect(hp.problems).toEqual([]);
});
