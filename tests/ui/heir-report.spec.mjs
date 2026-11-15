// Сводка руководителя за месяц: оценка для наследства (задача 2.508) — телефон 412×915: сколько сдано, по виду объекта,
// несколько объектов и насколько дата оценки раньше сдачи (месяцев); по экспертам. Цифры — tests/server/heir-report.test.mjs.
// Номера +7 999 000-50-85…86 — только здесь.
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

test('2.508: сводка за месяц — оценка для наследства по виду объекта и дата оценки раньше сдачи', async ({ browser, baseURL }) => {
  const hp = await phone(browser, baseURL);
  const head = await signIn(hp, '+79990005085');
  const { orgId, expert } = await db(async (c) => {
    const expert = (await c.query("insert into users (phone, full_name) values ('+79990005086', 'Тестова-Наследственная Анна') returning id")).rows[0].id;
    const { rows: [org] } = await c.query("insert into organizations (name) values ('ООО «Наследство в сводке 2.508»') returning id");
    await c.query("insert into org_members (org_id, user_id, role, created_at) values ($1, $2, 'head', now() - interval '40 days'), ($1, $3, 'member', now() - interval '40 days')", [org.id, head.id, expert]);
    await c.query('insert into specialists (user_id, org_id) values ($1, $2)', [expert, org.id]);
    // День открытия наследства — за days дней до сегодня (по Москве), сдано минуту назад.
    const done = async (service, title, fields, days) => {
      const { rows: [{ day }] } = await c.query("select to_char((now() at time zone 'Europe/Moscow')::date - $1::int, 'DD.MM.YYYY') as day", [days]);
      const id = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields)
        values ($1, $2, 'expertise', $3, 'done', $1, current_date + 5, $4) returning id`,
      [expert, title, service, { purpose: 'inheritance', death_date: day, ...fields }])).rows[0].id;
      await c.query("insert into order_status_history (order_id, from_status, to_status, side, at) values ($1, 'review', 'done', 'dispatcher', now() - interval '1 minute')", [id]);
    };
    await done('realty', 'Квартира по наследству', { address: 'г. Москва, ул. Тестовая, д. 1, кв. 5', heir_objects: 'гараж, ГСК «Ромашка», бокс 12' }, 183);
    await done('vehicle', 'Машина по наследству', { make_model: 'Лада Веста' }, 91);
    return { orgId: org.id, expert };
  });

  await hp.goto(`/kabinet#org=${orgId}`);
  const box = hp.locator('#org-report-heir-box');
  await expect(box).toBeVisible();
  await expect(hp.locator('#org-report-heir-total'))
    .toHaveText('Сдано отчётов: 2 дела · несколько объектов: 1 · дата оценки раньше сдачи в среднем на 4,5 мес.');
  await expect(box.locator('li[data-report-heir="realty"] .title')).toHaveText('Оценка недвижимости');
  await expect(box.locator('li[data-report-heir="realty"] .muted')).toHaveText('1 дело · несколько объектов: 1 · дата оценки раньше сдачи в среднем на 6 мес.');
  await expect(box.locator('li[data-report-heir="vehicle"] .muted')).toHaveText('1 дело · дата оценки раньше сдачи в среднем на 3 мес.');
  await expect(box.locator(`li[data-report-heir-expert="${expert}"] .title`)).toHaveText('Тестова-Наследственная Анна');
  await box.scrollIntoViewIfNeeded();
  await shot(hp, 'nh13-2508-svodka-nasledstvo');
  expect(hp.problems).toEqual([]);
});
