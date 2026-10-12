// Модуль «Переводы» (задача штаба 3f617197): заявка на перевод на телефоне 412×915 — три услуги, «Куда подаёте»,
// предупреждение «нужен нотариальный», расчёт по таблице цен; диспетчеру цена подставлена из расчёта.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DB_URL, TEST_TOKEN } from '../helpers.mjs';

const CONTROL = process.env.UI_TEST_CONTROL_TOKEN || TEST_TOKEN;
const H = { 'x-delo-request': '1' };
const inDays = (n) => new Date(Date.now() + 3 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);

async function signIn(page, phone) {
  expect((await page.request.post('/api/auth/code', { data: { phone }, headers: H })).status()).toBe(200);
  const r = await page.request.get('/__test/fakes/sms/calls', { headers: { 'x-test-control': CONTROL } });
  const code = (await r.json()).calls.filter((c) => c.method === 'sendCode' && c.args.phone === phone).at(-1).args.code;
  const v = await page.request.post('/api/auth/verify', { data: { phone, code }, headers: H });
  expect(v.status()).toBe(200);
  return (await v.json()).user;
}

async function shot(page, name) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), `${name}: страница шире экрана`).toBeLessThanOrEqual(412);
  await page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: true });
}

test('заявка на перевод: «Куда подаёте», предупреждение, расчёт по таблице цен; диспетчеру цена подставлена', async ({ page, browser, baseURL }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page, '+79990000961');
  await page.goto('/kabinet');
  await page.locator('#new-order').getByLabel('Услуга').selectOption({ label: 'Перевод без нотариуса (с сертификатом платформы)' });
  await page.getByRole('button', { name: 'Создать заявку' }).click();
  await expect(page.locator('#order-status')).toHaveText('Новая');
  await expect(page.locator('#quote-box')).toBeHidden();

  await page.getByLabel('Куда подаёте перевод').selectOption({ label: 'МВД, миграционная служба' });
  await page.getByLabel('Язык (кроме русского)').selectOption({ label: 'Английский' });
  await page.getByLabel('Направление перевода').selectOption({ label: 'С языка на русский' });
  await page.getByLabel('Что переводим').selectOption({ label: 'Паспорт, удостоверение личности' });
  await page.getByLabel('Документов, шт.').fill('1');
  await page.getByLabel('Страниц всего').fill('1');
  await page.getByLabel('Срочность').selectOption({ label: '1–2 дня' });
  await page.getByLabel('Бумажный экземпляр').selectOption({ label: 'Не нужен, только PDF' });
  await page.getByLabel('Срок: результат нужен к').fill(inDays(5));
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.locator('#details-msg')).toHaveText('Сохранено');

  await expect(page.locator('#quote-box')).toBeVisible();
  await expect(page.locator('[data-notice="notary_needed"]')).toContainText('только нотариальный перевод');
  await expect(page.locator('#quote-total')).toHaveText('Итого по таблице цен: 750 ₽');
  await expect(page.locator('#quote-lines')).toContainText('Сертификат платформы');
  await page.locator('#quote-box').scrollIntoViewIfNeeded();
  await shot(page, 'perevod-01-bez-notariusa-preduprezhdenie');

  // Клиент послушался подсказки — нотариальный на бумаге: предупреждения нет, нотариус отдельной строкой.
  await page.locator('#d-service').selectOption({ label: 'Нотариальный перевод (бумага)' });
  await page.getByLabel('Срочность').selectOption({ label: '3–5 рабочих дней' });
  await page.getByLabel('Как передадите оригинал').selectOption({ label: 'Курьером' });
  await page.getByLabel('Как получить бумажный перевод').selectOption({ label: 'Заберу сам' });
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.locator('#details-msg')).toHaveText('Сохранено');
  await expect(page.locator('[data-notice]')).toHaveCount(0);
  await expect(page.locator('#quote-total')).toHaveText('Итого по таблице цен: 1 550 ₽');
  await expect(page.locator('#quote-lines')).toContainText('Нотариус — подпись переводчика');
  await expect(page.locator('#quote-note')).toContainText('Тарифы нотариуса и доставка (550 ₽) — без наценки платформы');
  await page.locator('#quote-box').scrollIntoViewIfNeeded();
  await shot(page, 'perevod-02-notarialnyj-raschet');

  await page.getByRole('button', { name: 'Отправить заявку' }).click();
  await expect(page.locator('#order-status')).toHaveText('Подбор исполнителя');
  const id = new URL(page.url()).hash.match(/order=([\w-]+)/)[1];

  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' });
  const dp = await ctx.newPage();
  dp.on('pageerror', (e) => errors.push(e.message));
  const disp = await signIn(dp, '+79990000962');
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try { await c.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]); } finally { await c.end(); }
  await dp.goto(`/kabinet#order=${id}`);
  await expect(dp.locator('#price')).toHaveValue('1550');
  await expect(dp.locator('#price-quoted')).toContainText('550 ₽ — тарифы нотариуса и доставка');
  await dp.locator('#price-form').scrollIntoViewIfNeeded();
  await shot(dp, 'perevod-03-dispetcher-cena');
  // Деньги перевода (2а.2): 80/20 — только от услуг (1 000 ₽), нотариус 550 ₽ — без вознаграждения.
  await dp.getByRole('button', { name: 'Назначить цену' }).click();
  const facts = dp.locator('#money-facts');
  await expect(facts).toContainText('Нотариус и доставка');
  await expect(facts).toContainText('550 ₽ — по тарифам, без вознаграждения платформы');
  await expect(facts).toContainText(/Исполнителю \(80% от услуг\)\s*800 ₽/);
  await expect(facts).toContainText(/Платформе \(20% от услуг\)\s*200 ₽/);
  await facts.scrollIntoViewIfNeeded();
  await shot(dp, 'perevod-04-dispetcher-dengi');
  await ctx.close();

  await page.reload();
  await expect(page.locator('#money-facts')).toContainText('550 ₽ — по тарифам, без вознаграждения платформы');
  await expect(page.locator('#money-facts')).not.toContainText('Платформе');
  await page.locator('#money-facts').scrollIntoViewIfNeeded();
  await shot(page, 'perevod-05-zakazchik-oplata');
  expect(errors).toEqual([]);
});

// Исполнители-переводчики (2а.3): статус и правила самозанятого, документ о знании языка на проверке у администратора,
// чек «Мой налог» к выплате.
test('переводчик: правила самозанятого, диплом на проверку, администратор отмечает «проверен», чек к выплате', async ({ page, browser, baseURL }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const tr = await signIn(page, '+79990000971');
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  try {
    await db.query("update users set full_name = 'Тестовый Переводчик' where id = $1", [tr.id]);
    await db.query("insert into specialists (user_id, regions, capacity, tax_status) values ($1, '{moscow}', 5, 'self_employed')", [tr.id]);
    await db.query("insert into specialist_permits (user_id, module, service) values ($1, 'translation', 'plain')", [tr.id]);

    await page.goto('/kabinet#specialist');
    await expect(page.locator('#specialist-tax-name')).toHaveText('Статус: Самозанятый');
    await expect(page.locator('#specialist-tax-rules')).toContainText('чек в приложении «Мой налог»');
    await shot(page, 'perevodchik-01-pravila-samozanyatogo');

    await page.locator('#dossier-kind').selectOption({ label: 'Документ о знании языка' });
    await page.getByLabel('Язык', { exact: true }).selectOption({ label: 'Английский' });
    await page.locator('#dossier-title').fill('Диплом МГЛУ, переводчик английского языка');
    await page.locator('#dossier-save').click();
    await expect(page.locator('#dossier-msg')).toHaveText('Документ добавлен — загрузите копию');
    const item = page.locator('[data-dossier]').filter({ hasText: 'Английский' });
    await item.locator('input[type=file]').setInputFiles({ name: 'diplom.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 скан') });
    await expect(page.locator('#dossier-msg')).toHaveText('Копия сохранена');
    await expect(item).toContainText('ждёт проверки');
    await item.scrollIntoViewIfNeeded();
    await shot(page, 'perevodchik-02-diplom-na-proverke');

    // Администратор: статус в профиле, копия и отметка «проверен».
    const actx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' });
    const ap = await actx.newPage();
    ap.on('pageerror', (e) => errors.push(e.message));
    const adm = await signIn(ap, '+79990000972');
    await db.query("update users set platform_role = 'admin' where id = $1", [adm.id]);
    await ap.goto('/kabinet#admin');
    await ap.locator('#admin-phone').fill('+79990000971');
    await ap.locator('#admin-search').click();
    await expect(ap.locator('#sp-tax')).toHaveValue('self_employed');
    const lang = ap.locator('#sp-langs li').first();
    await expect(lang).toContainText('Английский: Диплом МГЛУ');
    await expect(lang).toContainText('ждёт проверки · копия загружена');
    await lang.getByRole('button', { name: 'Проверен' }).click();
    await expect(ap.locator('#sp-msg')).toHaveText('Документ отмечен проверенным');
    await expect(ap.locator('#sp-langs li').first()).toContainText('проверен · копия загружена');
    await ap.locator('#sp-langs-box').scrollIntoViewIfNeeded();
    await shot(ap, 'perevodchik-03-admin-proveril-diplom');
    await actx.close();

    await page.reload();
    await expect(page.locator('[data-dossier]').filter({ hasText: 'Английский' })).toContainText('проверен');

    // Выплата прошла — самозанятый прикладывает чек «Мой налог».
    const owner = await (await browser.newContext({ baseURL })).newPage();
    await signIn(owner, '+79990000973');
    const o = await (await owner.request.post('/api/orders', { data: { module: 'translation', service: 'plain', title: 'Перевод диплома' }, headers: H })).json();
    const id = o.order.id;
    const fields = { recipient: 'business', language: 'en', direction: 'to_ru', doc_kind: 'diploma', docs: 1, pages: 1, urgent: 'no', delivery: 'none' };
    expect((await owner.request.patch(`/api/orders/${id}`, { data: { deadline: inDays(3), fields }, headers: H })).status()).toBe(200);
    await db.query("update orders set status = 'done', executor_user_id = $2, price_kop = 75000, paid_at = now() where id = $1", [id, tr.id]);
    await db.query("insert into payouts (order_id, executor_user_id, amount_kop, commission_kop, status, paid_at) values ($1, $2, 60000, 15000, 'succeeded', now())", [id, tr.id]);
    await page.goto(`/kabinet#order=${id}`);
    await expect(page.locator('#money-facts')).toContainText('нужен: выдайте чек в «Мой налог» и приложите ссылку');
    await page.locator('#receipt-url').fill('https://example.com/chek');
    await page.getByRole('button', { name: 'Приложить чек' }).click();
    await expect(page.locator('#money-msg')).toContainText('lknpd.nalog.ru');
    await page.locator('#receipt-url').fill('https://lknpd.nalog.ru/api/v1/receipt/770000000000/20abc0009/print');
    await page.getByRole('button', { name: 'Приложить чек' }).click();
    await expect(page.locator('#money-msg')).toHaveText('Чек приложен');
    await expect(page.locator('#money-facts')).toContainText(/Чек самозанятого\s*приложен/);
    await page.locator('#receipt-form').scrollIntoViewIfNeeded();
    await shot(page, 'perevodchik-04-chek-k-vyplate');
  } finally { await db.end(); }
  expect(errors).toEqual([]);
});

// Нотариусы-партнёры (2а.4): администратор заводит нотариуса с окнами; переводчик видит окна на две недели и пачку —
// свои нотариальные переводы в работе.
test('нотариусы: администратор заводит нотариуса и окна, переводчик видит окна и пачку', async ({ page, browser, baseURL }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const adm = await signIn(page, '+79990000980');
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  try {
    await db.query("update users set platform_role = 'admin' where id = $1", [adm.id]);
    await page.goto('/kabinet#admin');
    await page.getByRole('button', { name: 'Добавить нотариуса' }).click();
    await page.getByLabel('ФИО нотариуса').fill('Тестовый нотариус Сидорова С. С.');
    await page.getByLabel('Адрес нотариуса').fill('г. Москва, тестовая ул., 5');
    await page.getByLabel('Контакты (телефон, почта, помощник)').fill('+7 999 000-09-82');
    // Окна по умолчанию — вт и чт 10:00–12:00; второе поменяем на пятницу 15:00–17:00.
    const rows = page.locator('#nt-windows [data-window]');
    await expect(rows).toHaveCount(2);
    await rows.nth(1).getByLabel('День недели').selectOption({ label: 'пт' });
    await rows.nth(1).getByLabel('С', { exact: true }).fill('15:00');
    await rows.nth(1).getByLabel('До', { exact: true }).fill('17:00');
    await page.locator('#notary-form').scrollIntoViewIfNeeded();
    await shot(page, 'notarius-01-admin-forma');
    await page.locator('#nt-save').click();
    await expect(page.locator('#notary-msg')).toHaveText('Нотариус сохранён');
    const card = page.locator('#notaries li').filter({ hasText: 'Сидорова' });
    await expect(card).toContainText('Окна: вт 10:00–12:00, пт 15:00–17:00 · оплата по счёту от платформы · паспорт файлом — нет');
    await card.scrollIntoViewIfNeeded();
    await shot(page, 'notarius-02-admin-spravochnik');

    // Переводчик с допуском к нотариальному переводу и одним делом в работе.
    const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' });
    const tp = await ctx.newPage();
    tp.on('pageerror', (e) => errors.push(e.message));
    const tr = await signIn(tp, '+79990000981');
    await db.query("insert into specialists (user_id, regions, capacity, tax_status) values ($1, '{moscow}', 5, 'ip')", [tr.id]);
    await db.query("insert into specialist_permits (user_id, module, service) values ($1, 'translation', 'notary_paper')", [tr.id]);
    const fields = { recipient: 'zags', language: 'de', direction: 'to_ru', doc_kind: 'civil', docs: 1, pages: 1, urgent: 'no', original: 'meeting', delivery: 'pickup' };
    await db.query(`insert into orders (owner_user_id, title, module, service, status, deadline, fields, executor_user_id)
      values ($1, 'Перевод свидетельства о браке', 'translation', 'notary_paper', 'in_work', $2, $3, $4)`, [adm.id, inDays(4), JSON.stringify(fields), tr.id]);
    await tp.goto('/kabinet#specialist');
    const desk = tp.locator('#desk-box');
    await expect(desk).toBeVisible();
    await expect(tp.locator('#desk-windows li').first()).toContainText('Сидорова');
    await expect(tp.locator('#desk-batch-title')).toHaveText('Пачка: 1 пер. · документов 1');
    await expect(tp.locator('#desk-batch')).toContainText('Нотариальный перевод (бумага) · Свидетельство ЗАГС · немецкий → русский · 1 док. · 1 стр. · оригинал: при встрече');
    await desk.scrollIntoViewIfNeeded();
    await shot(tp, 'notarius-03-perevodchik-okna-pachka');
    await tp.locator('#desk-batch a').first().click();
    await expect(tp.locator('#order-status')).toHaveText('В работе');
    await ctx.close();

    // Перестали работать с нотариусом — он остаётся в справочнике выключенным.
    page.once('dialog', (d) => d.accept());
    await card.getByRole('button', { name: 'Не работаем' }).click();
    await expect(page.locator('#notary-msg')).toHaveText('Нотариус выключен');
    await expect(page.locator('#notaries li').filter({ hasText: 'Сидорова' })).toContainText('не работаем');
  } finally { await db.end(); }
  expect(errors).toEqual([]);
});

test('сертификат платформы: переводчик выдаёт к файлу, получатель проверяет по ссылке и сверяет файл', async ({ page, browser, baseURL }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const tr = await signIn(page, '+79990000985');
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  const FILE = Buffer.from('%PDF-1.4 тестовый перевод договора');
  let url;
  try {
    await db.query("update users set full_name = 'Тестова Переводчица Ивановна' where id = $1", [tr.id]);
    await db.query("insert into specialists (user_id, regions, capacity, tax_status) values ($1, '{moscow}', 5, 'self_employed')", [tr.id]);
    await db.query("insert into specialist_permits (user_id, module, service) values ($1, 'translation', 'plain')", [tr.id]);
    await db.query("insert into dossier_items (user_id, kind, title, number, language, verified_at) values ($1, 'language', 'Тестовый диплом', 'ТД-7', 'en', now())", [tr.id]);
    const owner = (await db.query("insert into users (phone) values ('+79990000986') on conflict (phone) do update set phone = excluded.phone returning id")).rows[0];
    const fields = { recipient: 'business', language: 'en', direction: 'to_ru', doc_kind: 'contract', docs: 1, pages: 2, urgent: 'no', delivery: 'none' };
    const o = (await db.query(`insert into orders (owner_user_id, title, module, service, status, deadline, fields, executor_user_id)
      values ($1, 'Перевод договора поставки', 'translation', 'plain', 'in_work', $2, $3, $4) returning id`, [owner.id, inDays(3), JSON.stringify(fields), tr.id])).rows[0];
    await page.goto(`/kabinet#order=${o.id}`);
    await expect(page.locator('#order-status')).toHaveText('В работе');
    await page.locator('#result-file').setInputFiles({ name: 'perevod-dogovora.pdf', mimeType: 'application/pdf', buffer: FILE });
    const doc = page.locator('li.doc').filter({ hasText: 'perevod-dogovora.pdf' });
    await expect(doc.locator('[data-action="cert-issue"]')).toBeVisible();
    await doc.scrollIntoViewIfNeeded();
    await shot(page, 'sertifikat-01-vydat');
    page.once('dialog', (d) => d.accept());
    await doc.locator('[data-action="cert-issue"]').click();
    await expect(page.locator('#doc-msg')).toContainText('Сертификат № П-');
    const block = doc.locator('[data-role="certificate"]');
    await expect(block).toContainText('Сертификат платформы № П-');
    url = await block.locator('[data-role="cert-url"]').textContent();
    expect(url).toMatch(/\/proverka\.html#[A-Z2-9]{12}$/);
    await block.scrollIntoViewIfNeeded();
    await shot(page, 'sertifikat-02-vydan');
    const [dl] = await Promise.all([page.waitForEvent('download'), block.locator('[data-action="cert-sheet"]').click()]);
    expect(dl.suggestedFilename()).toMatch(/^Сертификат П-\d{4}-\d{6}\.docx$/);
  } finally { await db.end(); }

  // Получатель: без входа, по ссылке из QR-кода.
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' });
  const pp = await ctx.newPage();
  pp.on('pageerror', (e) => errors.push(e.message));
  await pp.goto(new URL(url).pathname + new URL(url).hash);
  await expect(pp.locator('#state')).toHaveText('Сертификат действует');
  await expect(pp.locator('#translator')).toHaveText('Тестова Переводчица Ивановна');
  await expect(pp.locator('#languages')).toHaveText('с английского на русский');
  await pp.locator('#file').setInputFiles({ name: 'perevod-dogovora.pdf', mimeType: 'application/pdf', buffer: FILE });
  await expect(pp.locator('#file-msg')).toContainText('Совпадает');
  await shot(pp, 'sertifikat-03-proverka-sovpadaet');
  await pp.locator('#file').setInputFiles({ name: 'drugoj.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 изменённый') });
  await expect(pp.locator('#file-msg')).toContainText('Не совпадает');
  // Код вручную: неверный — понятное сообщение.
  await pp.locator('#code').fill('AAAA-AAAA-AAAA');
  await pp.getByRole('button', { name: 'Проверить' }).click();
  await expect(pp.locator('#code-msg')).toContainText('не найден');
  await expect(pp.locator('#result')).toBeHidden();
  await shot(pp, 'sertifikat-04-kod-ne-najden');
  await ctx.close();
  expect(errors).toEqual([]);
});

test('ход заказа: переводчик отмечает оригинал, нотариуса и файл нотариуса, потом сдаёт; заказчик видит ход', async ({ page, browser, baseURL }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const tr = await signIn(page, '+79990000987');
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  let o;
  try {
    await db.query("insert into specialists (user_id, regions, capacity, tax_status) values ($1, '{moscow}', 5, 'self_employed')", [tr.id]);
    await db.query("insert into specialist_permits (user_id, module, service) values ($1, 'translation', 'notary_file')", [tr.id]);
    const owner = (await db.query("insert into users (phone) values ('+79990000988') on conflict (phone) do update set phone = excluded.phone returning id")).rows[0];
    const fields = { recipient: 'university', language: 'en', direction: 'to_ru', doc_kind: 'diploma', docs: 1, pages: 2, original: 'courier', delivery: 'none' };
    o = (await db.query(`insert into orders (owner_user_id, title, module, service, status, deadline, fields, executor_user_id, paid_at)
      values ($1, 'Перевод диплома', 'translation', 'notary_file', 'in_work', $2, $3, $4, now()) returning id`, [owner.id, inDays(3), JSON.stringify(fields), tr.id])).rows[0];
  } finally { await db.end(); }

  await page.goto(`/kabinet#order=${o.id}&to=steps`);
  await expect(page.locator('#order-status')).toHaveText('В работе');
  const box = page.locator('#steps-box');
  await expect(box).toBeVisible();
  await expect(box.locator('[data-order-step]')).toHaveCount(3);
  await expect(box.locator('[data-order-step="original"]')).toContainText('Оригинал получен от курьера');
  await box.scrollIntoViewIfNeeded();
  await shot(page, 'hod-zakaza-01-shagi');

  await box.locator('[data-order-step="original"] [data-role="step-note"]').fill('курьер привёз в 11:00');
  await box.locator('[data-order-step="original"] [data-action="step-mark"]').click();
  await expect(page.locator('#steps-msg')).toContainText('Отмечено: Оригинал получен от курьера');
  await expect(box.locator('[data-order-step="original"]')).toContainText('курьер привёз в 11:00');
  await box.locator('[data-order-step="notarized"] [data-action="step-mark"]').click();
  await expect(box.locator('[data-order-step="notarized"]')).toContainText('✓');

  // Файл нотариуса: загрузили файл результата — он появился в выборе.
  await page.locator('#result-file').setInputFiles({ name: 'diplom-notarius.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 файл нотариуса') });
  await expect(page.locator('li.doc').filter({ hasText: 'diplom-notarius.pdf' })).toBeVisible();
  const pick = box.locator('[data-order-step="notary_file"] [data-role="step-file"]');
  await expect(pick.locator('option')).toHaveCount(2);
  await pick.selectOption({ label: 'diplom-notarius.pdf' });
  await box.locator('[data-order-step="notary_file"] [data-action="step-mark"]').click();
  await expect(box.locator('[data-order-step="notary_file"]')).toContainText('✓');
  await expect(page.locator('#next-steps [data-step="steps"]')).toHaveClass(/done/);
  await box.scrollIntoViewIfNeeded();
  await shot(page, 'hod-zakaza-02-otmecheno');

  // Заказчик: видит ход, без кнопок.
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' });
  const cp = await ctx.newPage();
  cp.on('pageerror', (e) => errors.push(e.message));
  await signIn(cp, '+79990000988');
  await cp.goto(`/kabinet#order=${o.id}&to=steps`);
  const cbox = cp.locator('#steps-box');
  await expect(cbox.locator('[data-order-step="original"]')).toContainText('✓ Оригинал получен от курьера');
  await expect(cbox.locator('[data-action="step-mark"], [data-action="step-undo"]')).toHaveCount(0);
  await cbox.scrollIntoViewIfNeeded();
  await shot(cp, 'hod-zakaza-03-zakazchik');
  await ctx.close();
  expect(errors).toEqual([]);
});

test('вычитка и переделка: диспетчер видит обязательную вычитку; заказчик просит бесплатную переделку; правило возврата', async ({ page, browser, baseURL }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const disp = await signIn(page, '+79990000989');
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  let o;
  try {
    await db.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]);
    const tr = (await db.query("insert into users (phone) values ('+79990000979') on conflict (phone) do update set phone = excluded.phone returning id")).rows[0];
    const owner = (await db.query("insert into users (phone) values ('+79990000978') on conflict (phone) do update set phone = excluded.phone returning id")).rows[0];
    const fields = { recipient: 'business', language: 'en', direction: 'to_ru', doc_kind: 'contract', docs: 1, pages: 2, urgent: 'no', delivery: 'none' };
    o = (await db.query(`insert into orders (owner_user_id, title, module, service, status, deadline, fields, executor_user_id, paid_at, review_round, proofread)
      values ($1, 'Перевод устава', 'translation', 'plain', 'review', $2, $3, $4, now(), 1, 'new') returning id`, [owner.id, inDays(3), JSON.stringify(fields), tr.id])).rows[0];
  } finally { await db.end(); }

  await page.goto(`/kabinet#order=${o.id}`);
  await expect(page.locator('#order-status')).toHaveText('Проверка результата');
  await expect(page.locator('#review-proofread')).toContainText('Вычитка обязательная — у исполнителя ещё мало сданных дел');
  await expect(page.locator('#review-checks')).toContainText('Вычитка: текст прочитан целиком, ошибок нет');
  await page.locator('#review-box').scrollIntoViewIfNeeded();
  await shot(page, 'vychitka-01-dispetcher');

  // Выдано заказчику — заказчик нашёл ошибку и просит переделать бесплатно.
  const c2 = new pg.Client({ connectionString: DB_URL });
  await c2.connect();
  try { await c2.query("update orders set status = 'done' where id = $1", [o.id]); } finally { await c2.end(); }
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' });
  const cp = await ctx.newPage();
  cp.on('pageerror', (e) => errors.push(e.message));
  await signIn(cp, '+79990000978');
  await cp.goto(`/kabinet#order=${o.id}`);
  await expect(cp.locator('#order-status')).toHaveText('Готово');
  const redo = cp.locator('#actions [data-to="in_work"]');
  await expect(redo).toHaveText('Нашли ошибку — переделать бесплатно');
  await cp.locator('#reason').fill('В фамилии директора ошибка');
  await redo.scrollIntoViewIfNeeded();
  await shot(cp, 'vychitka-02-zakazchik-peredelka');
  await redo.click();
  await expect(cp.locator('#order-status')).toHaveText('В работе');
  await ctx.close();

  // Диспетчер: при отмене после начала работ видит правило возврата.
  await page.goto(`/kabinet#order=${o.id}`);
  await page.reload();
  await expect(page.locator('#order-status')).toHaveText('В работе');
  await expect(page.locator('#cancel-note')).toContainText('Возврат — только за качество перевода');
  await page.locator('#cancel-box').scrollIntoViewIfNeeded();
  await shot(page, 'vychitka-03-pravilo-vozvrata');
  expect(errors).toEqual([]);
});

// Оферта (2а.8): «Условия заказа» в карточке заявки — черновик, пока юрист не проверил; заказчику — свои пункты,
// диспетчеру — и пункты для переводчика.
test('условия заказа: заказчик видит главное из оферты с пометкой «черновик», диспетчер — и пункты для переводчика', async ({ page, browser, baseURL }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page, '+79990009399');
  const o = await (await page.request.post('/api/orders', { data: { module: 'translation', service: 'plain', title: 'Перевод справки' }, headers: H })).json();
  await page.goto(`/kabinet#order=${o.order.id}`);
  const box = page.locator('#terms-box');
  await expect(box).toBeVisible();
  await expect(page.locator('#terms-draft')).toHaveText('Черновик условий: проверяется юристом и пока не действует.');
  await page.locator('#terms-summary').click();
  await expect(page.locator('[data-point="guarantee"]')).toContainText('в пределах стоимости заказа');
  await expect(page.locator('[data-point="quality"]')).toContainText('отвечает переводчик');
  await expect(page.locator('[data-point="notary"]')).toHaveCount(0);
  await expect(page.locator('#terms-executor-title')).toBeHidden();
  await expect(page.locator('#terms-version')).toHaveText('Редакция от 12.10.2026');
  await box.scrollIntoViewIfNeeded();
  await shot(page, 'perevod-20-usloviya-zakazchik');

  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' });
  const dp = await ctx.newPage();
  dp.on('pageerror', (e) => errors.push(e.message));
  const disp = await signIn(dp, '+79990009398');
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try { await c.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]); } finally { await c.end(); }
  await dp.goto(`/kabinet#order=${o.order.id}`);
  await dp.locator('#terms-summary').click();
  await expect(dp.locator('#terms-executor-title')).toBeVisible();
  await expect(dp.locator('[data-point="executor_money"]')).toContainText('80% от услуг');
  await dp.locator('#terms-executor').scrollIntoViewIfNeeded();
  await shot(dp, 'perevod-21-usloviya-dispetcher');
  await ctx.close();
  expect(errors).toEqual([]);
});

test('цены и правила перевода: администратор меняет цену, видит историю; заказчику расчёт по новой цене', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const adm = await signIn(page, '+79990000990');
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  // Вернуть стартовые цены — так же, как правит администратор (сервер сразу считает по ним).
  const restore = async () => {
    const r = await page.request.get('/api/admin/translation-settings');
    const values = Object.fromEntries((await r.json()).settings.fields.map((f) => [f.key, f.default]));
    expect((await page.request.put('/api/admin/translation-settings', { data: { values }, headers: H })).status()).toBe(200);
  };
  try {
    await db.query("update users set platform_role = 'admin' where id = $1", [adm.id]);
    await page.goto('/kabinet#admin');
    const box = page.locator('#tprices-box');
    await expect(page.locator('#tp-page_kop')).toHaveValue('600');
    await expect(page.locator('#tp-commission')).toHaveText('20');
    await page.getByLabel('Перевод, за страницу, ₽').fill('650');
    await page.getByLabel('Подпись переводчика, за документ, ₽').fill('450,50');
    await page.getByLabel('Паспорт можно заказать нотариальным файлом').check();
    await page.getByRole('button', { name: 'Сохранить цены и правила' }).click();
    await expect(page.locator('#tp-msg')).toContainText('Сохранено. Изменено: Перевод, за страницу — 650 ₽; Подпись переводчика, за документ — 450,5 ₽; Паспорт можно заказать нотариальным файлом — да');
    await expect(box.locator('#tp-page_kop + .muted')).toHaveText('стартовое: 600 ₽');
    await box.locator('#tp-history-box summary').click();
    await expect(page.locator('#tp-history li').first()).toContainText('Перевод, за страницу: 600 ₽ → 650 ₽');
    await page.locator('#tp-history li').first().scrollIntoViewIfNeeded();
    await shot(page, 'ceny-01-admin-pravka-istoriya');

    // Ошибка в поле — понятное сообщение, ничего не сохранено.
    await page.getByLabel('Перевод, за страницу, ₽').fill('сто');
    await page.getByRole('button', { name: 'Сохранить цены и правила' }).click();
    await expect(page.locator('#tp-msg')).toHaveText('«Перевод, за страницу»: введите число');
    await page.getByLabel('Перевод, за страницу, ₽').fill('0');
    await page.getByRole('button', { name: 'Сохранить цены и правила' }).click();
    await expect(page.locator('#tp-msg')).toContainText('«Перевод, за страницу»: сумма от 1 ₽');
    await page.locator('#tp-page_kop').scrollIntoViewIfNeeded();
    await shot(page, 'ceny-02-admin-oshibka');

    // Заказчик: перевод без нотариуса, 1 стр., обычный срок — 650 + 150 = 800 ₽.
    await page.goto('/kabinet');
    await page.locator('#new-order').getByLabel('Услуга').selectOption({ label: 'Перевод без нотариуса (с сертификатом платформы)' });
    await page.getByRole('button', { name: 'Создать заявку' }).click();
    await expect(page.locator('#order-status')).toHaveText('Новая');
    await page.getByLabel('Куда подаёте перевод').selectOption({ label: 'МВД, миграционная служба' });
    await page.getByLabel('Язык (кроме русского)').selectOption({ label: 'Английский' });
    await page.getByLabel('Направление перевода').selectOption({ label: 'С языка на русский' });
    await page.getByLabel('Что переводим').selectOption({ label: 'Паспорт, удостоверение личности' });
    await page.getByLabel('Документов, шт.').fill('1');
    await page.getByLabel('Страниц всего').fill('1');
    await page.getByLabel('Срочность').selectOption({ label: '1–2 дня' });
    await page.getByLabel('Бумажный экземпляр').selectOption({ label: 'Не нужен, только PDF' });
    await page.getByLabel('Срок: результат нужен к').fill(inDays(5));
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.locator('#details-msg')).toHaveText('Сохранено');
    await expect(page.locator('#quote-lines')).toContainText('Перевод: 1 стр. × 650 ₽');
    await expect(page.locator('#quote-total')).toHaveText('Итого по таблице цен: 800 ₽');
    await page.locator('#quote-box').scrollIntoViewIfNeeded();
    await shot(page, 'ceny-03-zakazchik-novaya-cena');
  } finally {
    await restore();
    await db.end();
  }
  expect(errors).toEqual([]);
});

test('оплата ЮKassa — проверка перед подключением: адрес уведомлений, частые ошибки, кнопка проверки адреса', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const adm = await signIn(page, '+79990000991');
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  try {
    await db.query("update users set platform_role = 'admin' where id = $1", [adm.id]);
    await page.goto('/kabinet#admin');
    const box = page.locator('#paycheck-box');
    // На стенде оплата поддельная и адреса сайта нет — проверка честно говорит, что ещё не готово.
    await expect(box.locator('[data-pc="provider"]')).toContainText('поддельная оплата');
    await expect(box.locator('[data-pc="webhook"]')).toHaveAttribute('data-ok', 'false');
    await expect(box.locator('[data-pc="webhook"]')).toContainText('появится, когда задан PUBLIC_URL');
    await expect(box.locator('[data-pc="receipts"]')).toContainText('только по решению Дамира');
    await expect(box.locator('[data-pc="operator"]')).toContainText('ИНН');
    await box.getByRole('button', { name: 'Проверить адрес уведомлений' }).click();
    await expect(page.locator('#pc-msg')).toHaveText('Адрес уведомлений: сначала исправьте адрес сайта (PUBLIC_URL)');
    await box.locator('#pc-mistakes-box summary').click();
    await expect(page.locator('[data-pc-mistake="return_url"]')).toContainText('return_url');
    await expect(page.locator('[data-pc-mistake="receipt_contact"]')).toContainText('почты или телефона');
    await box.scrollIntoViewIfNeeded();
    await shot(page, 'yukassa-01-admin-proverka');
  } finally {
    await db.end();
  }
  expect(errors).toEqual([]);
});
