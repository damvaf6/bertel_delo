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
import { makePdf } from '../tools/make-docs.mjs';

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

  await page.getByLabel('Добавить файл (до 5 МБ)').setInputFiles({
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
  await mp.getByLabel('От чьего имени').selectOption({ label: 'От организации «АНО «Тестовый центр экспертиз»»' });
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
  await expect(page.locator('#facts')).toContainText('54.3');
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
  await expect(sp.locator('#orders li').filter({ hasText: 'Оценка автомобиля после ДТП' })).toContainText('Вы исполнитель');
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
  await sp.getByRole('button', { name: 'Сдать на проверку' }).click();
  await expect(sp.locator('#status-msg')).toHaveText('Подпишите УКЭП файлы результата: тестовый-отчёт.pdf');
  sp.once('dialog', (d) => d.accept());
  await repDoc.getByRole('button', { name: 'Подписать' }).click();
  await expect(sp.locator('#doc-msg')).toHaveText('Файл подписан');
  await expect(repDoc.locator('.sig-state')).toContainText('Подписан УКЭП: Тестовый оценщик');
  await expect(repDoc.locator('.sig-test')).toHaveText('Тестовая подпись площадки — юридической силы не имеет');
  await shot(sp, '93-specialist-podpis');
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
  await expect(signed.locator('.sig-state')).toContainText('Подписан УКЭП: Тестовый оценщик');
  await signed.getByRole('button', { name: 'Проверить подпись' }).click();
  await expect(page.locator('#doc-msg')).toHaveText('Подпись верна: Тестовый оценщик');
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
  await expect(dp.locator('#review-summary')).toContainText('не проверено: 7');
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
  await expect(sp.locator('#draft-msg')).toHaveText('Файл «Заключение.docx» добавлен в результат работы');
  await expect(sp.locator('#docs li').filter({ hasText: 'Заключение.docx' })).toContainText('Результат работы');
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
  await expect(page.locator('#docs')).not.toContainText('Заключение.docx');
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
  await shot(sp, '84-specialist-osmotr-foto');
  const notes = await (await sp.request.get('/api/notifications')).json();
  expect(JSON.stringify(notes)).toContain('Владелец объекта прислал фото осмотра');

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
  expect(answer.subject).toMatch(/^Заявка № /);
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
  await page.getByLabel('Добавить файл (до 5 МБ)').setInputFiles({ name: 'Выписка ЕГРН.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 тестовая выписка') });
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
