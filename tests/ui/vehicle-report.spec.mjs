// Сводка руководителя за месяц: оценка транспорта (задача 2.498) — телефон 412×915: сколько сдано, по виду транспорта, для
// чего оценка и средний срок от принятия до сдачи; по экспертам. Цифры — tests/server/vehicle-report.test.mjs.
// Номера +7 999 000-49-85…86 — только здесь.
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

test('2.498: сводка за месяц — оценка транспорта по виду, цели и средний срок', async ({ browser, baseURL }) => {
  const hp = await phone(browser, baseURL);
  const head = await signIn(hp, '+79990004985');
  const { orgId, expert } = await db(async (c) => {
    const expert = (await c.query("insert into users (phone, full_name) values ('+79990004986', 'Тестов-Транспортный Иван') returning id")).rows[0].id;
    const { rows: [org] } = await c.query("insert into organizations (name) values ('ООО «Транспорт в сводке 2.498»') returning id");
    await c.query("insert into org_members (org_id, user_id, role, created_at) values ($1, $2, 'head', now() - interval '40 days'), ($1, $3, 'member', now() - interval '40 days')", [org.id, head.id, expert]);
    await c.query('insert into specialists (user_id, org_id) values ($1, $2)', [expert, org.id]);
    // Принято taken дней назад (по Москве — полдень), сдано минуту назад.
    const done = async (title, fields, taken) => {
      const id = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields)
        values ($1, $2, 'expertise', 'vehicle', 'done', $1, current_date + 5, $3) returning id`,
      [expert, title, { make_model: 'Лада Веста', ...fields }])).rows[0].id;
      await c.query("insert into order_status_history (order_id, from_status, to_status, side, at) values ($1, 'review', 'done', 'dispatcher', now() - interval '1 minute')", [id]);
      await c.query(`insert into order_offers (order_id, specialist_id, score, outcome, outcome_at)
        values ($1, $2, '{}'::jsonb, 'accepted', ((now() at time zone 'Europe/Moscow')::date - $3::int + '12:00'::time) at time zone 'Europe/Moscow')`, [id, expert, taken]);
    };
    await done('Лада для банка', { vehicle_type: 'car', purpose: 'bank' }, 4);
    await done('Лада для суда', { vehicle_type: 'car', purpose: 'court' }, 2);
    await done('Газель по наследству', { vehicle_type: 'truck', purpose: 'inheritance' }, 3);
    return { orgId: org.id, expert };
  });

  await hp.goto(`/kabinet#org=${orgId}`);
  const box = hp.locator('#org-report-veh-box');
  await expect(box).toBeVisible();
  await expect(hp.locator('#org-report-veh-total')).toHaveText('Сдано отчётов: 3 дела · в среднем 3 дня от принятия до сдачи.');
  await expect(box.locator('li[data-report-veh="car"] .title')).toHaveText('Легковой автомобиль');
  await expect(box.locator('li[data-report-veh="car"] .muted')).toHaveText('2 дела · в среднем 3 дня от принятия до сдачи');
  await expect(box.locator('li[data-report-veh="truck"] .muted')).toHaveText('1 дело · в среднем 3 дня от принятия до сдачи');
  await expect(box.locator('li[data-report-veh-purpose="bank"] .title')).toHaveText('Для чего: Ипотека, залог, банк');
  await expect(box.locator('li[data-report-veh-purpose="bank"] .muted')).toHaveText('1 дело · в среднем 4 дня от принятия до сдачи');
  await expect(box.locator('li[data-report-veh-purpose="court"] .muted')).toHaveText('1 дело · в среднем 2 дня от принятия до сдачи');
  await expect(box.locator(`li[data-report-veh-expert="${expert}"] .title`)).toHaveText('Тестов-Транспортный Иван');
  await expect(hp.locator('#org-report-goods-box')).toBeHidden();
  await expect(hp.locator('#org-report-car-box')).toBeHidden();
  await box.scrollIntoViewIfNeeded();
  await shot(hp, 'vt13-2498-svodka-transport');
  expect(hp.problems).toEqual([]);
});
