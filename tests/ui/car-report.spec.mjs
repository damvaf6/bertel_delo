// Сводка руководителя за месяц: дела по ДТП (задача 2.478) — телефон 412×915: сколько сдано по ущербу после ДТП, как
// считали ремонт по заявке и разница эксперта с суммой страховой; по экспертам. Цифры — tests/server/car-report.test.mjs.
// Номера +7 999 000-47-85…86 — только здесь.
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

test('2.478: сводка за месяц — дела по ДТП по методике и разница со страховой', async ({ browser, baseURL }) => {
  const hp = await phone(browser, baseURL);
  const head = await signIn(hp, '+79990004785');
  const { orgId, expert } = await db(async (c) => {
    const expert = (await c.query("insert into users (phone, full_name) values ('+79990004786', 'Тестов-Аварийный Пётр') returning id")).rows[0].id;
    const { rows: [org] } = await c.query("insert into organizations (name) values ('ООО «ДТП в сводке 2.478»') returning id");
    await c.query("insert into org_members (org_id, user_id, role, created_at) values ($1, $2, 'head', now() - interval '40 days'), ($1, $3, 'member', now() - interval '40 days')", [org.id, head.id, expert]);
    await c.query('insert into specialists (user_id, org_id) values ($1, $2)', [expert, org.id]);
    const done = async (title, method, ago, calc) => {
      const id = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields)
        values ($1, $2, 'expertise', 'car_damage', 'done', $1, current_date + 5, $3) returning id`,
      [expert, title, { method, make_model: 'Лада Веста', accident_date: '01.10.2026', damage: 'задний бампер' }])).rows[0].id;
      await c.query("insert into order_status_history (order_id, from_status, to_status, side, at) values ($1, 'review', 'done', 'dispatcher', now() - $2::interval)", [id, ago]);
      if (calc) await c.query("insert into insurer_calcs (order_id, wear, insurer_kop, own_kop, created_by) values ($1, 'with', $2, $3, $4)", [id, calc[0], calc[1], expert]);
    };
    await done('Веста: спор по ОСАГО', 'osago', '1 minute', [4000000, 5850000]);
    await done('Веста: к виновнику', 'market', '2 minutes', [6000000, 5500000]);
    await done('Веста: не знаю', 'unknown', '3 minutes', null);
    return { orgId: org.id, expert };
  });

  await hp.goto(`/kabinet#org=${orgId}`);
  const box = hp.locator('#org-report-car-box');
  await expect(box).toBeVisible();
  await expect(hp.locator('#org-report-car-total')).toHaveText(
    'сдано по ДТП: 3 дела · со сверкой со страховой: 2, у эксперта в среднем +6 750 ₽ · больше страховой: 1, меньше: 1 · без сверки: 1.');
  await expect(box.locator('li[data-report-method="osago"] .title')).toHaveText('По Единой методике — спор со страховой по ОСАГО — 1 дело');
  await expect(box.locator('li[data-report-method="osago"] .muted')).toHaveText('со сверкой со страховой: 1, у эксперта в среднем +18 500 ₽');
  await expect(box.locator('li[data-report-method="market"] .muted')).toHaveText('со сверкой со страховой: 1, у эксперта в среднем −5 000 ₽');
  await expect(box.locator('li[data-report-method="unknown"] .muted')).toHaveText('сверки со страховой нет');
  await expect(box.locator(`li[data-report-car-expert="${expert}"] .title`)).toHaveText('Тестов-Аварийный Пётр — 3 дела');
  await box.scrollIntoViewIfNeeded();
  await shot(hp, 'dr01-2478-svodka-dtp');
  expect(hp.problems).toEqual([]);
});
