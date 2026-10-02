// Общий прогон на площадке stage (TASKS.md, «До первого показа»): то, что закрыто «без облака», повторяется на настоящей
// базе, настоящем хранилище файлов и копиях контейнера в облаке — на телефоне 412×915. Каждый входит служебным входом
// тестовым номером (решение Дамира 02.10.2026, вариант А). База площадки сохраняется между выкладками — поэтому номера
// и названия у каждого прогона свои. Шаги, где нужны администратор и диспетчер, ждут решения Дамира (STATE.md).
// Скриншоты — test-results/screens/stage-run-*.png.
import { test as base, expect } from '@playwright/test';

const TOKEN = process.env.STAGE_INVOKE_TOKEN;
const LOGIN_KEY = process.env.STAGE_LOGIN_KEY;
if (!TOKEN || !LOGIN_KEY) throw new Error('STAGE_INVOKE_TOKEN и STAGE_LOGIN_KEY — ключи прогона (workflow Deploy core)');
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
  if (name) expect((await page.request.patch('/api/me', { data: { full_name: name }, headers: { ...AUTH, ...H } })).status()).toBe(200);
}

async function shot(page, name) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, `${name}: страница шире экрана`).toBeLessThanOrEqual(412);
  await page.screenshot({ path: `test-results/screens/stage-run-${name}.png`, fullPage: true });
}

// Номера прогона: +7 999 000-NN-x0…x9, NN — от 20 до 89 (служебная проверка входа занимает 90-01).
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
  await page.locator('#members li').filter({ hasText: tel(3).replace(/^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/, '+7 $1 $2-$3-$4') }).getByRole('button', { name: 'Убрать' }).click();
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
