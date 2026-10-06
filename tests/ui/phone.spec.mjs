// Проверка на телефоне 412×915: вход по коду (СМС и звонок), заявка, документ (загрузка, скачивание, удаление),
// чужой не видит, руководитель видит дела сотрудника, выход; профиль; организация — создание, приглашение,
// роли, передача дела, уход сотрудника; управление ролями администратором; заявка на оценку — заполнение по описанию
// услуги, основание «определение суда», отправка, ход заявки у диспетчера и заказчика, отмена, просрочка.
// Скриншоты — test-results/screens/.
// На каждой странице: нет прокрутки вбок, нет ошибок JavaScript, нет запросов к чужим адресам.
import { test as base, expect } from '@playwright/test';
import pg from 'pg';
import { DB_URL, TEST_TOKEN, BRIDGE_SECRET, testEnv } from '../helpers.mjs';
import { signBridge } from '../../src/bridge/signature.mjs';
import { makePdf, makeDocx } from '../tools/make-docs.mjs';
import { extractPages } from '../../src/ai/extract.mjs';
import fs from 'node:fs';
import { testExternalSignature, testGoskeySignature } from '../../src/providers/sign.mjs';
import crypto from 'node:crypto';

const CONTROL = process.env.UI_TEST_CONTROL_TOKEN || TEST_TOKEN;
// Ключ моста CRM → Платформа на проверяемом стенде (тестовый, не настоящий).
const BRIDGE = process.env.UI_CRM_BRIDGE_SECRET || BRIDGE_SECRET;
// Адрес хранилища для временных ссылок (MinIO в CI) — единственный разрешённый «чужой» адрес.
const EXTRA_ORIGINS = (process.env.UI_ALLOWED_ORIGINS || '').split(',').filter(Boolean);

const test = base.extend({
  page: async ({ page, baseURL }, use) => {
    const allowed = new Set([new URL(baseURL).origin, ...EXTRA_ORIGINS]);
    const problems = [];
    page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) problems.push(`консоль: ${m.text()}`); });
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (!['data:', 'blob:'].includes(u.protocol) && !allowed.has(u.origin)) problems.push(`внешний запрос: ${r.url()}`);
    });
    await use(page);
    expect(problems, problems.join('\n')).toEqual([]);
  },
});

async function shot(page, name) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, `${name}: страница шире экрана`).toBeLessThanOrEqual(412);
  await page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: true });
}

// Подписать УКЭП (поддельной подписью площадки) все свои неподписанные файлы результата (задача 2.5).
async function signResults(sp) {
  const btn = sp.locator('#docs li').getByRole('button', { name: 'Подписать' });
  while (await btn.count()) {
    sp.once('dialog', (d) => d.accept());
    await btn.first().click();
    await expect(sp.locator('#doc-msg')).toHaveText('Файл подписан');
  }
}

async function smsCode(request, phone, channel = 'sms') {
  const r = await request.get(`/__test/fakes/${channel}/calls`, { headers: { 'x-test-control': CONTROL } });
  expect(r.status()).toBe(200);
  const calls = (await r.json()).calls.filter((c) => c.method === 'sendCode' && c.args.phone === phone);
  return calls.at(-1).args.code;
}

// Быстрый вход через API в контексте страницы (cookie попадает в браузер).
async function signIn(page, phone) {
  const h = { 'x-delo-request': '1' };
  expect((await page.request.post('/api/auth/code', { data: { phone }, headers: h })).status()).toBe(200);
  const code = await smsCode(page.request, phone);
  const r = await page.request.post('/api/auth/verify', { data: { phone, code }, headers: h });
  expect(r.status()).toBe(200);
  return (await r.json()).user;
}

function phoneContext(browser, baseURL, extra = {}) {
  return browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU', ...extra });
}

async function db(fn) {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

test('вход по коду из СМС', async ({ page }) => {
  const phone = '+79990000501';
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Вход' })).toBeVisible();
  await expect(page.getByText('Проверочная версия · только тестовые данные')).toBeVisible();
  await shot(page, '01-vhod');

  await page.getByLabel('Номер мобильного телефона').fill('8 999 000-05-01');
  await page.getByRole('button', { name: 'Получить код' }).click();
  await expect(page.getByText('Код отправлен на +7 999 000-05-01')).toBeVisible();
  await shot(page, '02-kod');

  await page.getByLabel('Код из СМС').fill(await smsCode(page.request, phone));
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/kabinet$/);
  await expect(page.getByRole('heading', { name: 'Мои заявки' })).toBeVisible();
  await expect(page.getByText('Заявок пока нет.')).toBeVisible();
  await shot(page, '03-kabinet-pusto');
});

test('неверный код — понятное сообщение', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Номер мобильного телефона').fill('+79990000502');
  await page.getByRole('button', { name: 'Получить код' }).click();
  // Код читается только после ответа сервера (иначе на медленном контейнере вызова СМС ещё нет).
  await expect(page.getByText('Код отправлен на +7 999 000-05-02')).toBeVisible();
  const code = await smsCode(page.request, '+79990000502');
  await page.getByLabel('Код из СМС').fill(code === '000000' ? '111111' : '000000');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByText('Неверный код')).toBeVisible();
  await shot(page, '04-nevernyy-kod');
});

test('заявка и документ: создать, загрузить, скачать, удалить', async ({ page }) => {
  await signIn(page, '+79990000503');
  await page.goto('/kabinet');
  await page.getByLabel('Коротко: что нужно').fill('Оценка квартиры для суда <b>тест</b>');
  await page.getByRole('button', { name: 'Создать заявку' }).click();
  await expect(page.getByRole('heading', { name: 'Оценка квартиры для суда <b>тест</b>' })).toBeVisible(); // текст, не разметка
  await expect(page.getByText('Документов пока нет.')).toBeVisible();
  await shot(page, '05-zayavka');

  await page.getByLabel('Добавить файл (до 100 МБ)').setInputFiles({
    name: 'Выписка ЕГРН.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 тестовый файл'),
  });
  await expect(page.getByText('Файл добавлен')).toBeVisible();
  await expect(page.getByText('Выписка ЕГРН.pdf')).toBeVisible();
  await shot(page, '06-dokument');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Скачать' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('Выписка ЕГРН.pdf');
  const chunks = [];
  for await (const ch of await download.createReadStream()) chunks.push(ch);
  expect(Buffer.concat(chunks).toString()).toBe('%PDF-1.4 тестовый файл');

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Удалить' }).click();
  await expect(page.getByText('Файл удалён')).toBeVisible();
  await expect(page.getByText('Документов пока нет.')).toBeVisible();

  await page.getByRole('button', { name: '← Все заявки' }).click();
  await expect(page.locator('#orders').getByText('Оценка квартиры для суда <b>тест</b>')).toBeVisible();
  await shot(page, '07-spisok');
});

test('чужой пользователь не видит заявку ни в списке, ни по прямой ссылке', async ({ page, browser, baseURL }) => {
  await signIn(page, '+79990000504');
  const created = await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Секретная заявка владельца' }, headers: { 'x-delo-request': '1' } });
  const { order } = await created.json();

  const other = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU' });
  const p2 = await other.newPage();
  await signIn(p2, '+79990000505');
  await p2.goto('/kabinet');
  await expect(p2.getByRole('heading', { name: 'Мои заявки' })).toBeVisible();
  await expect(p2.getByText('Секретная заявка владельца')).toHaveCount(0);
  await p2.goto(`/kabinet#order=${order.id}`);
  await expect(p2.getByRole('heading', { name: 'Заявка не найдена' })).toBeVisible();
  await expect(p2.getByText('Секретная заявка владельца')).toHaveCount(0);
  await shot(p2, '08-chuzhaya-zayavka');
  await other.close();
});

test('руководитель организации видит заявку сотрудника, сотрудник — только свою', async ({ page, browser, baseURL }) => {
  const head = await signIn(page, '+79990000506');
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' });
  const p2 = await ctx.newPage();
  const member = await signIn(p2, '+79990000507');
  const org = await db(async (c) => {
    const o = (await c.query("insert into organizations (name) values ('Тестовая экспертная организация') returning id")).rows[0];
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head'), ($1, $3, 'member')", [o.id, head.id, member.id]);
    return o;
  });
  const r = await p2.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Заявка сотрудника: оценка автомобиля', org_id: org.id }, headers: { 'x-delo-request': '1' } });
  expect(r.status()).toBe(201);
  await ctx.close();

  await page.goto('/kabinet');
  await expect(page.getByText('Заявка сотрудника: оценка автомобиля')).toBeVisible();
  await page.getByText('Заявка сотрудника: оценка автомобиля').click();
  await expect(page.getByRole('heading', { name: 'Заявка сотрудника: оценка автомобиля' })).toBeVisible();
  await shot(page, '09-rukovoditel');
});

test('выход возвращает на страницу входа, кабинет без входа недоступен', async ({ page }) => {
  await signIn(page, '+79990000508');
  await page.goto('/kabinet');
  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page.getByRole('heading', { name: 'Вход' })).toBeVisible();
  await page.goto('/kabinet');
  await expect(page).toHaveURL(/\/$/);
  await shot(page, '10-vyhod');
});

test('вход по звонку, если СМС не пришло', async ({ page }) => {
  const phone = '+79990000511';
  await page.clock.install();
  await page.goto('/');
  await page.getByLabel('Номер мобильного телефона').fill(phone);
  await page.getByRole('button', { name: 'Получить код' }).click();
  await expect(page.getByRole('button', { name: 'Позвонить с кодом' })).toBeDisabled();
  await expect(page.getByText(/Звонок можно заказать через \d+ с/)).toBeVisible();

  // Прошла минута: и на сервере (сдвигаем время кода), и на странице.
  await db((c) => c.query("update login_codes set created_at = created_at - interval '2 minutes' where phone = $1", [phone]));
  await page.clock.fastForward('01:01');
  await page.getByRole('button', { name: 'Позвонить с кодом' }).click();
  await expect(page.getByText('Сейчас на +7 999 000-05-11 позвонит робот и назовёт код.')).toBeVisible();
  await shot(page, '11-zvonok');

  await page.getByLabel('Код из звонка').fill(await smsCode(page.request, phone, 'call'));
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/kabinet$/);
});

test('профиль: имя показывается в шапке', async ({ page }) => {
  await signIn(page, '+79990000512');
  await page.goto('/kabinet#profile');
  await expect(page.getByRole('heading', { name: 'Профиль' })).toBeVisible();
  await expect(page.getByText('Телефон для входа: +7 999 000-05-12')).toBeVisible();
  await page.getByLabel('Как к Вам обращаться').fill('Тестова Анна Сергеевна');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Сохранено')).toBeVisible();
  await expect(page.locator('#who')).toHaveText('Тестова Анна Сергеевна');
  await shot(page, '12-profil');
});

test('организация: создать, пригласить, сотрудник принимает, руководитель передаёт дело, ушедший теряет доступ', async ({ page, browser, baseURL }) => {
  const H = '+79990000521', M = '+79990000522', P = '+79990000523';
  await signIn(page, H);
  await page.goto('/kabinet#orgs');
  await expect(page.getByText('Вы пока не состоите ни в одной организации.')).toBeVisible();
  await shot(page, '13-organizacii');
  await page.getByLabel('Название', { exact: true }).fill('АНО «Тестовый центр экспертиз»');
  await page.getByLabel('ИНН (можно позже)').fill('7707083893');
  await page.getByRole('button', { name: 'Создать организацию' }).click();
  await expect(page.getByRole('heading', { name: 'АНО «Тестовый центр экспертиз»' })).toBeVisible();
  await expect(page.getByText('ИНН 7707083893 · Ваша роль: Руководитель')).toBeVisible();

  await page.getByLabel('Номер телефона сотрудника').fill('8 999 000-05-22');
  await page.getByRole('button', { name: 'Пригласить' }).click();
  await expect(page.getByText('Приглашение отправлено')).toBeVisible();
  await page.getByLabel('Номер телефона сотрудника').fill(P);
  await page.getByLabel('Роль', { exact: true }).selectOption('senior');
  await page.getByRole('button', { name: 'Пригласить' }).click();
  await expect(page.locator('#org-invites li')).toHaveCount(2);
  await shot(page, '14-organizaciya');

  // Сотрудник: видит приглашение после входа, принимает, создаёт заявку от имени организации.
  const mctx = await phoneContext(browser, baseURL);
  const mp = await mctx.newPage();
  await signIn(mp, M);
  await mp.goto('/kabinet');
  await expect(mp.locator('#invites-count')).toHaveText('1');
  await mp.getByRole('link', { name: /Организации/ }).click();
  await expect(mp.locator('#invites').getByText('АНО «Тестовый центр экспертиз»')).toBeVisible();
  await expect(mp.getByText(/Вас приглашают: сотрудник/)).toBeVisible();
  await shot(mp, '15-priglashenie');
  await mp.getByRole('button', { name: 'Принять' }).click();
  await expect(mp.getByText('Ваша роль: Сотрудник')).toBeVisible();
  await expect(mp.getByRole('button', { name: 'Пригласить' })).toHaveCount(0);
  await mp.getByRole('link', { name: 'Заявки' }).click();
  await mp.getByLabel('Коротко: что нужно').fill('Оценка автомобиля для страховой');
  await mp.getByLabel('От чьего имени').selectOption({ label: 'От организации АНО «Тестовый центр экспертиз»' });
  await mp.getByRole('button', { name: 'Создать заявку' }).click();
  await expect(mp.getByText(/^Организация: АНО «Тестовый центр экспертиз» · Ведёт:/)).toBeVisible();
  const orderUrl = mp.url();

  // Старший принимает приглашение через API — для передачи дела.
  const pctx = await phoneContext(browser, baseURL);
  const pp = await pctx.newPage();
  await signIn(pp, P);
  const inv = (await (await pp.request.get('/api/invites')).json()).invites[0];
  expect((await pp.request.post(`/api/invites/${inv.id}/accept`, { headers: { 'x-delo-request': '1' } })).status()).toBe(200);
  expect((await pp.request.patch('/api/me', { data: { full_name: 'Тестовый Старший' }, headers: { 'x-delo-request': '1' } })).status()).toBe(200);
  await pctx.close();

  // Руководитель: видит дело сотрудника и передаёт его старшему.
  await page.getByRole('link', { name: 'Заявки' }).click();
  await page.getByText('Оценка автомобиля для страховой').click();
  await expect(page.getByRole('heading', { name: 'Кто ведёт дело' })).toBeVisible();
  await page.getByLabel('Передать сотруднику').selectOption({ label: 'Тестовый Старший · старший · дел 0' });
  await page.getByRole('button', { name: 'Передать' }).click();
  await expect(page.getByText('Дело передано')).toBeVisible();
  await expect(page.getByText('Организация: АНО «Тестовый центр экспертиз» · Ведёт: Тестовый Старший')).toBeVisible();
  await shot(page, '16-peredacha');

  // Состав: роли, телефоны, нагрузка; руководитель убирает сотрудника.
  await page.getByRole('link', { name: /Организации/ }).click();
  await page.locator('#orgs').getByText('АНО «Тестовый центр экспертиз»').click();
  await expect(page.locator('#members li')).toHaveCount(3);
  await expect(page.getByText('Старший · +7 999 000-05-23 · дел: 1')).toBeVisible();
  await shot(page, '17-sotrudniki');
  page.once('dialog', (d) => d.accept());
  await page.locator(`#members li`).filter({ hasText: '+7 999 000-05-22' }).getByRole('button', { name: 'Убрать' }).click();
  await expect(page.getByText('Сотрудник убран')).toBeVisible();
  await expect(page.locator('#members li')).toHaveCount(2);

  // Ушедший сотрудник больше не видит дело организации.
  await mp.goto(orderUrl);
  await mp.reload();
  await expect(mp.getByRole('heading', { name: 'Заявка не найдена' })).toBeVisible();
  await mctx.close();
});

test('администратор назначает диспетчера; остальным раздел «Управление» не виден', async ({ page, browser, baseURL }) => {
  const A = '+79990000531', D = '+79990000532';
  const admin = await signIn(page, A);
  await db((c) => c.query("update users set platform_role = 'admin' where id = $1", [admin.id]));
  const dctx = await phoneContext(browser, baseURL);
  const dp = await dctx.newPage();
  await signIn(dp, D);
  await dp.goto('/kabinet#admin');
  await expect(dp.getByRole('heading', { name: 'Мои заявки' })).toBeVisible();
  await expect(dp.getByRole('link', { name: 'Управление' })).toBeHidden();

  await page.goto('/kabinet');
  await page.getByRole('link', { name: 'Управление' }).click();
  await page.getByLabel('Номер телефона пользователя').fill('8 999 000-05-32');
  await page.getByRole('button', { name: 'Найти' }).click();
  await expect(page.getByText(/\+7 999 000-05-32 · доступ открыт · без организаций/)).toBeVisible();
  await page.getByLabel('Служебная роль').selectOption('dispatcher');
  await page.getByRole('button', { name: 'Сохранить роль' }).click();
  await expect(page.getByText('Роль сохранена')).toBeVisible();
  await expect(page.locator('#staff li').filter({ hasText: '+7 999 000-05-32' })).toContainText('Диспетчер');
  await shot(page, '18-upravlenie');

  const role = await db(async (c) => (await c.query('select platform_role from users where phone = $1', [D])).rows[0].platform_role);
  expect(role).toBe('dispatcher');
  await dctx.close();
});

// Меню на телефоне (2.22): у служебного с ролью специалиста 9 разделов — все видны сразу, без прокрутки вбок.
async function menuFits(page) {
  const nav = page.locator('nav.tabs');
  expect(await nav.evaluate((n) => n.scrollWidth <= n.clientWidth), 'меню прокручивается вбок').toBe(true);
  const boxes = await nav.locator('a:visible').evaluateAll((as) => as.map((a) => {
    const r = a.getBoundingClientRect();
    return { name: a.textContent, left: r.left, right: r.right };
  }));
  for (const b of boxes) expect(b.left >= 0 && b.right <= 412, `«${b.name}» за краем экрана`).toBe(true);
  const rows = await nav.locator('a:visible').evaluateAll((as) => new Set(as.map((a) => Math.round(a.getBoundingClientRect().top))).size);
  return { tabs: boxes.length, rows };
}

test('меню на телефоне (2.22): у администратора-специалиста все 11 разделов видны без прокрутки вбок', async ({ page, browser, baseURL }) => {
  const admin = await signIn(page, '+79990000597');
  await db(async (c) => {
    await c.query("update users set platform_role = 'admin' where id = $1", [admin.id]);
    await c.query('insert into specialists (user_id) values ($1)', [admin.id]);
  });
  await page.goto('/kabinet');
  await expect(page.getByRole('heading', { name: 'Все заявки' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Управление' })).toBeVisible();
  expect(await menuFits(page)).toEqual({ tabs: 11, rows: 4 });
  await shot(page, '99j-menu-sluzhebnyi');
  await page.getByRole('link', { name: 'Деньги' }).click();
  await expect(page.getByRole('heading', { name: 'Деньги платформы' })).toBeVisible();
  await page.getByRole('link', { name: 'Профиль', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Профиль' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Профиль', exact: true })).toHaveAttribute('aria-current', 'page');
  await shot(page, '99k-menu-profil');

  // У заказчика шесть разделов (с «Как работать», 2.52) — две строки (одной на 412 точках не помещаются).
  const cctx = await phoneContext(browser, baseURL);
  const cp = await cctx.newPage();
  await signIn(cp, '+79990000598');
  await cp.goto('/kabinet');
  await expect(cp.getByRole('heading', { name: 'Мои заявки' })).toBeVisible();
  expect(await menuFits(cp)).toEqual({ tabs: 6, rows: 2 });
  await shot(cp, '99l-menu-zakazchik');
  await cctx.close();
});

const inDays = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
const H = { 'x-delo-request': '1' };

test('заявка на оценку: поля услуги, срок, основание «определение суда» с файлом, отправка', async ({ page }) => {
  await signIn(page, '+79990000541');
  await page.goto('/kabinet');
  await page.locator('#new-order').getByLabel('Услуга').selectOption({ label: 'Оценка недвижимости' });
  await page.getByRole('button', { name: 'Создать заявку' }).click();
  await expect(page.getByRole('heading', { name: 'Оценка недвижимости' })).toBeVisible();
  await expect(page.locator('#order-status')).toHaveText('Новая');

  // Без данных отправить нельзя — понятный список, чего не хватает.
  await page.getByRole('button', { name: 'Отправить заявку' }).click();
  await expect(page.getByText(/^Не хватает: Для чего нужна оценка, Где находится объект, Что оцениваем, Адрес объекта, срок/)).toBeVisible();

  await page.getByLabel('Для чего нужна оценка').selectOption({ label: 'Для суда' });
  await page.getByLabel('Где находится объект').selectOption({ label: 'Московская область' });
  await page.getByLabel('Что оцениваем').selectOption({ label: 'Квартира' });
  await page.getByLabel('Адрес объекта').fill('Московская обл., г. Тестовск, ул. Проверочная, д. 1, кв. 2');
  await page.getByLabel('Кадастровый номер').fill('50:01:0001001:123');
  await page.getByLabel('Площадь, кв. м').fill('54,3');
  await page.getByLabel(/^Срок/).fill(inDays(14));
  await page.getByLabel('Основание').selectOption({ label: 'Определение суда' });
  await page.getByLabel(/^Номер определения/).fill('2-1234/2026');
  await page.getByLabel(/^Дата определения/).fill(inDays(-10));
  await expect(page.getByText('Файл определения ещё не приложен')).toBeVisible();
  await page.getByRole('button', { name: 'Отправить заявку' }).click();
  await expect(page.getByText('Не хватает: файл определения суда')).toBeVisible();
  await shot(page, '19-zayavka-zapolnenie');

  await page.getByLabel('Приложить определение суда').setInputFiles({
    name: 'Определение суда.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 тестовое определение'),
  });
  await expect(page.getByText('Приложено: Определение суда.pdf')).toBeVisible();
  await expect(page.locator('#docs li').filter({ hasText: 'Определение суда.pdf' })).toContainText('Основание');
  await page.getByRole('button', { name: 'Отправить заявку' }).click();
  await expect(page.getByText('Заявка отправлена')).toBeVisible();
  await expect(page.locator('#order-status')).toHaveText('Подбор исполнителя');
  await expect(page.locator('#facts')).toContainText('Квартира');
  await expect(page.locator('#facts')).toContainText('54,3');
  await expect(page.locator('#facts')).toContainText('Определение суда, № 2-1234/2026');
  await expect(page.locator('#details-form')).toBeHidden();
  await expect(page.locator('#docs li').filter({ hasText: 'Определение суда.pdf' }).getByRole('button', { name: 'Удалить' })).toHaveCount(0);
  await expect(page.locator('#steps li.done')).toHaveCount(1);
  await shot(page, '20-zayavka-otpravlena');
});

test('ход заявки: подбор диспетчером, принятие и сдача специалистом, проверка, заказчик видит каждый шаг и закрывает', async ({ page, browser, baseURL }) => {
  const customer = await signIn(page, '+79990000542');
  const created = await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'vehicle', title: 'Оценка автомобиля после ДТП' }, headers: H })).json();
  const id = created.order.id;
  expect((await page.request.patch(`/api/orders/${id}`, {
    data: { deadline: inDays(7), fields: { purpose: 'damage', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая марка', vin: 'xta21099012345678' } }, headers: H,
  })).status()).toBe(200);
  expect((await page.request.post(`/api/orders/${id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  expect(customer.id).toBeTruthy();

  const dctx = await phoneContext(browser, baseURL);
  const dp = await dctx.newPage();
  const disp = await signIn(dp, '+79990000543');
  await db((c) => c.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]));
  const sctx = await phoneContext(browser, baseURL);
  const sp = await sctx.newPage();
  const spec = await signIn(sp, '+79990000545');
  await db(async (c) => {
    await c.query("update users set full_name = 'Тестовый оценщик' where id = $1", [spec.id]);
    await c.query('insert into specialists (user_id) values ($1)', [spec.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'vehicle')", [spec.id]);
  });

  // Диспетчер: все заявки, подбор с оценкой по признакам, предложение.
  await dp.goto('/kabinet');
  await expect(dp.getByRole('heading', { name: 'Все заявки' })).toBeVisible();
  await dp.getByLabel('Показать').selectOption('matching');
  await expect(dp.locator('#orders li').filter({ hasText: 'Оценка автомобиля после ДТП' })).toBeVisible();
  await shot(dp, '25-dispetcher-ochered');
  await dp.goto(`/kabinet#order=${id}`);
  await expect(dp.locator('#order-status')).toHaveText('Подбор исполнителя');
  await expect(dp.locator('#facts')).toContainText('XTA21099012345678');
  await expect(dp.getByRole('button', { name: 'Удалить' })).toHaveCount(0);
  await expect(dp.getByRole('button', { name: 'Отправить заявку' })).toHaveCount(0);
  const cand = dp.locator('#candidates li').filter({ hasText: 'Тестовый оценщик' });
  await expect(cand).toContainText('из 100');
  await expect(cand).toContainText('Загрузка');
  await shot(dp, '26-podbor');
  // Без цены дело не предложить; диспетчер назначает цену (задача 1.6).
  dp.once('dialog', (d) => d.accept());
  await cand.getByRole('button', { name: 'Предложить дело' }).click();
  await expect(dp.locator('#match-msg')).toHaveText('Сначала назначьте цену');
  await dp.getByLabel('Цена, рублей').fill('25000');
  await dp.getByRole('button', { name: 'Назначить цену' }).click();
  await expect(dp.locator('#money-msg')).toHaveText('Цена назначена');
  await expect(dp.locator('#money-facts')).toContainText(/Исполнителю \(80%\)\s*20\s000 ₽/);
  await expect(dp.locator('#money-facts')).toContainText(/Платформе \(20%\)\s*5\s000 ₽/);
  await shot(dp, '35-dispetcher-cena');
  // Заказчик платит при заказе (1.6а): пока не оплачено, дело не предложить.
  await expect(dp.locator('#match-current')).toContainText('после оплаты заказчиком');
  dp.once('dialog', (d) => d.accept());
  await cand.getByRole('button', { name: 'Предложить дело' }).click();
  await expect(dp.locator('#match-msg')).toHaveText('Заявка ещё не оплачена заказчиком');

  // Заказчик видит цену и оплачивает (поддельная ЮKassa); деньги ждут у платформы до выдачи результата.
  await page.goto(`/kabinet#order=${id}`);
  await expect(page.locator('#money-facts')).toContainText(/Цена\s*25\s000 ₽/);
  await expect(page.locator('#money-facts')).not.toContainText('Исполнителю');
  await expect(page.locator('#money-facts')).toContainText('после неё заявку передадут исполнителю');
  await shot(page, '36-zakazchik-oplata');
  await page.getByRole('button', { name: /Оплатить 25\s000 ₽/ }).click();
  await expect(page.locator('#money-facts')).toContainText('оплачено');
  await expect(page.locator('#money-facts')).toContainText('уйдут исполнителю, только когда результат проверен');
  await expect(page.getByRole('button', { name: /Оплатить/ })).toBeHidden();
  await expect(page.locator('#closing li')).toHaveCount(0);

  await dp.reload();
  await expect(dp.locator('#match-current')).toContainText('Заявка оплачена');
  await expect(dp.getByLabel('Цена, рублей')).toBeHidden();
  dp.once('dialog', (d) => d.accept());
  await dp.locator('#candidates li').filter({ hasText: 'Тестовый оценщик' }).getByRole('button', { name: 'Предложить дело' }).click();
  await expect(dp.locator('#order-status')).toHaveText('Ждёт исполнителя');
  await expect(dp.locator('#match-current')).toContainText('Тестовый оценщик');

  // Специалист: видит предложение в своём списке, отказывается с причиной, получает снова, принимает и сдаёт.
  await sp.goto('/kabinet');
  await expect(sp.getByRole('link', { name: 'Специалист' })).toBeVisible();
  await expect(sp.getByRole('link', { name: 'Специалисты' })).toBeHidden();
  // Дела специалиста — по группам (разбор 03.10.2026, 2.11–2.12): предложение сверху, со сроком и вознаграждением.
  await expect(sp.locator('#orders li.group').first()).toHaveText('Предложены Вам · 1');
  const offer = sp.locator('#orders li').filter({ hasText: 'Оценка автомобиля после ДТП' });
  await expect(offer).toContainText(/осталось \d+ дн\./);
  await expect(offer).toContainText(/Вам \d/);
  await expect(offer.getByRole('button', { name: 'Принять дело' })).toBeVisible();
  await shot(sp, '99-specialist-predlozheniya');
  await sp.goto(`/kabinet#order=${id}`);
  await expect(sp.locator('#order-status')).toHaveText('Ждёт исполнителя');
  await expect(sp.getByRole('button', { name: 'Принять дело' })).toBeVisible();
  await expect(sp.locator('#match-box')).toBeHidden();
  // Исполнитель видит своё вознаграждение, но не цену заказчика.
  await expect(sp.locator('#money-facts')).toContainText(/Ваше вознаграждение \(80% цены\)\s*20\s000 ₽/);
  await expect(sp.locator('#money-facts')).not.toContainText('25');
  await shot(sp, '27-specialist-predlozhenie');
  await sp.getByRole('button', { name: 'Отказаться' }).click();
  await expect(sp.getByText('Укажите причину')).toBeVisible();
  await sp.getByLabel('Причина (для возврата или отмены)').fill('Занят до конца месяца');
  await sp.getByRole('button', { name: 'Отказаться' }).click();
  await expect(sp.getByRole('heading', { name: 'Заявка не найдена' })).toBeVisible();

  await dp.reload();
  await expect(dp.locator('#order-status')).toHaveText('Подбор исполнителя');
  await expect(dp.locator('#history')).toContainText('Причина: Занят до конца месяца');
  dp.once('dialog', (d) => d.accept());
  await dp.locator('#candidates li').filter({ hasText: 'Тестовый оценщик' }).getByRole('button', { name: 'Предложить дело' }).click();
  await expect(dp.locator('#order-status')).toHaveText('Ждёт исполнителя');

  await sp.goto('/kabinet');
  await sp.goto(`/kabinet#order=${id}`);
  await sp.reload();
  await sp.getByRole('button', { name: 'Принять дело' }).click();
  await expect(sp.locator('#order-status')).toHaveText('В работе');
  await expect(sp.locator('#order-org-line')).toContainText('Исполнитель: Вы');
  // «Что дальше» (разбор 03.10.2026, 2.10): шаги до сдачи и одна главная кнопка — вверху и внизу экрана.
  await expect(sp.locator('#next-box')).toBeVisible();
  await expect(sp.locator('#next-steps li[data-step="result"]')).toContainText('○ Файл результата');
  await expect(sp.locator('#next-main button')).toHaveText('Добавить файл результата');
  await expect(sp.locator('#next-bar button')).toHaveText('Добавить файл результата');
  await expect(sp.locator('#next-bar')).toBeHidden(); // карточка на экране — нижняя кнопка не дублирует
  await sp.locator('#chat-box').scrollIntoViewIfNeeded();
  await expect(sp.locator('#next-bar')).toBeVisible();
  await sp.evaluate(() => window.scrollTo(0, 0));
  await shot(sp, '99a-specialist-chto-dalshe');
  // Ассистент из карточки дела (2.21): заявка уже выбрана.
  await sp.getByRole('link', { name: 'Спросить ассистента об этом деле' }).click();
  await expect(sp.getByRole('heading', { name: 'Ассистент по делам' })).toBeVisible();
  await expect(sp.getByLabel('О какой заявке (можно не выбирать)')).toHaveValue(id);
  await sp.goto(`/kabinet#order=${id}`);
  await expect(sp.locator('#order-status')).toHaveText('В работе');
  // Без файла результата сдать нельзя; исполнитель прикладывает результат и пишет в переписку (задача 1.5).
  await sp.getByRole('button', { name: 'Сдать на проверку' }).click();
  await expect(sp.locator('#status-msg')).toHaveText('Сначала добавьте файл результата');
  await sp.locator('#result-file').setInputFiles({ name: 'тестовый-отчёт.pdf', mimeType: 'application/pdf', buffer: Buffer.from('тестовый отчёт об оценке') });
  await expect(sp.locator('#doc-msg')).toHaveText('Файл добавлен');
  await expect(sp.locator('#docs li').filter({ hasText: 'тестовый-отчёт.pdf' })).toContainText('Результат работы');
  await sp.getByLabel('Сообщение').fill('Осмотр проведён, отчёт приложен.');
  await sp.getByRole('button', { name: 'Отправить сообщение' }).click();
  await expect(sp.locator('#messages li')).toHaveCount(1);
  await expect(sp.locator('#messages li').first()).toContainText('Вы');
  await shot(sp, '32-specialist-rezultat');
  // Заключение подписывается УКЭП эксперта (2.5): без подписи не сдать.
  await expect(sp.locator('#result-sign-note')).toBeVisible();
  const repDoc = sp.locator('#docs li').filter({ hasText: 'тестовый-отчёт.pdf' });
  await expect(repDoc.locator('.sig-state')).toHaveText('Не подписан УКЭП — без подписи на проверку не сдать');
  await expect(sp.locator('#next-steps li[data-step="result"]')).toContainText('✓ Файл результата');
  await expect(sp.locator('#next-main button')).toHaveText('Подписать файл');
  await sp.getByRole('button', { name: 'Сдать на проверку' }).click();
  await expect(sp.locator('#status-msg')).toHaveText('Подпишите УКЭП файлы результата: тестовый-отчёт.pdf');
  sp.once('dialog', (d) => d.accept());
  await repDoc.getByRole('button', { name: 'Подписать' }).click();
  await expect(sp.locator('#doc-msg')).toHaveText('Файл подписан');
  await expect(repDoc.locator('.sig-state')).toContainText('Подпись эксперта: Тестовый оценщик');
  await expect(repDoc.locator('.sig-test')).toHaveText('Тестовая подпись площадки — юридической силы не имеет');
  await shot(sp, '93-specialist-podpis');
  await expect(sp.locator('#next-main button')).toHaveText('Сдать на проверку');
  await sp.getByRole('button', { name: 'Сдать на проверку' }).click();
  await expect(sp.locator('#order-status')).toHaveText('Проверка результата');
  await expect(sp.locator('#result-upload-box')).toBeHidden();
  await shot(sp, '28-specialist-sdal');

  // Диспетчер проверяет по правилам: замечание по одному правилу → причина возврата собирается из замечаний.
  await dp.reload();
  await expect(dp.locator('#review-box')).toBeVisible();
  await expect(dp.locator('#messages li').first()).toContainText('Исполнитель');
  const calc = dp.locator('#review-checks li').filter({ hasText: 'Расчёт' });
  await calc.getByRole('button', { name: 'Замечание' }).click();
  await expect(dp.locator('#review-msg')).toHaveText('Опишите замечание');
  await dp.locator('#review-checks li').filter({ hasText: 'Расчёт' }).getByRole('textbox').fill('Нет фото повреждений');
  await dp.locator('#review-checks li').filter({ hasText: 'Расчёт' }).getByRole('button', { name: 'Замечание' }).click();
  await expect(dp.locator('#review-checks li').filter({ hasText: 'Расчёт' }).locator('.verdict')).toHaveText('Замечание');
  await dp.getByRole('button', { name: 'Проверено, готово' }).click();
  await expect(dp.locator('#status-msg')).toContainText('Есть замечания');
  await expect(dp.getByLabel('Причина (для возврата или отмены)')).toHaveValue(/Нет фото повреждений/);
  await shot(dp, '33-dispetcher-proverka');
  await dp.getByRole('button', { name: 'Вернуть на доработку' }).click();
  await expect(dp.locator('#order-status')).toHaveText('В работе');

  // Исполнитель видит замечание, прикладывает исправленный файл и сдаёт снова.
  await sp.reload();
  await expect(sp.locator('#review-checks li').filter({ hasText: 'Расчёт' })).toContainText('Нет фото повреждений');
  await expect(sp.locator('#review-checks button')).toHaveCount(0);
  await sp.locator('#result-file').setInputFiles({ name: 'отчёт-с-фото.pdf', mimeType: 'application/pdf', buffer: Buffer.from('исправленный тестовый отчёт') });
  await expect(sp.locator('#docs li').filter({ hasText: 'отчёт-с-фото.pdf' })).toBeVisible();
  await shot(sp, '34-specialist-zamechaniya');
  await signResults(sp);
  await sp.getByRole('button', { name: 'Сдать на проверку' }).click();
  await expect(sp.locator('#order-status')).toHaveText('Проверка результата');

  // Новый круг: все правила в порядке → «Проверено, готово».
  await dp.reload();
  const rules = dp.locator('#review-checks > li');
  await expect(dp.locator('#review-summary')).toContainText('Круг проверки 2');
  const n = await rules.count();
  expect(n).toBeGreaterThan(3);
  for (let i = 0; i < n; i += 1) {
    await rules.nth(i).getByRole('button', { name: 'В порядке' }).click();
    await expect(rules.nth(i).locator('.verdict')).toHaveText('В порядке');
  }
  await expect(dp.locator('#review-summary')).toContainText('все правила');
  await shot(dp, '21-dispetcher-hod');
  await dp.getByRole('button', { name: 'Проверено, готово' }).click();
  await expect(dp.locator('#order-status')).toHaveText('Готово');

  await page.goto(`/kabinet#order=${id}`);
  await expect(page.locator('#order-status')).toHaveText('Готово');
  await expect(page.locator('#history')).toContainText('Нет фото повреждений');
  await expect(page.locator('#history li')).toHaveCount(10);
  await expect(page.getByRole('button', { name: 'Отменить заявку' })).toHaveCount(0);
  // Результат проверен и выдан: заказчику — акт (оплачено при заказе), исполнителю — выплата.
  await expect(page.locator('#results-later')).toBeHidden();
  // Заказчик получил подписанное заключение: видит подпись, проверяет её и скачивает файл подписи (2.5).
  const signed = page.locator('#docs li').filter({ hasText: 'отчёт-с-фото.pdf' });
  await expect(signed.locator('.sig-state')).toContainText('Подпись эксперта: Тестовый оценщик');
  await signed.getByRole('button', { name: 'Проверить подпись' }).click();
  await expect(page.locator('#doc-msg')).toHaveText('«отчёт-с-фото.pdf»: подпись верна — Тестовый оценщик');
  await expect(signed.getByRole('button', { name: 'Подписать' })).toHaveCount(0);
  const [sigFile] = await Promise.all([page.waitForEvent('download'), signed.getByRole('button', { name: 'Файл подписи' }).click()]);
  expect(sigFile.suggestedFilename()).toBe('отчёт-с-фото.pdf.sig');
  await shot(page, '94-zakazchik-podpis');
  await expect(page.locator('#money-facts')).toContainText('оплачено');
  await expect(page.locator('#closing li')).toHaveCount(1);
  await page.locator('#closing li').getByRole('button', { name: 'Открыть' }).click();
  await expect(page.locator('#closing-doc')).toContainText('Акт об оказании услуг');
  await expect(page.locator('#closing-doc')).toContainText('Проверочный документ');
  await expect(page.locator('#closing-doc')).toContainText(/вознаграждение агента \(20%\): 5\s000 ₽/);
  await shot(page, '37-zakazchik-akt');
  // После проверки заказчик видит оба файла результата и итог проверки; удалить их не может; отвечает в переписке.
  await expect(page.locator('#docs li').filter({ hasText: 'Результат работы' })).toHaveCount(2);
  await expect(page.locator('#docs li').filter({ hasText: 'Результат работы' }).getByRole('button', { name: 'Удалить' })).toHaveCount(0);
  await expect(page.locator('#review-summary')).toContainText('все правила');
  await expect(page.locator('#review-checks li')).toHaveCount(0);
  await expect(page.locator('#messages li').first()).toContainText('Исполнитель');
  await page.getByLabel('Сообщение').fill('Спасибо, результат получен.');
  await page.getByRole('button', { name: 'Отправить сообщение' }).click();
  await expect(page.locator('#messages li')).toHaveCount(2);
  await shot(page, '22-zakazchik-gotovo');
  await page.getByRole('button', { name: 'Принять и закрыть' }).click();
  await expect(page.locator('#order-status')).toHaveText('Закрыта');
  await expect(page.locator('#steps li.done')).toHaveCount(6);
  await expect(page.locator('#upload-box')).toBeHidden();
  await expect(page.locator('#message-form')).toBeHidden();

  // Выплата исполнителю прошла автоматически: специалист видит её в «Деньгах» и отчёт агента в деле.
  const sp2 = sp;
  await sp2.goto('/kabinet#money');
  await expect(sp2.getByRole('heading', { name: 'Мои выплаты' })).toBeVisible();
  await expect(sp2.locator('#money-totals')).toContainText(/Выплачено\s*20\s000 ₽/);
  await expect(sp2.locator('#money-payouts li').filter({ hasText: 'Оценка автомобиля после ДТП' })).toContainText('выплачено');
  await expect(sp2.locator('#money-payments-box')).toBeHidden();
  await shot(sp2, '38-specialist-vyplaty');
  await sp2.locator('#money-payouts li').filter({ hasText: 'Оценка автомобиля после ДТП' }).click();
  await sp2.locator('#closing li').getByRole('button', { name: 'Открыть' }).click();
  await expect(sp2.locator('#closing-doc')).toContainText(/К перечислению исполнителю: 20\s000 ₽/);
  await expect(sp2.locator('#closing-doc')).not.toContainText('Заказчик:');
  await sctx.close();

  // Диспетчер: сводка «Деньги».
  const dp2 = dp;
  await dp2.goto('/kabinet#money');
  await expect(dp2.getByRole('heading', { name: 'Деньги платформы' })).toBeVisible();
  await expect(dp2.locator('#money-payments li').filter({ hasText: 'Оценка автомобиля после ДТП' })).toContainText(/25\s000 ₽/);
  await shot(dp2, '39-dispetcher-dengi');
  await dctx.close();
});

test('отмена заказчиком до начала работ; просроченный срок виден в списке', async ({ page }) => {
  await signIn(page, '+79990000544');
  const mk = async (title) => (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'goods', title }, headers: H })).json()).order.id;
  const late = await mk('Экспертиза телевизора');
  const cancel = await mk('Экспертиза холодильника');
  await db((c) => c.query("update orders set deadline = current_date - 2 where id = $1", [late]));

  await page.goto(`/kabinet#order=${cancel}`);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Отменить заявку' }).click();
  await expect(page.locator('#order-status')).toHaveText('Отменена');
  await expect(page.locator('#steps')).toHaveText('Заявка отменена');
  await expect(page.getByRole('button', { name: 'Отправить заявку' })).toHaveCount(0);
  await expect(page.locator('#upload-box')).toBeHidden();
  await shot(page, '23-otmena');

  await page.getByRole('button', { name: '← Все заявки' }).click();
  await expect(page.locator('#orders li').filter({ hasText: 'Экспертиза телевизора' })).toContainText('просрочено');
  await expect(page.locator('#orders li').filter({ hasText: 'Экспертиза холодильника' })).toContainText('Отменена');
  await shot(page, '24-spisok-sroki');
});

test('администратор делает человека специалистом и выдаёт допуск; диспетчер видит список специалистов', async ({ page, browser, baseURL }) => {
  const admin = await signIn(page, '+79990000551');
  await db((c) => c.query("update users set platform_role = 'admin' where id = $1", [admin.id]));
  const sctx = await phoneContext(browser, baseURL);
  const sp = await sctx.newPage();
  await signIn(sp, '+79990000552');
  await sp.goto('/kabinet');
  await expect(sp.getByRole('link', { name: 'Специалист' })).toBeHidden();

  await page.goto('/kabinet#admin');
  await page.getByLabel('Номер телефона пользователя').fill('8 999 000-05-52');
  await page.getByRole('button', { name: 'Найти' }).click();
  await expect(page.locator('#admin-specialist-state')).toContainText('Пока не специалист');
  await page.getByLabel('Нормальная нагрузка: сколько дел одновременно').fill('3');
  await page.getByRole('button', { name: 'Сохранить профиль специалиста' }).click();
  await expect(page.getByText('Профиль специалиста сохранён')).toBeVisible();
  await page.getByLabel('Дать допуск на услугу').selectOption('expertise/land');
  await page.getByRole('button', { name: 'Дать допуск' }).click();
  await expect(page.locator('#sp-permits li')).toContainText('земельного участка');
  await shot(page, '29-upravlenie-specialist');

  await sp.reload();
  await sp.goto('/kabinet#specialist');
  await expect(sp.getByRole('heading', { name: 'Мой профиль специалиста' })).toBeVisible();
  await expect(sp.locator('#specialist-facts')).toContainText('Дел сейчас: 0 из 3');
  await expect(sp.locator('#specialist-permits')).toContainText('земельного участка');
  await sp.getByLabel('Принимаю новые дела').uncheck();
  await expect(sp.getByText('Вам не будут предлагать новые дела')).toBeVisible();
  await shot(sp, '30-specialist-profil');
  const active = await db(async (c) => (await c.query("select s.active from specialists s join users u on u.id = s.user_id where u.phone = '+79990000552'")).rows[0].active);
  expect(active).toBe(false);

  await page.goto('/kabinet#specialists');
  await expect(page.locator('#specialists li').filter({ hasText: 'не принимает дела' })).toContainText('земельного участка');
  await shot(page, '31-spisok-specialistov');
  await sctx.close();
});

test('уведомления: специалисту — о предложенном деле, заказчику — о принятии; переход в заявку; СМС можно выключить', async ({ page, browser, baseURL }) => {
  const dctx = await phoneContext(browser, baseURL);
  const dp = await dctx.newPage();
  const disp = await signIn(dp, '+79990000563');
  await db((c) => c.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]));
  const customer = await signIn(page, '+79990000561');
  const created = await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'land', title: 'Оценка участка в Подмосковье' }, headers: H })).json();
  const id = created.order.id;
  expect((await page.request.patch(`/api/orders/${id}`, {
    data: { deadline: inDays(9), fields: { purpose: 'deal', region: 'mo', address: 'Московская обл., тестовый пос., уч. 1', area: 600 } }, headers: H,
  })).status()).toBe(200);
  expect((await page.request.post(`/api/orders/${id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  expect(customer.id).toBeTruthy();

  const sctx = await phoneContext(browser, baseURL);
  const sp = await sctx.newPage();
  const spec = await signIn(sp, '+79990000562');
  await db(async (c) => {
    await c.query('insert into specialists (user_id) values ($1)', [spec.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'land')", [spec.id]);
    await c.query('update orders set price_kop = 2000000, paid_at = now() where id = $1', [id]);
  });
  expect((await dp.request.post(`/api/orders/${id}/offer`, { data: { specialist_id: spec.id, from: 'matching' }, headers: H })).status()).toBe(200);

  // Специалист: счётчик на вкладке, лента, переход в заявку.
  await sp.goto('/kabinet');
  await expect(sp.locator('#notify-count')).toHaveText('1');
  await sp.getByRole('link', { name: /Уведомления/ }).click();
  await expect(sp.getByRole('heading', { name: 'Уведомления', exact: true })).toBeVisible();
  const item = sp.locator('#notifications li').first();
  await expect(item).toContainText('Вам предложено новое дело');
  await expect(item).toContainText('Оценка участка в Подмосковье');
  await expect(item).toHaveClass(/unread/);
  await expect(sp.locator('#notify-count')).toBeHidden();
  await shot(sp, '40-uvedomleniya-specialist');
  // СМС о предложениях можно выключить; в кабинете уведомления остаются.
  await expect(sp.getByLabel('Предложения дел')).toBeChecked();
  await sp.getByLabel('Предложения дел').uncheck();
  await expect(sp.locator('#notify-msg')).toHaveText('СМС выключены — уведомления останутся в кабинете');
  await shot(sp, '41-uvedomleniya-nastroyki');
  const sms = await db(async (c) => (await c.query("select sms from notification_settings where user_id = $1 and type = 'offers'", [spec.id])).rows[0].sms);
  expect(sms).toBe(false);
  await item.getByRole('button').click();
  await expect(sp.locator('#order-title')).toHaveText('Оценка участка в Подмосковье');
  await expect(sp.getByRole('button', { name: 'Принять дело' })).toBeVisible();
  await sp.getByRole('button', { name: 'Принять дело' }).click();
  await expect(sp.locator('#order-status')).toHaveText('В работе');

  // Заказчик: уведомление о принятии; в настройках нет видов для специалистов и диспетчеров.
  await page.goto('/kabinet');
  await expect(page.locator('#notify-count')).toHaveText('1');
  await page.goto('/kabinet#notifications');
  await expect(page.locator('#notifications li').first()).toContainText('Исполнитель принял заявку в работу');
  await expect(page.getByLabel('Ход моих заявок')).toBeChecked();
  await expect(page.getByLabel('Предложения дел')).toHaveCount(0);
  await expect(page.getByLabel('Очередь диспетчера')).toHaveCount(0);
  await shot(page, '42-uvedomleniya-zakazchik');
  await page.locator('#notifications li').first().getByRole('button').click();
  await expect(page.locator('#order-status')).toHaveText('В работе');

  // Диспетчер видит «новую заявку» и вид «Очередь диспетчера» (СМС по нему по умолчанию выключены).
  await dp.goto('/kabinet#notifications');
  await expect(dp.locator('#notifications')).toContainText('Новая заявка ждёт подбора исполнителя');
  await expect(dp.getByLabel('Очередь диспетчера')).not.toBeChecked();
  await expect(dp.getByLabel('Предложения дел')).toHaveCount(0);
  await shot(dp, '43-uvedomleniya-dispetcher');
  await sctx.close();
  await dctx.close();
});

test('деньги при отмене: передача другому исполнителю; отказ заказчика после начала работ — оплата сделанной части и возврат', async ({ page, browser, baseURL }) => {
  const customer = await signIn(page, '+79990000571');
  const created = await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'goods', title: 'Оценка мебели' }, headers: H })).json();
  const id = created.order.id;
  expect((await page.request.patch(`/api/orders/${id}`, {
    data: { deadline: inDays(8), fields: { purpose: 'deal', region: 'moscow', subject: 'Тестовый шкаф, скол на дверце', questions: 'Есть ли производственный брак?' } }, headers: H,
  })).status()).toBe(200);
  expect((await page.request.post(`/api/orders/${id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  expect(customer.id).toBeTruthy();

  const dctx = await phoneContext(browser, baseURL);
  const dp = await dctx.newPage();
  const disp = await signIn(dp, '+79990000572');
  const sctx = await phoneContext(browser, baseURL);
  const sp = await sctx.newPage();
  const spec = await signIn(sp, '+79990000573');
  await db(async (c) => {
    await c.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]);
    await c.query('insert into specialists (user_id) values ($1)', [spec.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'goods')", [spec.id]);
  });
  expect((await dp.request.put(`/api/orders/${id}/price`, { data: { price: '10000' }, headers: H })).status()).toBe(200);
  await page.goto(`/kabinet#order=${id}`);
  await page.getByRole('button', { name: /Оплатить 10\s000 ₽/ }).click();
  await expect(page.locator('#money-facts')).toContainText('оплачено');
  const offerAndAccept = async () => {
    expect((await dp.request.post(`/api/orders/${id}/offer`, { data: { specialist_id: spec.id, from: 'matching' }, headers: H })).status()).toBe(200);
    expect((await sp.request.post(`/api/orders/${id}/status`, { data: { from: 'awaiting_executor', to: 'in_work' }, headers: H })).status()).toBe(200);
  };
  await offerAndAccept();

  // Исполнитель не справляется — диспетчер передаёт дело другому; оплата заказчика в силе.
  await dp.goto(`/kabinet#order=${id}`);
  await expect(dp.locator('#order-status')).toHaveText('В работе');
  await dp.getByRole('button', { name: 'Передать другому исполнителю' }).click();
  await expect(dp.locator('#status-msg')).toHaveText('Укажите причину');
  await dp.getByLabel('Причина (для возврата или отмены)').fill('Исполнитель не выходит на связь');
  await dp.getByRole('button', { name: 'Передать другому исполнителю' }).click();
  await expect(dp.locator('#order-status')).toHaveText('Подбор исполнителя');
  await expect(dp.locator('#match-current')).toContainText('Заявка оплачена');
  await shot(dp, '44-dispetcher-peredat-drugomu');
  await sp.goto(`/kabinet#order=${id}`);
  await expect(sp.getByRole('heading', { name: 'Заявка не найдена' })).toBeVisible();

  // Снова в работе; заказчик отказался — диспетчер указывает, что сделано 40%.
  await offerAndAccept();
  await dp.reload();
  await expect(dp.locator('#order-status')).toHaveText('В работе');
  await dp.getByLabel('Причина (для возврата или отмены)').fill('Заказчик отказался от оценки');
  dp.on('dialog', (d) => d.accept());
  await dp.getByRole('button', { name: 'Отменить заявку' }).click();
  await expect(dp.locator('#status-msg')).toHaveText('Укажите, по чьей причине отмена');
  await dp.getByLabel('Если отменить: по чьей причине').selectOption('customer');
  await dp.getByLabel('Сделано работы, %').fill('40');
  await shot(dp, '45-dispetcher-otmena-chast');
  await dp.getByRole('button', { name: 'Отменить заявку' }).click();
  await expect(dp.locator('#order-status')).toHaveText('Отменена');
  await expect(dp.locator('#money-facts')).toContainText('заказчик отказался, сделано 40% работы');
  await expect(dp.locator('#money-facts')).toContainText(/Возврат заказчику\s*6\s000 ₽ — возвращено/);
  await expect(dp.locator('#money-facts')).toContainText(/Выплата исполнителю\s*3\s200 ₽ — выплачено/);

  // Заказчик: возврат 6 000 ₽ и документ о возврате; акт — на сделанную часть.
  await page.reload();
  await expect(page.locator('#order-status')).toHaveText('Отменена');
  await expect(page.locator('#money-facts')).toContainText(/Возврат заказчику\s*6\s000 ₽ — возвращено/);
  await expect(page.locator('#money-facts')).not.toContainText('Выплата исполнителю');
  await page.locator('#closing li').filter({ hasText: 'Возврат' }).getByRole('button', { name: 'Открыть' }).click();
  await expect(page.locator('#closing-doc')).toContainText('Документ о возврате');
  await expect(page.locator('#closing-doc')).toContainText(/Возвращается заказчику: 6\s000 ₽/);
  await expect(page.locator('#closing-doc')).toContainText('Причина: Заказчик отказался от оценки');
  await shot(page, '46-zakazchik-vozvrat');
  await page.locator('#closing li').filter({ hasText: 'Акт' }).getByRole('button', { name: 'Открыть' }).click();
  await expect(page.locator('#closing-doc')).toContainText('оказана часть услуги (40%)');

  // Исполнитель видит выплату за сделанную часть в своём отменённом деле.
  await sp.reload();
  await expect(sp.locator('#order-status')).toHaveText('Отменена');
  await expect(sp.locator('#money-facts')).toContainText(/Выплата\s*3\s200 ₽ — выплачено/);
  await expect(sp.locator('#money-facts')).not.toContainText('Возврат');
  await shot(sp, '47-specialist-vyplata-chast');

  // Сводка «Деньги»: возвращено заказчикам.
  await dp.goto('/kabinet#money');
  await expect(dp.locator('#money-totals')).toContainText('Возвращено заказчикам');
  await shot(dp, '48-dispetcher-dengi-vozvraty');
  await sctx.close();
  await dctx.close();
});

test('помощник: человек описывает проблему, ИИ разъясняет и предлагает услугу, заявка-черновик; ассистент с личной и рабочей памятью; модель видна администратору', async ({ page }) => {
  const me = await signIn(page, '+79990000581');
  await db(async (c) => {
    const { rows: [org] } = await c.query("insert into organizations (name) values ('Тестовое бюро помощника') returning id");
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head')", [org.id, me.id]);
  });
  await page.goto('/kabinet');
  await page.getByRole('link', { name: 'Спросить помощника' }).click();
  await expect(page.getByRole('heading', { name: 'Помощник' })).toBeVisible();
  await page.getByRole('button', { name: 'Разобраться' }).click();
  await expect(page.locator('#problem-msg')).toHaveText('Опишите, что случилось');
  await shot(page, '49-pomoshnik');

  await page.getByLabel('Что случилось').fill('Суд назначил оценку квартиры в Москве при разделе имущества. Что мне делать?');
  await page.getByRole('button', { name: 'Разобраться' }).click();
  await expect(page.locator('#pa-explanation')).toContainText('независимая оценка');
  await expect(page.locator('#pa-steps li')).toHaveCount(2);
  await expect(page.locator('#pa-specialist')).toContainText('Оценка недвижимости');
  await expect(page.getByLabel('Услуга для заявки')).toHaveValue('expertise/realty');
  await expect(page.locator('#pa-disclaimer')).toContainText('не юридическая услуга');
  await shot(page, '50-pomoshnik-razbor');

  await page.getByRole('button', { name: 'Создать заявку' }).click();
  await expect(page).toHaveURL(/#order=/);
  await expect(page.locator('#order-status')).toHaveText('Новая');
  await expect(page.locator('#order-title')).toContainText('Оценка по описанию');
  await expect(page.getByLabel('Что ещё важно знать')).toHaveValue(/Суд назначил оценку квартиры/);
  await expect(page.getByLabel('Для чего нужна оценка')).toHaveValue('court');
  await shot(page, '51-zayavka-iz-razbora');

  // Ассистент: вопрос о заявке в личной памяти; в памяти организации разговор отдельный.
  await page.goto('/kabinet#assistant');
  await expect(page.getByText('Разговор пока пуст.')).toBeVisible();
  await page.getByLabel('О какой заявке (можно не выбирать)').selectOption({ index: 1 });
  await page.getByLabel('Вопрос').fill('Какие документы подготовить к осмотру?');
  await page.getByRole('button', { name: 'Спросить' }).click();
  await expect(page.locator('#as-messages li')).toHaveCount(2);
  await expect(page.locator('#as-messages li.assistant')).toContainText('Какие документы подготовить к осмотру?');
  await shot(page, '52-assistent');
  await page.getByLabel('Раздел памяти').selectOption({ label: 'Тестовое бюро помощника' });
  await expect(page.getByText('Разговор пока пуст.')).toBeVisible();
  await expect(page.locator('#as-order option')).toHaveCount(1);
  await page.getByLabel('Вопрос').fill('Как распределить дела между сотрудниками?');
  await page.getByRole('button', { name: 'Спросить' }).click();
  await expect(page.locator('#as-messages li')).toHaveCount(2);
  await shot(page, '53-assistent-organizaciya');
  page.on('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Очистить память' }).click();
  await expect(page.locator('#as-msg')).toHaveText('Память очищена');
  await page.getByLabel('Раздел памяти').selectOption({ label: 'Личное' });
  await expect(page.locator('#as-messages li')).toHaveCount(2);

  // Администратор видит, какая модель ИИ работает.
  await db((c) => c.query("update users set platform_role = 'admin' where id = $1", [me.id]));
  await page.goto('/kabinet#admin');
  await page.reload(); // роль поменялась — кабинет перечитывает, кто вошёл
  await expect(page.locator('#admin-ai')).toContainText('Поддельная модель (проверки)');
  await expect(page.locator('#admin-ai')).toContainText('не задана');
  await shot(page, '56-upravlenie-ii');
});

test('ИИ-проверка результата: специалист перед сдачей, диспетчер на проверке; отметки ставит человек', async ({ browser, baseURL }) => {
  // Заявку здесь создаёт сам диспетчер (как заказчик), оплата — напрямую в базе.
  const dctx = await phoneContext(browser, baseURL);
  const dp = await dctx.newPage();
  const disp = await signIn(dp, '+79990000592');
  const created = await (await dp.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Оценка квартиры для ИИ-проверки' }, headers: H })).json();
  const id = created.order.id;
  expect((await dp.request.patch(`/api/orders/${id}`, {
    data: { deadline: inDays(9), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 9' } }, headers: H,
  })).status()).toBe(200);
  expect((await dp.request.post(`/api/orders/${id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  const sctx = await phoneContext(browser, baseURL);
  const sp = await sctx.newPage();
  const spec = await signIn(sp, '+79990000593');
  await db(async (c) => {
    await c.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]);
    await c.query('insert into specialists (user_id) values ($1)', [spec.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [spec.id]);
    // Оплата — как после успешного платежа поддельной ЮKassa (сама оплата проверяется в других сценариях).
    await c.query('update orders set price_kop = 1500000, paid_at = now() where id = $1', [id]);
    await c.query("insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at) values ($1, 1500000, 'succeeded', $2, $3, now())", [id, `pay_ui_${id}`, disp.id]);
  });
  expect((await dp.request.post(`/api/orders/${id}/offer`, { data: { specialist_id: spec.id, from: 'matching' }, headers: H })).status()).toBe(200);
  expect((await sp.request.post(`/api/orders/${id}/status`, { data: { from: 'awaiting_executor', to: 'in_work' }, headers: H })).status()).toBe(200);
  // Отчёт — PDF на две страницы (задача 2.1): ИИ читает его и показывает отмеченное место со страницей.
  expect((await sp.request.post(`/api/orders/${id}/results`, {
    data: makePdf([['Заключение № 3/2026 об оценке квартиры'], ['Итоговая стоимость 9 500 000 руб.', 'В разделе 3 опечатка в адресе.']]),
    headers: { ...H, 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('отчёт.pdf') },
  })).status()).toBe(201);

  // Специалист проверяет результат с помощью ИИ до сдачи.
  await sp.goto(`/kabinet#order=${id}`);
  await expect(sp.locator('#review-summary')).toContainText('Перед сдачей можно проверить результат с помощью ИИ');
  await expect(sp.locator('#ai-review-state')).toHaveText('ИИ-проверка ещё не запускалась.');
  await sp.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(sp.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  await expect(sp.locator('#ai-review-state')).toContainText('запускал исполнитель перед сдачей');
  await expect(sp.locator('#review-checks li').filter({ hasText: 'Технические ошибки' }).locator('.ai-hint')).toContainText('посмотрите');
  await expect(sp.locator('#review-checks li').filter({ hasText: 'Технические ошибки' }).locator('.ai-marks li')).toHaveText(['отчёт.pdf, стр. 2: В разделе 3 опечатка в адресе.']);
  await expect(sp.locator('#review-checks li').filter({ hasText: 'Расчёт' }).locator('.ai-hint')).toHaveText('ИИ: Замечаний не найдено');
  await expect(sp.locator('#review-checks .verdict')).toHaveCount(0);
  await shot(sp, '54-specialist-ii-proverka');
  expect((await sp.request.patch('/api/me', { data: { full_name: 'Тестов Эксперт ИИ' }, headers: H })).status()).toBe(200);
  await signResults(sp);
  await sp.getByRole('button', { name: 'Сдать на проверку' }).click();
  await expect(sp.locator('#order-status')).toHaveText('Проверка результата');
  await expect(sp.getByRole('button', { name: 'Проверить с помощью ИИ' })).toBeHidden();

  // Диспетчер видит подсказки исполнителя, запускает свою проверку; отметки по-прежнему «не проверено».
  await dp.goto(`/kabinet#order=${id}`);
  await expect(dp.locator('#ai-review-state')).toContainText('запускал исполнитель перед сдачей');
  await dp.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(dp.locator('#ai-review-state')).toContainText('запускал диспетчер');
  await expect(dp.locator('#review-summary')).toContainText('не проверено: 12'); // у оценки недвижимости 12 правил (2.43: сверка объекта и шаблона)
  await dp.locator('#review-checks li').filter({ hasText: 'Технические ошибки' }).getByRole('textbox').fill('Опечатка в адресе в разделе 3');
  await dp.locator('#review-checks li').filter({ hasText: 'Технические ошибки' }).getByRole('button', { name: 'Замечание' }).click();
  await expect(dp.locator('#review-checks li').filter({ hasText: 'Технические ошибки' }).locator('.verdict')).toHaveText('Замечание');
  await shot(dp, '55-dispetcher-ii-proverka');

  // Заказчик подсказок ИИ не видит — проверено автотестами сервера (tests/server/ai.test.mjs).
  await sctx.close();
  await dctx.close();
});

test('черновик заключения от ИИ: специалист готовит, правит, прикладывает Word; диспетчер только читает; заказчику не виден', async ({ page, browser, baseURL }) => {
  // Заказчик — на экране page; оплата — напрямую в базе, как в сценарии ИИ-проверки.
  await signIn(page, '+79990000594');
  const created = await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Квартира для черновика заключения' }, headers: H })).json();
  const id = created.order.id;
  expect((await page.request.patch(`/api/orders/${id}`, {
    data: { deadline: inDays(9), fields: { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 11', area: '48' } }, headers: H,
  })).status()).toBe(200);
  expect((await page.request.post(`/api/orders/${id}/documents`, {
    data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), headers: { ...H, 'content-type': 'image/jpeg', 'x-file-name': encodeURIComponent('фасад.jpg') },
  })).status()).toBe(201);
  expect((await page.request.post(`/api/orders/${id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  const dctx = await phoneContext(browser, baseURL);
  const dp = await dctx.newPage();
  const disp = await signIn(dp, '+79990000595');
  const sctx = await phoneContext(browser, baseURL);
  const sp = await sctx.newPage();
  const spec = await signIn(sp, '+79990000596');
  await db(async (c) => {
    await c.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]);
    await c.query('insert into specialists (user_id) values ($1)', [spec.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [spec.id]);
    await c.query('update orders set price_kop = 1500000, paid_at = now() where id = $1', [id]);
    await c.query("insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at) values ($1, 1500000, 'succeeded', $2, $3, now())", [id, `pay_ui_${id}`, disp.id]);
  });
  expect((await dp.request.post(`/api/orders/${id}/offer`, { data: { specialist_id: spec.id, from: 'matching' }, headers: H })).status()).toBe(200);
  expect((await sp.request.post(`/api/orders/${id}/status`, { data: { from: 'awaiting_executor', to: 'in_work' }, headers: H })).status()).toBe(200);

  // Специалист готовит черновик: данные заявки, фото с пометкой «описать», места «заполнить».
  await sp.goto(`/kabinet#order=${id}`);
  await expect(sp.locator('#draft-state')).toContainText('заказчик черновик не увидит');
  await sp.getByRole('button', { name: 'Подготовить черновик с помощью ИИ' }).click();
  await expect(sp.locator('#draft-msg')).toHaveText('Черновик готов — проверьте и поправьте');
  const text = sp.getByLabel('Текст заключения');
  await expect(text).toHaveValue(/Адрес объекта: г\. Москва, тестовая ул\., 11/);
  await expect(text).toHaveValue(/Фото 1 \(фасад\.jpg\): \[описать по фото: фасад\.jpg\]/);
  await expect(sp.locator('#draft-state')).toContainText('Черновик подготовил ИИ');
  await expect(sp.locator('#draft-state')).toContainText('Осталось заполнить мест');
  await shot(sp, '56-specialist-chernovik');

  // Незаполненные места — файл не прикладывается; эксперт заполняет, подтверждает и прикладывает.
  await sp.getByLabel('Я проверил текст и отвечаю за него').check();
  await sp.getByRole('button', { name: 'Приложить как файл результата' }).click();
  await expect(sp.locator('#draft-msg')).toContainText('остались незаполненные места');
  const value = await text.inputValue();
  await text.fill(`${value.replace(/\[(?:заполнить|описать)[^\]]*\]/g, 'заполнено экспертом')}\nИтоговая стоимость: 11 200 000 руб.`);
  await sp.getByRole('button', { name: 'Сохранить правку' }).click();
  await expect(sp.locator('#draft-msg')).toHaveText('Правка сохранена');
  await expect(sp.locator('#draft-state')).toContainText('Последняя правка');
  await sp.getByLabel('Я проверил текст и отвечаю за него').check();
  await sp.getByRole('button', { name: 'Приложить как файл результата' }).click();
  await expect(sp.locator('#draft-msg')).toHaveText('Файл «Отчёт об оценке.docx» добавлен в результат работы');
  await expect(sp.locator('#docs li').filter({ hasText: 'Отчёт об оценке.docx' })).toContainText('Результат работы');
  await shot(sp, '57-specialist-chernovik-prilozhen');
  // ИИ-проверка читает приложенный Word.
  await sp.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(sp.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  await expect(sp.locator('#ai-review-state')).not.toContainText('Не прочитаны');

  // Диспетчер видит черновик только для чтения.
  await dp.goto(`/kabinet#order=${id}`);
  await expect(dp.getByLabel('Текст заключения')).toHaveValue(/Итоговая стоимость: 11 200 000 руб\./);
  await expect(dp.getByLabel('Текст заключения')).not.toBeEditable();
  await expect(dp.getByRole('button', { name: 'Приложить как файл результата' })).toBeHidden();
  await expect(dp.getByRole('button', { name: /Подготовить/ })).toBeHidden();

  // Заказчик: ни черновика, ни файла результата до проверки.
  await page.goto(`/kabinet#order=${id}`);
  await expect(page.locator('#order-title')).toHaveText('Квартира для черновика заключения');
  await expect(page.locator('#draft-box')).toBeHidden();
  await expect(page.locator('#results-later')).toBeVisible();
  await expect(page.locator('#docs')).not.toContainText('Отчёт об оценке.docx');
  await shot(page, '58-zakazchik-bez-chernovika');
  await sctx.close();
  await dctx.close();
});

test('дистанционный осмотр: специалист выдаёт ссылку, владелец снимает по шагам без входа, фото с местом — в деле', async ({ page, browser, baseURL }) => {
  // Заказчик — на экране page; оплата и допуск — напрямую в базе, как в сценарии черновика.
  await signIn(page, '+79990000568');
  const created = await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Квартира для дистанционного осмотра' }, headers: H })).json();
  const id = created.order.id;
  expect((await page.request.patch(`/api/orders/${id}`, {
    data: { deadline: inDays(9), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 23', area: '37' } }, headers: H,
  })).status()).toBe(200);
  expect((await page.request.post(`/api/orders/${id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  const sctx = await phoneContext(browser, baseURL);
  const sp = await sctx.newPage();
  const spec = await signIn(sp, '+79990000569');
  await db(async (c) => {
    await c.query('insert into specialists (user_id) values ($1)', [spec.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [spec.id]);
    await c.query('update orders set price_kop = 1500000, paid_at = now(), status = $2, executor_user_id = $3 where id = $1', [id, 'in_work', spec.id]);
    await c.query("insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at) values ($1, 1500000, 'succeeded', $2, $3, now())", [id, `pay_ui_${id}`, spec.id]);
  });

  // Специалист выдаёт ссылку на 1 день; видит её один раз.
  await sp.goto(`/kabinet#order=${id}`);
  await expect(sp.locator('#inspect-state')).toContainText('Владелец объекта снимает его сам по ссылке');
  await sp.getByLabel('Ссылка владельцу объекта действует').selectOption('1');
  await sp.getByRole('button', { name: 'Выдать ссылку владельцу' }).click();
  await expect(sp.locator('#inspect-msg')).toHaveText('Ссылка готова — отправьте её владельцу объекта');
  const url = await sp.locator('#inspect-url').textContent();
  expect(url).toMatch(/\/osmotr#[A-Za-z0-9_-]{43}$/);
  await expect(sp.locator('#inspect-links li')).toHaveCount(1);
  await expect(sp.locator('#inspect-links li')).toContainText('действует');
  await shot(sp, '80-specialist-osmotr-ssylka');
  // Настоящий снимок (JPEG) для загрузки — рисуется в браузере.
  const jpeg = Buffer.from((await sp.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 480;
    const g = c.getContext('2d');
    g.fillStyle = '#9db4d0'; g.fillRect(0, 0, 640, 480);
    g.fillStyle = '#1f4e8c'; g.fillRect(200, 140, 240, 200);
    return c.toDataURL('image/jpeg', 0.8);
  })).split(',')[1], 'base64');

  // Владелец — без входа, на своём телефоне; место разрешено.
  const octx = await phoneContext(browser, baseURL, { permissions: ['geolocation'], geolocation: { latitude: 55.7512, longitude: 37.6184, accuracy: 12 } });
  const op = await octx.newPage();
  await op.goto(url);
  await expect(op.locator('#service')).toHaveText('Оценка недвижимости');
  await expect(op.locator('#expires')).toContainText('Ссылка действует до');
  expect(op.url()).not.toContain('#'); // секрет убран из строки адреса
  await expect(op.locator('body')).not.toContainText('тестовая ул.');
  await shot(op, '81-vladelec-osmotr-nachalo');
  await op.getByRole('button', { name: 'Начать: разрешить определение места' }).click();
  await expect(op.locator('#geo-state')).toContainText('Место определено');
  await expect(op.locator('#steps li')).toHaveCount(10);
  await op.locator('#steps li[data-step="facade"] input[type=file]').setInputFiles({ name: 'facade.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  await expect(op.locator('#steps li[data-step="facade"] .msg')).toHaveText('Фото отправлено');
  await expect(op.locator('#steps li[data-step="facade"] .badge')).toHaveText('Фото: 1');
  await op.locator('#steps li[data-step="kitchen"] input[type=file]').setInputFiles({ name: 'kitchen.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  await expect(op.locator('#steps li[data-step="kitchen"] .badge')).toHaveText('Фото: 1');
  await expect(op.locator('#steps li[data-step="facade"] label.btn')).toHaveText('Ещё фото');
  await shot(op, '82-vladelec-osmotr-shagi');
  op.once('dialog', (d) => d.accept());
  await op.getByRole('button', { name: 'Готово' }).click();
  await expect(op.locator('#closed-text')).toHaveText('Спасибо! Эксперт получил 2 фото. Страницу можно закрыть.');
  await shot(op, '83-vladelec-osmotr-gotovo');
  // Повторно по той же ссылке — уже закрыто.
  const again = await octx.newPage();
  await again.goto(url);
  await expect(again.locator('#closed-text')).toHaveText('Осмотр завершён — фото переданы эксперту');

  // У специалиста — фото по шагам с временем и местом; ссылка закрыта; уведомление.
  await sp.reload();
  await expect(sp.locator('#inspect-state')).toContainText('Фото осмотра: 2');
  await expect(sp.locator('#inspect-links li')).toContainText('владелец нажал «Готово»');
  const facade = sp.locator('#inspect-steps li[data-step="facade"]');
  await expect(facade).toContainText('Осмотр · Дом снаружи · 1.jpg');
  await expect(facade.locator('.photo-meta').first()).toContainText('место 55.75120, 37.61840 (±12 м)');
  await expect(sp.locator('#inspect-steps li[data-step="rooms"] .badge')).toHaveText('нет фото');
  await expect(sp.locator('#docs li').filter({ hasText: 'Осмотр · Кухня · 1.jpg' })).toContainText('Фото осмотра');
  // 2.71: у каждого фото — картинка сразу (уменьшенная копия со страницы владельца); нажал — фото целиком.
  const thumb = facade.locator('img.photo-thumb').first();
  await thumb.scrollIntoViewIfNeeded();
  await expect.poll(() => thumb.evaluate((i) => i.complete && i.naturalWidth)).toBe(320);
  await expect(sp.locator('#inspect-steps li[data-step="kitchen"] img.photo-thumb')).toHaveCount(1);
  const thumbSize = await (await sp.request.get(await thumb.getAttribute('src'))).body();
  expect(thumbSize.length).toBeLessThan(jpeg.length);
  await shot(sp, '84-specialist-osmotr-foto');
  const [full] = await Promise.all([sp.waitForRequest((r) => r.url().includes('/link')), thumb.click()]);
  expect(full.url()).toContain('/api/documents/');
  await sp.goto(`/kabinet#order=${id}`);
  await expect(sp.locator('#inspect-state')).toContainText('Фото осмотра: 2');
  const notes = await (await sp.request.get('/api/notifications')).json();
  expect(JSON.stringify(notes)).toContain('Владелец объекта прислал фото осмотра');

  // 2.20: специалист просит переснять фасад и отправляет владельцу новую ссылку СМС с платформы.
  await sp.getByLabel('Попросить переснять шаг').selectOption('facade');
  await sp.getByLabel('Что не так').fill('Размыто — снимите дом целиком, днём');
  await sp.getByRole('button', { name: 'Попросить переснять' }).click();
  await expect(sp.locator('#inspect-msg')).toContainText('Выдайте владельцу новую ссылку');
  await expect(facade.locator('.badge').first()).toHaveText('переснять');
  await expect(facade).toContainText('Попросили переснять: Размыто — снимите дом целиком, днём');
  await sp.getByLabel('Телефон владельца — пришлём ему ссылку СМС (необязательно)').fill('+7 999 000-11-22');
  await sp.getByRole('button', { name: 'Выдать ссылку владельцу' }).click();
  await expect(sp.locator('#inspect-msg')).toHaveText('Ссылка отправлена СМС на +7 *** ***-11-22');
  await expect(sp.locator('#inspect-links li').first()).toContainText('СМС на +7 *** ***-11-22');
  await shot(sp, '84a-specialist-osmotr-peresnyat');
  const url2 = await sp.locator('#inspect-url').textContent();
  const op2 = await octx.newPage();
  await op2.goto(url2);
  await expect(op2.locator('#expires')).toContainText('Эксперт просит переснять шаги, отмеченные ниже.');
  await op2.getByRole('button', { name: 'Начать: разрешить определение места' }).click();
  const f2 = op2.locator('#steps li[data-step="facade"]');
  await expect(f2).toContainText('Эксперт просит переснять: Размыто — снимите дом целиком, днём');
  await expect(f2.locator('.badge')).toHaveText('переснять');
  await expect(f2.locator('label.btn')).toHaveText('Переснять');
  await shot(op2, '84b-vladelec-peresnyat');
  await f2.locator('input[type=file]').setInputFiles({ name: 'facade2.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  await expect(f2.locator('.msg')).toHaveText('Фото отправлено');
  await expect(f2.locator('.badge')).toHaveText('Фото: 1');
  await expect(f2).not.toContainText('Эксперт просит переснять');
  await sp.reload();
  await expect(facade.locator('.badge').first()).toHaveText('фото: 2');
  await expect(facade).not.toContainText('Попросили переснять');
  await expect(facade).toContainText('Осмотр · Дом снаружи · 2.jpg');

  // Заказчик видит фото в документах, удалить их не может.
  await page.goto(`/kabinet#order=${id}`);
  const photo = page.locator('#docs li').filter({ hasText: 'Осмотр · Дом снаружи · 1.jpg' });
  await expect(photo).toContainText('Фото осмотра');
  await expect(photo.getByRole('button', { name: 'Удалить' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Выдать ссылку владельцу' })).toBeHidden();
  await shot(page, '85-zakazchik-foto-osmotra');
  await octx.close();
  await sctx.close();
});

test('экспресс: заказчик выбирает выезд помощника, эксперт назначает выезд, помощник снимает и пишет данные, всё в деле', async ({ page, browser, baseURL }) => {
  await signIn(page, '+79990000620');
  const created = await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Экспресс-оценка квартиры' }, headers: H })).json();
  const id = created.order.id;
  expect((await page.request.patch(`/api/orders/${id}`, {
    data: { deadline: inDays(7), fields: { purpose: 'bank', region: 'moscow', object_type: 'flat', address: 'г. Москва, Экспрессная ул., 9', area: '44', comment: 'Ключи у соседки' } }, headers: H,
  })).status()).toBe(200);
  // Заказчик отмечает экспресс в форме заявки.
  await page.goto(`/kabinet#order=${id}`);
  await expect(page.locator('#express-box')).toBeVisible();
  await page.getByLabel('Экспресс: на объект приедет помощник').check();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.locator('#details-msg')).not.toHaveText('');
  await expect(page.locator('#order-meta')).toContainText('Экспресс: выезд помощника');
  await shot(page, '86-zakazchik-express');
  expect((await page.request.post(`/api/orders/${id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);

  const sctx = await phoneContext(browser, baseURL);
  const sp = await sctx.newPage();
  const spec = await signIn(sp, '+79990000621');
  const hctx = await phoneContext(browser, baseURL, { permissions: ['geolocation'], geolocation: { latitude: 55.7601, longitude: 37.6202, accuracy: 8 } });
  const hp = await hctx.newPage();
  const helper = await signIn(hp, '+79990000622');
  expect((await hp.request.patch('/api/me', { data: { full_name: 'Тестов Выездной' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('insert into specialists (user_id) values ($1)', [spec.id]);
    await c.query("insert into specialists (user_id, onsite, regions) values ($1, true, '{moscow}')", [helper.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [spec.id]);
    await c.query('update orders set price_kop = 1500000, paid_at = now(), status = $2, executor_user_id = $3 where id = $1', [id, 'in_work', spec.id]);
    await c.query("insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at) values ($1, 1500000, 'succeeded', $2, $3, now())", [id, `pay_ui_${id}`, spec.id]);
  });

  // Эксперт назначает выезд помощнику.
  await sp.goto(`/kabinet#order=${id}`);
  await expect(sp.locator('#onsite-state')).toContainText('Согласуйте время с заказчиком');
  await expect(sp.locator('#onsite-helper')).toContainText('Тестов Выездной');
  await sp.getByRole('button', { name: 'Назначить выезд' }).click();
  await expect(sp.locator('#onsite-msg')).toHaveText('Выезд назначен — помощник получил уведомление');
  await expect(sp.locator('#onsite-visits li')).toContainText('назначен');
  await expect(sp.locator('#onsite-visits li')).toContainText('помощник: Тестов Выездной');
  await shot(sp, '87-specialist-express-vyezd');

  // Помощник: уведомление и выезд в разделе «Специалист»; заявку и заказчика не видит.
  await hp.goto('/kabinet#notifications');
  await expect(hp.locator('#notifications')).toContainText('Вам назначен выезд на объект');
  await hp.goto('/kabinet#specialist');
  await expect(hp.locator('#visits li')).toContainText('г. Москва, Экспрессная ул., 9');
  await shot(hp, '88-pomoshnik-vyezdy');
  await hp.getByRole('link', { name: 'Открыть выезд' }).click();
  await expect(hp.locator('#page-title')).toHaveText('Выезд на объект');
  await expect(hp.locator('#object')).toContainText('г. Москва, Экспрессная ул., 9');
  await expect(hp.locator('body')).not.toContainText('Ключи у соседки');
  await hp.getByRole('button', { name: 'Начать: разрешить определение места' }).click();
  await expect(hp.locator('#geo-state')).toContainText('Место определено');
  const jpeg = Buffer.from((await hp.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 480;
    const g = c.getContext('2d');
    g.fillStyle = '#c9d6c0'; g.fillRect(0, 0, 640, 480);
    g.fillStyle = '#4a6b2f'; g.fillRect(180, 120, 260, 220);
    return c.toDataURL('image/jpeg', 0.8);
  })).split(',')[1], 'base64');
  await hp.locator('#steps li[data-step="facade"] input[type=file]').setInputFiles({ name: 'facade.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  await expect(hp.locator('#steps li[data-step="facade"] .badge')).toHaveText('Фото: 1');
  await hp.getByLabel('Общее состояние *').selectOption('needs_repair');
  await hp.getByLabel('Площадь по замеру, кв. м').fill('43,8');
  await hp.getByLabel('Замечания помощника').fill('Следы протечки на потолке кухни');
  await hp.getByRole('button', { name: 'Сохранить данные' }).click();
  await expect(hp.locator('#data-msg')).toHaveText('Данные сохранены');
  await shot(hp, '89-pomoshnik-vyezd-shagi');
  hp.once('dialog', (d) => d.accept());
  await hp.getByRole('button', { name: 'Готово' }).click();
  await expect(hp.locator('#finish-msg')).toContainText('Объект соответствует заявке');
  await hp.getByLabel('Объект соответствует заявке *').selectOption('yes');
  hp.once('dialog', (d) => d.accept());
  await hp.getByRole('button', { name: 'Готово' }).click();
  await expect(hp.locator('#closed-text')).toHaveText('Спасибо! Эксперт получил 1 фото и данные с объекта. Страницу можно закрыть.');
  await shot(hp, '90-pomoshnik-vyezd-gotovo');
  expect((await hp.request.get(`/api/orders/${id}`)).status()).toBe(404);

  // Эксперт: выезд завершён, данные с объекта, фото по шагам с местом.
  await sp.reload();
  await expect(sp.locator('#onsite-visits li')).toContainText('завершён');
  await expect(sp.locator('#onsite-visits li dl')).toContainText('Нужен ремонт');
  await expect(sp.locator('#onsite-visits li dl')).toContainText('43.8');
  await expect(sp.locator('#inspect-steps li[data-step="facade"] .photo-meta').first()).toContainText('место 55.76010, 37.62020 (±8 м)');
  await shot(sp, '91-specialist-express-dannye');

  // Заказчик видит ход выезда и данные — без имени помощника.
  await page.reload();
  await expect(page.locator('#onsite-visits li')).toContainText('завершён');
  await expect(page.locator('#onsite-visits li')).not.toContainText('Тестов Выездной');
  await expect(page.getByRole('button', { name: 'Назначить выезд' })).toBeHidden();
  await shot(page, '92-zakazchik-express-dannye');
  await hctx.close();
  await sctx.close();
});

test('заявка по письму: почта подключается кодом из письма; письмо с вложением — заявка-черновик; ответ «Отправить» — заявка в подборе', async ({ page }) => {
  const me = await signIn(page, '+79990000591');
  const email = 'pismo-test@example.ru';
  const control = { 'x-test-control': CONTROL, 'x-delo-request': '1' };
  await db(async (c) => {
    const { rows: [org] } = await c.query("insert into organizations (name) values ('Тестовая юрфирма писем') returning id");
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head')", [org.id, me.id]);
  });
  const mailTo = async (to) => {
    const r = await page.request.get('/__test/fakes/mail/calls', { headers: { 'x-test-control': CONTROL } });
    return (await r.json()).calls.filter((c) => c.method === 'send' && c.args.to === to).at(-1).args;
  };

  await page.goto('/kabinet#profile');
  await expect(page.getByRole('heading', { name: 'Почта для заявок' })).toBeVisible();
  await expect(page.locator('#mail-inbox')).toHaveText(/@/);
  await expect(page.locator('#mail-status')).toHaveText('Почта не подключена.');
  await page.getByLabel('Ваш адрес почты').fill(email);
  await page.getByRole('button', { name: 'Получить код на почту' }).click();
  await expect(page.locator('#mail-msg')).toHaveText('Код отправлен — проверьте почту');
  const code = (await mailTo(email)).text.match(/\d{6}/)[0];
  await page.getByLabel('Код из письма').fill(code);
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(page.locator('#mail-status')).toHaveText(`Подключена: ${email}. Письма с неё принимаются как заявки.`);
  await expect(page.getByLabel('Заявки по письмам — от имени')).toHaveValue('');
  await shot(page, '57-pochta-dlya-zayavok');

  // Письмо с вложением на особый адрес — заявка-черновик и ответ номером.
  const r = await page.request.post('/__test/mail/inbound', {
    headers: control,
    data: {
      from: `Тестовый Юрист <${email}>`, subject: 'Оценка квартиры для суда',
      text: 'Прошу оценить квартиру в Москве для суда.\nАдрес: г. Москва, тестовая ул., 15\nСрок до 30.12.2026',
      attachments: [{ filename: 'выписка ЕГРН.txt', content_type: 'text/plain', base64: Buffer.from('тестовая выписка').toString('base64') }],
    },
  });
  expect(r.status()).toBe(200);
  const { inbound } = await r.json();
  expect(inbound.outcome).toBe('created');
  await page.goto('/kabinet');
  await page.locator(`button.open[data-id="${inbound.order_id}"]`).click();
  await expect(page.locator('#order-status')).toHaveText('Новая');
  await expect(page.locator('#order-title')).toHaveText('Оценка квартиры для суда');
  await expect(page.locator('#order-mail-line')).toHaveText(`Пришла по письму. Ход заявки и результат — письмами на ${email}`);
  await expect(page.getByLabel('Адрес объекта')).toHaveValue('г. Москва, тестовая ул., 15');
  await expect(page.getByLabel('Для чего нужна оценка')).toHaveValue('court');
  await expect(page.getByText('выписка ЕГРН.txt')).toBeVisible();
  await shot(page, '58-zayavka-po-pismu');

  // Ответ «Отправить» на письмо с номером — заявка уходит в подбор.
  const answer = await mailTo(email);
  expect(answer.subject).toBe('Re: Оценка квартиры для суда'); // тема заказчика — переписка не распадается (2.44)
  expect(answer.text).toMatch(/^Заявка № /);
  const s = await page.request.post('/__test/mail/inbound', {
    headers: control, data: { from: email, text: 'Отправить\n\n> Заявка создана по Вашему письму', in_reply_to: [answer.messageId] },
  });
  expect((await s.json()).inbound.outcome).toBe('submitted');
  await page.reload();
  await expect(page.locator('#order-status')).toHaveText('Подбор исполнителя');
  await shot(page, '59-zayavka-po-pismu-otpravlena');
});

// Сообщение моста CRM → Платформа, подписанное так, как это будет делать БЕРТЕЛ CRM.
let bridgeSeq = 0;
async function crmBridge(request, kind, data) {
  const id = `ui-${Date.now()}-${++bridgeSeq}`;
  const time = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify(data);
  const r = await request.post(`/api/bridge/crm/${kind}`, {
    data: body,
    headers: { 'content-type': 'application/json', 'x-bridge-id': id, 'x-bridge-time': time, 'x-bridge-signature': signBridge(BRIDGE, id, time, Buffer.from(body)) },
  });
  expect(r.status()).toBe(200);
  return r.json();
}

test('мост CRM: профиль переводчика переносится с согласием; специалист видит предложения госзаказа и число дел в CRM; диспетчер — в списке', async ({ page, browser, baseURL }) => {
  const phone = '+79990000611';
  const deadline = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const consent = { platform: true, version: 'crm-test-1', given_at: '2026-09-20T10:00:00Z' };
  const prof = await crmBridge(page.request, 'profiles', { profiles: [{
    crm_id: 'ui-crm-611', phone, email: 'perevodchik-ui@example.test', full_name: 'Тестовый Переводчик Из CRM',
    languages: ['китайский', 'английский'], qualification: 'Переводчик, диплом', consent,
  }] });
  expect(prof.results[0].outcome).toBe('created');
  await crmBridge(page.request, 'load', { loads: [{ crm_id: 'ui-crm-611', open_cases: 2 }] });
  await crmBridge(page.request, 'offers', { offers: [
    { offer_id: 'ui-offer-1', crm_id: 'ui-crm-611', customer: 'ГСУ СК России по г. Москве', language: 'китайский → русский',
      deadline, volume: { amount: 12, unit: 'pages' }, payment: 'pp1240', status: 'open' },
    { offer_id: 'ui-offer-2', crm_id: 'ui-crm-611', customer: 'Мещанский районный суд', language: 'английский → русский',
      deadline, volume: { amount: 3, unit: 'hours' }, payment: 'pp1240', status: 'open' },
  ] });

  // Переводчик входит по своему телефону — кабинет специалиста уже есть, госзаказ из CRM виден.
  await signIn(page, phone);
  await page.goto('/kabinet#notifications');
  const n = page.locator('#notifications li').filter({ hasText: 'Новое предложение госзаказа' }).first();
  await expect(n).toBeVisible();
  await n.locator('button.open').click();
  await expect(page.getByRole('heading', { name: 'Госзаказ — БЕРТЕЛ CRM' })).toBeVisible();
  await expect(page.locator('#crm-facts')).toContainText('Дел в CRM сейчас: 2');
  await expect(page.locator('#crm-facts')).toContainText('Языки: китайский, английский');
  const first = page.locator('#crm-offers li[data-id="ui-offer-1"]');
  await expect(first).toContainText('ГСУ СК России по г. Москве');
  await expect(first).toContainText('китайский → русский · 12 стр.');
  await expect(first).toContainText('Оплата по Положению (ПП РФ № 1240)');
  await expect(first.getByRole('link', { name: 'Открыть в CRM' })).toHaveAttribute('href', /\/offers\/ui-offer-1$/);
  await expect(page.locator('#crm-offers li')).toHaveCount(2);
  await expect(page.locator('#specialist-permits-empty')).toBeVisible();
  await shot(page, '60-specialist-goszakaz-crm');

  // Предложение закрыто в CRM — пропадает из кабинета.
  await crmBridge(page.request, 'offers', { offers: [{ offer_id: 'ui-offer-2', crm_id: 'ui-crm-611', status: 'closed' }] });
  await page.reload();
  await expect(page.locator('#crm-offers li')).toHaveCount(1);

  // Диспетчер видит переводчика в списке специалистов с делами в CRM.
  const ctx = await phoneContext(browser, baseURL);
  const dp = await ctx.newPage();
  const d = await signIn(dp, '+79990000612');
  await db((c) => c.query("update users set platform_role = 'dispatcher' where id = $1", [d.id]));
  await dp.goto('/kabinet#specialists');
  await expect(dp.locator('#specialists li').filter({ hasText: 'Тестовый Переводчик Из CRM' })).toContainText('Из БЕРТЕЛ CRM · дел там: 2 · языки: китайский, английский');
  await shot(dp, '61-spisok-specialistov-crm');
  await ctx.close();
});

// Задача 1.11: сквозной путь тестовой заявки на экспертизу — всё через экран телефона, без обходных путей в базе.
// Первый администратор назначается командой (как в контуре); дальше роли, допуск, заявка, цена, оплата, подбор,
// работа, ИИ-проверка, проверка по правилам, выдача результата, акт, закрытие, выплата — только кнопками.
test('две подписи (2.5а): эксперт от организации загружает готовую подпись, руководитель подписывает от организации, заказчик видит обе', async ({ page, browser, baseURL }) => {
  await signIn(page, '+79990000630');
  const created = await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Квартира: две подписи' }, headers: H })).json();
  const id = created.order.id;
  expect((await page.request.patch(`/api/orders/${id}`, {
    data: { deadline: inDays(9), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 30', area: '40' } }, headers: H,
  })).status()).toBe(200);
  expect((await page.request.post(`/api/orders/${id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  const sctx = await phoneContext(browser, baseURL);
  const sp = await sctx.newPage();
  const spec = await signIn(sp, '+79990000631');
  const hctx = await phoneContext(browser, baseURL);
  const hp = await hctx.newPage();
  const head = await signIn(hp, '+79990000632');
  const orgId = await db(async (c) => {
    const { rows: [org] } = await c.query("insert into organizations (name) values ('ООО «Тестовая оценочная компания»') returning id");
    await c.query("update users set full_name = 'Тестовый эксперт компании' where id = $1", [spec.id]);
    await c.query("update users set full_name = 'Тестовый руководитель' where id = $1", [head.id]);
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head'), ($1, $3, 'member')", [org.id, head.id, spec.id]);
    await c.query('insert into specialists (user_id) values ($1)', [spec.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [spec.id]);
    return org.id;
  });

  // Эксперт выбирает в профиле, что работает от организации.
  await sp.goto('/kabinet#specialist');
  await sp.getByLabel('Работаю от организации').selectOption({ label: 'ООО «Тестовая оценочная компания»' });
  await expect(sp.locator('#specialist-msg')).toHaveText('Теперь заключение подписывает ещё руководитель организации');
  await shot(sp, '95-specialist-organizaciya');
  await db((c) => c.query('update orders set price_kop = 1500000, paid_at = now(), status = $2, executor_user_id = $3 where id = $1', [id, 'in_work', spec.id]));

  // Эксперт прикладывает отчёт и загружает готовую подпись «из программы УЦ».
  const report = Buffer.from('отчёт об оценке для двух подписей');
  const digest = crypto.createHash('sha256').update(report).digest('hex');
  await sp.goto(`/kabinet#order=${id}`);
  await expect(sp.locator('#order-status')).toHaveText('В работе');
  await sp.locator('#result-file').setInputFiles({ name: 'отчёт-компании.pdf', mimeType: 'application/pdf', buffer: report });
  const doc = sp.locator('#docs li').filter({ hasText: 'отчёт-компании.pdf' });
  await expect(doc.locator('[data-sig="org-wait"]')).toHaveText('После Вашей подписи файл подписывает руководитель организации ООО «Тестовая оценочная компания»');
  await expect(doc.getByText('Загрузить готовую подпись')).toBeVisible();
  sp.once('dialog', (d) => d.accept());
  await doc.locator('input[type=file]').setInputFiles({ name: 'отчёт-компании.pdf.sig', mimeType: 'application/octet-stream',
    buffer: testExternalSignature({ digest, subject: 'Тестовый эксперт компании' }) });
  await expect(sp.locator('#doc-msg')).toHaveText('Подпись проверена и добавлена');
  await expect(doc.locator('.sig-state').first()).toContainText('Подпись эксперта: Тестовый эксперт компании');
  await expect(doc).toContainText('загружена готовым файлом');
  await expect(doc.locator('[data-sig="org-wait"]')).toContainText('Ждёт подписи организации');
  await sp.getByRole('button', { name: 'Сдать на проверку' }).click();
  await expect(sp.locator('#status-msg')).toContainText('Нужна подпись организации ООО «Тестовая оценочная компания» (руководитель): отчёт-компании.pdf');
  await shot(sp, '96-specialist-gotovaya-podpis');

  // Руководитель: уведомление, раздел организации — подписать от организации.
  await hp.goto('/kabinet#notifications');
  await expect(hp.locator('#notifications li').first()).toContainText('нужна подпись организации');
  await hp.goto(`/kabinet#org=${orgId}`);
  await expect(hp.locator('#org-title')).toHaveText('ООО «Тестовая оценочная компания»');
  // 2.36: в «Делах экспертов» у дела — «Ждёт Вашей подписи» и переход к подписи.
  const caseRow = hp.locator('#org-cases li[data-case]').first();
  await expect(caseRow.locator('[data-role="sign-wait"]')).toContainText('Ждёт Вашей подписи: 1');
  await caseRow.getByRole('button', { name: 'К подписи' }).click();
  await expect(hp.locator('#org-sign > li.flash')).toHaveCount(1);
  const item = hp.locator('#org-sign li.doc').filter({ hasText: 'отчёт-компании.pdf' });
  await expect(hp.locator('#org-sign > li').first()).toContainText('Оценка недвижимости');
  await expect(hp.locator('#org-sign > li').first()).toContainText('Эксперт: Тестовый эксперт компании');
  await expect(hp.locator('#org-sign')).not.toContainText('две подписи');
  await expect(item.locator('.sig-state').first()).toContainText('Подпись эксперта: Тестовый эксперт компании');
  const [file] = await Promise.all([hp.waitForEvent('download'), item.getByRole('button', { name: 'Скачать' }).click()]);
  expect(file.suggestedFilename()).toBe('отчёт-компании.pdf');

  // Возврат эксперту (2.27): руководитель пишет замечание — подпись эксперта снимается; эксперт видит замечание и подписывает заново.
  await item.getByRole('button', { name: 'Вернуть эксперту' }).click();
  await item.getByRole('button', { name: 'Вернуть с замечанием' }).click();
  await expect(hp.locator('#org-sign-msg')).toHaveText('Напишите замечание — что эксперту исправить');
  await item.getByLabel('Замечание эксперту по файлу отчёт-компании.pdf').fill('Раздел 5: корректировка на торг не обоснована.\nПроверьте итог.');
  await shot(hp, '97c-rukovoditel-vozvrat');
  await item.getByRole('button', { name: 'Вернуть с замечанием' }).click();
  await expect(hp.locator('#org-sign-msg')).toHaveText('Файл возвращён эксперту с замечанием — его подпись снята');
  await expect(hp.locator('#org-cases li[data-case]').first().locator('[data-role="returned"]')).toHaveText('Вы вернули отчёт эксперту — ждём исправления');
  await expect(hp.locator('#org-cases [data-role="sign-wait"]')).toHaveCount(0);
  await expect(hp.locator('#org-sign details.returns summary')).toHaveText('Возвраты эксперту · 1 · ждём исправления');
  await expect(item.getByRole('button', { name: 'Подписать от организации' })).toHaveCount(0);
  await sp.goto('/kabinet#notifications');
  await expect(sp.locator('#notifications li').first()).toContainText('Руководитель вернул отчёт с замечанием');
  await sp.goto(`/kabinet#order=${id}`);
  await expect(sp.locator('#org-returns-box')).toBeVisible();
  await expect(sp.locator('#org-returns li').first()).toContainText('отчёт-компании.pdf · исправить');
  await expect(sp.locator('#org-returns li').first()).toContainText('Тестовый руководитель · ООО «Тестовая оценочная компания»');
  await expect(sp.locator('#org-returns .comment').first()).toHaveText('Раздел 5: корректировка на торг не обоснована.\nПроверьте итог.');
  await expect(sp.locator('#next-steps [data-step="fix"]')).toContainText('Исправить по замечанию руководителя');
  await expect(sp.locator('#next-main button')).toHaveText('Исправить по замечанию руководителя');
  await shot(sp, '96a-specialist-zamechanie');
  await expect(doc.locator('.sig-state').first()).not.toContainText('Подпись эксперта');
  sp.once('dialog', (d) => d.accept());
  // Заново — подписью из «Госключа» (2.69): в деле видно, откуда подпись.
  await doc.locator('input[type=file]').setInputFiles({ name: 'отчёт-компании.pdf.sig', mimeType: 'application/octet-stream',
    buffer: testGoskeySignature({ digest, subject: 'Тестовый эксперт компании' }) });
  await expect(sp.locator('#doc-msg')).toHaveText('Подпись проверена и добавлена');
  await expect(doc.locator('[data-sig="method"]').first()).toContainText('загружена готовым файлом из приложения «Госключ»');
  await expect(sp.locator('#org-returns li').first()).toContainText('отчёт-компании.pdf · исправлено');
  await expect(sp.locator('#org-returns-lead')).toHaveText('Все замечания учтены. История возвратов:');
  await expect(sp.locator('#next-steps [data-step="fix"]')).toHaveCount(0);
  // Заказчик возвратов не видит.
  await page.goto(`/kabinet#order=${id}`);
  await expect(page.locator('#order-status')).toHaveText('В работе');
  await expect(page.locator('#org-returns-box')).toBeHidden();
  await page.goto('/kabinet');
  await hp.reload();
  await expect(hp.locator('#org-sign details.returns summary')).toHaveText('Возвраты эксперту · 1');

  hp.once('dialog', (d) => d.accept());
  await item.getByRole('button', { name: 'Подписать от организации' }).click();
  await expect(hp.locator('#org-sign-msg')).toHaveText('Файл подписан от организации');
  await expect(item.locator('.sig-state').nth(1)).toContainText('Подпись организации: ООО «Тестовая оценочная компания» — руководитель Тестовый руководитель');
  await shot(hp, '97-rukovoditel-podpis');

  // Дела экспертов (2.16): руководитель видит дело эксперта без заказчика и названия заявки, нагрузку и деньги.
  const cases = hp.locator('#org-cases-box');
  await expect(cases).toBeVisible();
  const row = hp.locator('#org-cases > li').first();
  await expect(row).toContainText('Оценка недвижимости');
  await expect(row).toContainText('В работе · эксперт: Тестовый эксперт компании');
  await expect(row).toContainText('вознаграждение 12 000 ₽');
  await expect(cases).not.toContainText('две подписи');
  await expect(cases).not.toContainText('тестовая ул.');
  await expect(hp.locator('#org-cases-load li').first()).toContainText('в работе: 1');
  await expect(hp.locator('#org-cases-money')).toContainText('Ждёт выдачи результата12 000 ₽');
  await expect(hp.locator('#members li').filter({ hasText: 'Тестовый эксперт компании' })).toContainText('дел: 1');
  await cases.scrollIntoViewIfNeeded();
  await expect(hp.locator('#org-cases [data-role="sign-wait"]')).toHaveCount(0);   // подписано — в делах больше не ждёт
  await shot(hp, '97a-rukovoditel-dela-ekspertov');

  // Внутренняя переписка (2.28): руководитель пишет эксперту из «Дел экспертов»; эксперт отвечает в деле; заказчик не видит.
  await row.locator('details.org-chat summary').click();
  const hchat = row.locator('details.org-chat');
  await expect(hchat).toContainText('Сообщений пока нет.');
  await hchat.getByLabel('Сообщение во внутренней переписке').fill('Посмотрите, пожалуйста, аналоги в разделе 6 до сдачи.');
  await hchat.getByRole('button', { name: 'Отправить' }).click();
  await expect(hchat.locator('.msg')).toHaveText('Сообщение отправлено');
  await expect(hchat.locator('.chat li').first()).toContainText('Вы ·');
  await sp.goto('/kabinet#notifications');
  await expect(sp.locator('#notifications li').first()).toContainText('Руководитель организации написал Вам по делу');
  await sp.goto(`/kabinet#order=${id}`);
  const echat = sp.locator('#org-chat-box');
  await expect(echat).toBeVisible();
  await expect(sp.locator('#org-chat-lead')).toContainText('Заказчик и диспетчер эту переписку не видят');
  await expect(echat.locator('.chat li').first()).toContainText('Руководитель · Тестовый руководитель');
  await expect(echat.locator('.chat li .body').first()).toHaveText('Посмотрите, пожалуйста, аналоги в разделе 6 до сдачи.');
  await echat.getByLabel('Сообщение во внутренней переписке').fill('Поправил аналоги, сдаю.');
  await echat.getByRole('button', { name: 'Отправить' }).click();
  await expect(echat.locator('.chat li')).toHaveCount(2);
  await echat.scrollIntoViewIfNeeded();
  await shot(sp, '96b-specialist-perepiska-rukovoditel');
  await hp.goto('/kabinet#notifications');
  await expect(hp.locator('#notifications li').first()).toContainText('Эксперт написал Вам по делу');
  await hp.goto(`/kabinet#org=${orgId}`);
  const hrow = hp.locator('#org-cases > li').first();
  await hrow.locator('details.org-chat summary').click();
  await expect(hrow.locator('details.org-chat .chat li').nth(1)).toContainText('Эксперт · Тестовый эксперт компании');
  await expect(hrow.locator('details.org-chat .chat li .body').nth(1)).toHaveText('Поправил аналоги, сдаю.');
  await hrow.scrollIntoViewIfNeeded();
  await shot(hp, '97d-rukovoditel-perepiska');
  await page.goto(`/kabinet#order=${id}`);
  await expect(page.locator('#order-status')).toHaveText('В работе');
  await expect(page.locator('#org-chat-box')).toBeHidden();
  await expect(page.locator('#order-view')).not.toContainText('Поправил аналоги');
  await page.goto('/kabinet');

  // Эксперт сдаёт; после проверки заказчик видит обе подписи, проверяет и скачивает подпись организации.
  await sp.reload();
  await expect(doc.locator('.sig-state')).toHaveCount(2);
  await sp.getByRole('button', { name: 'Сдать на проверку' }).click();
  await expect(sp.locator('#order-status')).toHaveText('Проверка результата');
  await db(async (c) => {
    await c.query("update orders set status = 'done' where id = $1", [id]);
  });
  await page.goto(`/kabinet#order=${id}`);
  await expect(page.locator('#order-status')).toHaveText('Готово');
  const got = page.locator('#docs li').filter({ hasText: 'отчёт-компании.pdf' });
  await expect(got.locator('.sig-state')).toHaveCount(2);
  await got.getByRole('button', { name: 'Проверить подпись' }).click();
  await expect(page.locator('#doc-msg')).toHaveText('«отчёт-компании.pdf»: подписи верны — Тестовый эксперт компании и ООО «Тестовая оценочная компания»');
  await expect(got.locator('[data-sig="method"]').first()).toContainText('из приложения «Госключ»');
  await expect(got.locator('[data-sig="method"]').nth(1)).toContainText('подпись в кабинете');
  // Архив дела — с протоколом проверки подписей (2.69).
  const [zipDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Выгрузить дело архивом' }).click()]);
  const zipBuf = fs.readFileSync(await zipDl.path());
  expect(zipBuf.includes(Buffer.from('Протокол проверки подписей № '))).toBe(true);
  expect(zipBuf.includes(Buffer.from('Документы/отчёт-компании.pdf.org.sig'))).toBe(true);
  const [orgSig] = await Promise.all([page.waitForEvent('download'), got.getByRole('button', { name: 'Подпись организации' }).click()]);
  expect(orgSig.suggestedFilename()).toBe('отчёт-компании.pdf.org.sig');
  await shot(page, '98-zakazchik-dve-podpisi');

  // Просроченное дело эксперта руководитель видит крупно (2.16); завершённое — ниже, в «Завершённых».
  await db((c) => c.query(`insert into orders (module, service, title, owner_user_id, executor_user_id, status, deadline, price_kop, paid_at)
    values ('expertise', 'vehicle', 'Просроченное дело', $1, $2, 'in_work', '2026-01-15', 900000, now())`, [created.order.owner_user_id, spec.id]));
  await hp.reload();
  const late = hp.locator('#org-cases > li').first();
  await expect(late.locator('.title')).toContainText('Оценка транспортного средства');
  await expect(late.locator('.overdue.big')).toHaveText('срок 15 января 2026 г. · ПРОСРОЧЕНО');
  await expect(hp.locator('#org-cases-load li').first()).toContainText('в работе: 1 · просрочено: 1');
  await expect(hp.locator('#org-cases li.group')).toHaveText('Завершённые · 1');
  await expect(hp.locator('#org-cases-box')).not.toContainText('Просроченное дело');
  await hp.locator('#org-cases-box').scrollIntoViewIfNeeded();
  await shot(hp, '97b-rukovoditel-prosrocheno');
  await sctx.close();
  await hctx.close();
});

test('распределение в организации (2.17): диспетчер предлагает дело организации, руководитель назначает эксперта, отказ эксперта — снова руководителю', async ({ page, browser, baseURL }) => {
  await signIn(page, '+79990000640');
  const created = await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Квартира: распределение' }, headers: H })).json();
  const id = created.order.id;
  expect((await page.request.patch(`/api/orders/${id}`, {
    data: { deadline: inDays(8), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, Распределительная ул., 4', area: '52' } }, headers: H,
  })).status()).toBe(200);
  expect((await page.request.post(`/api/orders/${id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  const dctx = await phoneContext(browser, baseURL);
  const dp = await dctx.newPage();
  const disp = await signIn(dp, '+79990000641');
  const hctx = await phoneContext(browser, baseURL);
  const hp = await hctx.newPage();
  const head = await signIn(hp, '+79990000642');
  const sctx = await phoneContext(browser, baseURL);
  const sp = await sctx.newPage();
  const spec = await signIn(sp, '+79990000643');
  const orgId = await db(async (c) => {
    await c.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]);
    await c.query('update orders set price_kop = 2000000, paid_at = now() where id = $1', [id]);
    const { rows: [org] } = await c.query("insert into organizations (name) values ('ООО «Тестовое бюро распределения»') returning id");
    await c.query("update users set full_name = 'Тестовый эксперт бюро' where id = $1", [spec.id]);
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head'), ($1, $3, 'member')", [org.id, head.id, spec.id]);
    await c.query('insert into specialists (user_id, org_id) values ($1, $2)', [spec.id, org.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [spec.id]);
    return org.id;
  });

  // Диспетчер в подборе видит организацию с экспертом и предлагает дело ей.
  await dp.goto(`/kabinet#order=${id}`);
  await expect(dp.locator('#order-status')).toHaveText('Подбор исполнителя');
  const og = dp.locator('#org-candidates li').filter({ hasText: 'ООО «Тестовое бюро распределения»' });
  await expect(og).toContainText('Экспертов с допуском: 1');
  dp.once('dialog', (d) => d.accept());
  await og.getByRole('button', { name: 'Предложить организации' }).click();
  await expect(dp.locator('#order-status')).toHaveText('Ждёт исполнителя');
  await expect(dp.locator('#match-current')).toHaveText('Сейчас дело у организации ООО «Тестовое бюро распределения»: её руководитель назначает эксперта. Можно передать другому.');
  await expect(og.locator('.badge')).toHaveText('Предложено сейчас');
  await og.scrollIntoViewIfNeeded();
  await shot(dp, '99a-dispetcher-organizacii');

  // Руководитель: уведомление и «Ждут назначения» — без заказчика и названия заявки; назначает эксперта.
  await hp.goto('/kabinet#notifications');
  await expect(hp.locator('#notifications li').first()).toContainText('Организации предложено дело');
  await hp.goto(`/kabinet#org=${orgId}`);
  const pend = hp.locator('#org-pending > li').first();
  await expect(pend).toContainText('Оценка недвижимости');
  await expect(pend).toContainText('вознаграждение 16 000 ₽');
  await expect(hp.locator('#org-pending-box')).not.toContainText('распределение');
  await expect(hp.locator('#org-pending-box')).not.toContainText('Распределительная');
  await expect(pend.locator('select option')).toHaveText(['Тестовый эксперт бюро · в работе 0']);
  await hp.locator('#org-pending-box').scrollIntoViewIfNeeded();
  await shot(hp, '99b-rukovoditel-zhdut-naznacheniya');
  await pend.getByRole('button', { name: 'Назначить' }).click();
  await expect(hp.locator('#org-pending-msg')).toHaveText('Дело предложено эксперту — он примет его или откажется');
  await expect(hp.locator('#org-pending-box')).toBeHidden();
  await expect(hp.locator('#org-cases > li').first()).toContainText('Ждёт исполнителя · эксперт: Тестовый эксперт бюро');

  // Эксперт отказывается — дело снова у руководителя, с причиной.
  await sp.goto('/kabinet');
  const offer = sp.locator('#orders li').filter({ hasText: 'Квартира: распределение' });
  await expect(offer.getByRole('button', { name: 'Принять дело' })).toBeVisible();
  sp.once('dialog', (d) => d.accept('Занят до конца месяца'));
  await offer.getByRole('button', { name: 'Отказаться' }).click();
  await expect(sp.locator('#orders-msg')).toHaveText('Вы отказались от дела');
  await hp.reload();
  const back = hp.locator('#org-pending > li').first();
  await expect(back).toContainText('Эксперт отказался: Занят до конца месяца');
  await hp.locator('#org-pending-box').scrollIntoViewIfNeeded();
  await shot(hp, '99c-rukovoditel-otkaz-eksperta');

  // Руководитель отказывается от дела — оно возвращается диспетчеру в подбор.
  hp.once('dialog', (d) => d.accept('Все эксперты заняты'));
  await back.getByRole('button', { name: 'Отказаться от дела' }).click();
  await expect(hp.locator('#org-pending-msg')).toHaveText('Вы отказались от дела — оно вернулось диспетчеру');
  await expect(hp.locator('#org-pending-box')).toBeHidden();
  await dp.goto('/kabinet#notifications');
  await expect(dp.locator('#notifications li').first()).toContainText('Организация отказалась от дела');
  await dp.goto(`/kabinet#order=${id}`);
  await expect(dp.locator('#order-status')).toHaveText('Подбор исполнителя');
  await expect(dp.locator('#history')).toContainText('Все эксперты заняты');
  await shot(dp, '99d-dispetcher-otkaz-organizacii');
  await dctx.close();
  await hctx.close();
  await sctx.close();
});

test('досье эксперта (2.14): эксперт заводит документы и копии; черновик берёт сведения, копии — в приложения; с истёкшим аттестатом — не в подборе', async ({ page, browser, baseURL }) => {
  // Эксперт — на экране page; заказчик и диспетчер — через запросы и второй телефон.
  const spec = await signIn(page, '+79990001481');
  const cctx = await phoneContext(browser, baseURL);
  const cp = await cctx.newPage();
  await signIn(cp, '+79990001482');
  const dctx = await phoneContext(browser, baseURL);
  const dp = await dctx.newPage();
  const disp = await signIn(dp, '+79990001483');
  await db(async (c) => {
    await c.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]);
    await c.query("update users set full_name = 'Тестовый Эксперт Досье' where id = $1", [spec.id]);
    await c.query('insert into specialists (user_id) values ($1)', [spec.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'vehicle')", [spec.id]);
  });

  // Досье пустое — эксперт добавляет аттестат (поля зависят от вида документа) и загружает копию.
  await page.goto('/kabinet#specialist');
  await expect(page.locator('#dossier-empty')).toBeVisible();
  await page.getByLabel('Документ', { exact: true }).selectOption({ label: 'Квалификационный аттестат' });
  await expect(page.getByLabel('Страховая сумма, руб.', { exact: true })).toBeHidden();
  await page.getByLabel('Направление', { exact: true }).fill('Оценка движимого имущества');
  await page.getByLabel('Номер аттестата', { exact: true }).fill('000777-2');
  await page.getByLabel('Действует до', { exact: true }).fill(inDays(20));
  await page.getByRole('button', { name: 'Добавить' }).click();
  await expect(page.locator('#dossier-msg')).toHaveText('Документ добавлен — загрузите копию');
  const cert = page.locator('#dossier-items li').filter({ hasText: 'Квалификационный аттестат' });
  await expect(cert).toContainText('№ 000777-2');
  await expect(cert).toContainText('срок кончается');
  await expect(page.locator('#dossier-alert')).toContainText('Скоро кончается срок: Квалификационный аттестат');
  await cert.locator('input[type=file]').setInputFiles({ name: 'аттестат.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 тестовая копия') });
  await expect(page.locator('#dossier-msg')).toHaveText('Копия сохранена');
  await expect(cert).toContainText('Копия: аттестат.pdf');

  // Полис: без суммы — понятный отказ; с суммой — в досье.
  await page.getByLabel('Документ', { exact: true }).selectOption({ label: 'Полис страхования оценщика' });
  await page.getByLabel('Страховщик', { exact: true }).fill('Тестовое страхование');
  await page.getByLabel('Номер полиса', { exact: true }).fill('ТП-001');
  await page.getByLabel('Действует до', { exact: true }).fill(inDays(300));
  await page.getByRole('button', { name: 'Добавить' }).click();
  await expect(page.locator('#dossier-msg')).toContainText('заполните: Страховая сумма');
  await page.getByLabel('Страховая сумма, руб.', { exact: true }).fill('5000000');
  await page.getByRole('button', { name: 'Добавить' }).click();
  await expect(page.locator('#dossier-items li').filter({ hasText: 'Полис страхования оценщика' })).toContainText('сумма 5');
  await shot(page, '99e-specialist-dossier');

  // Дело: черновик берёт сведения из досье, кнопка прикладывает копии к результату.
  const created = await (await cp.request.post('/api/orders', { data: { module: 'expertise', service: 'vehicle', title: 'Машина для досье' }, headers: H })).json();
  const id = created.order.id;
  expect((await cp.request.patch(`/api/orders/${id}`, {
    data: { deadline: inDays(9), fields: { purpose: 'deal', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая модель' } }, headers: H,
  })).status()).toBe(200);
  expect((await cp.request.post(`/api/orders/${id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 1500000, paid_at = now() where id = $1', [id]);
    await c.query("insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at) values ($1, 1500000, 'succeeded', $2, $3, now())", [id, `pay_ui_${id}`, disp.id]);
    // Аттестат истёк — диспетчер видит предупреждение в подборе.
    await c.query("update dossier_items set valid_until = current_date - 1 where user_id = $1 and kind = 'certificate'", [spec.id]);
  });
  // Решение Дамира 03.10.2026: по оценке эксперта с истёкшим аттестатом в подборе нет.
  await dp.goto(`/kabinet#order=${id}`);
  await expect(dp.locator('#candidates li, #candidates-empty:not(.hidden)').first()).toBeVisible();
  await expect(dp.locator('#candidates')).not.toContainText('Тестовый Эксперт Досье');
  await shot(dp, '99f-dispetcher-dossier');
  // Эксперт обновил аттестат — снова в подборе.
  await db((c) => c.query("update dossier_items set valid_until = current_date + 200 where user_id = $1 and kind = 'certificate'", [spec.id]));
  await dp.reload();
  const cand = dp.locator('#candidates li').filter({ hasText: 'Тестовый Эксперт Досье' });
  await expect(cand.locator('[data-role=dossier-expired]')).toHaveCount(0);
  dp.once('dialog', (d) => d.accept());
  await cand.getByRole('button', { name: 'Предложить дело' }).click();
  await expect(dp.locator('#status-msg')).toHaveText('Дело предложено специалисту');
  expect((await page.request.post(`/api/orders/${id}/status`, { data: { from: 'awaiting_executor', to: 'in_work' }, headers: H })).status()).toBe(200);

  await page.goto(`/kabinet#order=${id}`);
  await page.getByRole('button', { name: 'Подготовить черновик с помощью ИИ' }).click();
  await expect(page.locator('#draft-msg')).toHaveText('Черновик готов — проверьте и поправьте');
  const text = page.getByLabel('Текст заключения');
  await expect(text).toHaveValue(/Сведения об эксперте \(из досье\):\n- Квалификационный аттестат: Оценка движимого имущества, № 000777-2/);
  await expect(text).toHaveValue(/Приложение 1\. Квалификационный аттестат № 000777-2/);
  await page.getByRole('button', { name: 'Приложить копии из досье' }).click();
  await expect(page.locator('#doc-msg')).toHaveText('Приложено копий: 1. Подпишите их вместе с отчётом.');
  await expect(page.locator('#docs li').filter({ hasText: 'Приложение 1 — Квалификационный аттестат № 000777-2.pdf' })).toContainText('Результат работы');
  await shot(page, '99g-specialist-kopii-iz-dossier');
  // Заказчик досье не видит: ни сведений, ни копий до проверки.
  await cp.goto(`/kabinet#order=${id}`);
  await expect(cp.locator('#order-title')).toHaveText('Машина для досье');
  await expect(cp.locator('#docs')).not.toContainText('Приложение 1');
  await expect(cp.locator('body')).not.toContainText('000777-2');
  await cctx.close();
  await dctx.close();
});

test('сквозной путь: заявка на оценку квартиры от входа заказчика до выплаты исполнителю', async ({ page, browser, baseURL }) => {
  const A = '+79990001401', D = '+79990001402', S = '+79990001403', C = '+79990001404', X = '+79990001405';
  const { grantRole } = await import('../../src/tools/grant-role.mjs');
  const { createDb } = await import('../../src/db.mjs');
  const { loadConfig } = await import('../../src/config.mjs');
  const sql = createDb(loadConfig(testEnv()));
  try { await grantRole(sql, A, 'admin'); } finally { await sql.end(); }
  const title = 'Оценка квартиры для продажи — сквозной путь';

  // Каждый входит со своего телефона через страницу входа.
  async function enter(p, phone, name) {
    await p.goto('/');
    await p.getByLabel('Номер мобильного телефона').fill(phone);
    await p.getByRole('button', { name: 'Получить код' }).click();
    await expect(p.getByText(/^Код отправлен/)).toBeVisible();
    await p.getByLabel('Код из СМС').fill(await smsCode(p.request, phone));
    await p.getByRole('button', { name: 'Войти' }).click();
    await expect(p).toHaveURL(/\/kabinet$/);
    if (name) {
      await p.goto('/kabinet#profile');
      await p.getByLabel('Как к Вам обращаться').fill(name);
      await p.getByRole('button', { name: 'Сохранить' }).click();
      await expect(p.locator('#who')).toHaveText(name);
    }
  }
  const ctx = async () => (await phoneContext(browser, baseURL)).newPage();
  const ap = await ctx(), dp = await ctx(), sp = await ctx(), xp = await ctx();
  await enter(dp, D, 'Тестовый Диспетчер');
  await enter(sp, S, 'Тестов Оценщик Сквозной');
  await enter(xp, X);
  await enter(ap, A);

  // 1. Администратор: диспетчер; специалист с допуском на оценку недвижимости.
  await ap.getByRole('link', { name: 'Управление' }).click();
  await ap.getByLabel('Номер телефона пользователя').fill(D);
  await ap.getByRole('button', { name: 'Найти' }).click();
  await ap.getByLabel('Служебная роль').selectOption('dispatcher');
  await ap.getByRole('button', { name: 'Сохранить роль' }).click();
  await expect(ap.getByText('Роль сохранена')).toBeVisible();
  await ap.getByLabel('Номер телефона пользователя').fill(S);
  await ap.getByRole('button', { name: 'Найти' }).click();
  await expect(ap.locator('#admin-specialist-state')).toContainText('Пока не специалист');
  await ap.getByRole('button', { name: 'Сохранить профиль специалиста' }).click();
  await expect(ap.getByText('Профиль специалиста сохранён')).toBeVisible();
  await ap.getByLabel('Дать допуск на услугу').selectOption('expertise/realty');
  await ap.getByRole('button', { name: 'Дать допуск' }).click();
  await expect(ap.locator('#sp-permits li')).toContainText('недвижимости');
  await shot(ap, '70-skvoznoy-admin');

  // 2. Заказчик входит сам, заполняет заявку по описанию услуги, прикладывает документ и отправляет.
  await enter(page, C, 'Тестова Заказчица');
  await page.goto('/kabinet');
  await expect(page.getByText('Заявок пока нет.')).toBeVisible();
  await page.locator('#new-order').getByLabel('Услуга').selectOption({ label: 'Оценка недвижимости' });
  await page.getByLabel('Коротко: что нужно').fill(title);
  await page.getByRole('button', { name: 'Создать заявку' }).click();
  await expect(page.locator('#order-status')).toHaveText('Новая');
  const id = new URL(page.url()).hash.match(/^#order=([0-9a-f-]{36})$/i)[1];
  await page.getByLabel('Для чего нужна оценка').selectOption({ label: 'Купля-продажа' });
  await page.getByLabel('Где находится объект').selectOption({ label: 'Москва' });
  await page.getByLabel('Что оцениваем').selectOption({ label: 'Квартира' });
  await page.getByLabel('Адрес объекта').fill('г. Москва, ул. Тестовая, д. 11, кв. 4');
  await page.getByLabel('Площадь, кв. м').fill('42');
  await page.getByLabel(/^Срок/).fill(inDays(10));
  await page.getByLabel('Добавить файл (до 100 МБ)').setInputFiles({ name: 'Выписка ЕГРН.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 тестовая выписка') });
  await expect(page.getByText('Файл добавлен')).toBeVisible();
  await shot(page, '71-skvoznoy-zayavka');
  await page.getByRole('button', { name: 'Отправить заявку' }).click();
  await expect(page.getByText('Заявка отправлена')).toBeVisible();
  await expect(page.locator('#order-status')).toHaveText('Подбор исполнителя');

  // Посторонний не видит заявку ни в списке, ни по ссылке.
  await xp.goto('/kabinet');
  await expect(xp.getByRole('heading', { name: 'Мои заявки' })).toBeVisible();
  await expect(xp.getByText(title)).toHaveCount(0);
  await xp.goto(`/kabinet#order=${id}`);
  await expect(xp.getByRole('heading', { name: 'Заявка не найдена' })).toBeVisible();

  // 3. Диспетчер: уведомление о новой заявке, цена.
  await dp.goto('/kabinet#notifications');
  await expect(dp.locator('#notifications li').filter({ hasText: title })).toContainText('Новая заявка ждёт подбора исполнителя');
  await dp.locator('#notifications li').filter({ hasText: title }).getByRole('button').click();
  await expect(dp.locator('#order-title')).toHaveText(title);
  await expect(dp.locator('#facts')).toContainText('г. Москва, ул. Тестовая, д. 11, кв. 4');
  await dp.getByLabel('Цена, рублей').fill('18000');
  await dp.getByRole('button', { name: 'Назначить цену' }).click();
  await expect(dp.locator('#money-msg')).toHaveText('Цена назначена');
  await expect(dp.locator('#money-facts')).toContainText(/Исполнителю \(80%\)\s*14\s400 ₽/);

  // 4. Заказчик оплачивает (поддельная ЮKassa).
  await page.reload();
  await expect(page.locator('#money-facts')).toContainText(/Цена\s*18\s000 ₽/);
  await page.getByRole('button', { name: /Оплатить 18\s000 ₽/ }).click();
  await expect(page.locator('#money-facts')).toContainText('оплачено');
  await shot(page, '72-skvoznoy-oplata');

  // 5. Диспетчер предлагает дело лучшему по подбору.
  await dp.reload();
  await expect(dp.locator('#match-current')).toContainText('Заявка оплачена');
  const cand = dp.locator('#candidates li').filter({ hasText: 'Тестов Оценщик Сквозной' });
  await expect(cand).toContainText('из 100');
  dp.once('dialog', (d) => d.accept());
  await cand.getByRole('button', { name: 'Предложить дело' }).click();
  await expect(dp.locator('#order-status')).toHaveText('Ждёт исполнителя');
  await shot(dp, '73-skvoznoy-podbor');

  // 6. Специалист: уведомление, принимает, прикладывает отчёт, ИИ-проверка, пишет заказчику, сдаёт.
  await sp.goto('/kabinet');
  await expect(sp.locator('#notify-count')).toHaveText('1');
  await sp.getByRole('link', { name: /Уведомления/ }).click();
  await sp.locator('#notifications li').filter({ hasText: 'Вам предложено новое дело' }).getByRole('button').click();
  await expect(sp.locator('#order-title')).toHaveText(title);
  await expect(sp.locator('#money-facts')).toContainText(/Ваше вознаграждение \(80% цены\)\s*14\s400 ₽/);
  await sp.getByRole('button', { name: 'Принять дело' }).click();
  await expect(sp.locator('#order-status')).toHaveText('В работе');
  await sp.locator('#result-file').setInputFiles({ name: 'Отчёт об оценке.txt', mimeType: 'text/plain', buffer: Buffer.from('Отчёт об оценке квартиры. Итоговая стоимость 12 000 000 руб.') });
  await expect(sp.locator('#doc-msg')).toHaveText('Файл добавлен');
  await sp.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(sp.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  await expect(sp.locator('#review-checks .verdict')).toHaveCount(0);
  await sp.getByLabel('Сообщение').fill('Осмотр проведён, отчёт приложен.');
  await sp.getByRole('button', { name: 'Отправить сообщение' }).click();
  await expect(sp.locator('#messages li')).toHaveCount(1);
  await shot(sp, '74-skvoznoy-specialist');
  await signResults(sp);
  await sp.getByRole('button', { name: 'Сдать на проверку' }).click();
  await expect(sp.locator('#order-status')).toHaveText('Проверка результата');

  // Пока результат не проверен, заказчик его не видит.
  await page.reload();
  await expect(page.locator('#order-status')).toHaveText('Проверка результата');
  await expect(page.locator('#docs li').filter({ hasText: 'Результат работы' })).toHaveCount(0);

  // 7. Диспетчер: ИИ-подсказки, отметки по всем правилам, «Проверено, готово».
  await dp.reload();
  await expect(dp.locator('#review-box')).toBeVisible();
  await dp.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(dp.locator('#ai-review-state')).toContainText('запускал диспетчер');
  const rules = dp.locator('#review-checks > li');
  const n = await rules.count();
  expect(n).toBeGreaterThan(3);
  for (let i = 0; i < n; i += 1) {
    await rules.nth(i).getByRole('button', { name: 'В порядке' }).click();
    await expect(rules.nth(i).locator('.verdict')).toHaveText('В порядке');
  }
  await shot(dp, '75-skvoznoy-proverka');
  await dp.getByRole('button', { name: 'Проверено, готово' }).click();
  await expect(dp.locator('#order-status')).toHaveText('Готово');

  // 8. Заказчик: уведомление, результат скачивается, акт, сообщение исполнителя, закрытие.
  await page.goto('/kabinet#notifications');
  await expect(page.locator('#notifications')).toContainText(title);
  await page.goto(`/kabinet#order=${id}`);
  await expect(page.locator('#order-status')).toHaveText('Готово');
  await expect(page.locator('#messages li').first()).toContainText('Осмотр проведён');
  const res = page.locator('#docs li').filter({ hasText: 'Отчёт об оценке.txt' });
  await expect(res).toContainText('Результат работы');
  const [download] = await Promise.all([page.waitForEvent('download'), res.getByRole('button', { name: 'Скачать' }).click()]);
  expect(download.suggestedFilename()).toBe('Отчёт об оценке.txt');
  const chunks = [];
  for await (const ch of await download.createReadStream()) chunks.push(ch);
  expect(Buffer.concat(chunks).toString()).toContain('Итоговая стоимость 12 000 000 руб.');
  await page.locator('#closing li').getByRole('button', { name: 'Открыть' }).click();
  await expect(page.locator('#closing-doc')).toContainText('Акт об оказании услуг');
  await shot(page, '76-skvoznoy-gotovo');
  await page.getByRole('button', { name: 'Принять и закрыть' }).click();
  await expect(page.locator('#order-status')).toHaveText('Закрыта');
  await shot(page, '77-skvoznoy-zakryta');

  // 9. Исполнитель получил выплату; диспетчер видит оплату в сводке; посторонний по-прежнему ничего не видит.
  await sp.goto('/kabinet#money');
  await expect(sp.locator('#money-payouts li').filter({ hasText: title })).toContainText('выплачено');
  await expect(sp.locator('#money-totals')).toContainText(/Выплачено\s*14\s400 ₽/);
  await shot(sp, '78-skvoznoy-vyplata');
  await dp.goto('/kabinet#money');
  await expect(dp.locator('#money-payments li').filter({ hasText: title })).toContainText(/18\s000 ₽/);
  await xp.goto(`/kabinet#order=${id}`);
  await expect(xp.getByRole('heading', { name: 'Заявка не найдена' })).toBeVisible();
  for (const p of [ap, dp, sp, xp]) await p.context().close();
});

test('черновик готовым файлом Word (2.29): руководитель загружает шаблон, эксперт скачивает отчёт в нём', async ({ page, browser, baseURL }) => {
  await signIn(page, '+79990000650');
  const created = await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Квартира: отчёт в шаблоне' }, headers: H })).json();
  const id = created.order.id;
  expect((await page.request.patch(`/api/orders/${id}`, {
    data: { deadline: inDays(9), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 50', area: '61' } }, headers: H,
  })).status()).toBe(200);
  const sctx = await phoneContext(browser, baseURL, { acceptDownloads: true });
  const sp = await sctx.newPage();
  const spec = await signIn(sp, '+79990000651');
  const hctx = await phoneContext(browser, baseURL);
  const hp = await hctx.newPage();
  const head = await signIn(hp, '+79990000652');
  const orgId = await db(async (c) => {
    const { rows: [org] } = await c.query("insert into organizations (name) values ('ООО «Тестовый бланк»') returning id");
    await c.query("update users set full_name = 'Тестовый эксперт бланка' where id = $1", [spec.id]);
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head'), ($1, $3, 'member')", [org.id, head.id, spec.id]);
    await c.query('insert into specialists (user_id, org_id) values ($1, $2)', [spec.id, org.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [spec.id]);
    await c.query("update orders set status = 'in_work', executor_user_id = $2, price_kop = 1500000, paid_at = now() where id = $1", [id, spec.id]);
    return org.id;
  });

  // Руководитель загружает шаблон: сначала не тот файл, потом .docx с шапкой и местом для отчёта.
  await hp.goto(`/kabinet#org=${orgId}`);
  const box = hp.locator('#org-template-box');
  await expect(box).toContainText('Шаблон не загружен');
  await hp.locator('#org-template-file').setInputFiles({ name: 'бланк.doc', mimeType: 'application/msword', buffer: Buffer.from('старый Word') });
  await expect(hp.locator('#org-template-msg')).toHaveText('Шаблон — файл Word .docx (не .doc, не .docm)');
  await hp.locator('#org-template-file').setInputFiles({ name: 'Бланк компании.docx', mimeType: 'application/octet-stream',
    buffer: makeDocx(['ООО «Тестовый бланк» · ИНН 7700000000 · г. Москва', '{{ОТЧЁТ}}', 'Руководитель ____________']) });
  await expect(hp.locator('#org-template-msg')).toHaveText('Шаблон сохранён');
  await expect(hp.locator('#org-template-state')).toContainText('Загружен «Бланк компании.docx»');
  await expect(hp.locator('#org-template-state')).toContainText('Отчёт встаёт на место абзаца {{ОТЧЁТ}}');
  await expect(hp.getByRole('button', { name: 'Убрать шаблон' })).toBeVisible();
  await box.scrollIntoViewIfNeeded();
  await shot(hp, '99h-rukovoditel-shablon-otcheta');

  // Эксперт видит шаблон в организации, но не меняет его.
  await sp.goto(`/kabinet#org=${orgId}`);
  await expect(sp.locator('#org-template-state')).toContainText('Загружен «Бланк компании.docx»');
  await expect(sp.locator('#org-template-pick')).toBeHidden();
  await expect(sp.getByRole('button', { name: 'Убрать шаблон' })).toBeHidden();
  await expect(sp.getByRole('button', { name: 'Скачать шаблон' })).toBeVisible();

  // Черновик: таблица «задание» из заявки и таблица подходов; «Скачать Word» — готовый отчёт в шаблоне организации.
  await sp.goto(`/kabinet#order=${id}`);
  await sp.getByRole('button', { name: 'Подготовить черновик с помощью ИИ' }).click();
  await expect(sp.locator('#draft-msg')).toHaveText('Черновик готов — проверьте и поправьте');
  const text = sp.getByLabel('Текст заключения');
  await expect(text).toHaveValue(/\| Адрес объекта \| г\. Москва, тестовая ул\., 50 \|/);
  await expect(text).toHaveValue(/\| Подход \| Стоимость, руб\. \| Вес \|/);
  await expect(sp.getByRole('button', { name: 'Скачать Word' })).toBeVisible();
  await sp.locator('#draft-word-box').scrollIntoViewIfNeeded();
  await shot(sp, '99i-specialist-skachat-word');
  // Несохранённая правка уходит в файл: сначала сохраняется.
  await text.fill(`${await text.inputValue()}\nПравка эксперта перед скачиванием.`);
  const [download] = await Promise.all([sp.waitForEvent('download'), sp.getByRole('button', { name: 'Скачать Word' }).click()]);
  expect(download.suggestedFilename()).toBe('Отчёт об оценке.docx');
  const buf = fs.readFileSync(await download.path());
  const word = (await extractPages(buf, 'Отчёт.docx')).pages.join('\n');
  expect(word).toMatch(/^ООО «Тестовый бланк» · ИНН 7700000000 · г\. Москва\n[\s\S]*ОТЧЁТ ОБ ОЦЕНКЕ № [0-9A-F]{8}\nОценка недвижимости/);
  expect(word).toContain('Исполнитель: Тестовый эксперт бланка');
  expect(word).toMatch(/Содержание\n1\. Основные факты и выводы/);
  expect(word).toContain('Правка эксперта перед скачиванием.');
  expect(word).toMatch(/Руководитель ____________\n?$/);
  await expect(sp.locator('#draft-state')).toContainText('Последняя правка');

  // Заказчик кнопки не видит, файла не получает.
  await page.goto(`/kabinet#order=${id}`);
  await expect(page.locator('#draft-box')).toBeHidden();
  expect((await page.request.get(`/api/orders/${id}/draft/docx`)).status()).toBe(403);
  await sctx.close();
  await hctx.close();
});

test('аналоги в деле (2.32): ссылка и скриншот — ИИ заполняет признаки, эксперт подтверждает; заказчик раздела не видит', async ({ page, browser, baseURL }) => {
  await signIn(page, '+79990001591');
  const created = await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'vehicle', title: 'Машина: аналоги на телефоне' }, headers: H })).json();
  const id = created.order.id;
  expect((await page.request.patch(`/api/orders/${id}`, {
    data: { deadline: inDays(9), fields: { purpose: 'court', region: 'moscow', vehicle_type: 'car', make_model: 'Toyota Camry', year: 2019 } }, headers: H,
  })).status()).toBe(200);
  expect((await page.request.post(`/api/orders/${id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  const sctx = await phoneContext(browser, baseURL);
  const sp = await sctx.newPage();
  const spec = await signIn(sp, '+79990001592');
  await db(async (c) => {
    await c.query('insert into specialists (user_id) values ($1)', [spec.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'vehicle')", [spec.id]);
    await c.query('update orders set price_kop = 1500000, paid_at = now(), status = $2, executor_user_id = $3 where id = $1', [id, 'in_work', spec.id]);
    await c.query("insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at) values ($1, 1500000, 'succeeded', $2, $3, now())", [id, `pay_ui_${id}`, spec.id]);
  });

  await sp.goto(`/kabinet#order=${id}`);
  const box = sp.locator('#analogs-box');
  await expect(box).toBeVisible();
  await expect(sp.locator('#analogs-hints')).toContainText('Нужно не меньше 3 аналогов — подтверждено 0');
  await sp.locator('#analogs-search-box summary').click();
  await expect(sp.locator('#analogs-criteria')).toContainText('Toyota Camry, 2017–2021 г.');
  await expect(sp.locator('#analogs-links a').first()).toHaveAttribute('rel', 'noopener noreferrer');
  // Скриншот объявления — настоящая картинка (рисуется в браузере); текст для поддельного распознавания — после картинки.
  const png = Buffer.from((await sp.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 540; c.height = 1170;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 540, 1170);
    g.fillStyle = '#1f4e8c'; g.fillRect(20, 20, 500, 300);
    g.fillStyle = '#222'; g.font = '28px sans-serif'; g.fillText('Toyota Camry, 2018 — 2 150 000 ₽', 20, 380);
    return c.toDataURL('image/png');
  })).split(',')[1], 'base64');
  const ad = 'Toyota Camry 2.5 AT, 2018 г.\nЦена 2 150 000 ₽\nПробег 85 000 км\nМосква\nРазмещено 20.09.2026';
  await box.getByLabel('Ссылка на объявление').fill('https://www.avito.ru/moskva/avtomobili/toyota_camry_2018_1');
  await sp.locator('#analogs-file').setInputFiles({ name: 'Screenshot_avito.png', mimeType: 'image/png', buffer: Buffer.concat([png, Buffer.from(`OCR:${ad}`)]) });
  await expect(sp.locator('#analogs-file-name')).toHaveText('Screenshot_avito.png');
  await shot(sp, '90-specialist-analogi-dobavit');
  await box.getByRole('button', { name: 'Добавить аналог' }).click();
  await expect(sp.locator('#analogs-msg')).toContainText('ИИ заполнил признаков');
  const card = sp.locator('#analogs-list li.analog').first();
  await expect(card).toContainText('Аналог 1 · avito.ru');
  await expect(card).toContainText('Скриншот получен платформой');
  await expect(card.getByLabel(/Цена, руб/)).toHaveValue('2150000');
  await expect(card.getByLabel(/Пробег, км/)).toHaveValue('85000');
  await expect(card.locator('.ai-tag').first()).toHaveText('ИИ');
  await expect(card.locator('.analog-warn')).toContainText('Признаки предложил ИИ — проверьте и подтвердите');
  await shot(sp, '91-specialist-analog-ot-ii');
  // Эксперт поправил комплектацию и подтвердил.
  await card.getByLabel('Двигатель, коробка, комплектация').fill('2.5 AT');
  await card.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(sp.locator('#analogs-msg')).toHaveText('Аналог подтверждён');
  await expect(sp.locator('#analogs-list li.analog').first().locator('.badge')).toHaveText('подтверждён');
  await expect(sp.locator('#analogs-state')).toContainText('Подтверждено аналогов: 1 из 3');

  // Корректировки (2.74): торг из справочника и своя «Цвет» без таблицы — итог и цена после корректировок, предупреждение.
  const c1 = sp.locator('#analogs-list li.analog').first();
  await expect(c1.locator('.analog-adj summary')).toHaveText('Корректировки: нет');
  await c1.locator('.analog-adj summary').click();
  await c1.getByRole('button', { name: 'Добавить корректировку' }).click();
  let row = c1.locator('.analog-adj-row').last();
  await row.getByLabel('Корректировка', { exact: true }).selectOption({ label: 'Торг' });
  await expect(row.getByLabel('Название корректировки')).toBeHidden();
  await row.getByLabel('Значение, %').fill('−5');
  await row.getByLabel('Справочник или источник').fill('Справочник оценщика (Лейфер)');
  await row.getByLabel('Год справочника').fill('2025');
  await row.getByLabel('Таблица').fill('12');
  await c1.getByRole('button', { name: 'Добавить корректировку' }).click();
  row = c1.locator('.analog-adj-row').last();
  await row.getByLabel('Корректировка', { exact: true }).selectOption({ label: 'Другая' });
  await row.getByLabel('Название корректировки').fill('Цвет кузова');
  await row.getByLabel('Значение, %').fill('1,5');
  await row.getByLabel('Справочник или источник').fill('Анализ рынка');
  await row.getByLabel('Год справочника').fill('2026');
  await shot(sp, '93-specialist-analog-korrektirovki');
  await c1.getByRole('button', { name: 'Сохранить' }).click();
  await expect(sp.locator('#analogs-msg')).toHaveText('Аналог подтверждён');
  const c1s = sp.locator('#analogs-list li.analog').first();
  await expect(c1s.locator('.analog-adj summary')).toHaveText('Корректировки: 2 · всего −3,58 % · цена после — 2 073 138 руб.');
  await expect(c1s.locator('.analog-adj-row')).toHaveCount(2);
  await expect(c1s.locator('.analog-warn')).toContainText('Корректировка «Цвет кузова»: укажите таблицу');
  await c1s.locator('.analog-adj').scrollIntoViewIfNeeded();
  await shot(sp, '94-specialist-analog-korrektirovki-itog');
  // Убрали вторую — осталась одна.
  await c1s.getByRole('button', { name: 'Убрать корректировку' }).last().click();
  await c1s.getByRole('button', { name: 'Сохранить' }).click();
  await expect(sp.locator('#analogs-list li.analog').first().locator('.analog-adj summary')).toHaveText('Корректировки: 1 · всего −5 % · цена после — 2 042 500 руб.');

  // Второй — без скриншота, по вставленному тексту; предупреждение «нет скриншота».
  await box.getByLabel('Ссылка на объявление').fill('https://auto.drom.ru/moscow/toyota/camry/2.html');
  await sp.locator('#analogs-form details summary').click();
  await sp.locator('#analogs-text').fill('Toyota Camry, 2014 г.\nЦена 1 650 000 руб.\nПробег 160 000 км\nМосковская область');
  await box.getByRole('button', { name: 'Добавить аналог' }).click();
  await expect(sp.locator('#analogs-msg')).toContainText('ИИ заполнил признаков');
  const second = sp.locator('#analogs-list li.analog').nth(1);
  await expect(second.locator('.analog-warn')).toContainText('Нет скриншота объявления');
  await expect(second.locator('.analog-warn')).toContainText('Год выпуска: 2014 у аналога, 2019 у объекта — нужна корректировка');
  await expect(second.locator('.analog-warn')).toContainText('Другой регион');
  await shot(sp, '92-specialist-analogi-preduprezhdeniya');

  // 2.75: ИИ-проверка сверяет аналоги в отчёте с делом. В отчёте цена первого аналога другая, а второй (не подтверждён в
  // деле) — со своей ссылкой: эксперт видит это под правилом «Аналоги» с файлом и страницей.
  await sp.locator('#result-file').setInputFiles({ name: 'Отчёт с аналогами.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: makeDocx(['ОТЧЁТ ОБ ОЦЕНКЕ', 'Сравнительный подход',
      'Аналог № 1 — https://www.avito.ru/moskva/avtomobili/toyota_camry_2018_1 — 2 100 000 руб.',
      'Аналог № 2 — https://auto.drom.ru/moscow/toyota/camry/2.html — 1 650 000 руб.']) });
  await expect(sp.locator('#doc-msg')).toHaveText('Файл добавлен');
  await sp.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(sp.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  const found = sp.locator('li[data-check="analogs"] .ai-found');
  await expect(found).toContainText('Аналог 1 из дела (avito.ru): цена 2 150 000 руб. в отчёте не найдена');
  await expect(found).toContainText('В отчёте есть аналог № 2, а в деле подтверждён 1 аналог');
  await expect(found).toContainText('Ссылка у аналога № 2 в отчёте — не из аналогов дела');
  await found.scrollIntoViewIfNeeded();
  await shot(sp, '95-specialist-ii-analogi-v-otchete');

  // Заказчик раздела аналогов не видит.
  await page.goto(`/kabinet#order=${id}`);
  await expect(page.locator('#order-view')).toBeVisible();
  await expect(page.locator('#analogs-box')).toBeHidden();
  await sctx.close();
});

// Прогон «как настоящий эксперт» (2.33) по сценарию отчёта «221»: автобус для суда, только затратный подход, осмотр по
// ссылке владельцу. Проверяется то, что мешало живому эксперту: в заявке нет «Автобуса» и госномера; в предложении не
// видно, что за объект; черновик писал раздел неприменённого подхода (в отчёте пропадал номер раздела); «Что дальше» не
// отмечал черновик сделанным; владелец нажал «Готово», не сняв нужные шаги, — эксперт не видел, чего не хватает.
test('как настоящий эксперт (2.33): автобус для суда — от заявки до сдачи, подходы, осмотр, черновик без лишних разделов', async ({ page, browser, baseURL }) => {
  const A = '+79990003301', D = '+79990003302', S = '+79990003303', C = '+79990003304';
  const { grantRole } = await import('../../src/tools/grant-role.mjs');
  const { createDb } = await import('../../src/db.mjs');
  const { loadConfig } = await import('../../src/config.mjs');
  const sql = createDb(loadConfig(testEnv()));
  try { await grantRole(sql, A, 'admin'); } finally { await sql.end(); }
  const ctx = async (extra) => (await phoneContext(browser, baseURL, extra)).newPage();
  const ap = await ctx(), dp = await ctx(), sp = await ctx();
  await signIn(dp, D);
  const spec = await signIn(sp, S);
  await signIn(ap, A);
  await sp.request.patch('/api/me', { data: { full_name: 'Иванов Иван Иванович' }, headers: H });
  await ap.goto('/kabinet#admin');
  await ap.getByLabel('Номер телефона пользователя').fill(D);
  await ap.getByRole('button', { name: 'Найти' }).click();
  await ap.getByLabel('Служебная роль').selectOption('dispatcher');
  await ap.getByRole('button', { name: 'Сохранить роль' }).click();
  await expect(ap.getByText('Роль сохранена')).toBeVisible();
  await db(async (c) => {
    await c.query('insert into specialists (user_id) values ($1)', [spec.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'vehicle')", [spec.id]);
  });

  // 1. Заказчик: «Автобус», госномер и пробег есть в заявке.
  await signIn(page, C);
  await page.goto('/kabinet');
  await page.locator('#new-order').getByLabel('Услуга').selectOption({ label: 'Оценка транспортного средства' });
  await page.getByLabel('Коротко: что нужно').fill('Оценка автобуса для суда');
  await page.getByRole('button', { name: 'Создать заявку' }).click();
  await expect(page.locator('#order-status')).toHaveText('Новая');
  const id = new URL(page.url()).hash.split('=')[1];
  await page.getByLabel('Для чего нужна оценка').selectOption({ label: 'Для суда' });
  await page.getByLabel('Где находится объект').selectOption({ label: 'Москва' });
  await page.getByLabel('Вид транспорта').selectOption({ label: 'Автобус' });
  await page.getByLabel('Марка и модель').fill('Авто-Бус 1000-01');
  await page.getByLabel('Год выпуска').fill('2024');
  await page.getByLabel('VIN', { exact: true }).fill('XXX000000R0000000');
  await page.getByLabel('Госномер').fill('а001аа799');
  await page.getByLabel('Пробег, км').fill('12000');
  await page.getByLabel(/^Срок/).fill(inDays(10));
  await page.getByLabel('Основание').selectOption({ label: 'Определение суда' });
  await page.getByLabel(/^Номер определения/).fill('2-1234/2026');
  await page.getByLabel(/^Дата определения/).fill(inDays(-10));
  await page.getByLabel('Приложить определение суда').setInputFiles({ name: 'Определение суда.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 тестовое определение') });
  await expect(page.getByText('Приложено: Определение суда.pdf')).toBeVisible();
  await shot(page, '90-ekspert-zayavka-avtobus');
  await page.getByRole('button', { name: 'Отправить заявку' }).click();
  await expect(page.locator('#order-status')).toHaveText('Подбор исполнителя');
  await expect(page.locator('#facts')).toContainText('А001АА799');

  // 2. Диспетчер: цена; заказчик платит; диспетчер предлагает дело эксперту.
  await dp.goto(`/kabinet#order=${id}`);
  await dp.getByLabel('Цена, рублей').fill('15000');
  await dp.getByRole('button', { name: 'Назначить цену' }).click();
  await expect(dp.locator('#money-msg')).toHaveText('Цена назначена');
  await page.reload();
  await page.getByRole('button', { name: /Оплатить/ }).click();
  await expect(page.locator('#money-facts')).toContainText('оплачено');
  await dp.reload();
  dp.once('dialog', (d) => d.accept());
  await dp.locator('#candidates li').filter({ hasText: 'Иванов' }).getByRole('button', { name: 'Предложить дело' }).click();
  await expect(dp.locator('#order-status')).toHaveText('Ждёт исполнителя');

  // 3. Эксперт: в списке видно, что за объект и для чего, — принимает прямо из списка.
  await sp.goto('/kabinet');
  const offer = sp.locator('#orders li').filter({ hasText: 'Оценка автобуса для суда' });
  await expect(offer.locator('.brief')).toHaveText('Для суда · Москва · Автобус · Авто-Бус 1000-01 · 2024 · XXX000000R0000000');
  await shot(sp, '91-ekspert-predlozhenie');
  sp.once('dialog', (d) => d.accept());
  await offer.getByRole('button', { name: 'Принять дело' }).click();
  // Принял — сразу в деле, без поиска его в списке.
  await expect(sp.locator('#order-status')).toHaveText('В работе');
  expect(sp.url()).toContain(`#order=${id}`);

  // 4. В «Что дальше» — подходы к оценке и аналоги; выбран только затратный — аналоги не нужны, шага «Аналоги» нет.
  await expect(sp.locator('#next-steps li[data-step="approaches"]')).toContainText('○ Подходы к оценке');
  await expect(sp.locator('#next-steps li[data-step="analogs"]')).toContainText('Аналоги (подтверждено 0 из 3)');
  await shot(sp, '92-ekspert-chto-dalshe');
  await sp.locator('#next-steps li[data-step="approaches"] button').click();
  await sp.locator('#draft-approaches').getByLabel('Затратный').check();
  await expect(sp.locator('#draft-msg')).toHaveText('Подходы сохранены');
  await expect(sp.locator('#next-steps li[data-step="approaches"]')).toContainText('✓ Подходы к оценке');
  await expect(sp.locator('#next-steps li[data-step="analogs"]')).toHaveCount(0);
  await expect(sp.locator('#analogs-hints')).toContainText('Сравнительный подход не применяется — аналоги не нужны');
  await expect(sp.locator('#next-main button')).toHaveText('Добавить файл результата');
  await shot(sp, '93-ekspert-podhody');

  // 5. Осмотр по ссылке: владелец снял три шага из семи и нажал «Готово» — эксперт сразу видит, чего не хватает.
  await sp.getByLabel('Телефон владельца — пришлём ему ссылку СМС (необязательно)').fill('+7 999 000-33-05');
  await sp.getByRole('button', { name: 'Выдать ссылку владельцу' }).click();
  await expect(sp.locator('#inspect-msg')).toContainText('Ссылка отправлена СМС');
  const url = await sp.locator('#inspect-url').textContent();
  const jpeg = Buffer.from((await sp.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 640; c.height = 480;
    const g = c.getContext('2d'); g.fillStyle = '#9db4d0'; g.fillRect(0, 0, 640, 480);
    return c.toDataURL('image/jpeg', 0.8);
  })).split(',')[1], 'base64');
  const op = await ctx({ permissions: ['geolocation'], geolocation: { latitude: 55.75, longitude: 37.61, accuracy: 10 } });
  await op.goto(url);
  await op.getByRole('button', { name: 'Начать: разрешить определение места' }).click();
  await expect(op.locator('#geo-state')).toContainText('Место определено');
  for (const st of ['car_front', 'car_vin', 'car_odometer']) {
    await op.locator(`#steps li[data-step="${st}"] input[type=file]`).setInputFiles({ name: `${st}.jpg`, mimeType: 'image/jpeg', buffer: jpeg });
    await expect(op.locator(`#steps li[data-step="${st}"] .badge`)).toHaveText('Фото: 1');
  }
  op.once('dialog', (d) => d.accept());
  await op.getByRole('button', { name: 'Готово' }).click();
  await expect(op.locator('#closed-text')).toContainText('Эксперт получил 3 фото');
  await sp.reload();
  await expect(sp.locator('#inspect-state')).toContainText('Не снято: Сзади, Слева, Справа, Салон — попросите доснять ниже.');
  await expect(sp.getByLabel('Попросить переснять шаг')).toHaveValue('car_rear');
  await expect(sp.locator('#next-steps li[data-step="inspect"]')).toContainText('✓');
  await shot(sp, '94-ekspert-osmotr-ne-snyato');

  // 6. Черновик: разделы подряд, без «Сравнительного подхода»; в таблице подходов он «Не применялся».
  await sp.getByRole('button', { name: 'Подготовить черновик с помощью ИИ' }).click();
  await expect(sp.locator('#draft-msg')).toHaveText('Черновик готов — проверьте и поправьте');
  const text = sp.getByLabel('Текст заключения');
  const body = await text.inputValue();
  expect(body).not.toMatch(/^## \d+\. Сравнительный подход/m);
  expect(body).toMatch(/^## 11\. Затратный подход/m);
  expect(body).toContain('| Сравнительный | Не применялся | — |');
  await expect(sp.locator('#next-steps li[data-step="draft"]')).toContainText('✓');
  // 2.37: в Word — фото осмотра приложением, по шагам, с местом съёмки.
  const [word] = await Promise.all([sp.waitForEvent('download'), sp.getByRole('button', { name: 'Скачать Word' }).click()]);
  const wchunks = [];
  for await (const ch of await word.createReadStream()) wchunks.push(ch);
  const wtext = (await extractPages(Buffer.concat(wchunks), 'r.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).pages.join('\n');
  expect(wtext).toContain('Приложение. Фотоматериалы осмотра');
  expect(wtext).toContain('Фото 1 — Спереди');
  expect(wtext).toContain('Место съёмки: 55.75000, 37.61000');
  await text.fill(body.replace(/\[(?:заполнить|описать)[^\]]*\]/gi, 'заполнено экспертом'));
  await sp.getByRole('button', { name: 'Сохранить правку' }).click();
  await expect(sp.locator('#draft-msg')).toHaveText('Правка сохранена');
  await sp.getByLabel('Я проверил текст и отвечаю за него').check();
  await sp.getByRole('button', { name: 'Приложить как файл результата' }).click();
  await expect(sp.locator('#draft-msg')).toHaveText('Файл «Отчёт об оценке.docx» добавлен в результат работы');

  // 7. ИИ-проверка, подпись, сдача — «Что дальше» ведёт кнопкой до конца.
  await sp.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(sp.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  await expect(sp.locator('#next-main button')).toHaveText('Подписать файл');
  sp.once('dialog', (d) => d.accept());
  await sp.locator('#next-main button').click();
  await expect(sp.locator('#next-main button')).toHaveText('Сдать на проверку');
  await shot(sp, '95-ekspert-gotov-sdat');
  await sp.locator('#next-main button').click();
  await expect(sp.locator('#order-status')).toHaveText('Проверка результата');
  await shot(sp, '96-ekspert-sdano');
  for (const p of [ap, dp, sp, op]) await p.context().close();
});

// «Сегодня» (2.34): эксперт сразу видит, что горит, что вернули и что предложено; руководитель — дела своих экспертов и
// подписи организации, без данных заказчика. Нажатие ведёт в дело или в раздел организации.
test('«Сегодня» (2.34, 2.63): эксперт — горит, вернули, предложено; руководитель — подписи, сроки и досье экспертов; заказчику не показывается', async ({ page, browser, baseURL }) => {
  const C = '+79990003501', D = '+79990003502', S = '+79990003503', HD = '+79990003504';
  const customer = await signIn(page, C);
  const dctx = await phoneContext(browser, baseURL), sctx = await phoneContext(browser, baseURL), hctx = await phoneContext(browser, baseURL);
  const dp = await dctx.newPage(), sp = await sctx.newPage(), hp = await hctx.newPage();
  const disp = await signIn(dp, D), spec = await signIn(sp, S), head = await signIn(hp, HD);
  await sp.request.patch('/api/me', { data: { full_name: 'Эксперт Сегодня' }, headers: H });
  let orgId;
  await db(async (c) => {
    await c.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]);
    orgId = (await c.query("insert into organizations (name) values ('ООО «Оценка Сегодня»') returning id")).rows[0].id;
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head'), ($1, $3, 'member')", [orgId, head.id, spec.id]);
    await c.query('insert into specialists (user_id, org_id) values ($1, $2)', [spec.id, orgId]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [spec.id]);
  });
  // Три дела: горящее в работе, вернутое диспетчером, новое предложение.
  async function make(title, days, status) {
    const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title }, headers: H })).json()).order;
    await page.request.patch(`/api/orders/${o.id}`, { data: { deadline: inDays(days), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, ул. Сегодняшняя, 1' } }, headers: H });
    await db((c) => c.query('update orders set status = $2, price_kop = 1500000, paid_at = now(), executor_user_id = $3, submitted_at = now() where id = $1', [o.id, status, spec.id]));
    return o;
  }
  const fire = await make('Квартира — срок завтра', 1, 'in_work');
  const back = await make('Квартира — вернули', 6, 'review');
  await make('Квартира — новое предложение', 9, 'awaiting_executor');
  expect((await dp.request.post(`/api/orders/${back.id}/status`, { data: { from: 'review', to: 'in_work', reason: 'Нет даты осмотра в разделе 3' }, headers: H })).status()).toBe(200);
  // Эксперт подписал отчёт — руководителю нужна подпись организации.
  const up = await sp.request.post(`/api/orders/${fire.id}/results`, { data: Buffer.from('%PDF-1.4 отчёт'), headers: { ...H, 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('Отчёт.pdf') } });
  expect(up.status()).toBe(201);
  expect((await sp.request.post(`/api/documents/${(await up.json()).document.id}/sign`, { data: { confirm: true }, headers: H })).status()).toBe(201);

  await sp.goto('/kabinet');
  const box = sp.locator('#today-box');
  await expect(box).toBeVisible();
  await expect(box.locator('li[data-today="returned"]')).toHaveText('Вернули на доработку · 1');
  await expect(box.locator('li[data-today-item="returned"]')).toContainText('Диспетчер: Нет даты осмотра в разделе 3');
  await expect(box.locator('li[data-today-item="hot"]')).toContainText('срок завтра');
  await expect(box.locator('li[data-today-item="offers"]')).toContainText('Вам 12 000 ₽');
  await shot(sp, '97-segodnya-ekspert');
  await box.locator('li[data-today-item="returned"] button').click();
  await expect(sp.locator('#order-title')).toHaveText('Квартира — вернули');

  // Досье эксперта (2.63): полис кончается через 10 дней, аттестат истёк — руководитель видит вид и срок, без номеров.
  await db((c) => c.query(`insert into dossier_items (user_id, kind, title, number, valid_until, amount_kop) values
    ($1, 'policy', 'Тестовое страхование', 'ПОЛ-2063', $2, 30000000), ($1, 'certificate', 'Оценка недвижимости', 'АТТ-2063', $3, null)`,
  [spec.id, inDays(10), inDays(-3)]));

  await hp.goto('/kabinet');
  const hb = hp.locator('#today-box');
  await expect(hb.locator('li.group.org')).toHaveText('Организация: ООО «Оценка Сегодня»');
  await expect(hb.locator(`li[data-today="org-dossier-${orgId}"]`)).toHaveText('Документы экспертов: срок · 2');
  const dl = hb.locator(`li[data-today-item="org-dossier-${orgId}"]`);
  await expect(dl.first()).toContainText('Эксперт Сегодня · Квалификационный аттестат');
  await expect(dl.first()).toContainText('по оценке эксперт снят с подбора');
  await expect(dl.nth(1)).toContainText('Полис страхования оценщика');
  await expect(dl.nth(1)).toContainText(/осталось (9|10) дн\./);   // дата теста — по UTC, «Сегодня» — по Москве
  await expect(hb).not.toContainText('2063');   // номера документов руководителю не показываются
  await expect(hb.locator(`li[data-today="org-sign-${orgId}"]`)).toHaveText('Ждут подписи организации · 1');
  await expect(hb.locator(`li[data-today-item="org-hot-${orgId}"]`).first()).toContainText('Эксперт Сегодня');
  await expect(hb).not.toContainText('Квартира');   // названия заявок (текст заказчика) руководителю не показываются
  await shot(hp, '98-segodnya-rukovoditel');
  await dl.first().scrollIntoViewIfNeeded();
  await shot(hp, '98a-segodnya-dosje-ekspertov');
  await hb.locator(`li[data-today-item="org-sign-${orgId}"] button`).click();
  await expect(hp).toHaveURL(new RegExp(`#org=${orgId}&case=[0-9A-F]{8}&to=sign$`));

  // Заказчику карточка не показывается.
  await page.goto('/kabinet');
  await expect(page.locator('#orders li').first()).toBeVisible();
  await expect(page.locator('#today-box')).toBeHidden();
  void customer;
  for (const c of [dctx, sctx, hctx]) await c.close();
});

// Карточка эксперта (2.35): диспетчер открывает её из подбора, руководитель — из «Дел экспертов»; досье без копий,
// допуски, итоги работы и оценка «качество», история дел без данных заказчика.
test('карточка эксперта (2.35): из подбора у диспетчера и из «Дел экспертов» у руководителя', async ({ page, browser, baseURL }) => {
  const D = '+79990003701', S = '+79990003702', HD = '+79990003703', C = '+79990003704';
  await signIn(page, C);
  const dctx = await phoneContext(browser, baseURL), sctx = await phoneContext(browser, baseURL), hctx = await phoneContext(browser, baseURL);
  const dp = await dctx.newPage(), sp = await sctx.newPage(), hp = await hctx.newPage();
  const disp = await signIn(dp, D), spec = await signIn(sp, S), head = await signIn(hp, HD);
  await sp.request.patch('/api/me', { data: { full_name: 'Эксперт Карточный' }, headers: H });
  let orgId;
  await db(async (c) => {
    await c.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]);
    orgId = (await c.query("insert into organizations (name) values ('ООО «Карточки»') returning id")).rows[0].id;
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head'), ($1, $3, 'member')", [orgId, head.id, spec.id]);
    await c.query('insert into specialists (user_id, org_id) values ($1, $2)', [spec.id, orgId]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [spec.id]);
  });
  expect((await sp.request.post('/api/specialist/me/dossier', { data: { kind: 'certificate', title: 'Оценка недвижимости', number: '055555-1', valid_until: inDays(300) }, headers: H })).status()).toBe(201);
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Квартира для карточки' }, headers: H })).json()).order;
  await page.request.patch(`/api/orders/${o.id}`, { data: { deadline: inDays(8), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, ул. Карточная, 5' } }, headers: H });
  await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H });
  await db((c) => c.query('update orders set price_kop = 1500000, paid_at = now() where id = $1', [o.id]));

  // Диспетчер: в подборе у эксперта — «Карточка эксперта».
  await dp.goto(`/kabinet#order=${o.id}`);
  await dp.locator('#candidates li').filter({ hasText: 'Эксперт Карточный' }).getByRole('link', { name: 'Карточка эксперта' }).click();
  await expect(dp.locator('#expert-name')).toHaveText('Эксперт Карточный');
  await expect(dp.locator('#expert-facts')).toContainText('ООО «Карточки»');
  await expect(dp.locator('#expert-facts')).toContainText('Качество в подборе');
  await expect(dp.locator('#expert-dossier li[data-kind="certificate"]')).toContainText('№ 055555-1');
  await expect(dp.locator('#expert-dossier')).toContainText('копии нет');
  await expect(dp.locator('#expert-permits')).toContainText('Оценка недвижимости');
  await shot(dp, '99-kartochka-eksperta');
  await dp.getByRole('link', { name: '← Назад' }).click();
  await expect(dp.locator('#order-title')).toHaveText('Квартира для карточки');

  // Руководитель: из «Дел экспертов».
  await hp.goto(`/kabinet#org=${orgId}`);
  await hp.locator('#org-cases-load li').filter({ hasText: 'Эксперт Карточный' }).getByRole('link', { name: 'Карточка эксперта' }).click();
  await expect(hp.locator('#expert-name')).toHaveText('Эксперт Карточный');
  await expect(hp.locator('#expert-view')).not.toContainText('Карточная');

  // Заказчик по прямой ссылке — «не найдено».
  await page.goto(`/kabinet#expert=${spec.id}`);
  await expect(page.getByRole('heading', { name: 'Эксперт не найден' })).toBeVisible();
  for (const c of [dctx, sctx, hctx]) await c.close();
});

// Как настоящий заказчик (2.41): исполнитель и диспетчер — через API (их путь проверен в других проверках); заказчик —
// только на экране телефона: от проблемы своими словами до результата и акта.
async function staffFinish({ dp, sp, orderId, specId, price = '15000' }) {
  expect((await dp.request.put(`/api/orders/${orderId}/price`, { data: { price }, headers: H })).status()).toBe(200);
  return async function afterPay() {
    expect((await dp.request.post(`/api/orders/${orderId}/offer`, { data: { specialist_id: specId, from: 'matching' }, headers: H })).status()).toBe(200);
    expect((await sp.request.post(`/api/orders/${orderId}/status`, { data: { from: 'awaiting_executor', to: 'in_work' }, headers: H })).status()).toBe(200);
    const up = await sp.request.post(`/api/orders/${orderId}/results`, { data: Buffer.from('%PDF-1.4 Отчёт об оценке. Итоговая стоимость 1 250 000 руб.'), headers: { ...H, 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('Отчёт об оценке.pdf') } });
    expect(up.status()).toBe(201);
    expect((await sp.request.post(`/api/documents/${(await up.json()).document.id}/sign`, { data: { confirm: true }, headers: H })).status()).toBe(201);
    expect((await sp.request.post(`/api/orders/${orderId}/messages`, { data: { body: 'Отчёт готов, оригинал с подписью — в файле.' }, headers: H })).status()).toBe(201);
    expect((await sp.request.post(`/api/orders/${orderId}/status`, { data: { from: 'in_work', to: 'review' }, headers: H })).status()).toBe(200);
    const rv = await (await dp.request.get(`/api/orders/${orderId}/review`)).json();
    for (const c of rv.checks) expect((await dp.request.put(`/api/orders/${orderId}/review/${c.id}`, { data: { verdict: 'ok', round: rv.round }, headers: H })).status()).toBe(200);
    expect((await dp.request.post(`/api/orders/${orderId}/status`, { data: { from: 'review', to: 'done' }, headers: H })).status()).toBe(200);
  };
}

async function staffFor(browser, baseURL, D, S, service) {
  const dctx = await phoneContext(browser, baseURL), sctx = await phoneContext(browser, baseURL);
  const dp = await dctx.newPage(), sp = await sctx.newPage();
  const disp = await signIn(dp, D), spec = await signIn(sp, S);
  await sp.request.patch('/api/me', { data: { full_name: 'Эксперт Заказчиков' }, headers: H });
  await db(async (c) => {
    await c.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]);
    await c.query('insert into specialists (user_id) values ($1)', [spec.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', $2)", [spec.id, service]);
  });
  return { dp, sp, specId: spec.id, close: async () => { await dctx.close(); await sctx.close(); } };
}

// Заказчик открывает результат, акт и закрывает заявку — общий конец обоих сценариев.
async function customerReceives(page, prefix, customerName) {
  const next = page.locator('#next-box');
  await expect(page.locator('#order-status')).toHaveText('Готово');
  await expect(next).toContainText('Результат готов');
  await expect(next.locator('#next-steps li[data-step="result"]')).toContainText('Скачать результат (1)');
  await next.locator('#next-steps li[data-step="act"] button').click();
  const res = page.locator('#docs li').filter({ hasText: 'Отчёт об оценке.pdf' });
  await expect(res).toContainText('Результат работы');
  const [download] = await Promise.all([page.waitForEvent('download'), res.getByRole('button', { name: 'Скачать' }).click()]);
  expect(download.suggestedFilename()).toBe('Отчёт об оценке.pdf');
  await expect(page.locator('#messages li').first()).toContainText('Отчёт готов');
  await page.locator('#closing li').filter({ hasText: 'Акт' }).getByRole('button', { name: 'Открыть' }).click();
  await expect(page.locator('#closing-doc')).toContainText('Акт об оказании услуг');
  await expect(page.locator('#closing-doc')).toContainText(`Заказчик: ${customerName}`);
  await expect(page.locator('#closing-doc')).toContainText(/Стоимость: 15\s000 ₽/);
  await shot(page, `${prefix}-gotovo`);
  await page.locator('#next-main button', { hasText: 'Принять и закрыть' }).click();
  await expect(page.locator('#order-status')).toHaveText('Закрыта');
  await expect(next).toContainText('Заявка закрыта');
  await expect(page.locator('#closing li')).toHaveCount(1);
  await shot(page, `${prefix}-zakryta`);
}

test('как настоящий заказчик (2.41): частное лицо — ДТП своими словами, помощник, заявка, оплата, отчёт и акт', async ({ page, browser, baseURL }) => {
  const C = '+79990004101', D = '+79990004102', S = '+79990004103';
  const staff = await staffFor(browser, baseURL, D, S, 'vehicle');
  await signIn(page, C);
  await page.request.patch('/api/me', { data: { full_name: 'Тестов Иван Петрович' }, headers: H });
  await page.goto('/kabinet');
  await page.getByRole('link', { name: 'Спросить помощника' }).click();
  await page.getByLabel('Что случилось').fill('Попал в ДТП в Москве, страховая заплатила мало. Хочу доказать, что ремонт машины дороже. Выиграю ли я суд?');
  await page.getByRole('button', { name: 'Разобраться' }).click();
  await expect(page.locator('#pa-steps li').first()).toBeVisible();
  await expect(page.locator('#pa-specialist')).toContainText('Оценка транспортного средства');
  await expect(page.locator('#pa-legal')).toContainText('это вопрос к юристу');
  await expect(page.locator('#pa-disclaimer')).toContainText('не юридическая услуга');
  await shot(page, '102-zakazchik-razbor');
  await page.getByRole('button', { name: 'Создать заявку' }).click();
  await expect(page.locator('#order-status')).toHaveText('Новая');
  const id = new URL(page.url()).hash.match(/^#order=([0-9a-f-]{36})$/i)[1];

  // «Что дальше» говорит, чего не хватает; главная кнопка ведёт к заполнению.
  const next = page.locator('#next-box');
  await expect(next).toContainText('Чтобы отправить заявку, заполните: Вид транспорта, Марка и модель, срок');
  await expect(page.getByLabel('Для чего нужна оценка')).toHaveValue('court');
  await expect(page.getByLabel('Где находится объект')).toHaveValue('moscow');
  await shot(page, '103-zakazchik-chto-dalshe');
  await page.locator('#next-main button', { hasText: 'Заполнить заявку' }).click();
  await page.getByLabel('Вид транспорта').selectOption({ label: 'Легковой автомобиль' });
  await page.getByLabel('Марка и модель').fill('Лада Веста');
  await page.getByLabel('Год выпуска').fill('2019');
  await page.getByLabel('Пробег, км').fill('84500');
  await page.getByLabel(/^Срок/).fill(inDays(10));
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.locator('#details-msg')).toHaveText('Сохранено');
  await expect(next).toContainText('Всё нужное заполнено');
  await page.locator('#next-main button', { hasText: 'Отправить заявку' }).click();
  await expect(page.locator('#order-status')).toHaveText('Подбор исполнителя');
  await expect(next).toContainText('Платформа назначит цену');
  await expect(page.locator('#facts')).toContainText('84 500');
  await expect(page.locator('#facts')).toContainText('2019');

  // Цена назначена — главная кнопка «Оплатить».
  const afterPay = await staffFinish({ ...staff, orderId: id });
  await page.reload();
  await expect(next).toContainText('Цена назначена');
  await shot(page, '104-zakazchik-oplata');
  await page.locator('#next-main button', { hasText: /Оплатить 15\s000 ₽/ }).click();
  await expect(page.locator('#money-facts')).toContainText('оплачено');
  await expect(next).toContainText('Оплачено. Платформа подбирает исполнителя');

  await afterPay();
  await page.reload();
  await customerReceives(page, '105-zakazchik', 'Тестов Иван Петрович');
  await staff.close();
});

test('как настоящий заказчик (2.41): юрист фирмы — заявка от организации по определению суда, руководитель видит, акт на фирму', async ({ page, browser, baseURL }) => {
  const L = '+79990004201', HD = '+79990004202', D = '+79990004203', S = '+79990004204';
  const staff = await staffFor(browser, baseURL, D, S, 'realty');
  const lawyer = await signIn(page, L);
  const hctx = await phoneContext(browser, baseURL);
  const hp = await hctx.newPage();
  const head = await signIn(hp, HD);
  await db(async (c) => {
    const org = (await c.query("insert into organizations (name) values ('ООО «Юрфирма Тест»') returning id")).rows[0].id;
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head'), ($1, $3, 'member')", [org, head.id, lawyer.id]);
  });
  await page.goto('/kabinet');
  await page.reload(); // организация появилась — кабинет перечитывает, кто вошёл
  await page.locator('#new-order').getByLabel('Услуга').selectOption({ label: 'Оценка недвижимости' });
  await page.getByLabel('Коротко: что нужно').fill('Оценка доли в квартире — дело 2-777/2026');
  await page.getByLabel('От чьего имени').selectOption({ label: 'От организации ООО «Юрфирма Тест»' });
  await page.getByRole('button', { name: 'Создать заявку' }).click();
  await expect(page.locator('#order-status')).toHaveText('Новая');
  await expect(page.locator('#order-org-line')).toContainText('Организация: ООО «Юрфирма Тест»');
  const id = new URL(page.url()).hash.match(/^#order=([0-9a-f-]{36})$/i)[1];
  const next = page.locator('#next-box');

  await page.getByLabel('Для чего нужна оценка').selectOption({ label: 'Для суда' });
  await page.getByLabel('Где находится объект').selectOption({ label: 'Москва' });
  await page.getByLabel('Что оцениваем').selectOption({ label: 'Доля в квартире или доме' });
  await page.getByLabel('Адрес объекта').fill('г. Москва, ул. Судебная, д. 3, кв. 12');
  await page.getByLabel('Площадь, кв. м').fill('64,8');
  await page.getByLabel(/^Срок/).fill(inDays(12));
  await page.getByLabel('Основание').selectOption({ label: 'Определение суда' });
  await page.getByLabel(/^Номер определения/).fill('2-777/2026');
  await page.getByLabel(/^Дата определения/).fill(inDays(-5));
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(next).toContainText('заполните: файл определения суда');
  await page.getByLabel('Приложить определение суда').setInputFiles({ name: 'Определение 2-777.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 тестовое определение') });
  await expect(page.getByText('Приложено: Определение 2-777.pdf')).toBeVisible();
  await expect(next).toContainText('Всё нужное заполнено');
  await shot(page, '106-yurist-zayavka');
  await page.locator('#next-main button', { hasText: 'Отправить заявку' }).click();
  await expect(page.locator('#order-status')).toHaveText('Подбор исполнителя');
  await expect(page.locator('#facts')).toContainText('Определение суда, № 2-777/2026');
  await expect(page.locator('#facts')).toContainText('64,8');

  // Руководитель фирмы видит заявку юриста.
  await hp.goto(`/kabinet#order=${id}`);
  await expect(hp.locator('#order-title')).toHaveText('Оценка доли в квартире — дело 2-777/2026');

  const afterPay = await staffFinish({ ...staff, orderId: id });
  await page.reload();
  await page.locator('#next-main button', { hasText: /Оплатить 15\s000 ₽/ }).click();
  await expect(next).toContainText('Оплачено');
  await afterPay();
  await page.reload();
  await customerReceives(page, '107-yurist', 'Организация ООО «Юрфирма Тест»');
  await hctx.close();
  await staff.close();
});

// Как диспетчер (2.42): «Сегодня» диспетчера ведёт по делам — цена, подбор после отказа, молчащий исполнитель, проверка,
// деньги; «Что дальше» в деле — следующий шаг диспетчера. Заказчик и исполнители — через API.
test('как диспетчер (2.42): «Сегодня», цена, подбор после отказа, переназначение, проверка, выплата и её повтор', async ({ page, browser, baseURL }) => {
  const D = '+79990004401', C = '+79990004402', S1 = '+79990004403', S2 = '+79990004404';
  const disp = await signIn(page, D);
  const mk = async (phone, name) => {
    const ctx = await phoneContext(browser, baseURL);
    const p = await ctx.newPage();
    const u = await signIn(p, phone);
    if (name) await p.request.patch('/api/me', { data: { full_name: name }, headers: H });
    return { ctx, p, u };
  };
  const cu = await mk(C), s1 = await mk(S1, 'Эксперт Отказной'), sB = await mk(S2, 'Эксперт Надёжный');
  await db(async (c) => {
    await c.query("update users set platform_role = 'dispatcher', full_name = 'Диспетчер Сегодня' where id = $1", [disp.id]);
    for (const s of [s1, sB]) {
      await c.query('insert into specialists (user_id) values ($1)', [s.u.id]);
      await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [s.u.id]);
    }
  });
  const make = async (title, days) => {
    const o = (await (await cu.p.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title }, headers: H })).json()).order;
    await cu.p.request.patch(`/api/orders/${o.id}`, { data: { deadline: inDays(days), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, ул. Диспетчерская, 5' } }, headers: H });
    expect((await cu.p.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
    return o;
  };
  const main = await make('Квартира на Диспетчерской', 6);
  // Второе дело: предложено больше суток назад, исполнитель молчит.
  const silent = await make('Квартира — исполнитель молчит', 9);
  await db(async (c) => {
    await c.query("update orders set price_kop = 1200000, paid_at = now(), status = 'awaiting_executor', executor_user_id = $2 where id = $1", [silent.id, sB.u.id]);
    await c.query("insert into order_offers (order_id, specialist_id, score, offered_by, offered_at) values ($1, $2, '{}', $3, now() - interval '30 hours')", [silent.id, sB.u.id, disp.id]);
  });

  // 1. «Сегодня»: назначить цену; молчащий исполнитель.
  await page.goto('/kabinet');
  const today = page.locator('#today-box');
  await expect(today.locator('li[data-today-item="d-price"]').filter({ hasText: 'Квартира на Диспетчерской' })).toBeVisible();
  await expect(today.locator('li[data-today-item="d-slow"]').filter({ hasText: 'Квартира — исполнитель молчит' })).toBeVisible();
  await shot(page, '108-dispetcher-segodnya');
  await today.locator('li[data-today-item="d-price"]').filter({ hasText: 'Квартира на Диспетчерской' }).locator('button').click();
  await expect(page.locator('#order-title')).toHaveText('Квартира на Диспетчерской');
  const next = page.locator('#next-box');
  const mainBtn = page.locator('#next-main button');
  await expect(next).toContainText('Назначьте цену');
  await mainBtn.click();
  await expect(page.getByLabel('Цена, рублей')).toBeFocused();
  await page.getByLabel('Цена, рублей').fill('15000');
  await page.getByRole('button', { name: 'Назначить цену' }).click();
  await expect(page.locator('#money-msg')).toHaveText('Цена назначена');
  await expect(next).toContainText('ждём оплаты заказчика');

  // 2. Заказчик оплатил — «К подбору»; первый эксперт отказался — дело снова в «Сегодня» с причиной.
  const pay = await cu.p.request.post(`/api/orders/${main.id}/payments`, { headers: H });
  expect(pay.status()).toBe(201);
  expect((await cu.p.request.post(`/api/orders/${main.id}/payments/refresh`, { headers: H })).status()).toBe(200);
  await page.reload();
  await expect(next).toContainText('Оплачено. Выберите исполнителя');
  await mainBtn.click();
  page.once('dialog', (d) => d.accept());
  await page.locator('#candidates li').filter({ hasText: 'Эксперт Отказной' }).getByRole('button', { name: 'Предложить дело' }).click();
  await expect(page.locator('#order-status')).toHaveText('Ждёт исполнителя');
  await expect(next).toContainText('ждём ответа исполнителя');
  expect((await s1.p.request.post(`/api/orders/${main.id}/status`, { data: { from: 'awaiting_executor', to: 'matching', reason: 'Уезжаю в отпуск' }, headers: H })).status()).toBe(200);
  await page.goto('/kabinet');
  const again = today.locator('li[data-today-item="d-match"]').filter({ hasText: 'Квартира на Диспетчерской' });
  await expect(again).toContainText('Снова в подборе: Уезжаю в отпуск');
  await again.locator('button').click();
  page.once('dialog', (d) => d.accept());
  await page.locator('#candidates li').filter({ hasText: 'Эксперт Надёжный' }).getByRole('button', { name: 'Предложить дело' }).click();
  await expect(page.locator('#order-status')).toHaveText('Ждёт исполнителя');

  // 3. Принял, но не справляется — диспетчер передаёт дело другому с причиной; оплата остаётся, дело снова в подборе.
  expect((await sB.p.request.post(`/api/orders/${main.id}/status`, { data: { from: 'awaiting_executor', to: 'in_work' }, headers: H })).status()).toBe(200);
  await page.reload();
  await expect(next).toContainText('Исполнитель работает');
  await page.getByLabel('Причина (для возврата или отмены)').fill('Эксперт заболел');
  await page.getByRole('button', { name: 'Передать другому исполнителю' }).click();
  await expect(page.locator('#order-status')).toHaveText('Подбор исполнителя');
  await expect(next).toContainText('Оплачено. Выберите исполнителя');
  await page.goto('/kabinet');
  const moved = today.locator('li[data-today-item="d-match"]').filter({ hasText: 'Квартира на Диспетчерской' });
  await expect(moved).toContainText('Снова в подборе: Эксперт заболел');
  await moved.locator('button').click();
  page.once('dialog', (d) => d.accept());
  await page.locator('#candidates li').filter({ hasText: 'Эксперт Отказной' }).getByRole('button', { name: 'Предложить дело' }).click();
  await expect(page.locator('#order-status')).toHaveText('Ждёт исполнителя');

  // 4. Второй принял и сдал — «Сегодня»: ждёт проверки; «Что дальше» ведёт по правилам, затем «Проверено, готово».
  const s2 = s1;
  expect((await s2.p.request.post(`/api/orders/${main.id}/status`, { data: { from: 'awaiting_executor', to: 'in_work' }, headers: H })).status()).toBe(200);
  const up = await s2.p.request.post(`/api/orders/${main.id}/results`, { data: Buffer.from('%PDF-1.4 Отчёт'), headers: { ...H, 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('Отчёт об оценке.pdf') } });
  expect((await s2.p.request.post(`/api/documents/${(await up.json()).document.id}/sign`, { data: { confirm: true }, headers: H })).status()).toBe(201);
  expect((await s2.p.request.post(`/api/orders/${main.id}/status`, { data: { from: 'in_work', to: 'review' }, headers: H })).status()).toBe(200);
  await page.goto('/kabinet');
  const rv = today.locator('li[data-today-item="d-review"]').filter({ hasText: 'Квартира на Диспетчерской' });
  await expect(rv).toBeVisible();
  await rv.locator('button').click();
  await expect(next).toContainText(/Проверьте результат: отметьте каждое правило \(осталось \d+ из \d+\)/);
  await shot(page, '109-dispetcher-proverka');
  const rules = page.locator('#review-checks > li');
  const n = await rules.count();
  for (let i = 0; i < n; i += 1) {
    await rules.nth(i).getByRole('button', { name: 'В порядке' }).click();
    await expect(rules.nth(i).locator('.verdict')).toHaveText('В порядке');
  }
  await expect(next).toContainText('Все правила в порядке');
  await mainBtn.click();
  await expect(page.locator('#order-status')).toHaveText('Готово');
  await expect(next).toContainText('Результат выдан');

  // 5. Выплата не прошла — «Сегодня» → «Деньги» → повтор выплаты.
  await db((c) => c.query("update payouts set status = 'failed', failure = 'тест: банк отклонил' where order_id = $1", [main.id]));
  await page.goto('/kabinet');
  const failed = today.locator('li[data-today-item="d-money"]').filter({ hasText: 'Квартира на Диспетчерской' });
  await expect(failed).toContainText('Выплата исполнителю не прошла: тест: банк отклонил');
  await failed.locator('button').click();
  await page.getByRole('button', { name: 'Повторить выплату' }).click();
  await expect(page.locator('#money-facts')).toContainText(/Выплата исполнителю\s*12\s000 ₽ — выплачено/);
  await page.goto('/kabinet#money');
  await expect(page.locator('#money-payments li').filter({ hasText: 'Квартира на Диспетчерской' })).toContainText(/15\s000 ₽/);
  await shot(page, '110-dispetcher-dengi');
  await page.goto('/kabinet');
  await expect(today.locator('#today-list')).toBeVisible();
  await expect(today.locator('li[data-today-item="d-money"]').filter({ hasText: 'Квартира на Диспетчерской' })).toHaveCount(0);
  for (const x of [cu, s1, sB]) await x.ctx.close();
});

// Остальные виды оценки (2.43) — тот же прогон «как настоящий эксперт», что для транспорта в 2.33: по предложению видно,
// что за объект; подходы; черновик с разделами по порядку; Word; ИИ-проверка находит чужой кадастровый номер и остатки
// отчёта о машине, с 2.59 — чужие площадь, этаж, долю и категорию земель, с 2.60 — веса подходов и аналоги, с 2.61 — покупка и вопросы в выводах товароведческой. Заказчик и диспетчер — через API.
const OTHER_KINDS = [
  { svc: 'realty', name: 'Оценка недвижимости', title: 'Доля в квартире для суда', fields: { purpose: 'court', region: 'moscow', object_type: 'share', address: 'г. Москва, ул. Долевая, 3, кв. 8', cadastral: '77:01:0001001:1234', area: '64.8', floor: '5 / 9', rooms: '3', year_built: '1975', share_size: '1/3' },
    brief: 'Для суда · Москва · Доля в квартире или доме · г. Москва, ул. Долевая, 3, кв. 8 · 77:01:0001001:1234 · 64,8 кв. м', approach: ['Сравнительный', 'Затратный'], sections: ['11. Сравнительный подход: аналоги и корректировки', '12. Затратный подход', '13. Согласование результатов и итоговая величина'],
    report: 'Отчёт об оценке доли в квартире. Кадастровый номер объекта 77:05:0007003:999. Пробег не определялся.\nОбщая площадь 45,1 кв. м\nКвартира на 7 этаже\nДоля 1/4 в праве собственности\nАналог №1 https://ads.example.ru/kv/1\nАналог №2 https://ads.example.ru/kv/1\nСогласование результатов, вес подхода\nСравнительный подход 0,5\nЗатратный подход 0,3',
    finds: ['Кадастровый номер 77:05:0007003:999 не совпадает', '«Пробег» в отчёте об оценке недвижимости', 'Площадь 45,1 кв. м не совпадает с площадью из заявки (64,8 кв. м)', 'Этаж 7 не совпадает с этажом из заявки (5)', 'Доля 1/4 не совпадает с долей из заявки (1/3)',
      // 2.60: веса подходов, аналогов меньше трёх, одна ссылка у двух аналогов.
      'Веса подходов в согласовании в сумме 0,8, а должно быть 1', 'В сравнительном подходе два аналога — нужно не меньше трёх', 'Одна и та же ссылка у аналогов № 1 и № 2'] },
  { svc: 'land', name: 'Оценка земельного участка', title: 'Участок ИЖС для продажи', fields: { purpose: 'deal', region: 'mo', address: 'МО, д. Тестово, уч. 5', cadastral: '50:20:0010101:77', area: '1200', land_use: 'izhs', land_category: 'settlement' },
    brief: 'Купля-продажа · Московская область · МО, д. Тестово, уч. 5 · 50:20:0010101:77 · 1200 кв. м · Под жилой дом (ИЖС)', approach: null, sections: ['11. Сравнительный подход: аналоги и корректировки', '12. Доходный подход', '13. Затратный подход (метод выделения или распределения)'],
    report: 'Отчёт об оценке земельного участка. Кадастровый номер участка 50:20:0010101:88. Автомобиль на фото.\nКатегория земель: земли сельскохозяйственного назначения',
    finds: ['Кадастровый номер 50:20:0010101:88 не совпадает', '«Автомобиль» в отчёте об оценке земельного участка', 'Категория земель «земли сельскохозяйственного назначения» не совпадает с заявкой'] },
  { svc: 'movable', name: 'Оценка движимого имущества', title: 'Станки для залога', fields: { purpose: 'bank', region: 'mo', items: 'Токарный станок 16К20, 1985 г., 2 шт.; фрезерный 6Р82', location: 'МО, г. Тестовск, цех 1' },
    brief: 'Ипотека, залог, банк · Московская область · Токарный станок 16К20, 1985 г., 2 шт.; фрезерный 6Р82 · МО, г. Тестовск, цех 1', approach: ['Сравнительный', 'Затратный'], sections: ['10. Сравнительный подход: аналоги и корректировки', '11. Затратный подход', '12. Согласование результатов и итоговая величина'],
    report: 'Отчёт об оценке оборудования. Объект недвижимости расположен по адресу.', finds: ['«Объект недвижимости» в отчёте о движимом имуществе'] },
  { svc: 'goods', name: 'Товароведческая экспертиза', title: 'Ноутбук не включается', fields: { purpose: 'court', region: 'moscow', subject: 'Ноутбук перестал включаться через месяц после покупки', questions: 'Есть ли недостаток? Производственный или эксплуатационный?', purchase: '12.03.2026, магазин, 54 990 ₽' },
    brief: 'Для суда · Москва · Ноутбук перестал включаться через месяц после покупки · Есть ли недостаток? Производственный или эксплуатационный? · 12.03.2026, магазин, 54 990 ₽', approach: undefined, sections: ['1. Вводная часть: основание, эксперт, предупреждение об ответственности', '2. Вопросы эксперту', '5. Исследование', '7. Выводы'],
    // 2.61: чужие дата и цена покупки, второй вопрос без ответа в выводах.
    report: 'Заключение эксперта по ноутбуку.\nТовар приобретён 01.02.2025, цена по чеку 49 990 руб.\n7. Выводы\nНедостаток имеется: ноутбук не включается.',
    finds: ['Дата покупки 01.02.2025 не совпадает с датой из заявки (12.03.2026)', 'Цена покупки 49 990 ₽ не совпадает с ценой по чеку из заявки (54 990 ₽)', 'Вопрос 2 из заявки не найден в выводах: «Производственный или эксплуатационный?»'] },
];

test('остальные виды оценки (2.43): недвижимость, земля, движимое, товароведческая — как транспорт у эксперта', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const C = '+79990004501', D = '+79990004502', S = '+79990004503';
  await signIn(page, C);
  const dctx = await phoneContext(browser, baseURL), sctx = await phoneContext(browser, baseURL);
  const dp = await dctx.newPage(), sp = await sctx.newPage();
  const disp = await signIn(dp, D), spec = await signIn(sp, S);
  await sp.request.patch('/api/me', { data: { full_name: 'Эксперт Всех Видов' }, headers: H });
  await db(async (c) => {
    await c.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]);
    await c.query('insert into specialists (user_id) values ($1)', [spec.id]);
    for (const k of OTHER_KINDS) await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', $2)", [spec.id, k.svc]);
  });
  let n = 111;
  for (const k of OTHER_KINDS) {
    const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: k.svc, title: k.title }, headers: H })).json()).order;
    expect((await page.request.patch(`/api/orders/${o.id}`, { data: { deadline: inDays(10), fields: k.fields }, headers: H })).status()).toBe(200);
    expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
    expect((await dp.request.put(`/api/orders/${o.id}/price`, { data: { price: '15000' }, headers: H })).status()).toBe(200);
    await page.request.post(`/api/orders/${o.id}/payments`, { headers: H });
    expect((await page.request.post(`/api/orders/${o.id}/payments/refresh`, { headers: H })).status()).toBe(200);
    expect((await dp.request.post(`/api/orders/${o.id}/offer`, { data: { specialist_id: spec.id, from: 'matching' }, headers: H })).status()).toBe(200);

    // По предложению видно, что за объект — и для перечня имущества и товара тоже.
    await sp.goto('/kabinet');
    const offer = sp.locator('#orders li').filter({ hasText: k.title });
    await expect(offer.locator('.brief')).toHaveText(k.brief);
    if (k.svc === 'realty') await shot(sp, `${n++}-vidy-predlozhenie`);
    sp.once('dialog', (d) => d.accept());
    await offer.getByRole('button', { name: 'Принять дело' }).click();
    await expect(sp.locator('#order-status')).toHaveText('В работе');

    if (k.approach !== undefined) {
      await expect(sp.locator('#draft-approaches')).toBeVisible();
      for (const a of k.approach ?? []) {
        // Ждём сохранения именно этой отметки: надпись «Подходы сохранены» уже стоит от предыдущей.
        const saved = sp.waitForResponse((r) => r.url().endsWith(`/api/orders/${o.id}/approaches`) && r.request().method() === 'PUT');
        await sp.locator('#draft-approaches').getByLabel(a).check();
        expect((await saved).status()).toBe(200);
        await expect(sp.locator('#draft-msg')).toHaveText('Подходы сохранены');
      }
    } else {
      await expect(sp.locator('#draft-approaches')).toBeHidden();
    }
    await sp.getByRole('button', { name: 'Подготовить черновик с помощью ИИ' }).click();
    await expect(sp.locator('#draft-msg')).toHaveText('Черновик готов — проверьте и поправьте');
    const body = await sp.getByLabel('Текст заключения').inputValue();
    const titles = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    titles.forEach((t, i) => expect(t.startsWith(`${i + 1}. `), `${k.svc}: «${t}»`).toBe(true));
    for (const s of k.sections) expect(titles).toContain(s);
    await shot(sp, `${n++}-vidy-${k.svc}-chernovik`);
    const [word] = await Promise.all([sp.waitForEvent('download'), sp.getByRole('button', { name: 'Скачать Word' }).click()]);
    expect(word.suggestedFilename()).toMatch(k.svc === 'goods' ? /^Заключение/ : /^Отчёт об оценке/);

    if (k.report) {
      await sp.locator('#result-file').setInputFiles({ name: 'Отчёт.txt', mimeType: 'text/plain', buffer: Buffer.from(k.report) });
      await expect(sp.locator('#doc-msg')).toHaveText('Файл добавлен');
      await sp.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
      await expect(sp.locator('#review-msg')).toHaveText('ИИ-проверка готова');
      for (const f of k.finds) await expect(sp.locator('#review-box')).toContainText(f);
      await shot(sp, `${n++}-vidy-${k.svc}-proverka`);
    }
  }
  await dctx.close();
  await sctx.close();
});

// Все виды уведомлений на телефоне (2.45): каждое событие реестра показывается понятной строкой и ведёт туда, где
// действовать; настройки СМС работают (включил СМС о сообщениях — пришла СМС; выключил — нет).
test('уведомления (2.45): все события на экране и все ведут в нужное место; настройки СМС работают', async ({ page, browser, baseURL }) => {
  const { EVENTS } = await import('../../src/notify/registry.mjs');
  const U = '+79990004601', C = '+79990004602';
  const me = await signIn(page, U);
  const cctx = await phoneContext(browser, baseURL);
  const cp = await cctx.newPage();
  await signIn(cp, C);
  let orgId, orderId;
  await db(async (c) => {
    await c.query("update users set platform_role = 'dispatcher', full_name = 'Все Уведомления' where id = $1", [me.id]);
    await c.query('insert into specialists (user_id) values ($1)', [me.id]);
    orgId = (await c.query("insert into organizations (name) values ('ООО «Тестовые уведомления»') returning id")).rows[0].id;
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head')", [orgId, me.id]);
  });
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Заявка для уведомлений' }, headers: H })).json()).order;
  orderId = o.id;
  await db(async (c) => {
    for (const [id, e] of Object.entries(EVENTS)) {
      await c.query('insert into notifications (user_id, type, event, order_id, org_id) values ($1, $2, $3, $4, $5)',
        [me.id, e.type, id, e.order ? orderId : null, e.section === 'orgs' ? orgId : null]);
    }
  });
  await page.goto('/kabinet#notifications');
  const items = page.locator('#notifications li');
  await expect(items).toHaveCount(Object.keys(EVENTS).length);
  for (const e of Object.values(EVENTS)) await expect(page.locator('#notifications')).toContainText(e.title);
  // Каждая строка — кнопка перехода: никакое уведомление не оставляет человека без ответа «где это».
  await expect(page.locator('#notifications li > button.open')).toHaveCount(Object.keys(EVENTS).length);
  await expect(page.locator('#notifications li').filter({ hasText: EVENTS.org_offer.title })).toContainText('Организация ООО «Тестовые уведомления»');
  await shot(page, '119-uvedomleniya-vse');

  const open = async (title) => {
    await page.goto('/kabinet#notifications');
    await page.locator('#notifications li').filter({ hasText: title }).first().getByRole('button').click();
  };
  await open(EVENTS.dossier_week.title);
  await expect(page).toHaveURL(/#specialist$/);
  await open(EVENTS.org_sign_needed.title);
  await expect(page).toHaveURL(new RegExp(`#org=${orgId}$`));
  await open(EVENTS.dossier_expired_staff.title);
  await expect(page).toHaveURL(/#specialists$/);
  await open(EVENTS.accepted.title);
  await expect(page.locator('#order-title')).toHaveText('Заявка для уведомлений');

  // Настройки: у этого человека — все виды (он и заказчик, и специалист, и диспетчер); СМС о сообщениях по умолчанию нет.
  await page.goto('/kabinet#notifications');
  await expect(page.locator('#notify-types input[type=checkbox]')).toHaveCount(8);
  const msgBox = page.getByLabel('Сообщения в переписке');
  await expect(msgBox).not.toBeChecked();
  const smsCount = async () => (await (await page.request.get('/__test/fakes/sms/calls', { headers: { 'x-test-control': CONTROL } })).json())
    .calls.filter((x) => x.method === 'send' && x.args.phone === U).length;
  // Заказчик пишет — СМС нет (выключено); включили — следующее сообщение приходит СМС; выключили — снова нет.
  const sendFrom = async (p, oid, body) => expect((await p.request.post(`/api/orders/${oid}/messages`, { data: { body }, headers: H })).status()).toBe(201);
  // Сообщение по заявке, где я — исполнитель: заявка заказчика C.
  const co = (await (await cp.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Заявка заказчика' }, headers: H })).json()).order;
  await db((c) => c.query("update orders set status = 'in_work', deadline = current_date + 5, executor_user_id = $2, price_kop = 1000000, paid_at = now() where id = $1", [co.id, me.id]));
  const before = await smsCount();
  await sendFrom(cp, co.id, 'Первое сообщение');
  await page.waitForTimeout(300);
  expect(await smsCount()).toBe(before);
  await msgBox.check();
  await expect(page.locator('#notify-msg')).toHaveText('СМС включены');
  await sendFrom(cp, co.id, 'Второе сообщение');
  await expect.poll(smsCount, { timeout: 10_000 }).toBe(before + 1);
  await msgBox.uncheck();
  await expect(page.locator('#notify-msg')).toHaveText('СМС выключены — уведомления останутся в кабинете');
  await sendFrom(cp, co.id, 'Третье сообщение');
  await page.waitForTimeout(1500);
  expect(await smsCount()).toBe(before + 1);
  await shot(page, '120-uvedomleniya-nastroyki');
  await cctx.close();
});

// Деньги для юрлица (2.46): руководитель фирмы вносит реквизиты; по заявке организации — «Счёт для бухгалтерии (Word)»
// до оплаты; после выдачи — акт файлом Word на организацию; исполнителю — отчёт агента файлом Word.
test('деньги для юрлица (2.46): реквизиты, счёт до оплаты, акт и отчёт агента файлами Word', async ({ page, browser, baseURL }) => {
  const L = '+79990004701', D = '+79990004702', S = '+79990004703';
  const lawyer = await signIn(page, L);
  const staff = await staffFor(browser, baseURL, D, S, 'realty');
  let orgId;
  await db(async (c) => {
    orgId = (await c.query("insert into organizations (name) values ('ООО «Юрфирма Деньги»') returning id")).rows[0].id;
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head')", [orgId, lawyer.id]);
  });
  await page.goto(`/kabinet#org=${orgId}`);
  await page.getByLabel('ИНН организации').fill('7700000000');
  await page.getByLabel('КПП (если есть)').fill('770001001');
  await page.getByLabel('Юридический адрес').fill('г. Москва, ул. Бухгалтерская, 2');
  await page.locator('#org-edit').getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.locator('#org-edit-msg')).toHaveText('Сохранено');
  await shot(page, '121-yurlico-rekvizity');

  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Оценка для арбитража', org_id: orgId }, headers: H })).json()).order;
  expect((await page.request.patch(`/api/orders/${o.id}`, { data: { deadline: inDays(9), fields: { purpose: 'court', region: 'moscow', object_type: 'commercial', address: 'г. Москва, ул. Складская, 4' } }, headers: H })).status()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  const afterPay = await staffFinish({ ...staff, orderId: o.id });
  await page.goto(`/kabinet#order=${o.id}`);
  const inv = page.getByRole('button', { name: 'Счёт для бухгалтерии (Word)' });
  await expect(inv).toBeVisible();
  const [invoice] = await Promise.all([page.waitForEvent('download'), inv.click()]);
  expect(invoice.suggestedFilename()).toMatch(/^Счёт СЧ-[0-9A-F]{8}\.docx$/);
  const read = async (dl) => {
    const chunks = [];
    for await (const ch of await dl.createReadStream()) chunks.push(ch);
    return (await extractPages(Buffer.concat(chunks), 'x.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).pages.join('\n');
  };
  expect(await read(invoice)).toMatch(/Заказчик: ООО «Юрфирма Деньги»\nИНН 7700000000, КПП 770001001/);
  await shot(page, '122-yurlico-schet');
  await page.locator('#next-main button', { hasText: /Оплатить/ }).click();
  await expect(page.locator('#money-facts')).toContainText('оплачено');
  await afterPay();
  await page.reload();
  const actRow = page.locator('#closing li').filter({ hasText: 'Акт' });
  const [act] = await Promise.all([page.waitForEvent('download'), actRow.getByRole('button', { name: 'Word' }).click()]);
  expect(act.suggestedFilename()).toMatch(/^Акт А-\d{6}\.docx$/);
  expect(await read(act)).toMatch(/Заказчик: Организация ООО «Юрфирма Деньги»\nИНН 7700000000, КПП 770001001\nАдрес: г\. Москва, ул\. Бухгалтерская, 2/);
  await shot(page, '123-yurlico-akt');

  // Исполнитель: отчёт агента файлом Word, без имени заказчика.
  await staff.sp.goto(`/kabinet#order=${o.id}`);
  const [rep] = await Promise.all([staff.sp.waitForEvent('download'), staff.sp.locator('#closing li').filter({ hasText: 'Отчёт агента' }).getByRole('button', { name: 'Word' }).click()]);
  const rt = await read(rep);
  expect(rt).toContain('Отчёт агента');
  expect(rt).not.toContain('Юрфирма');
  await staff.close();
});

// Скорость на телефоне (2.49): открытие экранов, отчёт на 50 МБ (прямо в хранилище, с ходом загрузки), 100 фото осмотра.
// Замеры — в test-results/speed.json; пороги — для локального стенда (на площадке — сеть и облако, см. STATE.md).
test('скорость (2.49): экраны, отчёт на 50 МБ, 100 фото осмотра', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const C = '+79990005101', D = '+79990005102', S = '+79990005103';
  const speed = {};
  const ms = async (name, fn) => { const t = Date.now(); await fn(); speed[name] = Date.now() - t; };
  await signIn(page, C);
  const staff = await staffFor(browser, baseURL, D, S, 'realty');
  // 30 заявок у заказчика — список не должен тормозить.
  const ids = [];
  for (let i = 0; i < 30; i += 1) {
    const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: `Квартира №${i + 1}` }, headers: H })).json()).order;
    ids.push(o.id);
  }
  const main = ids[0];
  expect((await page.request.patch(`/api/orders/${main}`, { data: { deadline: inDays(9), fields: { purpose: 'deal', region: 'moscow', object_type: 'house', address: 'МО, д. Скоростная, 1' } }, headers: H })).status()).toBe(200);
  expect((await page.request.post(`/api/orders/${main}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db((c) => c.query('update orders set price_kop = 1500000, paid_at = now() where id = $1', [main]));
  expect((await staff.dp.request.post(`/api/orders/${main}/offer`, { data: { specialist_id: staff.specId, from: 'matching' }, headers: H })).status()).toBe(200);
  expect((await staff.sp.request.post(`/api/orders/${main}/status`, { data: { from: 'awaiting_executor', to: 'in_work' }, headers: H })).status()).toBe(200);

  await ms('список 30 заявок', async () => { await page.goto('/kabinet'); await expect(page.locator('#orders li')).toHaveCount(30); });
  await ms('открыть заявку', async () => { await page.locator('#orders li').filter({ hasText: 'Квартира №1' }).first().locator('button').first().click(); await expect(page.locator('#order-status')).toBeVisible(); await expect(page.locator('#next-box')).toBeVisible(); });

  // 100 фото осмотра владельцем по ссылке (через открытые операции осмотра).
  const link = await (await staff.sp.request.post(`/api/orders/${main}/inspection`, { data: { days: 1 }, headers: H })).json();
  const token = link.path.split('#')[1];
  const steps = (await (await staff.sp.request.get('/api/inspect', { headers: { 'x-inspect-token': token } })).json()).steps.map((s) => s.id);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, ...Buffer.alloc(200 * 1024, 7)]);
  await ms('100 фото осмотра загрузить', async () => {
    for (let i = 0; i < 100; i += 1) {
      const r = await staff.sp.request.post('/api/inspect/photos', { data: jpeg, headers: { ...H, 'content-type': 'image/jpeg', 'x-inspect-token': token, 'x-step': steps[i % steps.length], 'x-shot-at': new Date().toISOString() } });
      expect(r.status(), `фото ${i + 1}`).toBe(201);
    }
  });
  await ms('дело эксперта со 100 фото', async () => {
    await staff.sp.goto(`/kabinet#order=${main}`);
    await expect(staff.sp.locator('#order-status')).toHaveText('В работе');
    const group = staff.sp.locator('#docs li[data-group="inspection"]');
    await expect(group.locator('summary')).toHaveText('Фото осмотра: 100 — показать');
    await expect(group.locator('li.doc')).toHaveCount(100);
  });
  await shot(staff.sp, '124-skorost-100-foto');
  const h = await staff.sp.evaluate(() => document.documentElement.scrollHeight);
  expect(h, 'страница дела со 100 фото не уходит на десятки экранов').toBeLessThan(915 * 12);

  // Отчёт на 50 МБ — прямо в хранилище, на экране — ход загрузки в процентах.
  // Playwright передаёт в браузер больше 50 МБ только файлом с диска.
  const bigPath = 'test-results/Отчёт об оценке.pdf';
  fs.writeFileSync(bigPath, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(50 * 1024 * 1024, 32)]));
  await ms('отчёт 50 МБ загрузить', async () => {
    await staff.sp.locator('#result-file').setInputFiles(bigPath);
    await expect(staff.sp.locator('#doc-msg')).toHaveText('Файл добавлен', { timeout: 60_000 });
  });
  await expect(staff.sp.locator('#docs li').filter({ hasText: 'Отчёт об оценке.pdf' })).toContainText('50,0 МБ');
  await ms('Word черновика с фото', async () => {
    await staff.sp.getByRole('button', { name: 'Подготовить черновик с помощью ИИ' }).click();
    await expect(staff.sp.locator('#draft-msg')).toHaveText('Черновик готов — проверьте и поправьте');
    const [w] = await Promise.all([staff.sp.waitForEvent('download'), staff.sp.getByRole('button', { name: 'Скачать Word' }).click()]);
    expect(w.suggestedFilename()).toMatch(/\.docx$/);
  });
  fs.writeFileSync('test-results/speed.json', JSON.stringify(speed, null, 2));
  console.log('Скорость, мс:', JSON.stringify(speed));
  expect(speed['список 30 заявок']).toBeLessThan(3000);
  expect(speed['открыть заявку']).toBeLessThan(3000);
  expect(speed['дело эксперта со 100 фото']).toBeLessThan(5000);
  await staff.close();
});

test('передача дела (2.62): руководитель передаёт дело в работе другому эксперту, прежний теряет доступ, новый видит переписку', async ({ page, browser, baseURL }) => {
  await signIn(page, '+79990000770');
  const created = await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Квартира: передача дела' }, headers: H })).json();
  const id = created.order.id;
  expect((await page.request.patch(`/api/orders/${id}`, {
    data: { deadline: inDays(7), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, Передаточная ул., 5', area: '44' } }, headers: H,
  })).status()).toBe(200);
  expect((await page.request.post(`/api/orders/${id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  const hctx = await phoneContext(browser, baseURL);
  const hp = await hctx.newPage();
  const head = await signIn(hp, '+79990000771');
  const actx = await phoneContext(browser, baseURL);
  const ap = await actx.newPage();
  const first = await signIn(ap, '+79990000772');
  const bctx = await phoneContext(browser, baseURL);
  const bp = await bctx.newPage();
  const second = await signIn(bp, '+79990000773');
  const orgId = await db(async (c) => {
    const { rows: [org] } = await c.query("insert into organizations (name) values ('ООО «Тестовое бюро передачи»') returning id");
    await c.query("update users set full_name = 'Эксперт Заболевший' where id = $1", [first.id]);
    await c.query("update users set full_name = 'Эксперт Сменщик' where id = $1", [second.id]);
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head'), ($1, $3, 'member'), ($1, $4, 'member')", [org.id, head.id, first.id, second.id]);
    for (const u of [first.id, second.id]) {
      await c.query('insert into specialists (user_id, org_id) values ($1, $2)', [u, org.id]);
      await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [u]);
    }
    await c.query('update orders set price_kop = 1500000, paid_at = now(), status = $2, executor_user_id = $3 where id = $1', [id, 'in_work', first.id]);
    return org.id;
  });
  // Прежний эксперт успел написать заказчику.
  expect((await ap.request.post(`/api/orders/${id}/messages`, { data: { body: 'Осмотр назначен на пятницу' }, headers: H })).status()).toBe(201);

  // Руководитель: у дела в работе — «Передать другому эксперту»; без причины не передать.
  await hp.goto(`/kabinet#org=${orgId}`);
  const row = hp.locator('#org-cases > li').first();
  await expect(row).toContainText('В работе · эксперт: Эксперт Заболевший');
  await row.locator('[data-transfer] summary').click();
  await expect(row.locator('[data-transfer] select option')).toHaveText(['Эксперт Сменщик']);
  await row.getByRole('button', { name: 'Передать дело' }).click();
  await expect(row.locator('[data-transfer] .msg')).toHaveText('Укажите причину');
  await row.getByLabel(/Причина передачи дела/).fill('Эксперт заболел на две недели');
  await row.locator('[data-transfer]').scrollIntoViewIfNeeded();
  await shot(hp, '99e-rukovoditel-peredacha-dela');
  await row.getByRole('button', { name: 'Передать дело' }).click();
  await expect(hp.locator('#org-cases-msg')).toHaveText('Дело передано — новый эксперт получил уведомление');
  await expect(hp.locator('#org-cases > li').first()).toContainText('В работе · эксперт: Эксперт Сменщик');

  // Новый эксперт: уведомление ведёт в дело; переписка прежнего эксперта на месте.
  await bp.goto('/kabinet#notifications');
  const note = bp.locator('#notifications li').filter({ hasText: 'Руководитель организации передал Вам дело в работе' });
  await expect(note).toHaveCount(1);
  await bp.goto(`/kabinet#order=${id}`);
  await expect(bp.locator('#order-status')).toHaveText('В работе');
  await expect(bp.locator('#chat-box')).toContainText('Осмотр назначен на пятницу');
  await shot(bp, '99f-novyj-ekspert-delo');

  // Прежний эксперт: уведомление без перехода в дело; само дело — «не найдено».
  await ap.goto('/kabinet#notifications');
  await expect(ap.locator('#notifications li').filter({ hasText: 'передал Ваше дело другому эксперту' })).toHaveCount(1);
  await shot(ap, '99g-prezhnij-ekspert-uvedomlenie');
  await ap.goto(`/kabinet#order=${id}`);
  await expect(ap.getByRole('heading', { name: 'Заявка не найдена' })).toBeVisible();

  // Заказчик: имени эксперта и передачи не видит, дело в работе.
  await page.goto(`/kabinet#order=${id}`);
  await expect(page.locator('#order-status')).toHaveText('В работе');
  await expect(page.locator('#order-view')).not.toContainText('Сменщик');
  await expect(page.locator('#order-view')).not.toContainText('заболел');
  await hctx.close();
  await actx.close();
  await bctx.close();
});

test('переназначение до ответа (2.76): эксперт молчит — руководитель предлагает дело другому или забирает назад', async ({ page, browser, baseURL }) => {
  await signIn(page, '+79990000774');
  const created = await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Квартира: эксперт молчит' }, headers: H })).json();
  const id = created.order.id;
  expect((await page.request.patch(`/api/orders/${id}`, {
    data: { deadline: inDays(7), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, Тихая ул., 2', area: '38' } }, headers: H,
  })).status()).toBe(200);
  expect((await page.request.post(`/api/orders/${id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  const hctx = await phoneContext(browser, baseURL);
  const hp = await hctx.newPage();
  const head = await signIn(hp, '+79990000775');
  const actx = await phoneContext(browser, baseURL);
  const ap = await actx.newPage();
  const silent = await signIn(ap, '+79990000776');
  const bctx = await phoneContext(browser, baseURL);
  const bp = await bctx.newPage();
  const quick = await signIn(bp, '+79990000777');
  const orgId = await db(async (c) => {
    const { rows: [org] } = await c.query(`insert into organizations (name) values ('ООО «Бюро без ожидания ${Date.now()}»') returning id`);
    await c.query("update users set full_name = 'Эксперт Молчащий' where id = $1", [silent.id]);
    await c.query("update users set full_name = 'Эксперт Быстрый' where id = $1", [quick.id]);
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head'), ($1, $3, 'member'), ($1, $4, 'member')", [org.id, head.id, silent.id, quick.id]);
    for (const u of [silent.id, quick.id]) {
      await c.query('insert into specialists (user_id, org_id) values ($1, $2)', [u, org.id]);
      await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [u]);
    }
    // Диспетчер предложил дело организации, руководитель назначил эксперта — тот не отвечает уже сутки.
    await c.query('update orders set price_kop = 1500000, paid_at = now(), status = $2, offer_org_id = $3, executor_user_id = $4 where id = $1', [id, 'awaiting_executor', org.id, silent.id]);
    await c.query(`insert into order_offers (order_id, org_id, score, outcome, outcome_at) values ($1, $2, '{"org":true}', 'accepted', now())`, [id, org.id]);
    await c.query(`insert into order_offers (order_id, specialist_id, org_id, score, offered_by, offered_at) values ($1, $2, $3, '{}', $4, now() - interval '26 hours')`, [id, silent.id, org.id, head.id]);
    return org.id;
  });

  // Руководитель: у дела видно, что эксперт молчит больше суток; «Не ждать ответа — переназначить».
  await hp.goto(`/kabinet#org=${orgId}`);
  const row = hp.locator('#org-cases > li').filter({ hasText: 'эксперт: Эксперт Молчащий' });
  await expect(row.locator('[data-role="offer-wait"]')).toContainText('Эксперт ещё не ответил · предложено');
  await expect(row.locator('[data-role="offer-wait"]')).toContainText('(1 дн.)');
  await row.locator('[data-reassign] summary').click();
  await expect(row.locator('[data-reassign] select option')).toHaveText(['Эксперт Быстрый']);
  await row.locator('[data-reassign]').scrollIntoViewIfNeeded();
  await shot(hp, 'a1-rukovoditel-pereznachit-do-otveta');
  await row.getByRole('button', { name: 'Предложить другому' }).click();
  await expect(hp.locator('#org-cases-msg')).toHaveText('Дело предложено другому эксперту — прежний получил уведомление, что отвечать не нужно');
  const row2 = hp.locator('#org-cases > li').filter({ hasText: 'эксперт: Эксперт Быстрый' });
  await expect(row2.locator('[data-role="offer-wait"]')).toContainText('(меньше часа)');

  // Прежний эксперт: уведомление «отвечать не нужно», дела больше нет.
  await ap.goto('/kabinet#notifications');
  await expect(ap.locator('#notifications li').filter({ hasText: 'снял предложенное Вам дело — отвечать не нужно' })).toHaveCount(1);
  await shot(ap, 'a2-prezhnij-ekspert-otvechat-ne-nuzhno');
  await ap.goto(`/kabinet#order=${id}`);
  await expect(ap.getByRole('heading', { name: 'Заявка не найдена' })).toBeVisible();
  // Новый эксперт: предложение по делу пришло.
  await bp.goto('/kabinet#notifications');
  await expect(bp.locator('#notifications li').filter({ hasText: 'Вам предложено новое дело' })).toHaveCount(1);

  // Руководитель передумал — забирает назад: дело снова в «Ждут назначения».
  await row2.locator('[data-reassign] summary').click();
  await row2.getByRole('button', { name: 'Забрать назад' }).click();
  await expect(hp.locator('#org-pending-msg')).toHaveText('Дело снова в «Ждут назначения» — эксперту сообщили, что отвечать не нужно');
  await expect(hp.locator('#org-pending > li')).toHaveCount(1);
  await expect(hp.locator('#org-cases-msg')).toHaveText('');
  await expect(hp.locator('#org-cases > li').filter({ hasText: 'Квартира' })).toHaveCount(0);
  await hp.locator('#org-pending-box').scrollIntoViewIfNeeded();
  await shot(hp, 'a3-rukovoditel-zabral-nazad');
  await hctx.close();
  await actx.close();
  await bctx.close();
});

test('«не принимаю новые дела до …» (2.77): эксперт ставит отметку — руководитель видит до какого дня, назначить нельзя', async ({ page, browser, baseURL }) => {
  await signIn(page, '+79990000785');
  const created = await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Квартира: эксперт в отпуске' }, headers: H })).json();
  const id = created.order.id;
  expect((await page.request.patch(`/api/orders/${id}`, {
    data: { deadline: inDays(9), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, Отпускная ул., 3', area: '41' } }, headers: H,
  })).status()).toBe(200);
  expect((await page.request.post(`/api/orders/${id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  const ectx = await phoneContext(browser, baseURL);
  const ep = await ectx.newPage();
  const expert = await signIn(ep, '+79990000786');
  const hctx = await phoneContext(browser, baseURL);
  const hp = await hctx.newPage();
  const head = await signIn(hp, '+79990000787');
  const orgId = await db(async (c) => {
    const { rows: [org] } = await c.query(`insert into organizations (name) values ('ООО «Бюро в отпуске ${Date.now()}»') returning id`);
    await c.query("update users set full_name = 'Эксперт Отпускной' where id = $1", [expert.id]);
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head'), ($1, $3, 'member')", [org.id, head.id, expert.id]);
    await c.query('insert into specialists (user_id, org_id) values ($1, $2)', [expert.id, org.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [expert.id]);
    // Диспетчер предложил дело организации — эксперта назначит руководитель.
    await c.query('update orders set price_kop = 1500000, paid_at = now(), status = $2, offer_org_id = $3 where id = $1', [id, 'awaiting_executor', org.id]);
    await c.query(`insert into order_offers (order_id, org_id, score) values ($1, $2, '{"org":true}')`, [id, org.id]);
    return org.id;
  });

  // Эксперт: отпуск до дня через 10 дней.
  const back = inDays(10);
  await ep.goto('/kabinet#specialist');
  await expect(ep.locator('#specialist-away-form')).toBeVisible();
  await ep.locator('#specialist-away-set').click();
  await expect(ep.locator('#specialist-msg')).toHaveText('Укажите день, с которого снова принимаете дела');
  await ep.locator('#specialist-away-until').fill(back);
  await ep.locator('#specialist-away-note').fill('отпуск');
  await ep.locator('#specialist-away-box').scrollIntoViewIfNeeded();
  await shot(ep, 'a4-ekspert-ne-prinimayu-do');
  await ep.locator('#specialist-away-set').click();
  await expect(ep.locator('#specialist-msg')).toContainText('Новые дела не будут предлагать до');
  await expect(ep.locator('#specialist-away-now')).toContainText('Вы не принимаете новые дела до');
  await expect(ep.locator('#specialist-away-now')).toContainText('(отпуск)');
  await expect(ep.locator('#specialist-away-form')).toBeHidden();
  await expect(ep.locator('#specialist-away-clear')).toBeVisible();
  await shot(ep, 'a5-ekspert-otmetka-stoit');

  // Руководитель: уведомление; в «Ждут назначения» назначить некого и видно почему; в нагрузке — до какого дня.
  await hp.goto('/kabinet#notifications');
  await expect(hp.locator('#notifications li').filter({ hasText: 'не принимает новые дела до указанного дня' })).toHaveCount(1);
  await hp.goto(`/kabinet#org=${orgId}`);
  const pending = hp.locator('#org-pending > li');
  await expect(pending).toHaveCount(1);
  await expect(pending.getByText('Свободных экспертов с допуском на эту услугу нет.')).toBeVisible();
  await expect(pending.locator('[data-away]')).toContainText('Эксперт Отпускной не принимает новые дела до');
  await expect(pending.locator('[data-away]')).toContainText('(отпуск)');
  await expect(hp.locator('#org-cases-load li [data-away]')).toContainText('Не принимает новые дела до');
  await hp.locator('#org-pending-box').scrollIntoViewIfNeeded();
  await shot(hp, 'a6-rukovoditel-vidit-otpusk');

  // Эксперт вернулся раньше — снимает отметку; руководитель снова может назначить.
  await ep.locator('#specialist-away-clear').click();
  await expect(ep.locator('#specialist-msg')).toHaveText('Теперь Вам снова предлагают дела');
  await expect(ep.locator('#specialist-away-form')).toBeVisible();
  await hp.reload();
  await expect(hp.locator('#org-pending > li [data-pick] option')).toHaveCount(1);
  await expect(hp.locator('#org-pending > li [data-away]')).toHaveCount(0);
  await ectx.close();
  await hctx.close();
});

test('запрос документов (2.64): эксперт отмечает недостающие, заказчик загружает к каждому, эксперт видит отметки', async ({ page, browser, baseURL }) => {
  await signIn(page, '+79990000780');
  const created = await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Квартира: нужны документы' }, headers: H })).json();
  const id = created.order.id;
  expect((await page.request.patch(`/api/orders/${id}`, {
    data: { deadline: inDays(7), fields: { purpose: 'bank', region: 'moscow', object_type: 'flat', address: 'г. Москва, Документная ул., 9', area: '48' } }, headers: H,
  })).status()).toBe(200);
  expect((await page.request.post(`/api/orders/${id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  const ectx = await phoneContext(browser, baseURL);
  const ep = await ectx.newPage();
  const expert = await signIn(ep, '+79990000781');
  await db(async (c) => {
    await c.query('insert into specialists (user_id) values ($1)', [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [expert.id]);
    await c.query("update orders set price_kop = 1500000, paid_at = now(), status = 'in_work', executor_user_id = $2 where id = $1", [id, expert.id]);
  });

  // Эксперт: список документов по оценке квартиры, свой документ строкой и пояснение — одной кнопкой.
  await ep.goto(`/kabinet#order=${id}`);
  const box = ep.locator('#docreq-box');
  await expect(box).toBeVisible();
  await expect(box.locator('#docreq-items')).toContainText('Выписка из ЕГРН');
  await expect(box.locator('#docreq-items')).not.toContainText('ПТС');
  await box.getByRole('button', { name: 'Запросить у заказчика' }).click();
  await expect(ep.locator('#docreq-msg')).toHaveText('Отметьте документы или напишите, какой нужен');
  await box.getByLabel('Выписка из ЕГРН').check();
  await box.getByLabel('Технический паспорт БТИ или поэтажный план').check();
  await box.getByLabel(/Другие документы/).fill('Справка об отсутствии долгов за квартиру');
  await box.getByLabel(/Пояснение для заказчика/).fill('Выписку — не старше месяца');
  await box.locator('#docreq-form').scrollIntoViewIfNeeded();
  await shot(ep, '99h-ekspert-zapros-dokumentov');
  await box.getByRole('button', { name: 'Запросить у заказчика' }).click();
  await expect(ep.locator('#docreq-msg')).toHaveText('Запрошено документов: 3. Заказчику отправлено уведомление.');
  await expect(box.locator('#docreq-list li')).toHaveCount(3);
  await expect(box.getByLabel('Выписка из ЕГРН')).toBeDisabled();
  // Справка больше не нужна — снимает.
  await box.locator('#docreq-list li').filter({ hasText: 'Справка об отсутствии долгов' }).getByRole('button', { name: 'Не нужен' }).click();
  await expect(box.locator('#docreq-list li')).toHaveCount(2);

  // Заказчик: уведомление ведёт в заявку; список с отметками «нужен», загрузка файла к выписке.
  await page.goto('/kabinet#notifications');
  await page.locator('#notifications li').filter({ hasText: 'Исполнитель просит документы' }).first().getByRole('button').click();
  await expect(page.locator('#order-title')).toHaveText('Квартира: нужны документы');
  const cbox = page.locator('#docreq-box');
  await expect(cbox.locator('#docreq-lead')).toHaveText('Исполнитель просит документы: осталось загрузить 2. Нажмите «Загрузить файл» у каждого.');
  await expect(cbox.locator('#docreq-form')).toBeHidden();
  const egrn = cbox.locator('#docreq-list li').filter({ hasText: 'Выписка из ЕГРН' });
  await expect(egrn).toContainText('Пояснение: Выписку — не старше месяца');
  await expect(egrn.locator('.badge')).toHaveText('нужен');
  await cbox.scrollIntoViewIfNeeded();
  await shot(page, '99i-zakazchik-zaproshennye-dokumenty');
  await egrn.locator('input[type=file]').setInputFiles({ name: 'Выписка ЕГРН.pdf', mimeType: 'application/pdf', buffer: makePdf([['Выписка из ЕГРН (тест)']]) });
  await expect(page.locator('#docreq-msg')).toHaveText('«Выписка из ЕГРН»: файл получен, исполнитель увидит его в деле');
  await expect(egrn.locator('.badge')).toHaveText('получен');
  await expect(egrn).toContainText('Получено: Выписка ЕГРН.pdf');
  await expect(page.locator('#docs')).toContainText('Выписка ЕГРН.pdf');
  await expect(cbox.locator('#docreq-lead')).toHaveText('Исполнитель просит документы: осталось загрузить 1. Нажмите «Загрузить файл» у каждого.');
  await shot(page, '99j-zakazchik-dokument-zagruzhen');

  // Эксперт: уведомление и отметка «получен», файл в документах дела.
  await ep.goto('/kabinet#notifications');
  await expect(ep.locator('#notifications li').filter({ hasText: 'Заказчик загрузил запрошенный документ' })).toHaveCount(1);
  await ep.goto(`/kabinet#order=${id}`);
  await expect(ep.locator('#docreq-lead')).toHaveText('Получено 1 из 2. Заказчику пришло уведомление; файлы появятся и в «Документах».');
  await expect(ep.locator('#docreq-list li').filter({ hasText: 'Выписка из ЕГРН' }).locator('.badge')).toHaveText('получен');
  await expect(ep.locator('#docs')).toContainText('Выписка ЕГРН.pdf');
  await ep.locator('#docreq-box').scrollIntoViewIfNeeded();
  await shot(ep, '99k-ekspert-dokumenty-polucheny');
  await ectx.close();
});

test('черновик по своему прошлому делу (2.65): эксперт берёт методические разделы, данные прошлого дела — пометками', async ({ page, browser, baseURL }) => {
  await signIn(page, '+79990000790');
  const make = async (title, address) => {
    const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title }, headers: H })).json()).order;
    expect((await page.request.patch(`/api/orders/${o.id}`, {
      data: { deadline: inDays(7), fields: { purpose: 'bank', region: 'moscow', object_type: 'flat', address, area: '48' } }, headers: H,
    })).status()).toBe(200);
    expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
    return o.id;
  };
  const pastId = await make('Прошлая квартира', 'г. Москва, Прошлая ул., 1');
  const id = await make('Новая квартира', 'г. Москва, Новая ул., 2');
  const ectx = await phoneContext(browser, baseURL);
  const ep = await ectx.newPage();
  const expert = await signIn(ep, '+79990000791');
  await db(async (c) => {
    await c.query('insert into specialists (user_id) values ($1)', [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [expert.id]);
    await c.query("update orders set price_kop = 1500000, paid_at = now(), status = 'in_work', executor_user_id = $2 where id = any($1)", [[pastId, id], expert.id]);
  });
  // Прошлое дело: свой черновик с методикой и данными того заказчика.
  const past = [
    '## 4. Стандарты оценки и заявление о соответствии', 'Оценка по 135-ФЗ, ФСО I–VI и ФСО № 7; стандарты СРО «Тестовая СРО».',
    '## 5. Допущения и ограничительные условия', 'Квартира по адресу г. Москва, Прошлая ул., 1 осмотрена по фото; стоимость 9 100 000 руб. без обременений.',
    '## 10. Выбор подходов к оценке', 'Применён сравнительный подход: рынок квартир развит.',
  ].join('\n');
  expect((await ep.request.put(`/api/orders/${pastId}/draft`, { data: { body: past }, headers: H })).status()).toBe(200);

  await ep.goto(`/kabinet#order=${id}`);
  const box = ep.locator('#draft-past');
  await expect(box).toBeVisible();
  await expect(ep.locator('#draft-past-hint')).toContainText('«Стандарты оценки и заявление о соответствии»');
  await expect(ep.locator('#draft-past-case option')).toHaveCount(1);
  await expect(ep.locator('#draft-past-case')).not.toContainText('Прошлая');
  await box.scrollIntoViewIfNeeded();
  await shot(ep, '99l-ekspert-razdely-iz-proshlogo-dela');
  await box.getByRole('button', { name: 'Взять разделы из этого дела' }).click();
  await expect(ep.locator('#draft-msg')).toHaveText(/^Взято разделов: 3; данных прошлого дела убрано: \d+ — заполните пометки$/);
  await expect(ep.locator('#draft-state')).toContainText('Методические разделы взяты из Вашего прошлого дела');
  const text = await ep.getByLabel('Текст заключения').inputValue();
  expect(text).toContain('Оценка по 135-ФЗ, ФСО I–VI и ФСО № 7');
  expect(text).toContain('Применён сравнительный подход');
  expect(text).not.toContain('Прошлая ул');
  expect(text).not.toContain('9 100 000');
  expect(text).toContain('[заполнить: данные этого дела]');
  expect(text).toContain('## 7. Описание объекта оценки\n[заполнить: раздел по этому делу]');
  await ep.locator('#draft-edit').scrollIntoViewIfNeeded();
  await shot(ep, '99m-ekspert-chernovik-iz-proshlogo-dela');
  // Заказчик черновика и прошлого дела не видит.
  await page.goto(`/kabinet#order=${id}`);
  await expect(page.locator('#order-status')).toHaveText('В работе');
  await expect(page.locator('#draft-box')).toBeHidden();
  await ectx.close();
});

// Прогон «как эксперт» по оценке квартиры (2.66) — как 2.33 для транспорта: заказчик и диспетчер — через API, эксперт —
// только на экране телефона. Проверяется то, что мешало: в предложении площадь без единиц; в списке документов для
// сделки — «Определение суда»; запрошенные документы не видны в «Что дальше»; ИИ не брал из объявления адрес, этаж и
// тип дома; с одним подходом эксперт сам вписывал вес 1; в таблице задания «54.3»; после черновика главная кнопка звала
// загружать файл, хотя файл — из черновика.
test('как эксперт (2.66): квартира для сделки — документы, осмотр, аналоги, черновик, сдача', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const C = '+79990006601', D = '+79990006602', S = '+79990006603';
  await signIn(page, C);
  const dctx = await phoneContext(browser, baseURL), sctx = await phoneContext(browser, baseURL);
  const dp = await dctx.newPage(), sp = await sctx.newPage();
  const disp = await signIn(dp, D), spec = await signIn(sp, S);
  await sp.request.patch('/api/me', { data: { full_name: 'Оценщиков Олег Олегович' }, headers: H });
  await db(async (c) => {
    await c.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]);
    await c.query('insert into specialists (user_id) values ($1)', [spec.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [spec.id]);
  });
  const title = `Квартира для продажи ${Date.now()}`;
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title }, headers: H })).json()).order;
  expect((await page.request.patch(`/api/orders/${o.id}`, { data: { deadline: inDays(7), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, ул. Тестовая, 12, кв. 45', cadastral: '77:02:0004005:6789', area: '54.3', floor: '7 / 12', rooms: '2', year_built: '1986' } }, headers: H })).status()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  expect((await dp.request.put(`/api/orders/${o.id}/price`, { data: { price: '12000' }, headers: H })).status()).toBe(200);
  await page.request.post(`/api/orders/${o.id}/payments`, { headers: H });
  expect((await page.request.post(`/api/orders/${o.id}/payments/refresh`, { headers: H })).status()).toBe(200);
  expect((await dp.request.post(`/api/orders/${o.id}/offer`, { data: { specialist_id: spec.id, from: 'matching' }, headers: H })).status()).toBe(200);

  // 1. Предложение: площадь — с единицами.
  await sp.goto('/kabinet');
  const offer = sp.locator('#orders li').filter({ hasText: title });
  await expect(offer.locator('.brief')).toHaveText('Купля-продажа · Москва · Квартира · г. Москва, ул. Тестовая, 12, кв. 45 · 77:02:0004005:6789 · 54,3 кв. м');
  sp.once('dialog', (d) => d.accept());
  await offer.getByRole('button', { name: 'Принять дело' }).click();
  await expect(sp.locator('#order-status')).toHaveText('В работе');

  // 2. «Что дальше» — шаг «Документы от заказчика»; в списке для сделки нет определения суда.
  const docsStep = sp.locator('#next-steps li[data-step="docs"]');
  await expect(docsStep).toContainText('○ Документы от заказчика (по желанию)');
  await shot(sp, '99n-kvartira-chto-dalshe');
  await docsStep.locator('button').click();
  const box = sp.locator('#docreq-box');
  await expect(box.locator('#docreq-items')).toContainText('Выписка из ЕГРН');
  await expect(box.locator('#docreq-items')).not.toContainText('Определение суда');
  await box.getByLabel('Выписка из ЕГРН').check();
  await box.getByLabel('Технический паспорт БТИ или поэтажный план').check();
  await box.getByRole('button', { name: 'Запросить у заказчика' }).click();
  await expect(sp.locator('#docreq-msg')).toHaveText('Запрошено документов: 2. Заказчику отправлено уведомление.');
  await expect(docsStep).toContainText('○ Документы от заказчика (получено 0 из 2)');
  // Заказчик загружает выписку; техпаспорта нет — эксперт снимает просьбу; шаг закрыт.
  await page.goto(`/kabinet#order=${o.id}`);
  const egrn = page.locator('#docreq-list li').filter({ hasText: 'Выписка из ЕГРН' });
  await egrn.locator('input[type=file]').setInputFiles({ name: 'Выписка ЕГРН.pdf', mimeType: 'application/pdf', buffer: makePdf([['Выписка из ЕГРН (тест)']]) });
  await expect(egrn.locator('.badge')).toHaveText('получен');
  await sp.reload();
  await expect(docsStep).toContainText('○ Документы от заказчика (получено 1 из 2)');
  await box.locator('#docreq-list li').filter({ hasText: 'Технический паспорт' }).getByRole('button', { name: 'Не нужен' }).click();
  await expect(docsStep).toContainText('✓ Документы от заказчика (получено 1 из 1)');

  // 3. Подходы — только сравнительный.
  await sp.locator('#next-steps li[data-step="approaches"] button').click();
  await sp.locator('#draft-approaches').getByLabel('Сравнительный').check();
  await expect(sp.locator('#draft-msg')).toHaveText('Подходы сохранены');

  // 4. Осмотр по ссылке: владелец снимает квартиру.
  await sp.getByRole('button', { name: 'Выдать ссылку владельцу' }).click();
  await expect(sp.locator('#inspect-url')).toContainText('http');
  const url = await sp.locator('#inspect-url').textContent();
  const jpeg = Buffer.from((await sp.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 640; c.height = 480;
    const g = c.getContext('2d'); g.fillStyle = '#c9b48a'; g.fillRect(0, 0, 640, 480);
    return c.toDataURL('image/jpeg', 0.8);
  })).split(',')[1], 'base64');
  const octx = await phoneContext(browser, baseURL, { permissions: ['geolocation'], geolocation: { latitude: 55.75, longitude: 37.61, accuracy: 10 } });
  const op = await octx.newPage();
  await op.goto(url);
  await op.getByRole('button', { name: 'Начать: разрешить определение места' }).click();
  await expect(op.locator('#geo-state')).toContainText('Место определено');
  for (const st of ['facade', 'entrance', 'door', 'rooms', 'kitchen', 'bathroom', 'window_view', 'surroundings']) {
    await op.locator(`#steps li[data-step="${st}"] input[type=file]`).setInputFiles({ name: `${st}.jpg`, mimeType: 'image/jpeg', buffer: jpeg });
    await expect(op.locator(`#steps li[data-step="${st}"] .badge`)).toHaveText('Фото: 1');
  }
  op.once('dialog', (d) => d.accept());
  await op.getByRole('button', { name: 'Готово' }).click();
  await expect(op.locator('#closed-text')).toContainText('Эксперт получил 8 фото');
  await octx.close();

  // 5. Аналоги: ИИ берёт со скриншота цену, площадь, адрес, этаж и тип дома — эксперту остаётся проверить.
  await sp.reload();
  const abox = sp.locator('#analogs-box');
  await expect(sp.locator('#analogs-state')).toContainText('Подтверждено аналогов: 0 из 3');
  await expect(sp.locator('#inspect-state')).toContainText('Фото осмотра: 8');
  const ads = [
    ['https://www.cian.ru/sale/flat/1001/', '2-комн. квартира, 52,0 м², 5/9 этаж\nЦена 15 900 000 ₽\nг. Москва, ул. Тестовая, 8\nПанельный дом\nРазмещено 01.10.2026'],
    ['https://www.cian.ru/sale/flat/1002/', '2-комн. квартира, 56,5 м², 9/12 этаж\nЦена 16 700 000 ₽\nг. Москва, ул. Тестовая, 20\nПанельный дом\nРазмещено 28.09.2026'],
    ['https://www.avito.ru/moskva/kvartiry/2k_1003', '2-к. квартира, 49,8 м², 3/12 эт.\nЦена 14 990 000 ₽\nг. Москва, Тестовый пр., 4\nКирпичный дом\nРазмещено 30.09.2026'],
  ];
  for (const [n, [link, ad]] of ads.entries()) {
    await abox.getByLabel('Ссылка на объявление').fill(link);
    await sp.locator('#analogs-file').setInputFiles({ name: 'Screenshot.png', mimeType: 'image/png', buffer: Buffer.concat([jpeg, Buffer.from(`OCR:${ad}`)]) });
    await abox.getByRole('button', { name: 'Добавить аналог' }).click();
    // Ждём именно этот аналог: надпись «ИИ заполнил» уже стоит от предыдущего.
    await expect(sp.locator('#analogs-list li.analog')).toHaveCount(n + 1);
    await expect(sp.locator('#analogs-msg')).toContainText('ИИ заполнил');
  }
  const first = sp.locator('#analogs-list li.analog').first();
  await expect(first.getByLabel(/Адрес или район/)).toHaveValue('г. Москва, ул. Тестовая, 8');
  await expect(first.getByLabel('Этаж / этажей в доме')).toHaveValue('5/9');
  await expect(first.getByLabel('Тип дома')).toHaveValue('Панельный дом');
  await expect(first.locator('.analog-warn')).not.toContainText('Не заполнено');
  await first.scrollIntoViewIfNeeded();
  await shot(sp, '99o-kvartira-analog-ot-ii');
  for (let i = 0; i < 3; i++) {
    await sp.locator('#analogs-list li.analog').nth(i).getByRole('button', { name: 'Подтвердить' }).click();
    await expect(sp.locator('#analogs-msg')).toHaveText('Аналог подтверждён');
  }
  await expect(sp.locator('#next-steps li[data-step="analogs"]')).toContainText('✓ Аналоги (подтверждено 3 из 3)');

  // 6. Черновик: в задании «54,3», у единственного подхода вес 1; Word — с таблицей аналогов.
  await sp.getByRole('button', { name: 'Подготовить черновик с помощью ИИ' }).click();
  await expect(sp.locator('#draft-msg')).toHaveText('Черновик готов — проверьте и поправьте');
  const text = sp.getByLabel('Текст заключения');
  const body = await text.inputValue();
  expect(body).toContain('| Площадь, кв. м | 54,3 |');
  expect(body).toContain('| Сравнительный | [заполнить] | 1 |');
  expect(body).not.toMatch(/^## \d+\. Затратный подход/m);
  const [word] = await Promise.all([sp.waitForEvent('download'), sp.getByRole('button', { name: 'Скачать Word' }).click()]);
  const wchunks = [];
  for await (const ch of await word.createReadStream()) wchunks.push(ch);
  const wtext = (await extractPages(Buffer.concat(wchunks), 'r.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).pages.join('\n');
  expect(wtext).toContain('г. Москва, ул. Тестовая, 20');
  expect(wtext).toContain('Фотоматериалы осмотра');
  // Черновик есть — главная кнопка ведёт к «Приложить как файл результата», а не к загрузке файла с телефона.
  await expect(sp.locator('#next-main button')).toHaveText('Приложить черновик как файл результата');
  await shot(sp, '99p-kvartira-chernovik-gotov');
  await text.fill(body.replace(/\[(?:заполнить|описать)[^\]]*\]/gi, 'заполнено экспертом'));
  await sp.getByRole('button', { name: 'Сохранить правку' }).click();
  await expect(sp.locator('#draft-msg')).toHaveText('Правка сохранена');
  await sp.locator('#next-main button').click();
  await expect(sp.locator('#draft-confirm')).toBeFocused();
  await sp.locator('#draft-confirm').check();
  await sp.getByRole('button', { name: 'Приложить как файл результата' }).click();
  await expect(sp.locator('#draft-msg')).toHaveText('Файл «Отчёт об оценке.docx» добавлен в результат работы');

  // 7. ИИ-проверка, подпись, сдача.
  await sp.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(sp.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  await expect(sp.locator('#next-main button')).toHaveText('Подписать файл');
  sp.once('dialog', (d) => d.accept());
  await sp.locator('#next-main button').click();
  await expect(sp.locator('#next-main button')).toHaveText('Сдать на проверку');
  await sp.locator('#next-main button').click();
  await expect(sp.locator('#order-status')).toHaveText('Проверка результата');
  await shot(sp, '99q-kvartira-sdano');
  await sctx.close();
  await dctx.close();
});

test('как руководитель (2.67): организация, приглашение, назначение, переписка, возврат, подпись, передача дела', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const C = '+79990006701', D = '+79990006702', HD = '+79990006703', S1 = '+79990006704', S2 = '+79990006705';
  await signIn(page, C);
  const ctx = async () => (await phoneContext(browser, baseURL)).newPage();
  const dp = await ctx(), hp = await ctx(), sp = await ctx(), bp = await ctx();
  const disp = await signIn(dp, D), spec = await signIn(sp, S1), spec2 = await signIn(bp, S2);
  await signIn(hp, HD);
  await hp.request.patch('/api/me', { data: { full_name: 'Руководов Роман Романович' }, headers: H });
  await sp.request.patch('/api/me', { data: { full_name: 'Экспертова Елена Евгеньевна' }, headers: H });
  await bp.request.patch('/api/me', { data: { full_name: 'Сменщиков Семён Сергеевич' }, headers: H });
  await db(async (c) => {
    await c.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]);
    for (const u of [spec.id, spec2.id]) {
      await c.query('insert into specialists (user_id) values ($1)', [u]);
      await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [u]);
    }
  });
  const orgName = `ООО «Бюро руководителя ${Date.now()}»`;

  // 1. Новая организация: вместо пустой «Нагрузки» — подсказка и переход к приглашению.
  await hp.goto('/kabinet#orgs');
  await hp.locator('#org-name').fill(orgName);
  await hp.locator('#org-inn').fill('7707083893');
  await hp.locator('#create-org').click();
  await expect(hp.locator('#org-title')).toHaveText(orgName);
  await expect(hp.locator('#org-no-experts')).toBeVisible();
  await expect(hp.locator('#org-cases-load-title')).toBeHidden();
  await expect(hp.locator('#org-cases-empty')).toBeHidden();
  await shot(hp, '99r-rukovoditel-novaya-organizaciya');
  await hp.getByRole('button', { name: 'К приглашению экспертов' }).click();
  await expect(hp.locator('#invite-phone')).toBeFocused();
  for (const ph of ['+7 999 000-67-04', '+79990006705']) {
    await hp.locator('#invite-phone').fill(ph);
    await hp.locator('#invite').click();
    await expect(hp.locator('#invite-msg')).toHaveText('Приглашение отправлено');
  }
  await expect(hp.locator('#org-invites li')).toHaveCount(2);

  // 2. Эксперты принимают приглашение и одной кнопкой начинают работать от организации.
  for (const p of [sp, bp]) {
    await p.goto('/kabinet#orgs');
    await p.getByRole('button', { name: 'Принять' }).click();
    await expect(p.locator('#org-title')).toHaveText(orgName);
    await expect(p.locator('#org-work-lead')).toContainText('Вы специалист, но работаете от себя');
    if (p === sp) await shot(p, '99s-ekspert-rabotat-ot-organizacii');
    await p.getByRole('button', { name: 'Работать от этой организации' }).click();
    await expect(p.locator('#org-work-msg')).toHaveText(`Теперь Вы работаете от ${orgName}: руководитель может назначать Вам её дела`);
    await p.reload();
    await expect(p.locator('#org-work-box')).toBeHidden();
  }
  await hp.reload();
  await expect(hp.locator('#org-cases-load > li')).toHaveCount(2);
  await expect(hp.locator('#org-no-experts')).toBeHidden();
  await expect(hp.locator('#org-cases-empty')).toHaveText('Пока дел нет.');

  // 3. Диспетчер предлагает дело организации; уведомление ведёт прямо к делу, имена в списке не обрезаны.
  const title = `Квартира руководителю ${Date.now()}`;
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title }, headers: H })).json()).order;
  await page.request.patch(`/api/orders/${o.id}`, { data: { deadline: inDays(7), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, ул. Руководящая, 3', area: '48' } }, headers: H });
  await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H });
  await dp.request.put(`/api/orders/${o.id}/price`, { data: { price: '15000' }, headers: H });
  await page.request.post(`/api/orders/${o.id}/payments`, { headers: H });
  expect((await page.request.post(`/api/orders/${o.id}/payments/refresh`, { headers: H })).status()).toBe(200);
  const orgId = (await db((c) => c.query('select id from organizations where name = $1', [orgName]))).rows[0].id;
  expect((await dp.request.post(`/api/orders/${o.id}/offer`, { data: { org_id: orgId, from: 'matching' }, headers: H })).status()).toBe(200);
  const ref = o.id.slice(0, 8).toUpperCase();
  await hp.goto('/kabinet#notifications');
  const offerNote = hp.locator('#notifications li').filter({ hasText: 'Организации предложено дело' });
  await expect(offerNote).toContainText(`Организация ${orgName} · заявка № ${ref}`);
  await offerNote.getByRole('button').click();
  await expect(hp).toHaveURL(new RegExp(`#org=${orgId}&case=${ref}&to=pending$`));
  const pend = hp.locator('#org-pending > li').first();
  await expect(pend).toHaveClass(/flash/);
  await expect(hp.locator('#org-cases-empty')).toBeHidden();
  const pick = pend.locator('select');
  await pick.selectOption({ label: 'Экспертова Елена Евгеньевна · в работе 0' });
  // Список экспертов — во всю ширину карточки: имя не обрезано.
  const [pw, lw] = await Promise.all([pick.evaluate((x) => x.getBoundingClientRect().width), pend.evaluate((x) => x.getBoundingClientRect().width)]);
  expect(pw).toBeGreaterThan(lw - 2);
  await shot(hp, '99t-rukovoditel-naznachenie');
  await pend.getByRole('button', { name: 'Назначить' }).click();
  // Подтверждение видно и после того, как список «Ждут назначения» опустел.
  await expect(hp.locator('#org-pending-msg')).toBeVisible();
  await expect(hp.locator('#org-pending-msg')).toHaveText('Дело предложено эксперту — он примет его или откажется');
  await expect(hp.locator('#org-pending-box')).toBeHidden();
  await sp.goto('/kabinet');
  sp.once('dialog', (d) => d.accept());
  await sp.locator('#orders li').filter({ hasText: title }).getByRole('button', { name: 'Принять дело' }).click();
  await expect(sp.locator('#order-status')).toHaveText('В работе');

  // 4. Переписка: руководитель пишет, эксперт отвечает; уведомление открывает переписку этого дела, видно «ждёт ответа».
  await hp.reload();
  const row = hp.locator(`#org-cases > li[data-case="№ ${ref}"]`);
  await row.locator('[data-chat] summary').click();
  await row.getByLabel('Сообщение во внутренней переписке').fill('Елена, срок жёсткий — сдайте до четверга.');
  await row.getByRole('button', { name: 'Отправить' }).click();
  await expect(row.locator('[data-chat] .msg')).toHaveText('Сообщение отправлено');
  await sp.reload();
  await sp.locator('#org-chat textarea').fill('Хорошо, сдам в среду.');
  await sp.locator('#org-chat button[type=submit]').click();
  await expect(sp.locator('#org-chat')).toContainText('Хорошо, сдам в среду.');
  await hp.goto('/kabinet#notifications');
  await hp.locator('#notifications li').filter({ hasText: 'Эксперт написал Вам по делу' }).getByRole('button').click();
  await expect(hp).toHaveURL(new RegExp(`#org=${orgId}&case=${ref}&to=chat$`));
  await expect(row.locator('[data-chat] summary')).toHaveText('Переписка с экспертом · сообщений: 2 · ждёт Вашего ответа');
  await expect(row.locator('[data-chat]')).toHaveAttribute('open', '');
  await expect(row.locator('[data-chat] .chat')).toContainText('Хорошо, сдам в среду.');
  await shot(hp, '99u-rukovoditel-perepiska');

  // 5. Эксперт подписал — уведомление с номером дела ведёт к подписи; возврат с замечанием; повторная подпись; подпись организации.
  await sp.locator('#result-file').setInputFiles({ name: 'Отчёт.pdf', mimeType: 'application/pdf', buffer: makePdf([['Отчёт об оценке (тест)']]) });
  await expect(sp.locator('#docs li').getByRole('button', { name: 'Подписать' })).toHaveCount(1);
  await signResults(sp);
  await hp.goto('/kabinet#notifications');
  const signNote = hp.locator('#notifications li').filter({ hasText: 'нужна подпись организации' });
  await expect(signNote).toContainText(`заявка № ${ref}`);
  await signNote.getByRole('button').click();
  await expect(hp).toHaveURL(new RegExp(`#org=${orgId}&case=${ref}&to=sign$`));
  await expect(hp.locator(`#org-sign > li[data-item="№ ${ref}"]`)).toHaveClass(/flash/);
  const item = hp.locator('#org-sign li.doc').first();
  await item.getByRole('button', { name: 'Вернуть эксперту' }).click();
  await item.locator('textarea').fill('Раздел 4: нет корректировки на этаж.');
  await item.getByRole('button', { name: 'Вернуть с замечанием' }).click();
  await expect(hp.locator('#org-sign-msg')).toHaveText('Файл возвращён эксперту с замечанием — его подпись снята');
  await sp.reload();
  await expect(sp.locator('#org-returns .comment').first()).toHaveText('Раздел 4: нет корректировки на этаж.');
  await expect(sp.locator('#docs li').getByRole('button', { name: 'Подписать' })).toHaveCount(1);
  await signResults(sp);
  // «Сегодня» тоже ведёт прямо к подписи этого дела.
  await hp.goto('/kabinet');
  await hp.locator(`#today-box li[data-today-item="org-sign-${orgId}"] button`).click();
  await expect(hp).toHaveURL(new RegExp(`#org=${orgId}&case=${ref}&to=sign$`));
  hp.once('dialog', (d) => d.accept());
  await hp.locator('#org-sign li.doc').first().getByRole('button', { name: 'Подписать от организации' }).click();
  await expect(hp.locator('#org-sign-msg')).toHaveText('Файл подписан от организации');

  // 6. Передача дела другому эксперту.
  await hp.reload();
  await row.locator('[data-transfer] summary').click();
  await expect(row.locator('[data-transfer] select option')).toHaveText(['Сменщиков Семён Сергеевич']);
  await row.getByLabel(/Причина передачи дела/).fill('Уходит в отпуск');
  await row.getByRole('button', { name: 'Передать дело' }).click();
  await expect(hp.locator('#org-cases-msg')).toHaveText('Дело передано — новый эксперт получил уведомление');
  await expect(hp.locator(`#org-cases > li[data-case="№ ${ref}"]`)).toContainText('эксперт: Сменщиков Семён Сергеевич');
  await shot(hp, '99v-rukovoditel-peredal');
  for (const p of [dp, hp, sp, bp]) await p.context().close();
});

// Прогон «владелец по ссылке осмотра» и «помощник на выезде» (2.68): плохая связь — фото не теряется и уходит само (или по
// «Повторить сейчас»), ответ потерялся — фото не удваивается; «Готово» ждёт отправки; видно, сколько шагов снято.
test('осмотр при плохой связи (2.68): владелец по ссылке и помощник на выезде — повтор, без двойных фото, «Готово» ждёт', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  await signIn(page, '+79990006801');
  const mk = async (title, express) => {
    const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title }, headers: H })).json()).order;
    expect((await page.request.patch(`/api/orders/${o.id}`, {
      data: { deadline: inDays(9), express, fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, Связная ул., 3', area: '40' } }, headers: H,
    })).status()).toBe(200);
    expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
    return o.id;
  };
  const id = await mk('Осмотр при плохой связи', false);
  const vid0 = await mk('Выезд при плохой связи', true);
  const sctx = await phoneContext(browser, baseURL);
  const sp = await sctx.newPage();
  const spec = await signIn(sp, '+79990006802');
  const geo = { permissions: ['geolocation'], geolocation: { latitude: 55.7512, longitude: 37.6184, accuracy: 10 } };
  const hctx = await phoneContext(browser, baseURL, geo);
  const hp = await hctx.newPage();
  const helper = await signIn(hp, '+79990006803');
  await db(async (c) => {
    await c.query('insert into specialists (user_id) values ($1)', [spec.id]);
    await c.query("insert into specialists (user_id, onsite, regions) values ($1, true, '{moscow}')", [helper.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [spec.id]);
    for (const o of [id, vid0]) {
      await c.query('update orders set price_kop = 1500000, paid_at = now(), status = $2, executor_user_id = $3 where id = $1', [o, 'in_work', spec.id]);
      await c.query("insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at) values ($1, 1500000, 'succeeded', $2, $3, now())", [o, `pay_ui_${o}`, spec.id]);
    }
  });
  const issued = await (await sp.request.post(`/api/orders/${id}/inspection`, { data: { days: 1 }, headers: H })).json();
  const jpeg = Buffer.from((await sp.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 480;
    const g = c.getContext('2d');
    g.fillStyle = '#d0c49d'; g.fillRect(0, 0, 640, 480);
    g.fillStyle = '#8c5a1f'; g.fillRect(160, 120, 300, 220);
    return c.toDataURL('image/jpeg', 0.8);
  })).split(',')[1], 'base64');

  // Владелец: связь пропала при первой отправке; при второй фото дошло, а ответ потерялся; третья — успешно.
  const octx = await phoneContext(browser, baseURL, geo);
  const op = await octx.newPage();
  let tries = 0;
  await op.route('**/api/inspect/photos', async (route) => {
    tries += 1;
    if (tries === 1) return route.abort('internetdisconnected');
    if (tries === 2) { await route.fetch(); return route.abort('connectionreset'); }
    return route.continue();
  });
  await op.goto(issued.path);
  await op.getByRole('button', { name: 'Начать: разрешить определение места' }).click();
  await expect(op.locator('#progress')).toHaveText(/^Снято 0 из \d+ нужных шагов\.$/);
  const facade = op.locator('#steps li[data-step="facade"]');
  await facade.locator('input[type=file]').setInputFiles({ name: 'facade.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  await expect(facade.locator('.msg')).toContainText('Нет связи — фото не потеряно, отправим снова');
  await expect(op.locator('#pending')).toHaveText('Ещё не отправлено фото: 1. Не закрывайте страницу — отправим, как только будет связь.');
  await expect(op.getByRole('button', { name: 'Повторить сейчас' })).toBeVisible();
  await op.getByRole('button', { name: 'Готово' }).click();
  await expect(op.locator('#finish-msg')).toHaveText('Подождите — ещё не отправлено фото: 1. «Готово» сработает, когда они уйдут.');
  await shot(op, '99w-vladelec-net-svyazi');
  await op.getByRole('button', { name: 'Повторить сейчас' }).click();
  await expect.poll(() => tries).toBe(2);
  await expect(facade.locator('.msg')).toContainText('Нет связи');
  await op.getByRole('button', { name: 'Повторить сейчас' }).click();
  await expect(facade.locator('.msg')).toHaveText('Фото отправлено');
  await expect(facade.locator('.badge')).toHaveText('Фото: 1');
  await expect(op.locator('#pending')).toBeHidden();
  await expect(op.locator('#finish-msg')).toHaveText('Все фото отправлены — можно нажать «Готово».');
  await expect(op.getByRole('button', { name: 'Повторить сейчас' })).toBeHidden();
  await expect(op.locator('#progress')).toHaveText(/^Снято 1 из \d+ нужных шагов\.$/);
  expect(tries).toBe(3);
  const n = await db(async (c) => (await c.query("select count(*)::int as n from documents where order_id = $1 and kind = 'inspection'", [id])).rows[0].n);
  expect(n, 'фото дошло один раз, хотя отправлялось трижды').toBe(1);
  await shot(op, '99x-vladelec-otpravleno');
  // «Готово» с несделанными шагами — названия в вопросе.
  let asked = '';
  op.once('dialog', (d) => { asked = d.message(); d.accept(); });
  await op.getByRole('button', { name: 'Готово' }).click();
  await expect(op.locator('#closed-text')).toHaveText('Спасибо! Эксперт получил 1 фото. Страницу можно закрыть.');
  expect(asked).toMatch(/^Не снято: .*Кухня.*Всё равно завершить\?$/);

  // Помощник: выезд, без связи данные не сохраняются — понятное сообщение по-русски; фото уходит после восстановления связи.
  expect((await sp.request.post(`/api/orders/${vid0}/onsite`, { data: { helper_id: helper.id, planned_at: new Date(Date.now() + 2 * 86400_000).toISOString() }, headers: H })).status()).toBe(201);
  await hp.goto('/kabinet#specialist');
  await hp.locator('#visits li').filter({ hasText: 'Связная ул., 3' }).getByRole('link', { name: 'Открыть выезд' }).click();
  await expect(hp.locator('#page-title')).toHaveText('Выезд на объект');
  await hp.getByRole('button', { name: 'Начать: разрешить определение места' }).click();
  await hctx.setOffline(true);
  await hp.getByLabel('Замечания помощника').fill('Подъезд закрыт, ждали консьержа');
  await hp.getByRole('button', { name: 'Сохранить данные' }).click();
  await expect(hp.locator('#data-msg')).toHaveText('Нет связи с сервером — проверьте интернет и повторите');
  const kitchen = hp.locator('#steps li[data-step="kitchen"]');
  await kitchen.locator('input[type=file]').setInputFiles({ name: 'kitchen.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  await expect(kitchen.locator('.msg')).toContainText('Нет связи — фото не потеряно');
  await expect(hp.locator('#pending')).toContainText('Ещё не отправлено фото: 1');
  await shot(hp, '99y-pomoshnik-net-svyazi');
  await hctx.setOffline(false);
  await hp.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(kitchen.locator('.badge')).toHaveText('Фото: 1');
  await expect(kitchen.locator('.msg')).toHaveText('Фото отправлено');
  await expect(hp.locator('#pending')).toBeHidden();
  await hp.getByRole('button', { name: 'Сохранить данные' }).click();
  await expect(hp.locator('#data-msg')).toHaveText('Данные сохранены');
  await shot(hp, '99z-pomoshnik-otpravleno');
  await octx.close();
  await hctx.close();
  await sctx.close();
});
