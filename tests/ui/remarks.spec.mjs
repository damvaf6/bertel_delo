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

test('2.434: новая редакция отчёта — тот же номер, «Редакция от …», прежняя редакция остаётся в деле', async ({ browser, baseURL }) => {
  const sp = await phone(browser, baseURL);
  const expert = await signIn(sp, '+79990004321');
  const id = await db(async (c) => {
    await c.query("update users set full_name = 'Редакций Пётр' where id = $1", [expert.id]);
    await c.query('insert into specialists (user_id) values ($1)', [expert.id]);
    const oid = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields,
        remarks_at, remarks_due, remarks_round, report_number, report_number_on, report_number_by)
      values ($1, 'Квартира: новая редакция', 'expertise', 'realty', 'in_work', $1, current_date + 5, $2, now(), current_date + 3, 1,
        '7/2026', current_date - 3, $1) returning id`,
    [expert.id, { purpose: 'bank', region: 'moscow', object_type: 'flat', address: 'г. Москва, ул. Редакций, д. 4', area: '48' }])).rows[0].id;
    await c.query(`insert into documents (order_id, uploaded_by, filename, mime, size_bytes, storage_key, kind, created_at)
      values ($1, $2, 'Отчёт об оценке 7-2026.pdf', 'application/pdf', 1, $3, 'result', now() - interval '3 days')`, [oid, expert.id, `ui/2434/${oid}`]);
    await c.query("insert into result_drafts (order_id, author_id, source, body) values ($1, $2, 'edit', '1. Общие сведения\nТекст.')", [oid, expert.id]);
    return oid;
  });
  const first = new Date(Date.now() + 3 * 3_600_000 - 3 * 86_400_000).toISOString().slice(0, 10).split('-').reverse().join('.');
  const today = todayMsk().split('-').reverse().join('.');

  await sp.goto(`/kabinet#order=${id}`);
  await expect(sp.locator('#draft-number-line')).toContainText('Номер отчёта: № 7/2026');
  const ed = sp.locator('#draft-edition');
  await expect(ed).toContainText(`дата составления — первой редакции (${first})`);
  await expect(ed).toContainText(`«Редакция от ${today}»`);
  const doc = sp.locator('#docs li.doc', { hasText: 'Отчёт об оценке 7-2026.pdf' });
  await expect(doc.locator('[data-role="prior-edition"]')).toHaveText(`Прежняя редакция — сдана до замечаний от ${today}. Остаётся в деле.`);
  await expect(doc.getByRole('button', { name: 'Удалить' })).toHaveCount(0);
  await doc.scrollIntoViewIfNeeded();
  await shot(sp, 'rm07-2434-prezhnyaya-redakciya');
  await ed.scrollIntoViewIfNeeded();
  await shot(sp, 'rm08-2434-novaya-redakciya');
  expect(sp.problems).toEqual([]);
  await sp.context().close();
});

test('2.435: проверка исправленного отчёта по пунктам — изменился ли раздел с прихода замечаний', async ({ browser, baseURL }) => {
  const cp = await phone(browser, baseURL);
  const sp = await phone(browser, baseURL);
  const customer = await signIn(cp, '+79990004322');
  const expert = await signIn(sp, '+79990004323');
  const before = '## 1. Задание на оценку\nОбъект — квартира\n## 8. Расчёт стоимости\n### 8.2 Сравнительный подход\nАналог 3 — ул. Дальняя\n## 9. Описание объекта\nПлощадь 52 кв. м';
  const after = before.replace('Аналог 3 — ул. Дальняя', 'Аналог 3 — ул. Проверок, тот же район');
  const id = await db(async (c) => {
    await c.query("update users set full_name = 'Проверкин Пётр' where id = $1", [expert.id]);
    await c.query('insert into specialists (user_id) values ($1)', [expert.id]);
    const oid = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields,
        remarks_at, remarks_due, remarks_round)
      values ($1, 'Квартира: проверка по пунктам', 'expertise', 'realty', 'in_work', $2, current_date + 5, $3, now() - interval '1 day', current_date + 3, 1) returning id`,
    [customer.id, expert.id, { purpose: 'bank', region: 'moscow', object_type: 'flat', address: 'г. Москва, ул. Проверок, д. 5', area: '52' }])).rows[0].id;
    await c.query(`insert into order_status_history (order_id, from_status, to_status, side, reason) values ($1, 'done', 'in_work', 'customer', $2)`,
      [oid, 'Банк пишет:\n1. Обоснуйте выбор аналогов\n2. Уточните площадь\n3. Скидка на торг без источника']);
    await c.query(`insert into result_drafts (order_id, author_id, source, body, at) values ($1, $2, 'edit', $3, now() - interval '2 days'),
      ($1, $2, 'edit', $4, now())`, [oid, expert.id, before, after]);
    await c.query(`insert into remark_items (order_id, round, pos, body, resolution, note, place, by_ai) values
      ($1, 1, 0, 'Обоснуйте выбор аналогов', 'fixed', 'Аналог 3 заменён', 'раздел 8.2, стр. 31', true),
      ($1, 1, 1, 'Уточните площадь', 'fixed', 'Площадь уточнена', 'раздел 9', true),
      ($1, 1, 2, 'Скидка на торг без источника', 'explained', 'По справочнику', null, true)`, [oid]);
    return oid;
  });

  await sp.goto(`/kabinet#order=${id}`);
  const box = sp.locator('#remarks-items-box');
  const items = box.locator('#remarks-items > li');
  await expect(items.nth(0).locator('.rm-check')).toHaveText('По черновику: раздел «8.2 Сравнительный подход» изменён (добавлено 1 абзац, убрано 1 абзац)');
  await expect(items.nth(1).locator('.rm-check')).toHaveText('По черновику: в разделе «9. Описание объекта» с прихода замечаний ничего не изменилось — проверьте');
  await expect(items.nth(2).locator('.rm-check')).toHaveCount(0);
  await expect(sp.locator('#remarks-check')).toHaveText('Проверка по черновику: изменения видны по 1 из 2 исправленных пунктов · проверьте: 1.');
  await box.scrollIntoViewIfNeeded();
  await shot(sp, 'rm09-2435-proverka-punktov');

  // Эксперт исправил отметку: площадь — пояснение без правки; после сохранения сомнений нет.
  await items.nth(1).getByLabel('Пояснение без правки').check();
  await box.getByRole('button', { name: 'Сохранить пункты' }).click();
  await expect(sp.locator('#remarks-items-msg')).toHaveText('Сохранено · все пункты отмечены');
  await expect(sp.locator('#remarks-check')).toHaveText('Проверка по черновику: изменения видны по 1 из 1 исправленных пунктов.');
  await expect(items.nth(1).locator('.rm-check')).toHaveCount(0);

  // Заказчик черновика не видит — и проверки тоже.
  await cp.goto(`/kabinet#order=${id}`);
  const cbox = cp.locator('#remarks-items-box');
  await expect(cbox).toContainText('Обоснуйте выбор аналогов');
  await expect(cbox.locator('.rm-check')).toHaveCount(0);
  await expect(cp.locator('#remarks-check')).toBeHidden();
  expect(cp.problems).toEqual([]);
  expect(sp.problems).toEqual([]);
  await cp.context().close();
  await sp.context().close();
});

test('2.436: руководитель — отбор «Замечания к сданному отчёту» со сроком ответа; подпись организации новой редакции', async ({ browser, baseURL }) => {
  const hp = await phone(browser, baseURL);
  const sp = await phone(browser, baseURL);
  const head = await signIn(hp, '+79990004324');
  const expert = await signIn(sp, '+79990004325');
  const customer = await db(async (c) => (await c.query("insert into users (phone) values ('+79990004326') returning id")).rows[0]);
  const due = workdaysAfter(todayMsk(), 1);
  // Замечания пришли час назад: в первый час после полуночи по Москве это вчерашний день.
  const came = todayMsk(new Date(Date.now() - 3600e3));
  const { orgId, id } = await db(async (c) => {
    await c.query("update users set full_name = 'Руководителева Анна' where id = $1", [head.id]);
    await c.query("update users set full_name = 'Редакциев Пётр' where id = $1", [expert.id]);
    const org = (await c.query("insert into organizations (name) values ('ООО «Замечания 2.436»') returning id")).rows[0].id;
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head'), ($1, $3, 'member')", [org, head.id, expert.id]);
    await c.query('insert into specialists (user_id, org_id) values ($1, $2)', [expert.id, org]);
    const oid = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields,
        remarks_at, remarks_due, remarks_round, report_number)
      values ($1, 'Квартира: замечания банка', 'expertise', 'realty', 'in_work', $2, current_date + 5, $3, now() - interval '1 hour', $4, 1, '17/2026') returning id`,
    [customer.id, expert.id, { purpose: 'bank', region: 'moscow', object_type: 'flat', address: 'г. Москва, ул. Редакций, д. 3', area: '48' }, due])).rows[0].id;
    await c.query(`insert into order_status_history (order_id, from_status, to_status, side, reason) values ($1, 'done', 'in_work', 'customer', 'Банк: 1. Обоснуйте аналоги 2. Уточните площадь')`, [oid]);
    await c.query(`insert into remark_items (order_id, round, pos, body, resolution, note, by_ai) values
      ($1, 1, 0, 'Обоснуйте аналоги', 'fixed', 'Аналоги заменены', true), ($1, 1, 1, 'Уточните площадь', null, null, true)`, [oid]);
    return { orgId: org, id: oid };
  });
  // Две редакции файла результата: первая сдана до замечаний, вторая — исправленная; обе подписаны экспертом.
  const put = async (name) => {
    const r = await sp.request.post(`/api/orders/${id}/results`, { data: Buffer.from(`%PDF ${name}`),
      headers: { ...H, 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name) } });
    expect(r.status()).toBe(201);
    const doc = (await r.json()).document;
    expect((await sp.request.post(`/api/documents/${doc.id}/sign`, { data: { confirm: true }, headers: H })).status()).toBe(201);
    return doc;
  };
  const first = await put('Отчёт 17-2026.pdf');
  await db((c) => c.query("update documents set created_at = now() - interval '3 days' where id = $1", [first.id]));
  await put('Отчёт 17-2026 (редакция 2).pdf');

  await hp.goto(`/kabinet#org=${orgId}`);
  const chip = hp.locator('#org-cases-filter [data-filter="remarks"]');
  await expect(chip).toHaveText('Замечания к сданному отчёту · 1');
  await chip.click();
  const line = hp.locator('#org-cases > li').first().locator('[data-role="remarks"]');
  await expect(line).toHaveText(new RegExp(`^Замечания к отчёту от ${dayRu(came)}( \\d{4} г\\.)? · ответить до ${dayRu(due)}( \\d{4} г\\.)? · пунктов 2, без отметки 1$`));
  await expect(line).toHaveClass(/overdue/);
  await hp.locator('#org-cases-list-title').scrollIntoViewIfNeeded();
  await shot(hp, 'rm10-2436-rukovoditel-zamechaniya');

  // Подпись организации: «Новая редакция отчёта № …», прежняя — с пометкой и без кнопок подписи.
  const item = hp.locator('#org-sign li[data-item]').first();
  await expect(item.locator('[data-sig="edition"]')).toHaveText(`Новая редакция отчёта № 17/2026 — после замечаний от ${came.split('-').reverse().join('.')} · ответить до ${due.split('-').reverse().join('.')}`);
  const prior = item.locator(`li[data-doc="${first.id}"]`);
  await expect(prior.locator('[data-role="prior-edition"]')).toContainText('Прежняя редакция — сдана до замечаний');
  await expect(prior.locator('[data-action="org-sign"]')).toHaveCount(0);
  await expect(item.locator('[data-action="org-sign"]')).toHaveCount(1);
  await expect(item.locator('[data-action="org-sign-all"]')).toHaveCount(0);
  await item.scrollIntoViewIfNeeded();
  await shot(hp, 'rm11-2436-podpis-novoy-redakcii');
  expect(hp.problems).toEqual([]);
  expect(sp.problems).toEqual([]);
  await hp.context().close();
  await sp.context().close();
});

test('2.437: сводка за месяц — замечания после сдачи по пользователям отчёта и частые пункты', async ({ browser, baseURL }) => {
  const hp = await phone(browser, baseURL);
  const head = await signIn(hp, '+79990004327');
  const { orgId } = await db(async (c) => {
    const expert = (await c.query("insert into users (phone, full_name) values ('+79990004328', 'Сводкин-Замечаев Иван') returning id")).rows[0].id;
    const customer = (await c.query("insert into users (phone) values ('+79990004329') returning id")).rows[0].id;
    await c.query("update users set full_name = 'Руководителева Ольга' where id = $1", [head.id]);
    const org = (await c.query("insert into organizations (name) values ('ООО «Замечания 2.437»') returning id")).rows[0].id;
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head'), ($1, $3, 'member')", [org, head.id, expert]);
    await c.query('insert into specialists (user_id, org_id) values ($1, $2)', [expert, org]);
    const cases = [['Квартира: замечания суда', { purpose: 'court' }, ['Обоснуйте выбор аналогов', 'Уточните площадь'], 2],
      ['Дом: замечания Сбербанка', { purpose: 'bank', bank: 'sber' }, ['Обоснуйте выбор аналогов.', 'Приложите свежую выписку ЕГРН'], 1]];
    for (const [title, f, items, rounds] of cases) {
      const oid = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields,
          remarks_at, remarks_due, remarks_round)
        values ($1, $2, 'expertise', 'realty', 'in_work', $3, current_date + 5, $4, now(), current_date + 3, $5) returning id`,
      [customer, title, expert, { region: 'moscow', object_type: 'flat', ...f }, rounds])).rows[0].id;
      for (let r = 1; r <= rounds; r++) {
        await c.query(`insert into order_status_history (order_id, from_status, to_status, side, reason) values ($1, 'done', 'in_work', 'customer', 'Замечания')`, [oid]);
        for (const [i, body] of items.entries()) {
          await c.query('insert into remark_items (order_id, round, pos, body) values ($1, $2, $3, $4)', [oid, r, i, body]);
        }
      }
    }
    return { orgId: org };
  });

  await hp.goto(`/kabinet#org=${orgId}`);
  const box = hp.locator('#org-report-after-box');
  await expect(box).toBeVisible();
  await expect(hp.locator('#org-report-after-total')).toHaveText('замечания к сданному отчёту пришли по 2 делам · всего 3 раза · пунктов: 6');
  const users = hp.locator('#org-report-after-users > li');
  await expect(users).toHaveCount(2);
  await expect(users.nth(0).locator('.title')).toHaveText('Суд — 1 дело');
  await expect(users.nth(0).locator('.muted')).toHaveText('замечания приходили 2 раза · пунктов: 4 · чаще всего: «Уточните площадь» ×2, «Обоснуйте выбор аналогов» ×2');
  await expect(users.nth(1).locator('.title')).toHaveText('Сбербанк — 1 дело');
  await expect(hp.locator('#org-report-after > li').first()).toHaveText('Обоснуйте выбор аналогов. — 3 раза');
  await expect(hp.locator('#org-report [data-expert-after]')).toContainText('замечания к сданному отчёту пришли по 2 делам');
  await box.scrollIntoViewIfNeeded();
  await shot(hp, 'rm12-2437-svodka-zamechaniya');
  expect(hp.problems).toEqual([]);
  await hp.context().close();
});

const full = (iso) => `${dayRu(iso)} ${iso.slice(0, 4)} г.`;
test('2.438: перечень для СРО — новая редакция после замечаний вместо прежней', async ({ browser, baseURL }) => {
  const sp = await phone(browser, baseURL);
  const expert = await signIn(sp, '+79990004330');
  const id = await db(async (c) => {
    await c.query("update users set full_name = 'Редакциева Анна' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, created_at) values ($1, now() - interval '2 years')", [expert.id]);
    const oid = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields, remarks_at, remarks_round)
      values ($1, 'Квартира: две редакции', 'expertise', 'realty', 'done', $1, current_date, $2, now() - interval '1 day', 1) returning id`,
    [expert.id, { purpose: 'court', address: 'г. Москва, ул. Редакций, д. 2' }])).rows[0].id;
    await c.query("insert into order_status_history (order_id, from_status, to_status, side) values ($1, 'review', 'done', 'dispatcher')", [oid]);
    return oid;
  });
  const put = async (name, value) => {
    const text = `ОТЧЁТ ОБ ОЦЕНКЕ № 88/2026 от 12.10.2026\nИтоговая величина рыночной стоимости объекта оценки составляет ${value} руб.\nОтчёт № 88/2026`;
    const r = await sp.request.post(`/api/orders/${id}/documents`, { data: Buffer.from(text), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) } });
    expect(r.status()).toBe(201);
    return (await r.json()).document.id;
  };
  const old = await put('отчёт.txt', '9 870 000');
  await put('отчёт (редакция 2).txt', '9 500 000');
  await db(async (c) => {
    await c.query("update documents set kind = 'result' where order_id = $1", [id]);
    await c.query("update documents set created_at = now() - interval '2 days' where id = $1", [old]);
  });

  await sp.goto('/kabinet#specialist');
  const row = sp.locator(`#registry-rows > li[data-registry="${id}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator('.title')).toHaveText(/Отчёт № 88\/2026 от 12 октября|Отчёт № 88\/2026 от 12\.10\.2026/);
  await expect(row).toContainText('9 500 000');
  await expect(row).not.toContainText('9 870 000');
  await expect(row.locator('[data-registry-edition]')).toHaveText(`Новая редакция от ${full(todayMsk())} — после замечаний от ${full(todayMsk(new Date(Date.now() - 864e5)))}; прежняя остаётся в деле и в архиве`);
  await row.scrollIntoViewIfNeeded();
  await shot(sp, 'rm13-2438-perechen-redakciya');
  expect(sp.problems).toEqual([]);
  await sp.context().close();
});

test('2.439: «Сегодня» эксперта — замечания к сданному отчёту, ответить завтра; сразу к пунктам в деле', async ({ browser, baseURL }) => {
  const sp = await phone(browser, baseURL);
  const expert = await signIn(sp, '+79990004331');
  const due = workdaysAfter(todayMsk(), 1);
  const id = await db(async (c) => {
    await c.query("update users set full_name = 'Ответова Нина' where id = $1", [expert.id]);
    await c.query('insert into specialists (user_id) values ($1)', [expert.id]);
    const oid = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields, remarks_at, remarks_due, remarks_round)
      values ($1, 'Квартира: ответ банку', 'expertise', 'realty', 'in_work', $1, $2, $3, now() - interval '2 hours', $2, 1) returning id`,
    [expert.id, due, { purpose: 'bank', bank: 'sber', address: 'г. Москва, ул. Ответов, д. 3' }])).rows[0].id;
    await c.query("insert into order_status_history (order_id, from_status, to_status, side, reason) values ($1, 'done', 'in_work', 'customer', 'Сбербанк: 1. Обоснуйте аналоги 2. Уточните площадь')", [oid]);
    await c.query(`insert into remark_items (order_id, round, pos, body, resolution) values ($1, 1, 1, 'Обоснуйте аналоги', 'fixed'), ($1, 1, 2, 'Уточните площадь', null)`, [oid]);
    return oid;
  });

  await sp.goto('/kabinet');
  const box = sp.locator('#today-box');
  await expect(box.locator('li[data-today="remarks"]')).toHaveText('Замечания к отчёту — ответить · 1');
  const item = box.locator('li[data-today-item="remarks"]').first();
  await expect(item).toContainText('Квартира: ответ банку');
  const wd = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][new Date(`${due}T00:00:00Z`).getUTCDay()];
  await expect(item.locator('[data-role="remarks-when"]')).toHaveText(new RegExp(`^Ответить до ${wd}, ${dayRu(due)} · замечания пришли `));
  await expect(item.locator('[data-role="remarks-left"]')).toHaveText('пунктов: 2 · без отметки: 1 — отметьте их');
  await expect(box.locator('li[data-today-item="hot"]')).toHaveCount(0);
  await item.scrollIntoViewIfNeeded();
  await shot(sp, 'rm14-2439-segodnya-zamechaniya');
  await item.locator('button.open').click();
  await expect(sp).toHaveURL(new RegExp(`#order=${id}&to=remarks$`));
  await expect(sp.locator('#remarks-items-box')).toBeVisible();
  await expect(sp.locator('#remarks-items-lead')).toContainText('без отметки: 1');
  expect(sp.problems).toEqual([]);
  await sp.context().close();
});

test('прогон 2.440: ответ на замечания готовится — отчёт в перечне для СРО по сданной редакции', async ({ browser, baseURL }) => {
  const sp = await phone(browser, baseURL);
  const expert = await signIn(sp, '+79990004332');
  const due = workdaysAfter(todayMsk(), 3);
  const id = await db(async (c) => {
    await c.query("update users set full_name = 'Ответова Нина' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, created_at) values ($1, now() - interval '2 years')", [expert.id]);
    const oid = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields, remarks_at, remarks_due, remarks_round)
      values ($1, 'Квартира: ответ готовится', 'expertise', 'realty', 'in_work', $1, $3, $2, now(), $3, 1) returning id`,
    [expert.id, { purpose: 'bank', address: 'г. Москва, ул. Ответов, д. 3' }, due])).rows[0].id;
    await c.query("insert into order_status_history (order_id, from_status, to_status, side, at) values ($1, 'review', 'done', 'dispatcher', now() - interval '2 days')", [oid]);
    await c.query("insert into order_status_history (order_id, from_status, to_status, side, reason) values ($1, 'done', 'in_work', 'customer', 'Банк: обоснуйте аналоги')", [oid]);
    return oid;
  });
  const put = async (name, value) => {
    const text = `ОТЧЁТ ОБ ОЦЕНКЕ № 91/2026 от 20.10.2026\nИтоговая величина рыночной стоимости объекта оценки составляет ${value} руб.\nОтчёт № 91/2026`;
    const r = await sp.request.post(`/api/orders/${id}/documents`, { data: Buffer.from(text), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) } });
    expect(r.status(), await r.text()).toBe(201);
    return (await r.json()).document.id;
  };
  const old = await put('отчёт.txt', '7 400 000');
  await put('отчёт (черновик новой редакции).txt', '7 100 000');
  await db(async (c) => {
    await c.query("update documents set kind = 'result' where order_id = $1", [id]);
    await c.query("update documents set created_at = now() - interval '2 days' where id = $1", [old]);
  });

  await sp.goto('/kabinet#specialist');
  const row = sp.locator(`#registry-rows > li[data-registry="${id}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('Отчёт № 91/2026');
  await expect(row).toContainText('7 400 000');
  await expect(row).not.toContainText('7 100 000');
  await expect(row.locator('[data-registry-edition]')).toHaveText(`Пришли замечания от ${full(todayMsk())} — ответ готовится (ответить до ${full(due)}); в перечне — сданная редакция`);
  await expect(sp.locator('#registry-holes')).not.toContainText('91/2026');
  await row.scrollIntoViewIfNeeded();
  await shot(sp, 'rm15-2440-perechen-otvet-gotovitsya');
  expect(sp.problems).toEqual([]);
  await sp.context().close();
});
