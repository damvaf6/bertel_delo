// Сводка руководителя за месяц: товароведческие дела (задача 2.488) — телефон 412×915: сколько сдано, что за товар по заявке
// и недостатки из таблицы дела по характеру; по экспертам. Цифры — tests/server/goods-report.test.mjs.
// Номера +7 999 000-48-85…86 — только здесь.
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

test('2.488: сводка за месяц — товароведческие дела по виду товара и недостатки по характеру', async ({ browser, baseURL }) => {
  const hp = await phone(browser, baseURL);
  const head = await signIn(hp, '+79990004885');
  const { orgId, expert } = await db(async (c) => {
    const expert = (await c.query("insert into users (phone, full_name) values ('+79990004886', 'Тестова-Товарная Анна') returning id")).rows[0].id;
    const { rows: [org] } = await c.query("insert into organizations (name) values ('ООО «Товар в сводке 2.488»') returning id");
    await c.query("insert into org_members (org_id, user_id, role, created_at) values ($1, $2, 'head', now() - interval '40 days'), ($1, $3, 'member', now() - interval '40 days')", [org.id, head.id, expert]);
    await c.query('insert into specialists (user_id, org_id) values ($1, $2)', [expert, org.id]);
    const done = async (title, kind, ago, natures) => {
      const id = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields)
        values ($1, $2, 'expertise', 'goods', 'done', $1, current_date + 5, $3) returning id`,
      [expert, title, { goods_kind: kind, model: 'Смартфон X1', defects: 'не включается' }])).rows[0].id;
      await c.query("insert into order_status_history (order_id, from_status, to_status, side, at) values ($1, 'review', 'done', 'dispatcher', now() - $2::interval)", [id, ago]);
      for (const n of natures) await c.query("insert into goods_defects (order_id, defect, place, nature, created_by) values ($1, 'не включается', 'корпус', $2, $3)", [id, n, expert]);
    };
    await done('Смартфон: не включается', 'gadget', '1 minute', ['production', 'operation']);
    await done('Смартфон: трещина', 'gadget', '2 minutes', ['production']);
    await done('Холодильник', 'appliance', '3 minutes', []);
    return { orgId: org.id, expert };
  });

  await hp.goto(`/kabinet#org=${orgId}`);
  const box = hp.locator('#org-report-goods-box');
  await expect(box).toBeVisible();
  await expect(hp.locator('#org-report-goods-total')).toHaveText(
    'сдано товароведческих: 3 дела · в таблицах 3 недостатка: производственных — 2, эксплуатационных — 1 · дел с производственным недостатком: 2 · без таблицы недостатков: 1.');
  await expect(box.locator('li[data-report-goods="gadget"] .title')).toHaveText('Телефон, планшет, ноутбук, компьютер — 2 дела');
  await expect(box.locator('li[data-report-goods="gadget"] .muted')).toHaveText('в таблицах 3 недостатка: производственных — 2, эксплуатационных — 1');
  await expect(box.locator('li[data-report-goods="appliance"] .muted')).toHaveText('таблиц недостатков нет');
  await expect(box.locator(`li[data-report-goods-expert="${expert}"] .title`)).toHaveText('Тестова-Товарная Анна — 3 дела');
  await expect(hp.locator('#org-report-car-box')).toBeHidden();
  await box.scrollIntoViewIfNeeded();
  await shot(hp, 'gw11-2488-svodka-tovar');
  expect(hp.problems).toEqual([]);
});
