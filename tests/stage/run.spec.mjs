// Общий прогон на площадке stage (TASKS.md, «До первого показа»): то, что закрыто «без облака», повторяется на настоящей
// базе, настоящем хранилище файлов и копиях контейнера в облаке — на телефоне 412×915. Каждый входит служебным входом
// тестовым номером (решение Дамира 02.10.2026, вариант А). База площадки сохраняется между выкладками — поэтому номера
// и названия у каждого прогона свои. Администратор площадки — тестовый номер STAGE_ADMIN_PHONE, назначенный кнопкой
// «Stage admin» (решение Дамира 02.10.2026, вопрос 10, вариант А); диспетчера и специалиста каждого прогона назначает он.
// Скриншоты — test-results/screens/stage-run-*.png.
import { test as base, expect } from '@playwright/test';
import { makePdf } from '../tools/make-docs.mjs';

const TOKEN = process.env.STAGE_INVOKE_TOKEN;
const LOGIN_KEY = process.env.STAGE_LOGIN_KEY;
const ADMIN = process.env.STAGE_ADMIN_PHONE;
if (!TOKEN || !LOGIN_KEY) throw new Error('STAGE_INVOKE_TOKEN и STAGE_LOGIN_KEY — ключи прогона (workflow Deploy core)');
if (!/^\+7999000\d{4}$/.test(ADMIN || '')) throw new Error('STAGE_ADMIN_PHONE — тестовый номер администратора площадки (workflow Deploy core)');
const AUTH = { authorization: `Bearer ${TOKEN}` };
const H = { 'x-delo-request': '1' };

// Хранилище файлов Яндекса — единственный «чужой» адрес (временные ссылки на скачивание).
const isStorage = (u) => u.origin === 'https://storage.yandexcloud.net' || u.hostname.endsWith('.storage.yandexcloud.net');

// Токен облака уходит только на адрес площадки; на странице — нет ошибок JS и запросов к чужим адресам.
const test = base.extend({
  context: async ({ context, baseURL }, use) => {
    const origin = new URL(baseURL).origin;
    await context.route((u) => u.origin === origin, async (route) => route.continue({ headers: { ...(await route.request().allHeaders()), ...AUTH } }));
    await use(context);
  },
  page: async ({ page, baseURL }, use) => {
    await use(watched(page, baseURL));
    expect(page.problems, page.problems.join('\n')).toEqual([]);
  },
});

function watched(page, baseURL) {
  const origin = new URL(baseURL).origin;
  page.problems = [];
  page.on('pageerror', (e) => page.problems.push(`ошибка JS: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) page.problems.push(`консоль: ${m.text()}`); });
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['data:', 'blob:'].includes(u.protocol) && u.origin !== origin && !isStorage(u)) page.problems.push(`внешний запрос: ${r.url()}`);
  });
  return page;
}

// Второй телефон: свой контекст, тот же токен облака только для адреса площадки.
async function phone(browser, baseURL) {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU', acceptDownloads: true });
  const origin = new URL(baseURL).origin;
  await ctx.route((u) => u.origin === origin, async (route) => route.continue({ headers: { ...(await route.request().allHeaders()), ...AUTH } }));
  return watched(await ctx.newPage(), baseURL);
}

async function close(p) {
  expect(p.problems, p.problems.join('\n')).toEqual([]);
  await p.context().close();
}

async function enter(page, phoneNo, name) {
  const r = await page.request.post('/__stage/login', { data: { phone: phoneNo }, headers: { ...AUTH, ...H, 'x-stage-login': LOGIN_KEY } });
  expect(r.status(), await r.text()).toBe(200);
  const { user } = await r.json();
  if (name) expect((await page.request.patch('/api/me', { data: { full_name: name }, headers: { ...AUTH, ...H } })).status()).toBe(200);
  return user;
}

// Администратор открывает человека по номеру и ждёт, пока на экране именно он, а не предыдущий найденный: иначе на
// медленной площадке профиль сохраняется предыдущему.
const shown = (p) => p.replace(/^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/, '+7 $1 $2-$3-$4');
async function findUser(ap, phoneNo) {
  await ap.getByLabel('Номер телефона пользователя').fill(phoneNo);
  await ap.getByRole('button', { name: 'Найти' }).click();
  await expect(ap.locator('#admin-user-meta')).toContainText(shown(phoneNo));
}

async function shot(page, name) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, `${name}: страница шире экрана`).toBeLessThanOrEqual(412);
  await page.screenshot({ path: `test-results/screens/stage-run-${name}.png`, fullPage: true });
}

// Номера прогона: +7 999 000-NN-x0…x9, NN — от 20 до 89 (служебная проверка входа — 90-0x, администратор — 95-00).
const RUN = String(20 + Math.floor(Math.random() * 70)) + String(Math.floor(Math.random() * 10));
const tel = (i) => `+7999000${RUN}${i}`;
const TAG = `прогон ${RUN}-${Date.now().toString(36)}`;
const inDays = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

test.describe.configure({ mode: 'serial', timeout: 180_000 });

test('общий прогон: заявка на оценку с файлами в хранилище, отправка, чужой не видит, отмена', async ({ page, browser, baseURL }) => {
  const title = `Оценка квартиры — ${TAG}`;
  await enter(page, tel(0), 'Тестова Заказчица');
  await page.goto('/kabinet');
  await expect(page.locator('#who')).toHaveText('Тестова Заказчица');
  await page.locator('#new-order').getByLabel('Услуга').selectOption({ label: 'Оценка недвижимости' });
  await page.getByLabel('Коротко: что нужно').fill(title);
  await page.getByRole('button', { name: 'Создать заявку' }).click();
  await expect(page.locator('#order-status')).toHaveText('Новая');
  const id = new URL(page.url()).hash.match(/^#order=([0-9a-f-]{36})$/i)[1];

  // Без данных отправить нельзя.
  await page.getByRole('button', { name: 'Отправить заявку' }).click();
  await expect(page.getByText(/^Не хватает: /)).toBeVisible();

  await page.getByLabel('Для чего нужна оценка').selectOption({ label: 'Для суда' });
  await page.getByLabel('Где находится объект').selectOption({ label: 'Московская область' });
  await page.getByLabel('Что оцениваем').selectOption({ label: 'Квартира' });
  await page.getByLabel('Адрес объекта').fill('Московская обл., г. Тестовск, ул. Проверочная, д. 1, кв. 2');
  await page.getByLabel('Площадь, кв. м').fill('54,3');
  await page.getByLabel(/^Срок/).fill(inDays(14));
  await page.getByLabel('Основание').selectOption({ label: 'Определение суда' });
  await page.getByLabel(/^Номер определения/).fill('2-1234/2026');
  await page.getByLabel(/^Дата определения/).fill(inDays(-10));
  await page.getByLabel('Приложить определение суда').setInputFiles({ name: 'Определение суда.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 тестовое определение') });
  await expect(page.getByText('Приложено: Определение суда.pdf')).toBeVisible();

  // Файл в хранилище Яндекса: загрузка, скачивание по временной ссылке, содержимое совпадает.
  const body = `%PDF-1.4 тестовая выписка ${TAG}`;
  await page.getByLabel('Добавить файл (до 5 МБ)').setInputFiles({ name: 'Выписка ЕГРН.pdf', mimeType: 'application/pdf', buffer: Buffer.from(body) });
  await expect(page.getByText('Файл добавлен')).toBeVisible();
  const doc = page.locator('#docs li').filter({ hasText: 'Выписка ЕГРН.pdf' });
  const [download] = await Promise.all([page.waitForEvent('download'), doc.getByRole('button', { name: 'Скачать' }).click()]);
  expect(download.suggestedFilename()).toBe('Выписка ЕГРН.pdf');
  const chunks = [];
  for await (const ch of await download.createReadStream()) chunks.push(ch);
  expect(Buffer.concat(chunks).toString()).toBe(body);
  await shot(page, '01-zayavka');

  await page.getByRole('button', { name: 'Отправить заявку' }).click();
  await expect(page.getByText('Заявка отправлена')).toBeVisible();
  await expect(page.locator('#order-status')).toHaveText('Подбор исполнителя');
  await expect(page.locator('#facts')).toContainText('Определение суда, № 2-1234/2026');
  await shot(page, '02-otpravlena');

  // Посторонний не видит заявку ни в списке, ни по ссылке, ни её файлы.
  const xp = await phone(browser, baseURL);
  await enter(xp, tel(1));
  await xp.goto('/kabinet');
  await expect(xp.getByRole('heading', { name: 'Мои заявки' })).toBeVisible();
  await expect(xp.getByText(title)).toHaveCount(0);
  await xp.goto(`/kabinet#order=${id}`);
  await expect(xp.getByRole('heading', { name: 'Заявка не найдена' })).toBeVisible();
  expect((await xp.request.get(`/api/orders/${id}`, { headers: AUTH })).status()).toBe(404);
  expect((await xp.request.get(`/api/orders/${id}/documents`, { headers: AUTH })).status()).toBe(404);
  await shot(xp, '03-chuzhaya');
  await close(xp);

  // Отмена заказчиком до начала работ.
  await page.reload();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Отменить заявку' }).click();
  await expect(page.locator('#order-status')).toHaveText('Отменена');
  await page.getByRole('button', { name: '← Все заявки' }).click();
  await expect(page.locator('#orders li').filter({ hasText: title })).toContainText('Отменена');
  await shot(page, '04-otmena');
});

test('общий прогон: организация — приглашение, дело сотрудника у руководителя, ушедший теряет доступ; уведомления', async ({ page, browser, baseURL }) => {
  const org = `АНО «Тестовый центр ${RUN}»`;
  const title = `Оценка автомобиля — ${TAG}`;
  const mp = await phone(browser, baseURL);
  await enter(mp, tel(3), 'Тестовый Сотрудник');
  await enter(page, tel(2), 'Тестовый Руководитель');
  await page.goto('/kabinet#orgs');
  await page.getByLabel('Название', { exact: true }).fill(org);
  await page.getByRole('button', { name: 'Создать организацию' }).click();
  await expect(page.getByRole('heading', { name: org })).toBeVisible();
  await page.getByLabel('Номер телефона сотрудника').fill(tel(3));
  await page.getByRole('button', { name: 'Пригласить' }).click();
  await expect(page.getByText('Приглашение отправлено')).toBeVisible();
  await shot(page, '05-organizaciya');

  // Сотрудник: уведомление о приглашении, принимает, создаёт заявку от организации.
  await mp.goto('/kabinet#notifications');
  await expect(mp.locator('#notifications')).toContainText('Вас пригласили в организацию');
  await shot(mp, '06-uvedomlenie');
  await mp.goto('/kabinet#orgs');
  await expect(mp.locator('#invites').getByText(org)).toBeVisible();
  await mp.getByRole('button', { name: 'Принять' }).click();
  await expect(mp.getByText('Ваша роль: Сотрудник')).toBeVisible();
  await mp.getByRole('link', { name: 'Заявки' }).click();
  await mp.getByLabel('Коротко: что нужно').fill(title);
  await mp.getByLabel('От чьего имени').selectOption({ label: `От организации «${org}»` });
  await mp.getByRole('button', { name: 'Создать заявку' }).click();
  await expect(mp.getByText(new RegExp(`^Организация: ${org.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · Ведёт:`))).toBeVisible();
  const orderUrl = mp.url();

  // Руководитель видит дело сотрудника; убирает сотрудника — тот теряет доступ.
  await page.getByRole('link', { name: 'Заявки' }).click();
  await page.getByText(title).click();
  await expect(page.getByRole('heading', { name: 'Кто ведёт дело' })).toBeVisible();
  await shot(page, '07-delo-sotrudnika');
  await page.getByRole('link', { name: /Организации/ }).click();
  await page.locator('#orgs').getByText(org).click();
  await expect(page.locator('#members li')).toHaveCount(2);
  page.once('dialog', (d) => d.accept());
  await page.locator('#members li').filter({ hasText: shown(tel(3)) }).getByRole('button', { name: 'Убрать' }).click();
  await expect(page.getByText('Сотрудник убран')).toBeVisible();
  await mp.goto(orderUrl);
  await mp.reload();
  await expect(mp.getByRole('heading', { name: 'Заявка не найдена' })).toBeVisible();
  await close(mp);
});

test('общий прогон: помощник разбирает проблему и готовит черновик заявки; ассистент отвечает', async ({ page }) => {
  await enter(page, tel(4));
  await page.goto('/kabinet');
  await page.getByRole('link', { name: 'Спросить помощника' }).click();
  await expect(page.getByRole('heading', { name: 'Помощник' })).toBeVisible();
  await page.getByLabel('Что случилось').fill('Суд назначил оценку квартиры в Москве при разделе имущества. Что мне делать?');
  await page.getByRole('button', { name: 'Разобраться' }).click();
  await expect(page.locator('#pa-specialist')).toContainText('Оценка недвижимости');
  await expect(page.locator('#pa-disclaimer')).toContainText('не юридическая услуга');
  await shot(page, '08-pomoshnik');
  await page.getByRole('button', { name: 'Создать заявку' }).click();
  await expect(page).toHaveURL(/#order=/);
  await expect(page.locator('#order-status')).toHaveText('Новая');
  await expect(page.getByLabel('Для чего нужна оценка')).toHaveValue('court');

  await page.goto('/kabinet#assistant');
  await page.getByLabel('О какой заявке (можно не выбирать)').selectOption({ index: 1 });
  await page.getByLabel('Вопрос').fill('Какие документы подготовить к осмотру?');
  await page.getByRole('button', { name: 'Спросить' }).click();
  await expect(page.locator('#as-messages li')).toHaveCount(2);
  await shot(page, '09-assistent');
});

// Часть 2: шаги администратора и диспетчера (1.4, 1.5, 1.6, 1.11) — сквозной путь заявки до выплаты исполнителю.
test('общий прогон: сквозной путь — администратор назначает диспетчера и специалиста, цена, оплата, подбор, работа, проверка, выплата', async ({ page, browser, baseURL }) => {
  const D = tel(5), S = tel(6), X = tel(8);
  const specName = `Тестов Оценщик ${RUN}`;
  const title = `Оценка квартиры для продажи — ${TAG}`;
  const ap = await phone(browser, baseURL), dp = await phone(browser, baseURL), sp = await phone(browser, baseURL), xp = await phone(browser, baseURL);
  await enter(dp, D, `Тестовый Диспетчер ${RUN}`);
  await enter(sp, S, specName);
  await enter(xp, X);
  await enter(ap, ADMIN);

  // 1. Администратор: диспетчер; специалист с допуском на оценку недвижимости.
  await ap.goto('/kabinet');
  await ap.getByRole('link', { name: 'Управление' }).click();
  await findUser(ap, D);
  await ap.getByLabel('Служебная роль').selectOption('dispatcher');
  await ap.getByRole('button', { name: 'Сохранить роль' }).click();
  await expect(ap.getByText('Роль сохранена')).toBeVisible();
  await findUser(ap, S);
  await expect(ap.locator('#admin-specialist-state')).toContainText('Пока не специалист');
  await ap.getByRole('button', { name: 'Сохранить профиль специалиста' }).click();
  await expect(ap.getByText('Профиль специалиста сохранён')).toBeVisible();
  await ap.getByLabel('Дать допуск на услугу').selectOption('expertise/realty');
  await ap.getByRole('button', { name: 'Дать допуск' }).click();
  await expect(ap.locator('#sp-permits li')).toContainText('недвижимости');
  await shot(ap, '10-admin');

  // 2. Заказчик заполняет заявку, прикладывает документ (хранилище Яндекса) и отправляет.
  await enter(page, tel(7), 'Тестова Заказчица');
  await page.goto('/kabinet');
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
  await page.getByRole('button', { name: 'Отправить заявку' }).click();
  await expect(page.getByText('Заявка отправлена')).toBeVisible();
  await expect(page.locator('#order-status')).toHaveText('Подбор исполнителя');

  // 3. Диспетчер: уведомление о новой заявке, цена.
  await dp.goto('/kabinet#notifications');
  const note = dp.locator('#notifications li').filter({ hasText: title });
  await expect(note).toContainText('Новая заявка ждёт подбора исполнителя');
  await note.getByRole('button').click();
  await expect(dp.locator('#order-title')).toHaveText(title);
  await expect(dp.locator('#facts')).toContainText('г. Москва, ул. Тестовая, д. 11, кв. 4');
  await dp.getByLabel('Цена, рублей').fill('18000');
  await dp.getByRole('button', { name: 'Назначить цену' }).click();
  await expect(dp.locator('#money-msg')).toHaveText('Цена назначена');
  await expect(dp.locator('#money-facts')).toContainText(/Исполнителю \(80%\)\s*14\s400 ₽/);

  // 4. Заказчик оплачивает (поддельная ЮKassa — на площадке только тестовые данные).
  await page.reload();
  await page.getByRole('button', { name: /Оплатить 18\s000 ₽/ }).click();
  await expect(page.locator('#money-facts')).toContainText('оплачено');
  await shot(page, '11-oplata');

  // 5. Диспетчер предлагает дело специалисту этого прогона.
  await dp.reload();
  await expect(dp.locator('#match-current')).toContainText('Заявка оплачена');
  const cand = dp.locator('#candidates li').filter({ hasText: specName });
  await expect(cand).toContainText('из 100');
  dp.once('dialog', (d) => d.accept());
  await cand.getByRole('button', { name: 'Предложить дело' }).click();
  await expect(dp.locator('#order-status')).toHaveText('Ждёт исполнителя');
  await shot(dp, '12-podbor');

  // 6. Специалист: уведомление, принимает, прикладывает отчёт, ИИ-проверка, пишет заказчику, сдаёт.
  await sp.goto('/kabinet#notifications');
  await sp.locator('#notifications li').filter({ hasText: 'Вам предложено новое дело' }).getByRole('button').click();
  await expect(sp.locator('#order-title')).toHaveText(title);
  await expect(sp.locator('#money-facts')).toContainText(/Ваше вознаграждение \(80% цены\)\s*14\s400 ₽/);
  await sp.getByRole('button', { name: 'Принять дело' }).click();
  await expect(sp.locator('#order-status')).toHaveText('В работе');
  await sp.locator('#result-file').setInputFiles({ name: 'Отчёт об оценке.txt', mimeType: 'text/plain', buffer: Buffer.from(`Отчёт об оценке квартиры. Итоговая стоимость 12 000 000 руб. ${TAG}`) });
  await expect(sp.locator('#doc-msg')).toHaveText('Файл добавлен');
  // Отчёт в PDF (задача 2.1): ИИ читает его из хранилища Яндекса и показывает отмеченное место со страницей.
  await sp.locator('#result-file').setInputFiles({ name: 'Отчёт об оценке.pdf', mimeType: 'application/pdf', buffer: makePdf([[`Заключение № ${RUN}/2026`], ['Итоговая стоимость 12 000 000 руб.', 'В разделе 3 опечатка в адресе.']]) });
  await expect(sp.locator('#docs li').filter({ hasText: 'Отчёт об оценке.pdf' })).toHaveCount(1);
  await sp.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(sp.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  await expect(sp.locator('#review-checks li').filter({ hasText: 'Технические ошибки' }).locator('.ai-marks li')).toHaveText(['Отчёт об оценке.pdf, стр. 2: В разделе 3 опечатка в адресе.']);
  await sp.getByLabel('Сообщение').fill('Осмотр проведён, отчёт приложен.');
  await sp.getByRole('button', { name: 'Отправить сообщение' }).click();
  await expect(sp.locator('#messages li')).toHaveCount(1);
  await shot(sp, '13-specialist');
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
  await shot(dp, '14-proverka');
  await dp.getByRole('button', { name: 'Проверено, готово' }).click();
  await expect(dp.locator('#order-status')).toHaveText('Готово');

  // 8. Заказчик: результат из хранилища Яндекса скачивается и совпадает, акт, закрытие.
  await page.goto(`/kabinet#order=${id}`);
  await page.reload();
  await expect(page.locator('#order-status')).toHaveText('Готово');
  await expect(page.locator('#messages li').first()).toContainText('Осмотр проведён');
  const res = page.locator('#docs li').filter({ hasText: 'Отчёт об оценке.txt' });
  await expect(res).toContainText('Результат работы');
  const [download] = await Promise.all([page.waitForEvent('download'), res.getByRole('button', { name: 'Скачать' }).click()]);
  const chunks = [];
  for await (const ch of await download.createReadStream()) chunks.push(ch);
  expect(Buffer.concat(chunks).toString()).toContain(TAG);
  await page.locator('#closing li').getByRole('button', { name: 'Открыть' }).click();
  await expect(page.locator('#closing-doc')).toContainText('Акт об оказании услуг');
  await shot(page, '15-gotovo');
  await page.getByRole('button', { name: 'Принять и закрыть' }).click();
  await expect(page.locator('#order-status')).toHaveText('Закрыта');

  // 9. Исполнитель получил выплату; диспетчер видит оплату; посторонний по-прежнему ничего не видит.
  await sp.goto('/kabinet#money');
  await expect(sp.locator('#money-payouts li').filter({ hasText: title })).toContainText('выплачено');
  await expect(sp.locator('#money-totals')).toContainText(/Выплачено\s*14\s400 ₽/);
  await shot(sp, '16-vyplata');
  await dp.goto('/kabinet#money');
  await expect(dp.locator('#money-payments li').filter({ hasText: title })).toContainText(/18\s000 ₽/);
  await xp.goto(`/kabinet#order=${id}`);
  await expect(xp.getByRole('heading', { name: 'Заявка не найдена' })).toBeVisible();
  expect((await xp.request.get(`/api/orders/${id}/documents`, { headers: AUTH })).status()).toBe(404);
  for (const p of [ap, dp, sp, xp]) await close(p);
});

// Часть 2 (1.6/1.6а): передача другому исполнителю и отказ заказчика после начала работ — оплата сделанной части и возврат.
test('общий прогон: деньги при отмене — передача другому исполнителю; отказ после начала работ, выплата части и возврат', async ({ page, browser, baseURL }) => {
  const title = `Оценка мебели — ${TAG}`;
  const ap = await phone(browser, baseURL), dp = await phone(browser, baseURL), sp = await phone(browser, baseURL);
  const D = tel(9), S = tel(6);
  await enter(dp, D, `Тестовый Диспетчер ${RUN}-2`);
  const spec = await enter(sp, S);
  await enter(ap, ADMIN);
  await ap.goto('/kabinet#admin');
  await findUser(ap, D);
  await ap.getByLabel('Служебная роль').selectOption('dispatcher');
  await ap.getByRole('button', { name: 'Сохранить роль' }).click();
  await expect(ap.getByText('Роль сохранена')).toBeVisible();
  await findUser(ap, S);
  await ap.getByLabel('Дать допуск на услугу').selectOption('expertise/goods');
  await ap.getByRole('button', { name: 'Дать допуск' }).click();
  await expect(ap.locator('#sp-permits li').filter({ hasText: /товар/i })).toHaveCount(1);
  await close(ap);

  await enter(page, tel(7));
  const hp = { ...AUTH, ...H };
  const created = await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'goods', title }, headers: hp })).json();
  const id = created.order.id;
  expect((await page.request.patch(`/api/orders/${id}`, {
    data: { deadline: inDays(8), fields: { purpose: 'deal', region: 'moscow', subject: 'Тестовый шкаф, скол на дверце', questions: 'Есть ли производственный брак?' } }, headers: hp,
  })).status()).toBe(200);
  expect((await page.request.post(`/api/orders/${id}/status`, { data: { from: 'new', to: 'matching' }, headers: hp })).status()).toBe(200);
  expect((await dp.request.put(`/api/orders/${id}/price`, { data: { price: '10000' }, headers: hp })).status()).toBe(200);
  await page.goto(`/kabinet#order=${id}`);
  await page.getByRole('button', { name: /Оплатить 10\s000 ₽/ }).click();
  await expect(page.locator('#money-facts')).toContainText('оплачено');
  const offerAndAccept = async () => {
    expect((await dp.request.post(`/api/orders/${id}/offer`, { data: { specialist_id: spec.id, from: 'matching' }, headers: hp })).status()).toBe(200);
    expect((await sp.request.post(`/api/orders/${id}/status`, { data: { from: 'awaiting_executor', to: 'in_work' }, headers: hp })).status()).toBe(200);
  };
  await offerAndAccept();

  // Диспетчер передаёт дело другому; оплата заказчика в силе, прежний исполнитель дело больше не видит.
  await dp.goto(`/kabinet#order=${id}`);
  await expect(dp.locator('#order-status')).toHaveText('В работе');
  await dp.getByLabel('Причина (для возврата или отмены)').fill('Исполнитель не выходит на связь');
  await dp.getByRole('button', { name: 'Передать другому исполнителю' }).click();
  await expect(dp.locator('#order-status')).toHaveText('Подбор исполнителя');
  await expect(dp.locator('#match-current')).toContainText('Заявка оплачена');
  await sp.goto(`/kabinet#order=${id}`);
  await expect(sp.getByRole('heading', { name: 'Заявка не найдена' })).toBeVisible();

  // Снова в работе; заказчик отказался — сделано 40%: исполнителю 3 200 ₽, заказчику возврат 6 000 ₽.
  await offerAndAccept();
  await dp.reload();
  await expect(dp.locator('#order-status')).toHaveText('В работе');
  await dp.getByLabel('Причина (для возврата или отмены)').fill('Заказчик отказался от оценки');
  dp.on('dialog', (d) => d.accept());
  await dp.getByLabel('Если отменить: по чьей причине').selectOption('customer');
  await dp.getByLabel('Сделано работы, %').fill('40');
  await dp.getByRole('button', { name: 'Отменить заявку' }).click();
  await expect(dp.locator('#order-status')).toHaveText('Отменена');
  await expect(dp.locator('#money-facts')).toContainText(/Возврат заказчику\s*6\s000 ₽ — возвращено/);
  await expect(dp.locator('#money-facts')).toContainText(/Выплата исполнителю\s*3\s200 ₽ — выплачено/);
  await shot(dp, '17-otmena-chast');

  await page.reload();
  await expect(page.locator('#order-status')).toHaveText('Отменена');
  await expect(page.locator('#money-facts')).toContainText(/Возврат заказчику\s*6\s000 ₽ — возвращено/);
  await expect(page.locator('#money-facts')).not.toContainText('Выплата исполнителю');
  await page.locator('#closing li').filter({ hasText: 'Возврат' }).getByRole('button', { name: 'Открыть' }).click();
  await expect(page.locator('#closing-doc')).toContainText(/Возвращается заказчику: 6\s000 ₽/);
  await shot(page, '18-vozvrat');

  await sp.reload();
  await expect(sp.locator('#order-status')).toHaveText('Отменена');
  await expect(sp.locator('#money-facts')).toContainText(/Выплата\s*3\s200 ₽ — выплачено/);
  await close(dp);
  await close(sp);
});
