// Вызов эксперта в суд (задача 2.441) — телефон 412×915: заказчик после «готово» нажимает «Эксперта вызывают в суд», пишет
// суд, номер дела, дату и время заседания, адрес и прикладывает повестку; дело остаётся сданным, эксперт по уведомлению видит
// заседание в деле, а в «Моих сроках на две недели» — в его день (2.442). Что разрешено и кому — считает сервер (tests/server/court.test.mjs). Номера +7 999 000-44-2x — только здесь.
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
const plusDays = (n) => new Date(Date.now() + 3 * 3600 * 1000 + n * 86400000).toISOString().slice(0, 10);

test('2.441: эксперта вызывают в суд — заказчик пишет заседание и повестку, эксперт видит его в деле', async ({ browser, baseURL }) => {
  const cp = await phone(browser, baseURL);
  const sp = await phone(browser, baseURL);
  const customer = await signIn(cp, '+79990004421');
  const expert = await signIn(sp, '+79990004422');
  const id = await db(async (c) => {
    await c.query("update users set full_name = 'Заказчикова Алла' where id = $1", [customer.id]);
    await c.query("update users set full_name = 'Оценщиков Глеб' where id = $1", [expert.id]);
    await c.query('insert into specialists (user_id) values ($1)', [expert.id]);
    const oid = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields)
      values ($1, 'Квартира для суда', 'expertise', 'realty', 'done', $2, current_date - 2, $3) returning id`,
    [customer.id, expert.id, { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, ул. Судебная, д. 4', area: '52' }])).rows[0].id;
    await c.query("insert into order_status_history (order_id, from_status, to_status, side) values ($1, 'review', 'done', 'dispatcher')", [oid]);
    return oid;
  });
  const date = plusDays(6);

  await cp.goto(`/kabinet#order=${id}`);
  const box = cp.locator('#hearing-box');
  await expect(box).toBeVisible();
  await expect(box.locator('#hearing-lead')).toContainText('дело останется сданным');
  await box.getByRole('button', { name: 'Эксперта вызывают в суд' }).click();
  await expect(cp.locator('#hearing-form')).toBeVisible();
  await box.getByRole('button', { name: 'Передать эксперту' }).click();
  await expect(cp.locator('#hearing-msg')).toHaveText('Укажите суд');
  await cp.getByLabel('Суд', { exact: true }).fill('Тестовый районный суд г. Москвы');
  await cp.getByLabel('Номер дела в суде').fill('2-4421/2026');
  await cp.getByLabel('Дата заседания').fill(date);
  await cp.getByLabel('Время', { exact: true }).fill('9:5');
  await cp.getByLabel('Адрес суда, зал').fill('г. Москва, тестовая ул., 1, зал 12');
  await box.getByRole('button', { name: 'Передать эксперту' }).click();
  await expect(cp.locator('#hearing-msg')).toHaveText('Укажите время заседания, например 10:30');
  await cp.getByLabel('Время', { exact: true }).fill('10:30');
  await cp.getByLabel('Повестка или определение суда (если есть)').setInputFiles({ name: 'Повестка эксперту.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF повестка') });
  await box.scrollIntoViewIfNeeded();
  await shot(cp, 'ct01-2441-vyzov-v-sud-zakazchik');
  await box.getByRole('button', { name: 'Передать эксперту' }).click();
  await expect(cp.locator('#status-msg')).toHaveText('Вызов в суд передан эксперту');
  await expect(cp.locator('#hearing-form')).toBeHidden();
  await expect(cp.locator('#hearing-list li')).toHaveCount(1);
  await expect(cp.locator('#hearing-list li')).toContainText('10:30 — ближайшее');
  await expect(cp.locator('#order-status')).toHaveText('Готово');
  await expect(cp.locator('#docs li').filter({ hasText: 'Повестка эксперту.pdf' })).toHaveCount(1);

  // Эксперт: уведомление ведёт к заседанию в деле; дело по-прежнему сдано, кнопки «вызывают в суд» у него нет.
  await sp.goto('/kabinet#notifications');
  const note = sp.getByRole('button', { name: /^Вас вызывают в суд по сданному отчёту/ });
  await expect(note).toBeVisible();
  await note.click();
  await expect(sp).toHaveURL(new RegExp(`#order=${id}&to=court$`));
  const ebox = sp.locator('#hearing-box');
  await expect(ebox).toBeVisible();
  await expect(ebox.locator('li.hearing-next')).toContainText('Тестовый районный суд г. Москвы, дело № 2-4421/2026');
  await expect(ebox).toContainText('Адрес: г. Москва, тестовая ул., 1, зал 12');
  await expect(ebox.getByRole('button', { name: 'Повестка: Повестка эксперту.pdf' })).toBeVisible();
  await expect(ebox).toContainText('Сообщил заказчик');
  await expect(ebox.getByRole('button', { name: 'Эксперта вызывают в суд' })).toBeHidden();
  await expect(sp.locator('#order-status')).toHaveText('Готово');
  await ebox.scrollIntoViewIfNeeded();
  await shot(sp, 'ct02-2441-vyzov-v-sud-ekspert');

  // 2.442: заседание — в «Моих сроках на две недели» в свой день со временем, судом и адресом; в тот же день два дела к сдаче —
  // день перегружен («+ суд»); нажатие ведёт к вызову в суд в деле; в календарь телефона заседание идёт.
  await db(async (c) => {
    for (const t of ['Дом в Химках', 'Склад в Подольске']) {
      await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, price_kop, paid_at, deadline)
        values ($1, $2, 'expertise', 'realty', 'in_work', $1, 1500000, now(), $3::date)`, [expert.id, t, date]);
    }
  });
  await sp.goto('/kabinet#specialist');
  const sday = sp.locator(`#schedule-days > li[data-day="${date}"]`);
  await expect(sday).toBeVisible();
  const hearing = sday.locator('li[data-schedule-item="court"]');
  await expect(hearing).toContainText('10:30 · Заседание в суде: Квартира для суда');
  await expect(hearing).toContainText('Тестовый районный суд г. Москвы · дело № 2-4421/2026 · г. Москва, тестовая ул., 1, зал 12');
  await expect(sday.locator('.busy-mark')).toHaveText('много: к сдаче 2 + суд');
  await expect(sday.locator('[data-role="busy-court"]')).toContainText('заседание в суде и к сдаче 2 дела');
  await expect(sp.locator('#schedule-ics-box')).toBeVisible();
  await sday.scrollIntoViewIfNeeded();
  await shot(sp, 'ct03-2442-zasedanie-v-srokah');
  await hearing.locator('a').click();
  await expect(sp).toHaveURL(new RegExp(`#order=${id}&to=court$`));
  await expect(sp.locator('#hearing-box li.hearing-next')).toBeVisible();
  expect(cp.problems).toEqual([]);
  expect(sp.problems).toEqual([]);
  await cp.context().close();
  await sp.context().close();
});

test('2.443: заседание завтра — в «Сегодня» эксперта: что взять с собой, истёкший полис — красным', async ({ browser, baseURL }) => {
  const sp = await phone(browser, baseURL);
  const cp = await phone(browser, baseURL);
  const expert = await signIn(sp, '+79990004423');
  const customer = await signIn(cp, '+79990004424');
  await cp.context().close();
  const tomorrow = plusDays(1);
  const id = await db(async (c) => {
    await c.query('insert into specialists (user_id) values ($1)', [expert.id]);
    const oid = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields, report_number)
      values ($1, 'Дом в Одинцово для суда', 'expertise', 'realty', 'done', $2, current_date - 5, $3, '15/2026') returning id`,
    [customer.id, expert.id, { purpose: 'court', region: 'moscow', object_type: 'house', address: 'Московская обл., г. Одинцово, ул. Тестовая, 3' }])).rows[0].id;
    await c.query(`insert into documents (order_id, uploaded_by, filename, mime, size_bytes, storage_key, kind)
      values ($1, $2, 'Отчёт 15-2026.pdf', 'application/pdf', 1, $3, 'result')`, [oid, expert.id, `ui/2443/${oid}`]);
    await c.query(`insert into court_calls (order_id, court, case_no, hearing_at, address, created_by, side)
      values ($1, 'Одинцовский городской суд', '2-4423/2026', ($2::date + time '11:00') at time zone 'Europe/Moscow', 'Московская обл., г. Одинцово, ул. Неделина, 17, зал 3', $3, 'customer')`,
    [oid, tomorrow, customer.id]);
    await c.query(`insert into dossier_items (user_id, kind, title, number, valid_until, amount_kop) values
      ($1, 'certificate', 'Оценка недвижимости', 'А-4423', current_date + 300, null),
      ($1, 'policy', 'Тестовая страховая', 'П-4423', current_date, 30000000)`, [expert.id]);
    return oid;
  });

  await sp.goto('/kabinet');
  const row = sp.locator('li[data-today-item="court"]');
  await expect(row).toHaveCount(1);
  await expect(sp.locator('li[data-today="court"]')).toHaveText('Заседание в суде · 1');
  await expect(row.locator('[data-role="court-when"]')).toContainText('в 11:00 · Одинцовский городской суд, дело № 2-4423/2026');
  await expect(row.locator('[data-role="court-where"]')).toHaveText('Московская обл., г. Одинцово, ул. Неделина, 17, зал 3');
  await expect(row.locator('[data-role="court-take"]')).toHaveText('Взять с собой: отчёт № 15/2026 — Отчёт 15-2026.pdf, квалификационный аттестат № А-4423, паспорт');
  await expect(row.locator('[data-role="court-expired"]')).toContainText('Полис страхования оценщика № П-4423: срок истёк');
  await expect(row.locator('[data-role="court-missing"]')).toHaveCount(0);
  await row.scrollIntoViewIfNeeded();
  await shot(sp, 'ct04-2443-zasedanie-segodnya');
  await row.locator('button.open').click();
  await expect(sp).toHaveURL(new RegExp(`#order=${id}&to=court$`));
  await expect(sp.locator('#hearing-box li.hearing-next')).toContainText('Одинцовский городской суд');
  expect(sp.problems).toEqual([]);
  await sp.context().close();
});

test('2.444: «Пояснения к отчёту для суда» — ИИ делит вопросы суда, эксперт пишет пояснения, Word; заказчик видит готовое', async ({ browser, baseURL }) => {
  const sp = await phone(browser, baseURL);
  const cp = await phone(browser, baseURL);
  const expert = await signIn(sp, '+79990004425');
  const customer = await signIn(cp, '+79990004426');
  const id = await db(async (c) => {
    await c.query("update users set full_name = 'Пояснова Вера' where id = $1", [expert.id]);
    await c.query('insert into specialists (user_id) values ($1)', [expert.id]);
    const oid = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields, report_number)
      values ($1, 'Квартира в Химках для суда', 'expertise', 'realty', 'done', $2, current_date - 5, $3, '21/2026') returning id`,
    [customer.id, expert.id, { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'Московская обл., г. Химки, ул. Тестовая, 8' }])).rows[0].id;
    await c.query(`insert into court_calls (order_id, court, case_no, hearing_at, address, created_by, side)
      values ($1, 'Химкинский городской суд', '2-4425/2026', ($2::date + time '14:00') at time zone 'Europe/Moscow', 'Московская обл., г. Химки, ул. Ленинградская, 13', $3, 'customer')`,
    [oid, plusDays(8), customer.id]);
    return oid;
  });

  await sp.goto(`/kabinet#order=${id}&to=court`);
  const call = sp.locator('#hearing-list li[data-court]');
  await call.getByRole('button', { name: 'Пояснения к отчёту для суда' }).click();
  const qa = call.locator('.court-qa');
  await expect(qa).toContainText('разделит их на пункты');
  await qa.getByLabel('Вопросы суда текстом — из определения или повестки').fill(
    'Вопросы эксперту:\n1. Почему аналоги взяты из соседнего района?\n2. На чём основана скидка на торг 7%?');
  await qa.getByRole('button', { name: 'Разобрать вопросы суда' }).click();
  await expect(qa.locator('[role="status"]')).toContainText('Вопросов: 2');
  await expect(qa.getByLabel('Вопрос 1 (нашёл ИИ — проверьте)')).toHaveValue('Почему аналоги взяты из соседнего района?');
  await expect(qa).toContainText('без пояснения: 2');
  await expect(qa.getByRole('button', { name: 'Скачать «Пояснения эксперта» Word' })).toBeHidden();
  await qa.getByLabel('Пояснение эксперта').nth(0).fill('В районе объекта на дату оценки не было сопоставимых предложений; взяты соседние с поправкой на местоположение.');
  await qa.getByLabel('Где в отчёте').nth(0).fill('раздел 8.2, стр. 31');
  await qa.getByLabel('Пояснение эксперта').nth(1).fill('Скидка — по справочнику для квартир Москвы и области, 2026.');
  await qa.getByRole('button', { name: 'Сохранить' }).click();
  await expect(qa.locator('[role="status"]')).toHaveText('Сохранено · пояснения ко всем вопросам готовы');
  await expect(call.locator('.court-qa-open')).toHaveText('Пояснения для суда · готовы (вопросов 2)');
  const word = qa.getByRole('button', { name: 'Скачать «Пояснения эксперта» Word' });
  await expect(word).toBeVisible();
  await qa.scrollIntoViewIfNeeded();
  await shot(sp, 'ct05-2444-poyasneniya-dlya-suda');
  const [download] = await Promise.all([sp.waitForEvent('download'), word.click()]);
  expect(download.suggestedFilename()).toBe('Пояснения для суда 2-4425-2026.docx');

  // Заказчик видит готовые пояснения без правки и может скачать Word.
  await cp.goto(`/kabinet#order=${id}&to=court`);
  const ccall = cp.locator('#hearing-list li[data-court]');
  await ccall.getByRole('button', { name: 'Пояснения для суда · готовы (вопросов 2)' }).click();
  await expect(ccall.locator('.court-qa')).toContainText('Скидка — по справочнику');
  await expect(ccall.locator('.court-qa textarea')).toHaveCount(0);
  await expect(ccall.getByRole('button', { name: 'Скачать «Пояснения эксперта» Word' })).toBeVisible();
  expect(sp.problems).toEqual([]);
  expect(cp.problems).toEqual([]);
  await sp.context().close();
  await cp.context().close();
});
