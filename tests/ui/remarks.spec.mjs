// Замечания к сданному отчёту (задача 2.431) — телефон 412×915: заказчик после «готово» нажимает «Пришли замечания к отчёту»,
// пишет, что прислал банк, и прикладывает файл; дело снова у эксперта — у него в «Ходе заявки» замечания, срок ответа и файл.
// Что разрешено и кому — считает сервер (tests/server/remarks.test.mjs). Номера +7 999 000-43-1x — только здесь.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DB_URL, TEST_TOKEN } from '../helpers.mjs';
import { workdaysAfter } from '../../src/orders/holidays.mjs';
import { todayMsk } from '../../src/orders/workflow.mjs';

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
const dayRu = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' });

test('2.431: пришли замечания к отчёту — заказчик передаёт текст и файл, эксперт видит их и срок ответа', async ({ browser, baseURL }) => {
  const cp = await phone(browser, baseURL);
  const sp = await phone(browser, baseURL);
  const customer = await signIn(cp, '+79990004315');
  const expert = await signIn(sp, '+79990004316');
  const id = await db(async (c) => {
    await c.query("update users set full_name = 'Заказчикова Вера' where id = $1", [customer.id]);
    await c.query("update users set full_name = 'Оценщиков Пётр' where id = $1", [expert.id]);
    await c.query('insert into specialists (user_id) values ($1)', [expert.id]);
    const oid = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields)
      values ($1, 'Квартира для ипотеки', 'expertise', 'realty', 'done', $2, current_date - 2, $3) returning id`,
    [customer.id, expert.id, { purpose: 'bank', region: 'moscow', object_type: 'flat', address: 'г. Москва, ул. Замечаний, д. 1', area: '40' }])).rows[0].id;
    await c.query("insert into order_status_history (order_id, from_status, to_status, side) values ($1, 'review', 'done', 'dispatcher')", [oid]);
    return oid;
  });

  await cp.goto(`/kabinet#order=${id}`);
  const btn = cp.locator('#actions').getByRole('button', { name: 'Пришли замечания к отчёту' });
  await expect(btn).toBeVisible();
  await expect(cp.locator('#reason-box')).toBeHidden();
  await btn.click();
  await expect(cp.locator('#remarks-form')).toBeVisible();
  await expect(cp.locator('#remarks-lead')).toContainText('ответ — за 3 рабочих дня');
  await cp.getByRole('button', { name: 'Передать замечания эксперту' }).click();
  await expect(cp.locator('#remarks-msg')).toHaveText('Опишите, что пишут в замечаниях');
  await cp.getByLabel('Что пишут в замечаниях').fill('Банк просит пояснить выбор аналогов и скидку на торг');
  await cp.getByLabel('Файл замечаний (если есть)').setInputFiles({ name: 'Замечания банка.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF замечания банка') });
  await cp.locator('#remarks-form').scrollIntoViewIfNeeded();
  await shot(cp, 'rm01-2431-zamechaniya-zakazchik');
  await cp.getByRole('button', { name: 'Передать замечания эксперту' }).click();
  await expect(cp.locator('#status-msg')).toHaveText('Замечания переданы эксперту');
  await expect(cp.locator('#remarks-form')).toBeHidden();
  const due = dayRu(workdaysAfter(todayMsk(), 3));
  await expect(cp.locator('#remarks-view')).toContainText(`ответить до ${due}`);
  await expect(cp.locator('#docs li').filter({ hasText: 'Замечания банка.pdf' })).toHaveCount(1);

  // Эксперт: уведомление ведёт к делу, в «Ходе заявки» — замечания, срок ответа и файл.
  await sp.goto('/kabinet#notifications');
  await expect(sp.locator('body')).toContainText('К сданному отчёту пришли замечания от банка или суда');
  await sp.goto(`/kabinet#order=${id}`);
  const view = sp.locator('#remarks-view');
  await expect(view).toBeVisible();
  await expect(view.locator('#remarks-title')).toHaveText('Замечания к отчёту');
  await expect(view).toContainText(`ответить до ${due}`);
  await expect(view).toContainText('Банк просит пояснить выбор аналогов и скидку на торг');
  await expect(view.getByRole('button', { name: 'Файл замечаний: Замечания банка.pdf' })).toBeVisible();
  await expect(sp.locator('#order-status')).toHaveText('В работе');
  await expect(sp.locator('#order-deadline')).toContainText(due);
  await view.scrollIntoViewIfNeeded();
  await shot(sp, 'rm02-2431-zamechaniya-ekspert');
  expect(cp.problems).toEqual([]);
  expect(sp.problems).toEqual([]);
  await cp.context().close();
  await sp.context().close();
});
