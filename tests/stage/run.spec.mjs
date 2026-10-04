// Общий прогон на площадке stage (TASKS.md, «До первого показа»): то, что закрыто «без облака», повторяется на настоящей
// базе, настоящем хранилище файлов и копиях контейнера в облаке — на телефоне 412×915. Каждый входит служебным входом
// тестовым номером (решение Дамира 02.10.2026, вариант А). База площадки сохраняется между выкладками — поэтому номера
// и названия у каждого прогона свои. Администратор площадки — тестовый номер STAGE_ADMIN_PHONE, назначенный кнопкой
// «Stage admin» (решение Дамира 02.10.2026, вопрос 10, вариант А); диспетчера и специалиста каждого прогона назначает он.
// Скриншоты — test-results/screens/stage-run-*.png.
import { test as base, expect } from '@playwright/test';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { makePdf } from '../tools/make-docs.mjs';
import { testExternalSignature } from '../../src/providers/sign.mjs';
import { PROBLEM_QUESTIONS } from '../tools/problem-questions.mjs';
import fs from 'node:fs';

const TOKEN = process.env.STAGE_INVOKE_TOKEN;
const LOGIN_KEY = process.env.STAGE_LOGIN_KEY;
const ADMIN = process.env.STAGE_ADMIN_PHONE;
if (!TOKEN || !LOGIN_KEY) throw new Error('STAGE_INVOKE_TOKEN и STAGE_LOGIN_KEY — ключи прогона (workflow Deploy core)');
if (!/^\+7999000\d{4}$/.test(ADMIN || '')) throw new Error('STAGE_ADMIN_PHONE — тестовый номер администратора площадки (workflow Deploy core)');
const AUTH = { authorization: `Bearer ${TOKEN}` };
// Настоящая модель (YandexGPT) отвечает до минуты-двух — ждём её ответа дольше, чем обычного экрана.
const AI_WAIT = 150_000;
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
async function phone(browser, baseURL, extra = {}) {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU', acceptDownloads: true, ...extra });
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
  // Профиль специалиста дорисовывается после — ждём, пока на экране профиль именно этого человека.
  await expect(ap.locator('#admin-specialist')).toHaveAttribute('data-phone', phoneNo);
}

// Какая модель ИИ на площадке: поддельная отвечает предсказуемо, настоящая (YandexGPT, решение Дамира 03.10.2026) — нет.
// С настоящей проверяем то, что от её слов не зависит: ответ пришёл, находки по правилам, разделы черновика.
let realAiCache = null;
async function realAi(browser, baseURL) {
  if (realAiCache !== null) return realAiCache;
  const ap = await phone(browser, baseURL);
  await enter(ap, ADMIN);
  const r = await ap.request.get('/api/admin/ai', { headers: AUTH });
  expect(r.status()).toBe(200);
  realAiCache = (await r.json()).primary.driver !== 'fake';
  await close(ap);
  return realAiCache;
}

async function shot(page, name) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, `${name}: страница шире экрана`).toBeLessThanOrEqual(412);
  await page.screenshot({ path: `test-results/screens/stage-run-${name}.png`, fullPage: true });
}

// Часть файла Word (zip) по имени — без сторонних библиотек.
function unzipPart(buf, name) {
  let p = buf.length - 22;
  while (buf.readUInt32LE(p) !== 0x06054b50) p -= 1;
  const n = buf.readUInt16LE(p + 10);
  let q = buf.readUInt32LE(p + 16);
  for (let i = 0; i < n; i += 1) {
    const method = buf.readUInt16LE(q + 10); const csize = buf.readUInt32LE(q + 20);
    const nlen = buf.readUInt16LE(q + 28); const xlen = buf.readUInt16LE(q + 30); const clen = buf.readUInt16LE(q + 32);
    const local = buf.readUInt32LE(q + 42);
    if (buf.subarray(q + 46, q + 46 + nlen).toString('utf8') === name) {
      const from = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(from, from + csize);
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    }
    q += 46 + nlen + xlen + clen;
  }
  return null;
}

// Номера прогона: +7 999 000-NN-x0…x9, NN — от 20 до 89 (служебная проверка входа — 90-0x, администратор — 95-00, помощник экспресса — 96-00…99-99).
const RUN = String(20 + Math.floor(Math.random() * 70)) + String(Math.floor(Math.random() * 10));
const tel = (i) => `+7999000${RUN}${i}`;
const TAG = `прогон ${RUN}-${Date.now().toString(36)}`;
const inDays = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

test.describe.configure({ mode: 'serial', timeout: 600_000 }); // с настоящей моделью шаги ИИ дольше

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
  await page.getByLabel('Добавить файл (до 100 МБ)').setInputFiles({ name: 'Выписка ЕГРН.pdf', mimeType: 'application/pdf', buffer: Buffer.from(body) });
  await expect(page.getByText('Файл добавлен')).toBeVisible();
  const doc = page.locator('#docs li').filter({ hasText: 'Выписка ЕГРН.pdf' });
  const [download] = await Promise.all([page.waitForEvent('download'), doc.getByRole('button', { name: 'Скачать' }).click()]);
  expect(download.suggestedFilename()).toBe('Выписка ЕГРН.pdf');
  const chunks = [];
  for await (const ch of await download.createReadStream()) chunks.push(ch);
  expect(Buffer.concat(chunks).toString()).toBe(body);
  // Большой файл (6 МБ > 3,5 МБ — предел запроса к контейнеру облака, 2.49): идёт прямо в хранилище по ссылке.
  const big = Buffer.concat([Buffer.from(`%PDF-1.4 большой ${TAG}\n`), Buffer.alloc(6 * 1024 * 1024, 32)]);
  await page.getByLabel('Добавить файл (до 100 МБ)').setInputFiles({ name: 'Техпаспорт большой.pdf', mimeType: 'application/pdf', buffer: big });
  await expect(page.locator('#doc-msg')).toHaveText('Файл добавлен', { timeout: 120_000 });
  const bigDoc = page.locator('#docs li').filter({ hasText: 'Техпаспорт большой.pdf' });
  await expect(bigDoc).toContainText('6,0 МБ');
  const [bigDl] = await Promise.all([page.waitForEvent('download'), bigDoc.getByRole('button', { name: 'Скачать' }).click()]);
  const bigChunks = [];
  for await (const ch of await bigDl.createReadStream()) bigChunks.push(ch);
  expect(Buffer.concat(bigChunks).length).toBe(big.length);
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
  await mp.getByLabel('От чьего имени').selectOption({ label: `От организации ${org}` }); // название уже в кавычках (2.41)
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

test('общий прогон: помощник разбирает проблему и готовит черновик заявки; ассистент отвечает', async ({ page, browser, baseURL }) => {
  const real = await realAi(browser, baseURL);
  await enter(page, tel(4));
  await page.goto('/kabinet');
  await page.getByRole('link', { name: 'Спросить помощника' }).click();
  await expect(page.getByRole('heading', { name: 'Помощник' })).toBeVisible();
  await page.getByLabel('Что случилось').fill('Суд назначил оценку квартиры в Москве при разделе имущества. Что мне делать?');
  await page.getByRole('button', { name: 'Разобраться' }).click();
  if (real) await expect(page.locator('#pa-specialist')).not.toBeEmpty({ timeout: AI_WAIT });
  else await expect(page.locator('#pa-specialist')).toContainText('Оценка недвижимости');
  await expect(page.locator('#pa-disclaimer')).toContainText('не юридическая услуга');
  await shot(page, '08-pomoshnik');
  // Настоящая модель могла не выбрать услугу — тогда человек выбирает её сам.
  if (real && !(await page.getByLabel('Услуга для заявки').isHidden()) && !(await page.getByLabel('Услуга для заявки').inputValue())) {
    await page.getByLabel('Услуга для заявки').selectOption({ label: 'Экспертиза и оценка · Оценка недвижимости' });
  }
  await page.getByRole('button', { name: 'Создать заявку' }).click();
  await expect(page).toHaveURL(/#order=/);
  await expect(page.locator('#order-status')).toHaveText('Новая');
  if (!real) await expect(page.getByLabel('Для чего нужна оценка')).toHaveValue('court');

  await page.goto('/kabinet#assistant');
  await page.getByLabel('О какой заявке (можно не выбирать)').selectOption({ index: 1 });
  await page.getByLabel('Вопрос').fill('Какие документы подготовить к осмотру?');
  await page.getByRole('button', { name: 'Спросить' }).click();
  await expect(page.locator('#as-messages li')).toHaveCount(2, { timeout: AI_WAIT });
  await shot(page, '09-assistent');
});

// Вход через проблему на 20 типичных вопросах по оценке (2.41) — с настоящей моделью площадки. Только по запросу
// (входной параметр «problems» в Deploy core): 20 обращений к модели стоят денег. Ответы — в test-results/problem-answers.json
// (вопросы тестовые, персональных данных нет): по ним видно, понятно ли объясняет модель.
test('вход через проблему: 20 типичных вопросов — ответ понятен, без юридической консультации, всегда «что сделать самому» и «к кому»', async ({ page }) => {
  test.skip(process.env.PROBLEMS !== '1', 'по запросу: Deploy core, параметр problems');
  test.setTimeout(1_800_000);
  await enter(page, tel(4));
  const answers = [];
  const legalAdvice = /подайте[^.]*иск|стать[яиеюё]й?\s*\d|ст\.\s*\d|(?:ГК|ГПК|УК|КоАП)\s*РФ|шанс\w*[^.]{0,20}выигр|выиграете|исков\w* давност/i;
  for (const q of PROBLEM_QUESTIONS) {
    const r = await page.request.post('/api/ai/problem', { data: { text: q.text }, headers: { ...AUTH, ...H }, timeout: AI_WAIT });
    expect(r.status(), q.text).toBe(201);
    const c = (await r.json()).consultation;
    answers.push({ question: q.text, expected: q.service, got: c.service?.service ?? null, explanation: c.explanation, self_steps: c.self_steps, specialist: c.specialist, legal_note: c.legal_note, model: c.model });
    expect(c.explanation.length, q.text).toBeGreaterThan(20);
    expect(c.self_steps.length, `нет «что сделать самому»: ${q.text}`).toBeGreaterThan(0);
    expect(c.specialist || c.service, `нет «к кому обратиться»: ${q.text}`).toBeTruthy();
    for (const x of [c.explanation, ...c.self_steps, c.specialist ?? '']) expect(x, q.text).not.toMatch(legalAdvice);
    if (q.legal) expect(c.legal_note, q.text).toBeTruthy();
  }
  fs.writeFileSync('test-results/problem-answers.json', JSON.stringify(answers, null, 2));
  const matched = answers.filter((a) => a.got === a.expected).length;
  console.log(`Вход через проблему: услуга совпала в ${matched} из ${answers.length}`);
  expect(matched, 'услуга угадана слишком редко').toBeGreaterThanOrEqual(14);
});

// Часть 2: шаги администратора и диспетчера (1.4, 1.5, 1.6, 1.11) — сквозной путь заявки до выплаты исполнителю.
// Сквозной путь экспертизы (задача 2.6): заявка → осмотр → черновик → ИИ-проверка → подпись → выдача → выплата — одним прогоном.
test('общий прогон: сквозной путь экспертизы — заявка, цена, оплата, подбор, осмотр, черновик, ИИ-проверка, подпись, выдача, выплата', async ({ page, browser, baseURL }) => {
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
  await page.getByLabel('Добавить файл (до 100 МБ)').setInputFiles({ name: 'Выписка ЕГРН.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 тестовая выписка') });
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
  // Дистанционный осмотр (задача 2.3): ссылка владельцу; владелец без входа снимает фасад с геометкой и нажимает «Готово».
  await sp.getByRole('button', { name: 'Выдать ссылку владельцу' }).click();
  await expect(sp.locator('#inspect-msg')).toHaveText('Ссылка готова — отправьте её владельцу объекта');
  const inspectUrl = await sp.locator('#inspect-url').textContent();
  const jpeg = Buffer.from((await sp.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 480;
    const g = c.getContext('2d');
    g.fillStyle = '#9db4d0'; g.fillRect(0, 0, 640, 480);
    return c.toDataURL('image/jpeg', 0.8);
  })).split(',')[1], 'base64');
  const op = await phone(browser, baseURL, { permissions: ['geolocation'], geolocation: { latitude: 55.7512, longitude: 37.6184, accuracy: 12 } });
  await op.goto(inspectUrl);
  await op.getByRole('button', { name: 'Начать: разрешить определение места' }).click();
  await expect(op.locator('#geo-state')).toContainText('Место определено');
  await op.locator('#steps li[data-step="facade"] input[type=file]').setInputFiles({ name: 'facade.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  await expect(op.locator('#steps li[data-step="facade"] .msg')).toHaveText('Фото отправлено');
  await shot(op, '12o-osmotr-vladelec');
  op.once('dialog', (d) => d.accept());
  await op.getByRole('button', { name: 'Готово' }).click();
  await expect(op.locator('#closed-text')).toContainText('Эксперт получил 1 фото');
  await close(op);
  // После «Готово» ссылка больше не принимает фото.
  const op2 = await phone(browser, baseURL);
  await op2.goto(inspectUrl);
  await expect(op2.locator('#closed-text')).toHaveText('Осмотр завершён — фото переданы эксперту');
  await close(op2);
  await sp.reload();
  await expect(sp.locator('#inspect-steps li[data-step="facade"]')).toContainText('место 55.75120, 37.61840');
  await shot(sp, '12p-osmotr-foto');
  // Аналоги в деле (задача 2.32): ссылка, скриншот в хранилище Яндекса со временем платформы, текст объявления читает ИИ;
  // эксперт проверяет признаки и подтверждает. Подтверждённый аналог попадает в Word таблицей и приложением со скриншотом.
  const abox = sp.locator('#analogs-box');
  await expect(abox).toBeVisible();
  await expect(sp.locator('#analogs-hints')).toContainText('Нужно не меньше 3 аналогов — подтверждено 0');
  const adPng = Buffer.from((await sp.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 540; c.height = 1170;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 540, 1170);
    g.fillStyle = '#1f4e8c'; g.fillRect(20, 20, 500, 300);
    g.fillStyle = '#222'; g.font = '28px sans-serif'; g.fillText('2-комн. квартира, 40 м² — 11 500 000 ₽', 20, 380);
    return c.toDataURL('image/png');
  })).split(',')[1], 'base64');
  await abox.getByLabel('Ссылка на объявление').fill(`https://www.cian.ru/sale/flat/${RUN}0001/`);
  await sp.locator('#analogs-file').setInputFiles({ name: 'Screenshot_cian.png', mimeType: 'image/png', buffer: adPng });
  await sp.locator('#analogs-form details summary').click();
  await sp.locator('#analogs-text').fill(`Продаётся 2-комнатная квартира, 40 м², этаж 5 из 9, панельный дом.\nМосква, ул. Тестовая, д. 15.\nЦена 11 500 000 ₽\nРазмещено ${inDays(-5)}`);
  await abox.getByRole('button', { name: 'Добавить аналог' }).click();
  await expect(sp.locator('#analogs-msg')).toContainText(/ИИ заполнил признаков: \d+/, { timeout: AI_WAIT });
  const acard = sp.locator('#analogs-list li.analog').first();
  await expect(acard).toContainText('Аналог 1 · cian.ru');
  await expect(acard).toContainText('Скриншот получен платформой');
  await expect(acard.getByLabel(/Цена, руб/)).toHaveValue('11500000');
  await shot(sp, '12q-analog-ot-ii');
  // Эксперт проверяет: адрес и площадь — как в объявлении, и подтверждает.
  await acard.getByLabel('Адрес или район').fill('Москва, ул. Тестовая, д. 15');
  await acard.getByLabel('Площадь, кв. м').fill('40');
  await acard.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(sp.locator('#analogs-msg')).toHaveText('Аналог подтверждён');
  await expect(sp.locator('#analogs-list li.analog').first().locator('.badge')).toHaveText('подтверждён');
  await expect(sp.locator('#analogs-state')).toContainText('Подтверждено аналогов: 1 из 3');
  await shot(sp, '12r-analog-podtverzhden');
  // Распознавание скриншота (Yandex Vision): только скриншот, без текста — ИИ сам читает цену и признаки с картинки.
  await expect(sp.locator('#analogs-ai-note')).toHaveText(/ИИ прочитает скриншот/);
  const ocrPng = Buffer.from((await sp.evaluate(() => {
    const lines = ['Продаётся 2-комнатная квартира', 'Площадь 42 м², этаж 3 из 9', 'Москва, ул. Тестовая, д. 21', 'Цена 12 300 000 ₽'];
    const c = document.createElement('canvas');
    c.width = 1080; c.height = 700;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 1080, 700);
    g.fillStyle = '#111'; g.font = 'bold 56px sans-serif';
    lines.forEach((t, i) => g.fillText(t, 40, 120 + i * 140));
    return c.toDataURL('image/png');
  })).split(',')[1], 'base64');
  // После конца картинки — тот же текст для поддельного распознавания на локальном стенде (Yandex Vision его не читает).
  const ocrShot = Buffer.concat([ocrPng, Buffer.from('OCR:Продаётся 2-комнатная квартира, 42 м², этаж 3 из 9. Москва, ул. Тестовая, д. 21. Цена 12 300 000 ₽', 'utf8')]);
  await abox.getByLabel('Ссылка на объявление').fill(`https://www.cian.ru/sale/flat/${RUN}0002/`);
  await sp.locator('#analogs-file').setInputFiles({ name: 'Screenshot_cian_2.png', mimeType: 'image/png', buffer: ocrShot });
  await abox.getByRole('button', { name: 'Добавить аналог' }).click();
  await expect(sp.locator('#analogs-msg')).toContainText(/ИИ заполнил признаков: \d+/, { timeout: AI_WAIT });
  const ocard = sp.locator('#analogs-list li.analog').nth(1);
  await expect(ocard).toContainText('Аналог 2 · cian.ru');
  await expect(ocard.getByLabel(/Цена, руб/)).toHaveValue('12300000');
  await shot(sp, '12r2-analog-so-skrinshota');
  // Учебный аналог убираем — дальше в деле один подтверждённый, как раньше.
  sp.once('dialog', (d) => d.accept());
  await ocard.getByRole('button', { name: 'Убрать' }).click();
  await expect(sp.locator('#analogs-msg')).toHaveText('Аналог убран');
  await expect(sp.locator('#analogs-list li.analog')).toHaveCount(1);
  // Черновик заключения от ИИ (задача 2.2): готовится по заявке, эксперт заполняет пометки и прикладывает Word.
  await sp.getByRole('button', { name: 'Подготовить черновик с помощью ИИ' }).click();
  await expect(sp.locator('#draft-msg')).toHaveText('Черновик готов — проверьте и поправьте', { timeout: AI_WAIT });
  await expect(sp.getByLabel('Текст заключения')).toHaveValue(/## /);
  // Готовый файл Word (2.29): таблица «задание» из заявки, файл скачивается с площадки.
  await expect(sp.getByLabel('Текст заключения')).toHaveValue(/\| Сведение \| Значение \|/);
  const [wordDraft] = await Promise.all([sp.waitForEvent('download'), sp.getByRole('button', { name: 'Скачать Word' }).click()]);
  expect(wordDraft.suggestedFilename()).toBe('Отчёт об оценке.docx');
  const dchunks = [];
  for await (const ch of await wordDraft.createReadStream()) dchunks.push(ch);
  expect(Buffer.concat(dchunks).subarray(0, 2).toString()).toBe('PK');
  // Аналог из дела — в Word таблицей, скриншот из хранилища Яндекса — в приложении.
  const dxml = unzipPart(Buffer.concat(dchunks), 'word/document.xml');
  expect(dxml).toContain('Скриншоты объявлений');
  expect(dxml).toContain('cian.ru');
  expect(dxml).toMatch(/11\s500\s000/);
  const draft = await sp.getByLabel('Текст заключения').inputValue();
  await sp.getByLabel('Текст заключения').fill(draft.replace(/\[(?:заполнить|описать)[^\]]*\]/gi, 'заполнено экспертом'));
  await sp.getByLabel('Я проверил текст и отвечаю за него').check();
  await sp.getByRole('button', { name: 'Приложить как файл результата' }).click();
  await expect(sp.locator('#draft-msg')).toHaveText('Файл «Отчёт об оценке.docx» добавлен в результат работы');
  await expect(sp.locator('#docs li').filter({ hasText: 'Отчёт об оценке.docx' })).toHaveCount(1);
  await shot(sp, '12a-chernovik');
  await sp.locator('#result-file').setInputFiles({ name: 'Отчёт об оценке.txt', mimeType: 'text/plain', buffer: Buffer.from(`Отчёт об оценке квартиры. Итоговая стоимость 12 000 000 руб. ${TAG}`) });
  await expect(sp.locator('#doc-msg')).toHaveText('Файл добавлен');
  // Отчёт в PDF (задача 2.1): ИИ читает его из хранилища Яндекса и показывает отмеченное место со страницей.
  // На стр. 3 — служебная строка Word: её находит автоматическая проверка (2.8) при любой модели.
  await sp.locator('#result-file').setInputFiles({ name: 'Отчёт об оценке.pdf', mimeType: 'application/pdf', buffer: makePdf([[`Заключение № ${RUN}/2026`], ['Итоговая стоимость 12 000 000 руб.', 'В разделе 3 опечатка в адресе.'], ['См. таблицу Ошибка! Закладка не определена.']]) });
  await expect(sp.locator('#docs li').filter({ hasText: 'Отчёт об оценке.pdf' })).toHaveCount(1);
  await sp.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(sp.locator('#review-msg')).toHaveText('ИИ-проверка готова', { timeout: AI_WAIT });
  const tech = sp.locator('#review-checks > li').filter({ hasText: 'Технические ошибки' });
  await expect(tech.locator('.ai-found li')).toContainText(['Отчёт об оценке.pdf, стр. 3: Служебная строка Word «Ошибка! Закладка не определена.»']);
  if (!(await realAi(browser, baseURL))) await expect(tech.locator('.ai-marks:not(.ai-found) li')).toHaveText(['Отчёт об оценке.pdf, стр. 2: В разделе 3 опечатка в адресе.']);
  await sp.getByLabel('Сообщение').fill('Осмотр проведён, отчёт приложен.');
  await sp.getByRole('button', { name: 'Отправить сообщение' }).click();
  await expect(sp.locator('#messages li')).toHaveCount(1);
  await shot(sp, '13-specialist');
  // Подпись УКЭП (задача 2.5): без подписи не сдать; на площадке — поддельная подпись, в хранилище Яндекса рядом с файлом.
  await sp.getByRole('button', { name: 'Сдать на проверку' }).click();
  await expect(sp.locator('#status-msg')).toContainText('Подпишите УКЭП файлы результата');
  const toSign = sp.locator('#docs li').getByRole('button', { name: 'Подписать' });
  await expect(toSign).toHaveCount(3);
  while (await toSign.count()) {
    sp.once('dialog', (d) => d.accept());
    await toSign.first().click();
    await expect(sp.locator('#doc-msg')).toHaveText('Файл подписан');
  }
  await expect(sp.locator('#docs li').filter({ hasText: 'Отчёт об оценке.docx' }).locator('.sig-state')).toContainText(`Подпись эксперта: ${specName}`);
  await shot(sp, '13s-podpis');
  await sp.getByRole('button', { name: 'Сдать на проверку' }).click();
  await expect(sp.locator('#order-status')).toHaveText('Проверка результата');

  // Пока результат не проверен, заказчик его не видит.
  await page.reload();
  await expect(page.locator('#order-status')).toHaveText('Проверка результата');
  await expect(page.locator('#docs li').filter({ hasText: 'Результат работы' })).toHaveCount(0);
  // Черновик и подсказки ИИ — только эксперту и диспетчеру.
  await expect(page.locator('#draft-box')).toBeHidden();
  expect((await page.request.get(`/api/orders/${id}/draft`, { headers: { ...AUTH, ...H } })).status()).toBe(403);

  // 7. Диспетчер: ИИ-подсказки, отметки по всем правилам, «Проверено, готово».
  await dp.reload();
  await expect(dp.locator('#review-box')).toBeVisible();
  await dp.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(dp.locator('#ai-review-state')).toContainText('запускал диспетчер', { timeout: AI_WAIT });
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

  // 8. Заказчик: уведомление, результат из хранилища Яндекса скачивается и совпадает, акт, закрытие.
  await page.goto('/kabinet#notifications');
  const ready = page.locator('#notifications li').filter({ hasText: title }).filter({ hasText: 'Результат проверен и доступен в кабинете' });
  await expect(ready).toHaveCount(1);
  await ready.getByRole('button').click();
  await expect(page.locator('#order-title')).toHaveText(title);
  await expect(page.locator('#order-status')).toHaveText('Готово');
  await expect(page.locator('#messages li').first()).toContainText('Осмотр проведён');
  const res = page.locator('#docs li').filter({ hasText: 'Отчёт об оценке.txt' });
  await expect(res).toContainText('Результат работы');
  const [download] = await Promise.all([page.waitForEvent('download'), res.getByRole('button', { name: 'Скачать' }).click()]);
  const chunks = [];
  for await (const ch of await download.createReadStream()) chunks.push(ch);
  expect(Buffer.concat(chunks).toString()).toContain(TAG);
  // Заказчик получил подписанное заключение: подпись проверяется по файлу из хранилища.
  const concl = page.locator('#docs li').filter({ hasText: 'Отчёт об оценке.docx' });
  await concl.getByRole('button', { name: 'Проверить подпись' }).click();
  await expect(page.locator('#doc-msg')).toHaveText(`Подпись верна: ${specName}`);
  const [sigFile] = await Promise.all([page.waitForEvent('download'), concl.getByRole('button', { name: 'Файл подписи' }).click()]);
  expect(sigFile.suggestedFilename()).toBe('Отчёт об оценке.docx.sig');
  // Заключение — настоящий файл Word из хранилища; подсказок ИИ заказчик не видит.
  const [word] = await Promise.all([page.waitForEvent('download'), concl.getByRole('button', { name: 'Скачать' }).click()]);
  const wchunks = [];
  for await (const ch of await word.createReadStream()) wchunks.push(ch);
  expect(Buffer.concat(wchunks).subarray(0, 2).toString()).toBe('PK');
  await expect(page.locator('#draft-box')).toBeHidden();
  // Подсказок ИИ у заказчика на экране нет (скрытый раздел «Аналоги» с пустым списком подсказок — не в счёт).
  await expect(page.locator('.ai-marks:visible')).toHaveCount(0);
  await expect(page.locator('#analogs-box')).toBeHidden();
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

// Экспресс-услуга (задача 2.4): заказчик выбирает экспресс, эксперт назначает выезд помощнику, помощник на телефоне снимает
// объект с геометкой (фото — в хранилище Яндекса) и пишет данные с места; эксперт видит всё в деле.
// Помощник — свой номер +7 999 000-9x-xx из 96-00…99-99 (не пересекается с номерами прогона и администратором 95-00).
test('общий прогон: экспресс — выезд помощника, фото с геометкой и данные с объекта у эксперта', async ({ page, browser, baseURL }) => {
  const title = `Экспресс-оценка квартиры — ${TAG}`;
  const HELPER = `+79990009${96 + Math.floor(Math.random() * 4)}${Math.floor(Math.random() * 10)}`;
  const helperName = `Тестов Выездной ${RUN}`;
  const ap = await phone(browser, baseURL), dp = await phone(browser, baseURL), sp = await phone(browser, baseURL);
  const hp = await phone(browser, baseURL, { permissions: ['geolocation'], geolocation: { latitude: 55.7601, longitude: 37.6202, accuracy: 9 } });
  await enter(dp, tel(5));
  const spec = await enter(sp, tel(6));
  await enter(hp, HELPER, helperName);
  await enter(ap, ADMIN);
  // Администратор отмечает помощника на объекте (Москва).
  await ap.goto('/kabinet#admin');
  await findUser(ap, HELPER);
  await ap.getByLabel('Московская область').uncheck();
  await ap.getByLabel('Помощник на объекте: выезды по экспресс-заявкам').check();
  await ap.getByRole('button', { name: 'Сохранить профиль специалиста' }).click();
  await expect(ap.getByText('Профиль специалиста сохранён')).toBeVisible();
  await close(ap);

  const h = { ...AUTH, ...H };
  await enter(page, tel(7));
  const id = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title }, headers: h })).json()).order.id;
  expect((await page.request.patch(`/api/orders/${id}`, {
    data: { deadline: inDays(6), fields: { purpose: 'bank', region: 'moscow', object_type: 'flat', address: 'г. Москва, ул. Экспрессная, д. 3', area: '39' } }, headers: h,
  })).status()).toBe(200);
  await page.goto(`/kabinet#order=${id}`);
  await page.getByLabel('Экспресс: на объект приедет помощник').check();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.locator('#order-meta')).toContainText('Экспресс: выезд помощника');
  await page.getByRole('button', { name: 'Отправить заявку' }).click();
  await expect(page.locator('#order-status')).toHaveText('Подбор исполнителя');
  expect((await dp.request.put(`/api/orders/${id}/price`, { data: { price: '15000' }, headers: h })).status()).toBe(200);
  await page.reload();
  await page.getByRole('button', { name: /Оплатить 15\s000 ₽/ }).click();
  await expect(page.locator('#money-facts')).toContainText('оплачено');
  expect((await dp.request.post(`/api/orders/${id}/offer`, { data: { specialist_id: spec.id, from: 'matching' }, headers: h })).status()).toBe(200);
  expect((await sp.request.post(`/api/orders/${id}/status`, { data: { from: 'awaiting_executor', to: 'in_work' }, headers: h })).status()).toBe(200);

  // Эксперт назначает выезд.
  await sp.goto(`/kabinet#order=${id}`);
  await sp.getByLabel('Помощник на объекте', { exact: true }).selectOption({ label: helperName });
  await sp.getByRole('button', { name: 'Назначить выезд' }).click();
  await expect(sp.locator('#onsite-msg')).toHaveText('Выезд назначен — помощник получил уведомление');
  await shot(sp, '14-express-vyezd');

  // Помощник: выезд в разделе «Специалист», фото фасада с геометкой, данные, «Готово».
  await hp.goto('/kabinet#specialist');
  const visit = hp.locator('#visits li').filter({ hasText: 'г. Москва, ул. Экспрессная, д. 3' });
  await visit.first().getByRole('link', { name: 'Открыть выезд' }).click();
  await expect(hp.locator('#page-title')).toHaveText('Выезд на объект');
  await hp.getByRole('button', { name: 'Начать: разрешить определение места' }).click();
  await expect(hp.locator('#geo-state')).toContainText('Место определено');
  const jpeg = Buffer.from((await hp.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 480;
    const g = c.getContext('2d');
    g.fillStyle = '#c9d6c0'; g.fillRect(0, 0, 640, 480);
    return c.toDataURL('image/jpeg', 0.8);
  })).split(',')[1], 'base64');
  await hp.locator('#steps li[data-step="facade"] input[type=file]').setInputFiles({ name: 'facade.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  await expect(hp.locator('#steps li[data-step="facade"] .msg')).toHaveText('Фото отправлено');
  await hp.getByLabel('Общее состояние *').selectOption('normal');
  await hp.getByLabel('Объект соответствует заявке *').selectOption('yes');
  await hp.getByLabel('Площадь по замеру, кв. м').fill('38,7');
  await shot(hp, '14p-express-pomoshnik');
  hp.once('dialog', (d) => d.accept());
  await hp.getByRole('button', { name: 'Готово' }).click();
  await expect(hp.locator('#closed-text')).toContainText('Эксперт получил 1 фото и данные с объекта');
  await close(hp);

  // Эксперт: выезд завершён, данные и фото с местом.
  await sp.reload();
  await expect(sp.locator('#onsite-visits li').first()).toContainText('завершён');
  await expect(sp.locator('#onsite-visits li dl').first()).toContainText('38.7');
  await expect(sp.locator('#inspect-steps li[data-step="facade"]')).toContainText('место 55.76010, 37.62020');
  await shot(sp, '14e-express-dannye');
  await close(sp);
  await close(dp);
});

// Две подписи (задача 2.5а): эксперт работает от организации — загружает готовую подпись «из программы УЦ», руководитель
// организации по уведомлению подписывает от организации; без подписи организации сдать нельзя; заказчик видит и проверяет
// обе, файлы подписей — из хранилища Яндекса. Диспетчер — из сквозного пути выше. Эксперт — отдельный (номер постороннего из
// первой проверки, у него нет дел): сменить организацию можно только без дел в работе.
test('общий прогон: две подписи — эксперт от организации загружает готовую подпись, руководитель подписывает от организации', async ({ page, browser, baseURL }) => {
  const title = `Оценка квартиры, две подписи — ${TAG}`;
  const org = `ООО «Тестовая оценочная компания ${RUN}»`;
  const specName = `Тестов Эксперт Компании ${RUN}`;
  const headName = `Тестовый Руководитель ${RUN}`;
  const ap = await phone(browser, baseURL), dp = await phone(browser, baseURL), sp = await phone(browser, baseURL), hp = await phone(browser, baseURL);
  await enter(dp, tel(5));
  const spec = await enter(sp, tel(1), specName);
  await enter(hp, tel(2), headName);
  await enter(ap, ADMIN);
  await ap.goto('/kabinet#admin');
  await findUser(ap, tel(1));
  await ap.getByRole('button', { name: 'Сохранить профиль специалиста' }).click();
  await expect(ap.getByText('Профиль специалиста сохранён')).toBeVisible();
  await ap.getByLabel('Дать допуск на услугу').selectOption('expertise/realty');
  await ap.getByRole('button', { name: 'Дать допуск' }).click();
  await expect(ap.locator('#sp-permits li')).toContainText('недвижимости');
  await close(ap);

  // Руководитель заводит организацию и приглашает эксперта; эксперт принимает и выбирает, что работает от неё.
  await hp.goto('/kabinet#orgs');
  await hp.getByLabel('Название', { exact: true }).fill(org);
  await hp.getByRole('button', { name: 'Создать организацию' }).click();
  await expect(hp.getByRole('heading', { name: org })).toBeVisible();
  const orgUrl = hp.url();
  await hp.getByLabel('Номер телефона сотрудника').fill(tel(1));
  await hp.getByRole('button', { name: 'Пригласить' }).click();
  await expect(hp.getByText('Приглашение отправлено')).toBeVisible();
  await sp.goto('/kabinet#orgs');
  await sp.locator('#invites li').filter({ hasText: org }).getByRole('button', { name: 'Принять' }).click();
  await expect(sp.getByText('Ваша роль: Сотрудник')).toBeVisible();
  await sp.goto('/kabinet#specialist');
  await sp.getByLabel('Работаю от организации').selectOption({ label: org });
  await expect(sp.locator('#specialist-msg')).toHaveText('Теперь заключение подписывает ещё руководитель организации');
  await shot(sp, '30-specialist-organizaciya');

  // Заявка, цена, оплата, предложение и принятие — как в сквозном пути, коротко.
  const h = { ...AUTH, ...H };
  await enter(page, tel(7));
  const id = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title }, headers: h })).json()).order.id;
  expect((await page.request.patch(`/api/orders/${id}`, {
    data: { deadline: inDays(8), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, ул. Подписная, д. 2', area: '44' } }, headers: h,
  })).status()).toBe(200);
  expect((await page.request.post(`/api/orders/${id}/status`, { data: { from: 'new', to: 'matching' }, headers: h })).status()).toBe(200);
  expect((await dp.request.put(`/api/orders/${id}/price`, { data: { price: '16000' }, headers: h })).status()).toBe(200);
  await page.goto(`/kabinet#order=${id}`);
  await page.getByRole('button', { name: /Оплатить 16\s000 ₽/ }).click();
  await expect(page.locator('#money-facts')).toContainText('оплачено');
  expect((await dp.request.post(`/api/orders/${id}/offer`, { data: { specialist_id: spec.id, from: 'matching' }, headers: h })).status()).toBe(200);
  expect((await sp.request.post(`/api/orders/${id}/status`, { data: { from: 'awaiting_executor', to: 'in_work' }, headers: h })).status()).toBe(200);

  // Эксперт прикладывает отчёт и загружает к нему готовую подпись; без подписи организации сдать нельзя.
  const report = makePdf([[`Отчёт об оценке № ${RUN}-2П/2026`], [`Итоговая стоимость 13 500 000 руб. ${TAG}`]]);
  const digest = crypto.createHash('sha256').update(report).digest('hex');
  await sp.goto(`/kabinet#order=${id}`);
  await expect(sp.locator('#order-status')).toHaveText('В работе');
  await sp.locator('#result-file').setInputFiles({ name: 'Отчёт компании.pdf', mimeType: 'application/pdf', buffer: report });
  const doc = sp.locator('#docs li').filter({ hasText: 'Отчёт компании.pdf' });
  await expect(doc.locator('[data-sig="org-wait"]')).toContainText(`подписывает руководитель организации ${org}`);
  sp.once('dialog', (d) => d.accept());
  await doc.locator('input[type=file]').setInputFiles({ name: 'Отчёт компании.pdf.sig', mimeType: 'application/octet-stream', buffer: testExternalSignature({ digest, subject: specName }) });
  await expect(sp.locator('#doc-msg')).toHaveText('Подпись проверена и добавлена');
  await expect(doc.locator('.sig-state').first()).toContainText(`Подпись эксперта: ${specName}`);
  await expect(doc).toContainText('загружена готовым файлом');
  await sp.getByRole('button', { name: 'Сдать на проверку' }).click();
  await expect(sp.locator('#status-msg')).toContainText(`Нужна подпись организации ${org} (руководитель): Отчёт компании.pdf`);
  await shot(sp, '31-specialist-gotovaya-podpis');

  // Руководитель: уведомление; в организации видит только файл (не заявку), скачивает его и подписывает от организации.
  await hp.goto('/kabinet#notifications');
  await expect(hp.locator('#notifications li').filter({ hasText: 'нужна подпись организации' }).first()).toBeVisible();
  await hp.goto(orgUrl);
  await hp.reload();
  await expect(hp.locator('#org-title')).toHaveText(org);
  const item = hp.locator('#org-sign li.doc').filter({ hasText: 'Отчёт компании.pdf' });
  await expect(item.locator('.sig-state').first()).toContainText(`Подпись эксперта: ${specName}`);
  await expect(hp.locator('#org-sign')).not.toContainText(title);
  const [file] = await Promise.all([hp.waitForEvent('download'), item.getByRole('button', { name: 'Скачать' }).click()]);
  const fchunks = [];
  for await (const ch of await file.createReadStream()) fchunks.push(ch);
  expect(crypto.createHash('sha256').update(Buffer.concat(fchunks)).digest('hex')).toBe(digest);
  hp.once('dialog', (d) => d.accept());
  await item.getByRole('button', { name: 'Подписать от организации' }).click();
  await expect(hp.locator('#org-sign-msg')).toHaveText('Файл подписан от организации');
  await expect(item.locator('.sig-state').nth(1)).toContainText(`Подпись организации: ${org} — руководитель ${headName}`);
  expect((await hp.request.get(`/api/orders/${id}`, { headers: h })).status()).toBe(404);
  await shot(hp, '32-rukovoditel-podpis');

  // Дела экспертов (2.16): дело эксперта — без названия заявки и адреса; вознаграждение и «ждёт выдачи» — 80% цены.
  const cases = hp.locator('#org-cases-box');
  await expect(hp.locator('#org-cases > li').first()).toContainText(`В работе · эксперт: ${specName}`);
  await expect(hp.locator('#org-cases > li').first()).toContainText('вознаграждение 12 800 ₽');
  await expect(cases).not.toContainText(title);
  await expect(cases).not.toContainText('Подписная');
  await expect(hp.locator('#org-cases-money')).toContainText('Ждёт выдачи результата12 800 ₽');
  await shot(hp, '32a-rukovoditel-dela-ekspertov');

  // Эксперт сдаёт; диспетчер проверяет по всем правилам; заказчик видит обе подписи и проверяет их.
  await sp.reload();
  await expect(doc.locator('.sig-state')).toHaveCount(2);
  await sp.getByRole('button', { name: 'Сдать на проверку' }).click();
  await expect(sp.locator('#order-status')).toHaveText('Проверка результата');
  await dp.goto(`/kabinet#order=${id}`);
  await expect(dp.locator('#review-box')).toBeVisible();
  const rules = dp.locator('#review-checks > li');
  await expect(rules.first()).toBeVisible();
  const n = await rules.count();
  for (let i = 0; i < n; i += 1) {
    await rules.nth(i).getByRole('button', { name: 'В порядке' }).click();
    await expect(rules.nth(i).locator('.verdict')).toHaveText('В порядке');
  }
  await dp.getByRole('button', { name: 'Проверено, готово' }).click();
  await expect(dp.locator('#order-status')).toHaveText('Готово');
  await page.reload();
  await expect(page.locator('#order-status')).toHaveText('Готово');
  const got = page.locator('#docs li').filter({ hasText: 'Отчёт компании.pdf' });
  await expect(got.locator('.sig-state')).toHaveCount(2);
  await got.getByRole('button', { name: 'Проверить подпись' }).click();
  await expect(page.locator('#doc-msg')).toHaveText(`Подпись верна: ${specName} и ${org}`);
  const [orgSig] = await Promise.all([page.waitForEvent('download'), got.getByRole('button', { name: 'Подпись организации' }).click()]);
  expect(orgSig.suggestedFilename()).toBe('Отчёт компании.pdf.org.sig');
  await shot(page, '33-zakazchik-dve-podpisi');
  await hp.reload();
  await expect(hp.locator('#org-cases li.group')).toHaveText('Завершённые · 1');
  await expect(hp.locator('#org-cases-money')).toContainText('12 800 ₽');
  await shot(hp, '33a-rukovoditel-vyplacheno');
  for (const p of [dp, sp, hp]) await close(p);
});
