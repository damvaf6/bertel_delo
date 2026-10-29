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

test('2.432: замечания пунктами — ИИ разбирает, эксперт правит и отмечает, заказчик видит пункты', async ({ browser, baseURL }) => {
  const cp = await phone(browser, baseURL);
  const sp = await phone(browser, baseURL);
  const customer = await signIn(cp, '+79990004317');
  const expert = await signIn(sp, '+79990004318');
  const id = await db(async (c) => {
    await c.query("update users set full_name = 'Заказчикова Нина' where id = $1", [customer.id]);
    await c.query("update users set full_name = 'Оценщиков Иван' where id = $1", [expert.id]);
    await c.query('insert into specialists (user_id) values ($1)', [expert.id]);
    const oid = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields,
        remarks_at, remarks_due, remarks_round)
      values ($1, 'Квартира: замечания пунктами', 'expertise', 'realty', 'in_work', $2, current_date + 5, $3, now(), current_date + 3, 1) returning id`,
    [customer.id, expert.id, { purpose: 'bank', region: 'moscow', object_type: 'flat', address: 'г. Москва, ул. Пунктов, д. 2', area: '41' }])).rows[0].id;
    await c.query(`insert into order_status_history (order_id, from_status, to_status, side, reason) values ($1, 'done', 'in_work', 'customer', $2)`,
      [oid, 'Банк пишет:\n1. Обоснуйте выбор аналогов\n2. Скидка на торг без источника']);
    return oid;
  });

  await sp.goto(`/kabinet#order=${id}`);
  const box = sp.locator('#remarks-items-box');
  await expect(box).toBeVisible();
  await expect(box).toContainText('ИИ разделит замечания');
  await box.getByRole('button', { name: 'Разобрать на пункты' }).click();
  await expect(sp.locator('#remarks-items-msg')).toContainText('Пунктов: 2. Это предложение ИИ');
  await expect(sp.getByLabel('Пункт 1 (разобрал ИИ — проверьте)', { exact: true })).toHaveValue('Обоснуйте выбор аналогов');
  await expect(sp.getByLabel('Пункт 2 (разобрал ИИ — проверьте)', { exact: true })).toHaveValue('Скидка на торг без источника');
  await expect(box.getByRole('button', { name: 'Разобрать заново' })).toBeVisible();

  // Отметки и пояснения; свой пункт; пустой — нельзя сохранить.
  const items = box.locator('#remarks-items > li');
  await items.nth(0).getByLabel('Исправлено в отчёте').check();
  await items.nth(0).getByLabel('Что исправлено', { exact: true }).fill('Аналог 3 заменён, раздел 8.2');
  await items.nth(1).getByLabel('Пояснение без правки').check();
  await items.nth(1).getByLabel('Что пояснить банку или суду').fill('Скидка — по справочнику, ссылка в разделе 9');
  await box.getByRole('button', { name: 'Добавить пункт' }).click();
  await expect(sp.getByLabel('Пункт 3', { exact: true })).toBeFocused();
  await box.getByRole('button', { name: 'Сохранить пункты' }).click();
  await expect(sp.locator('#remarks-items-msg')).toHaveText('Пункт 3: впишите текст или удалите пункт');
  await sp.getByLabel('Пункт 3', { exact: true }).fill('Проверить дату оценки на титуле');
  await expect(sp.locator('#remarks-items-lead')).toHaveText('Пунктов: 3 · без отметки: 1');
  await box.getByRole('button', { name: 'Сохранить пункты' }).click();
  await expect(sp.locator('#remarks-items-msg')).toHaveText('Сохранено · без отметки: 1');
  await box.scrollIntoViewIfNeeded();
  await shot(sp, 'rm03-2432-punkty-ekspert');

  // После перезагрузки — то же; удалил пункт — сохранилось.
  await sp.reload();
  await expect(sp.getByLabel('Пункт 3', { exact: true })).toHaveValue('Проверить дату оценки на титуле');
  await expect(items.nth(0).getByLabel('Исправлено в отчёте')).toBeChecked();
  await items.nth(2).getByRole('button', { name: 'Удалить пункт' }).click();
  await box.getByRole('button', { name: 'Сохранить пункты' }).click();
  await expect(sp.locator('#remarks-items-msg')).toHaveText('Сохранено · все пункты отмечены');

  // Заказчик: пункты и отметки без правки.
  await cp.goto(`/kabinet#order=${id}`);
  const cbox = cp.locator('#remarks-items-box');
  await expect(cbox).toBeVisible();
  await expect(cbox.locator('#remarks-items > li')).toHaveCount(2);
  await expect(cbox).toContainText('Исправлено в отчёте');
  await expect(cbox).toContainText('Скидка — по справочнику, ссылка в разделе 9');
  await expect(cbox.locator('textarea')).toHaveCount(0);
  await expect(cbox.getByRole('button', { name: 'Разобрать заново' })).toBeHidden();
  await expect(cbox.getByRole('button', { name: 'Сохранить пункты' })).toBeHidden();
  await cbox.scrollIntoViewIfNeeded();
  await shot(cp, 'rm04-2432-punkty-zakazchik');
  expect(cp.problems).toEqual([]);
  expect(sp.problems).toEqual([]);
  await cp.context().close();
  await sp.context().close();
});

test('2.433: «Ответ на замечания» Word — где в отчёте, скачать и приложить к исправленному отчёту', async ({ browser, baseURL }) => {
  const cp = await phone(browser, baseURL);
  const sp = await phone(browser, baseURL);
  const customer = await signIn(cp, '+79990004319');
  const expert = await signIn(sp, '+79990004320');
  const id = await db(async (c) => {
    await c.query("update users set full_name = 'Заказчикова Вера' where id = $1", [customer.id]);
    await c.query("update users set full_name = 'Ответов Пётр' where id = $1", [expert.id]);
    await c.query('insert into specialists (user_id) values ($1)', [expert.id]);
    const oid = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields,
        remarks_at, remarks_due, remarks_round)
      values ($1, 'Квартира: ответ на замечания', 'expertise', 'realty', 'in_work', $2, current_date + 5, $3, now(), current_date + 3, 1) returning id`,
    [customer.id, expert.id, { purpose: 'bank', region: 'moscow', object_type: 'flat', address: 'г. Москва, ул. Ответов, д. 3', area: '52' }])).rows[0].id;
    await c.query(`insert into order_status_history (order_id, from_status, to_status, side, reason) values ($1, 'done', 'in_work', 'customer', $2)`,
      [oid, 'Банк пишет:\n1. Обоснуйте выбор аналогов\n2. Скидка на торг без источника']);
    await c.query(`insert into remark_items (order_id, round, pos, body, resolution, note, by_ai) values
      ($1, 1, 0, 'Обоснуйте выбор аналогов', 'fixed', 'Аналог 3 заменён', true), ($1, 1, 1, 'Скидка на торг без источника', null, null, true)`, [oid]);
    return oid;
  });

  await sp.goto(`/kabinet#order=${id}`);
  const box = sp.locator('#remarks-items-box');
  await expect(box).toBeVisible();
  // Пока не все отмечены — только подсказка, без кнопок.
  await expect(sp.locator('#remarks-answer-lead')).toContainText('Когда у каждого пункта будет отметка');
  await expect(box.getByRole('button', { name: 'Скачать «Ответ на замечания» Word' })).toBeHidden();

  const items = box.locator('#remarks-items > li');
  await items.nth(0).getByLabel('Где в отчёте', { exact: true }).fill('раздел 8.2, стр. 31');
  await items.nth(1).getByLabel('Пояснение без правки').check();
  await items.nth(1).getByLabel('Что пояснить банку или суду').fill('Скидка — по справочнику Лейфера');
  await box.getByRole('button', { name: 'Сохранить пункты' }).click();
  await expect(sp.locator('#remarks-items-msg')).toHaveText('Сохранено · все пункты отмечены');
  await expect(sp.locator('#remarks-answer-lead')).toContainText('Приложите его к исправленному отчёту');

  // Правка без сохранения — «Скачать» сначала сохраняет, потом отдаёт Word.
  await items.nth(1).getByLabel('Где в отчёте', { exact: true }).fill('раздел 9');
  const [dl] = await Promise.all([sp.waitForEvent('download'), box.getByRole('button', { name: 'Скачать «Ответ на замечания» Word' }).click()]);
  expect(dl.suggestedFilename()).toMatch(/^Ответ на замечания [0-9A-F]{8}\.docx$/);
  const place = await db(async (c) => (await c.query('select place from remark_items where order_id = $1 order by pos', [id])).rows.map((r) => r.place));
  expect(place).toEqual(['раздел 8.2, стр. 31', 'раздел 9']);

  await box.getByRole('button', { name: 'Приложить к исправленному отчёту' }).click();
  await expect(sp.locator('#status-msg')).toContainText('Ответ на замечания приложен');
  await expect(sp.locator('#remarks-answer-lead')).toContainText('Ответ приложен к делу файлом результата');
  await expect(box.getByRole('button', { name: 'Заменить приложенный ответ' })).toBeVisible();
  await expect(sp.locator('body')).toContainText(/Ответ на замечания [0-9A-F]{8}\.docx/);
  await sp.locator('#remarks-answer-box').scrollIntoViewIfNeeded();
  await shot(sp, 'rm05-2433-otvet-ekspert');

  // Заказчик: где в отчёте и «Скачать», без «Приложить».
  await cp.goto(`/kabinet#order=${id}`);
  const cbox = cp.locator('#remarks-items-box');
  await expect(cbox).toContainText('Где в отчёте: раздел 8.2, стр. 31');
  await expect(cbox.getByRole('button', { name: 'Скачать «Ответ на замечания» Word' })).toBeVisible();
  await expect(cbox.getByRole('button', { name: /Приложить|Заменить/ })).toHaveCount(0);
  await cbox.scrollIntoViewIfNeeded();
  await shot(cp, 'rm06-2433-otvet-zakazchik');
  expect(cp.problems).toEqual([]);
  expect(sp.problems).toEqual([]);
  await cp.context().close();
  await sp.context().close();
});
