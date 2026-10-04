// Экскурсия по кабинетам для Дамира (решение 03.10.2026, «Порядок работ», пункт а): один проход по площадке stage на
// телефоне 412×915 — кабинет эксперта, руководителя организации, заказчика и диспетчера. Снимки — по разделам экрана
// (test-results/screens/tour-NN-*.png), подписи — test-results/tour.json; PDF собирается из них (tests/tools/tour-pdf.mjs).
// Запускается только по просьбе (TOUR=1, workflow Deploy core с отметкой «Экскурсия»); в обычной выкладке пропускается.
// Только тестовые данные: номера +7999000xxxx, вымышленные марка, VIN и отчёт.
import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import { makePdf } from '../tools/make-docs.mjs';

const TOUR = process.env.TOUR === '1';
const TOKEN = process.env.STAGE_INVOKE_TOKEN;
const LOGIN_KEY = process.env.STAGE_LOGIN_KEY;
const ADMIN = process.env.STAGE_ADMIN_PHONE;
const AUTH = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};
const H = { 'x-delo-request': '1' };
const AI_WAIT = 150_000; // настоящая модель отвечает дольше

const test = base.extend({
  context: async ({ context, baseURL }, use) => {
    const origin = new URL(baseURL).origin;
    await context.route((u) => u.origin === origin, async (route) => route.continue({ headers: { ...(await route.request().allHeaders()), ...AUTH } }));
    await use(context);
  },
});

async function phone(browser, baseURL, extra = {}) {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ru-RU', timezoneId: 'Europe/Moscow', acceptDownloads: true, ...extra });
  const origin = new URL(baseURL).origin;
  await ctx.route((u) => u.origin === origin, async (route) => route.continue({ headers: { ...(await route.request().allHeaders()), ...AUTH } }));
  return ctx.newPage();
}

async function enter(page, phoneNo, name) {
  const r = await page.request.post('/__stage/login', { data: { phone: phoneNo }, headers: { ...AUTH, ...H, 'x-stage-login': LOGIN_KEY } });
  expect(r.status(), await r.text()).toBe(200);
  const { user } = await r.json();
  if (name) expect((await page.request.patch('/api/me', { data: { full_name: name }, headers: { ...AUTH, ...H } })).status()).toBe(200);
  return user;
}

const shown = (p) => p.replace(/^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/, '+7 $1 $2-$3-$4');
async function findUser(ap, phoneNo) {
  await ap.getByLabel('Номер телефона пользователя').fill(phoneNo);
  await ap.getByRole('button', { name: 'Найти' }).click();
  await expect(ap.locator('#admin-user-meta')).toContainText(shown(phoneNo));
  // Профиль специалиста дорисовывается после — ждём, пока на экране профиль именно этого человека.
  await expect(ap.locator('#admin-specialist')).toHaveAttribute('data-phone', phoneNo);
}

// Снимок раздела экрана с подписью. what — один или несколько разделов (снимаются вместе: от верха первого до низа
// последнего); без what — экран целиком, как его видит человек.
const shots = [];
const card = (page, scope, heading) => page.locator(`${scope} .card`).filter({ has: page.getByRole('heading', { name: heading, exact: true }) });
async function snap(page, cabinet, title, caption, what) {
  const n = String(shots.length + 1).padStart(2, '0');
  const file = `tour-${n}.png`;
  const path = `test-results/screens/${file}`;
  await page.waitForTimeout(300);
  if (!what) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path });
  } else {
    const list = (Array.isArray(what) ? what : [what]).map((s) => (typeof s === 'string' ? page.locator(s) : s));
    await list[0].scrollIntoViewIfNeeded();
    const boxes = [];
    for (const l of list) boxes.push(await l.boundingBox());
    const sx = await page.evaluate(() => window.scrollY);
    const top = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 8);
    const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + 8;
    await page.screenshot({ path, fullPage: true, clip: { x: 0, y: top + sx, width: 412, height: Math.min(bottom - top, 4000) } });
  }
  shots.push({ file, cabinet, title, caption });
  fs.writeFileSync('test-results/tour.json', JSON.stringify({ at: new Date().toISOString(), base: 'stage', shots }, null, 2));
}

// Номера экскурсии: +7 999 000-9N-Dx, N — 1…4 (не пересекаются с общим прогоном 20…89, администратором 95-00 и помощником 96…99).
const RUN = `9${1 + Math.floor(Math.random() * 4)}${Math.floor(Math.random() * 10)}`;
const tel = (i) => `+7999000${RUN}${i}`;
const inDays = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

// Обезличенный тестовый отчёт об оценке транспорта: вымышленные марка, VIN и организации; в нём ошибки, похожие на найденные
// в настоящем отчёте, — год в выводах не тот, «Ошибка! Закладка не определена», после раздела 13 сразу 15.
const REPORT = [
  ['ОТЧЁТ ОБ ОЦЕНКЕ № ' + RUN + '/2026', 'Объект: грузовой фургон «Тестмаш 3000» 2024 г.в., VIN: XTA000000R0000001', 'Заказчик: ООО «Заказчик-1»'],
  ['СОДЕРЖАНИЕ', '12. АНАЛИЗ РЫНКА ........ 15', '13. ОБОСНОВАНИЕ ПОДХОДОВ ........ 16', '15. РАСЧЁТ СТОИМОСТИ ........ 16',
    '15.2. СРАВНИТЕЛЬНЫЙ ПОДХОД ........ Ошибка! Закладка не определена.', '16. ОБОБЩЕНИЕ РЕЗУЛЬТАТОВ ........ 19'],
  ['1. ОСНОВНЫЕ ФАКТЫ И ВЫВОДЫ', 'Проведена оценка объекта: грузовой фургон «Тестмаш 3000» 2019 г.в., VIN: XTA000000R0000001.',
    'Рыночная стоимость составляет 2 400 000 (Два миллиона четыреста тысяч) рублей.'],
];

test.describe.configure({ mode: 'serial', timeout: 900_000 });
test.use({ actionTimeout: 30_000, timezoneId: 'Europe/Moscow' });

test('экскурсия по кабинетам: эксперт, руководитель организации, заказчик, диспетчер', async ({ page, browser, baseURL }) => {
  test.skip(!TOUR, 'экскурсия — только по просьбе (TOUR=1)');
  if (!TOKEN || !LOGIN_KEY || !/^\+7999000\d{4}$/.test(ADMIN || '')) throw new Error('нужны STAGE_INVOKE_TOKEN, STAGE_LOGIN_KEY, STAGE_ADMIN_PHONE');
  fs.mkdirSync('test-results/screens', { recursive: true });
  const C = tel(0), D = tel(1), S = tel(2), HEAD = tel(3), E = tel(4);
  const org = `ООО «Тестовая оценка ${RUN}»`;
  const specName = `Тестов Эксперт ${RUN}`;
  const headName = `Тестова Руководитель ${RUN}`;
  const empName = `Тестов Сотрудник ${RUN}`;
  const title = `Оценка фургона для суда — тест ${RUN}`;
  const h = { ...AUTH, ...H };

  const ap = await phone(browser, baseURL), dp = await phone(browser, baseURL), sp = await phone(browser, baseURL);
  const hp = await phone(browser, baseURL), ep = await phone(browser, baseURL);
  await enter(ap, ADMIN);
  await enter(dp, D, `Тестовый Диспетчер ${RUN}`);
  const spec = await enter(sp, S, specName);
  await enter(hp, HEAD, headName);
  await enter(ep, E, empName);

  // Подготовка (без снимков): диспетчер, эксперт с допуском на оценку транспорта.
  await ap.goto('/kabinet#admin');
  await findUser(ap, D);
  await ap.getByLabel('Служебная роль').selectOption('dispatcher');
  await ap.getByRole('button', { name: 'Сохранить роль' }).click();
  await expect(ap.getByText('Роль сохранена')).toBeVisible();
  await findUser(ap, S);
  await ap.getByRole('button', { name: 'Сохранить профиль специалиста' }).click();
  await expect(ap.getByText('Профиль специалиста сохранён')).toBeVisible();
  await ap.getByLabel('Дать допуск на услугу').selectOption('expertise/vehicle');
  await ap.getByRole('button', { name: 'Дать допуск' }).click();
  await expect(ap.locator('#sp-permits li')).toContainText('транспорт');

  // ——— Руководитель организации: заводит организацию, приглашает эксперта и сотрудника ———
  await hp.goto('/kabinet#orgs');
  await hp.getByLabel('Название', { exact: true }).fill(org);
  await hp.getByRole('button', { name: 'Создать организацию' }).click();
  await expect(hp.getByRole('heading', { name: org })).toBeVisible();
  const orgUrl = hp.url();
  for (const who of [S, E]) {
    await hp.getByLabel('Номер телефона сотрудника').fill(who);
    await hp.getByRole('button', { name: 'Пригласить' }).click();
    await expect(hp.getByText('Приглашение отправлено')).toBeVisible();
  }
  for (const p of [sp, ep]) {
    await p.goto('/kabinet#orgs');
    await p.locator('#invites li').filter({ hasText: org }).getByRole('button', { name: 'Принять' }).click();
    await expect(p.getByText('Ваша роль: Сотрудник')).toBeVisible();
  }
  await sp.goto('/kabinet#specialist');
  await sp.getByLabel('Работаю от организации').selectOption({ label: org });
  await expect(sp.locator('#specialist-msg')).toHaveText('Теперь заключение подписывает ещё руководитель организации');

  // ——— Заказчик ———
  const lp = await phone(browser, baseURL);
  await lp.goto('/');
  await expect(lp.getByRole('button').first()).toBeVisible();
  await snap(lp, 'Заказчик', 'Вход', 'Вход по номеру телефона: робот звонит и называет код. Пароль не нужен.');
  await lp.context().close();
  await enter(page, C, 'Тестова Заказчица');
  await page.goto('/kabinet');
  await expect(page.locator('#who')).toHaveText('Тестова Заказчица');
  await snap(page, 'Заказчик', 'Главная: мои заявки', 'Список своих заявок, кнопка «Спросить помощника» и новая заявка. Вверху — разделы кабинета: Заявки, Помощник, Уведомления, Организации и другие (строка прокручивается вбок).');
  await page.getByRole('link', { name: 'Спросить помощника' }).click();
  await page.getByLabel('Что случилось').fill('Суд назначил оценку нашего грузового автомобиля (фургон) в Московской области по спору с лизинговой компанией. Что делать?');
  await page.getByRole('button', { name: 'Разобраться' }).click();
  const real = (await (await ap.request.get('/api/admin/ai', { headers: AUTH })).json()).primary.driver !== 'fake';
  if (real) await expect(page.locator('#pa-specialist')).not.toBeEmpty({ timeout: AI_WAIT });
  else await expect(page.locator('#pa-specialist')).toContainText('транспорт');
  await snap(page, 'Заказчик', 'Помощник разбирает проблему', 'Человек пишет своими словами — помощник объясняет, что можно сделать самому, к кому идти, и предлагает заявку. Это разъяснение, не юридическая услуга.', '#problem-answer');
  if (real && !(await page.getByLabel('Услуга для заявки').isHidden()) && !(await page.getByLabel('Услуга для заявки').inputValue())) {
    await page.getByLabel('Услуга для заявки').selectOption({ label: 'Экспертиза и оценка · Оценка транспортного средства' });
  }
  await page.getByRole('button', { name: 'Создать заявку' }).click();
  await expect(page.locator('#order-status')).toHaveText('Новая');
  const id = new URL(page.url()).hash.match(/^#order=([0-9a-f-]{36})$/i)[1];
  // Настоящая модель могла выбрать другую услугу — эксперт и экскурсия про оценку транспорта.
  await page.locator('#d-service').selectOption({ label: 'Оценка транспортного средства' });
  await page.getByLabel('Название заявки').fill(title);
  await page.getByLabel('Вид транспорта').selectOption({ label: 'Грузовой автомобиль' });
  await page.getByLabel('Марка и модель').fill('Тестмаш 3000 (вымышленная)');
  await page.getByLabel('Год выпуска').fill('2024');
  await page.getByLabel('VIN').fill('XTA000000R0000001');
  await page.getByLabel(/^Срок/).fill(inDays(10));
  await page.getByLabel('Добавить файл (до 100 МБ)').setInputFiles({ name: 'ПТС (тест).pdf', mimeType: 'application/pdf', buffer: makePdf([['Тестовый ПТС: Тестмаш 3000, 2024 г.в.']]) });
  await expect(page.getByText('Файл добавлен')).toBeVisible();
  await snap(page, 'Заказчик', 'Заявка: данные', 'Поля заявки на оценку транспорта: вид, марка, год, VIN, срок, основание. Помощник уже заполнил цель и регион.', '#details-form');
  await page.getByRole('button', { name: 'Отправить заявку' }).click();
  await expect(page.locator('#order-status')).toHaveText('Подбор исполнителя');

  // ——— Диспетчер: цена ———
  await dp.goto('/kabinet');
  await snap(dp, 'Диспетчер', 'Все заявки', 'Диспетчер видит все заявки и может отобрать их по состоянию.', '#list-view .card >> nth=0');
  await dp.goto(`/kabinet#order=${id}`);
  await expect(dp.locator('#order-title')).toHaveText(title);
  await dp.getByLabel('Цена, рублей').fill('20000');
  await dp.getByRole('button', { name: 'Назначить цену' }).click();
  await expect(dp.locator('#money-msg')).toHaveText('Цена назначена');
  await snap(dp, 'Диспетчер', 'Цена заявки', 'Диспетчер назначает цену; сразу видно, сколько получит исполнитель (80%) и платформа (20%).', '#money-box');

  // ——— Заказчик: оплата ———
  await page.reload();
  await page.getByRole('button', { name: /Оплатить 20\s000 ₽/ }).click();
  await expect(page.locator('#money-facts')).toContainText('оплачено');
  await snap(page, 'Заказчик', 'Оплата', 'Заказчик платит при заказе (на площадке — тестовая оплата). Деньги исполнителю — после выдачи результата.', '#money-box');

  // ——— Диспетчер: подбор ———
  await dp.reload();
  const cand = dp.locator('#candidates li').filter({ hasText: specName });
  await expect(cand).toContainText('из 100');
  await snap(dp, 'Диспетчер', 'Подбор исполнителя', 'Список специалистов с допуском на эту услугу и оценкой по району, загрузке, сроку и качеству. Диспетчер предлагает дело.', '#match-box');
  dp.once('dialog', (d) => d.accept());
  await cand.getByRole('button', { name: 'Предложить дело' }).click();
  await expect(dp.locator('#order-status')).toHaveText('Ждёт исполнителя');

  // ——— Эксперт ———
  await sp.goto('/kabinet#notifications');
  await expect(sp.locator('#notifications li').filter({ hasText: 'Вам предложено новое дело' }).first()).toBeVisible();
  await snap(sp, 'Эксперт', 'Уведомления: предложение дела', 'Предложения дел приходят уведомлением (и СМС, если включено). Отдельной ленты предложений пока нет.');
  await sp.goto('/kabinet');
  await snap(sp, 'Эксперт', 'Мои дела', 'Все дела эксперта одним списком: предложенные, в работе, на проверке, готовые.', '#list-view .card >> nth=0');
  await sp.goto(`/kabinet#order=${id}`);
  await expect(sp.locator('#money-facts')).toContainText(/Ваше вознаграждение \(80% цены\)\s*16\s000 ₽/);
  await snap(sp, 'Эксперт', 'Предложенное дело', 'Эксперт видит данные заявки, срок и своё вознаграждение и решает: принять или отказаться.');
  await sp.getByRole('button', { name: 'Принять дело' }).click();
  await expect(sp.locator('#order-status')).toHaveText('В работе');
  await snap(sp, 'Эксперт', 'Дело в работе: данные и документы', 'Данные заявки, документы заказчика (ПТС), ход заявки и история.', ['#details-view', card(sp, '#order-view', 'Документы')]);

  // Осмотр: ссылка владельцу, владелец снимает по шагам с геометкой.
  await sp.getByRole('button', { name: 'Выдать ссылку владельцу' }).click();
  await expect(sp.locator('#inspect-msg')).toHaveText('Ссылка готова — отправьте её владельцу объекта');
  const inspectUrl = await sp.locator('#inspect-url').textContent();
  await snap(sp, 'Эксперт', 'Дистанционный осмотр: ссылка', 'Эксперт выдаёт ссылку владельцу машины — тот снимет её по шагам сам, без входа и пароля.', '#inspect-box');
  const jpeg = Buffer.from((await sp.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 480;
    const g = c.getContext('2d');
    g.fillStyle = '#b8c4d6'; g.fillRect(0, 0, 640, 480);
    g.fillStyle = '#334'; g.fillRect(160, 220, 320, 120);
    return c.toDataURL('image/jpeg', 0.8);
  })).split(',')[1], 'base64');
  const op = await phone(browser, baseURL, { permissions: ['geolocation'], geolocation: { latitude: 55.9, longitude: 37.4, accuracy: 10 } });
  await op.goto(inspectUrl);
  await op.getByRole('button', { name: 'Начать: разрешить определение места' }).click();
  await expect(op.locator('#geo-state')).toContainText('Место определено');
  for (const step of ['car_front', 'car_vin', 'car_odometer']) {
    await op.locator(`#steps li[data-step="${step}"] input[type=file]`).setInputFiles({ name: `${step}.jpg`, mimeType: 'image/jpeg', buffer: jpeg });
    await expect(op.locator(`#steps li[data-step="${step}"] .msg`)).toHaveText('Фото отправлено');
  }
  await snap(op, 'Владелец объекта', 'Осмотр с телефона владельца', 'Владелец по ссылке снимает машину по шагам: спереди, сзади, VIN, пробег, салон. У каждого фото — время и место.');
  op.once('dialog', (d) => d.accept());
  await op.getByRole('button', { name: 'Готово' }).click();
  await expect(op.locator('#closed-text')).toContainText('Эксперт получил 3 фото');
  await op.context().close();
  await sp.reload();
  await expect(sp.locator('#inspect-steps li[data-step="car_vin"]')).toContainText('место');
  await snap(sp, 'Эксперт', 'Осмотр: фото в деле', 'Фото владельца — в деле у эксперта, с временем и местом съёмки.', '#inspect-box');

  // Черновик от ИИ.
  await sp.getByRole('button', { name: 'Подготовить черновик с помощью ИИ' }).click();
  await expect(sp.locator('#draft-msg')).toHaveText('Черновик готов — проверьте и поправьте', { timeout: AI_WAIT });
  await snap(sp, 'Эксперт', 'Черновик заключения от ИИ', 'ИИ готовит черновик по заявке, документам и фото. Где нужен расчёт или вывод эксперта — пометка [заполнить]. Эксперт правит текст и сам отвечает за него.', '#draft-box');
  const draft = await sp.getByLabel('Текст заключения').inputValue();
  await sp.getByLabel('Текст заключения').fill(draft.replace(/\[(?:заполнить|описать)[^\]]*\]/gi, 'заполнено экспертом'));
  await sp.getByLabel('Я проверил текст и отвечаю за него').check();
  await sp.getByRole('button', { name: 'Приложить как файл результата' }).click();
  await expect(sp.locator('#draft-msg')).toHaveText('Файл «Отчёт об оценке.docx» добавлен в результат работы');

  // Отчёт и ИИ-проверка.
  await sp.locator('#result-file').setInputFiles({ name: 'Отчёт об оценке (тест).pdf', mimeType: 'application/pdf', buffer: makePdf(REPORT) });
  await expect(sp.locator('#docs li').filter({ hasText: 'Отчёт об оценке (тест).pdf' })).toHaveCount(1);
  await sp.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(sp.locator('#review-msg')).toHaveText('ИИ-проверка готова', { timeout: AI_WAIT });
  await snap(sp, 'Эксперт', 'ИИ-проверка отчёта', 'Перед сдачей ИИ проверяет отчёт по правилам: реквизиты, данные объекта, расчёт, аналоги, технические ошибки — и показывает места со страницей. Решение — за экспертом.', '#review-box');

  // Подпись эксперта; без подписи организации сдать нельзя.
  const toSign = sp.locator('#docs li').getByRole('button', { name: 'Подписать' });
  await expect(toSign.first()).toBeVisible();
  while (await toSign.count()) {
    sp.once('dialog', (d) => d.accept());
    await toSign.first().click();
    await expect(sp.locator('#doc-msg')).toHaveText('Файл подписан');
  }
  await sp.getByRole('button', { name: 'Сдать на проверку' }).click();
  await expect(sp.locator('#status-msg')).toContainText(`Нужна подпись организации ${org}`);
  await snap(sp, 'Эксперт', 'Подпись УКЭП и сдача', 'Эксперт подписывает файлы своей подписью (в кабинете или загрузкой готовой). Сдать нельзя, пока не подписал и руководитель организации.', [card(sp, '#order-view', 'Документы')]);

  // ——— Сотрудник организации заказывает от организации — руководитель видит его дело ———
  await ep.goto('/kabinet');
  await ep.locator('#new-order').getByLabel('Услуга').selectOption({ label: 'Оценка транспортного средства' });
  await ep.getByLabel('Коротко: что нужно').fill(`Оценка служебного автомобиля — тест ${RUN}`);
  await ep.getByLabel('От чьего имени').selectOption({ label: `От организации ${org}` });
  await ep.getByRole('button', { name: 'Создать заявку' }).click();
  await expect(ep.locator('#order-status')).toHaveText('Новая');

  // ——— Руководитель организации ———
  await hp.goto('/kabinet#notifications');
  await expect(hp.locator('#notifications li').filter({ hasText: 'нужна подпись организации' }).first()).toBeVisible();
  await snap(hp, 'Руководитель организации', 'Уведомления', 'Руководителю приходит уведомление: эксперт организации подписал файл, нужна подпись организации.');
  await hp.goto(orgUrl);
  await hp.reload();
  await expect(hp.locator('#org-title')).toHaveText(org);
  await snap(hp, 'Руководитель организации', 'Организация и сотрудники', 'Данные организации, сотрудники с ролями и числом дел, приглашения. Здесь же руководитель убирает ушедшего сотрудника.', ['#org-view .card >> nth=0', card(hp, '#org-view', 'Сотрудники')]);
  const item = hp.locator('#org-sign li.doc').filter({ hasText: 'Отчёт об оценке (тест).pdf' });
  await expect(item).toBeVisible();
  for (const name of ['Отчёт об оценке (тест).pdf', 'Отчёт об оценке.docx']) {
    const it = hp.locator('#org-sign li.doc').filter({ hasText: name });
    hp.once('dialog', (d) => d.accept());
    await it.getByRole('button', { name: 'Подписать от организации' }).click();
    await expect(hp.locator('#org-sign-msg')).toHaveText('Файл подписан от организации');
  }
  await snap(hp, 'Руководитель организации', 'Подпись от организации', 'Руководитель подписывает файлы от организации после эксперта. Саму заявку и заказчика он не видит — только файлы, эксперта и срок.', '#org-sign-box');
  await hp.goto('/kabinet');
  await expect(hp.locator('#orders li').filter({ hasText: `Оценка служебного автомобиля — тест ${RUN}` })).toHaveCount(1);
  await snap(hp, 'Руководитель организации', 'Дела сотрудников', 'Руководитель видит заявки, которые сотрудники заказали от организации. Дела, которые эксперты организации выполняют для заказчиков, здесь не видны.', '#list-view .card >> nth=0');
  await hp.locator('#orders li').filter({ hasText: `Оценка служебного автомобиля — тест ${RUN}` }).getByRole('button').first().click();
  await expect(hp.getByRole('heading', { name: 'Кто ведёт дело' })).toBeVisible();
  await snap(hp, 'Руководитель организации', 'Распределение: кто ведёт дело', 'Руководитель передаёт заявку организации другому сотруднику. Сроков и нагрузки по сотрудникам одним экраном пока нет.', '#transfer-box');
  await hp.goto('/kabinet#money');
  await snap(hp, 'Руководитель организации', 'Деньги', 'Раздел «Деньги» у руководителя сейчас показывает только его собственные оплаты — денег по организации пока нет.');

  // ——— Эксперт сдаёт; диспетчер проверяет ———
  await sp.reload();
  await sp.getByRole('button', { name: 'Сдать на проверку' }).click();
  await expect(sp.locator('#order-status')).toHaveText('Проверка результата');
  await dp.goto(`/kabinet#order=${id}`);
  await dp.reload();
  await expect(dp.locator('#review-box')).toBeVisible();
  await dp.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(dp.locator('#ai-review-state')).toContainText('запускал диспетчер', { timeout: AI_WAIT });
  const rules = dp.locator('#review-checks > li');
  const n = await rules.count();
  for (let i = 0; i < n; i += 1) {
    await rules.nth(i).getByRole('button', { name: 'В порядке' }).click();
    await expect(rules.nth(i).locator('.verdict')).toHaveText('В порядке');
  }
  await snap(dp, 'Диспетчер', 'Проверка результата', 'Диспетчер проверяет результат по тем же правилам, видит подсказки ИИ и ставит отметки сам. Затем — «Проверено, готово».', '#review-box');
  await dp.getByRole('button', { name: 'Проверено, готово' }).click();
  await expect(dp.locator('#order-status')).toHaveText('Готово');

  // ——— Заказчик получает результат ———
  await page.reload();
  await expect(page.locator('#order-status')).toHaveText('Готово');
  const got = page.locator('#docs li').filter({ hasText: 'Отчёт об оценке (тест).pdf' });
  await got.getByRole('button', { name: 'Проверить подпись' }).click();
  await expect(page.locator('#doc-msg')).toContainText('Подпись верна');
  await snap(page, 'Заказчик', 'Результат и подписи', 'Заказчик скачивает отчёт и заключение, проверяет обе подписи (эксперта и организации) одной кнопкой.', card(page, '#order-view', 'Документы'));
  await page.locator('#closing li').getByRole('button', { name: 'Открыть' }).first().click();
  await expect(page.locator('#closing-doc')).toContainText('Акт');
  await snap(page, 'Заказчик', 'Акт и закрытие', 'Закрывающие документы (акт) и кнопка «Принять и закрыть».', '#money-box');
  await page.getByLabel('Сообщение').fill('Спасибо, отчёт получили.');
  await page.getByRole('button', { name: 'Отправить сообщение' }).click();
  await expect(page.locator('#messages li')).toHaveCount(1);
  await snap(page, 'Заказчик', 'Переписка по заявке', 'Одна переписка на заявку: заказчик, исполнитель и диспетчер. Имя исполнителя заказчику не показывается.', '#chat-box');
  await page.getByRole('button', { name: 'Принять и закрыть' }).click();
  await expect(page.locator('#order-status')).toHaveText('Закрыта');

  // ——— Эксперт: выплата, ассистент ———
  await sp.goto('/kabinet#money');
  await expect(sp.locator('#money-payouts li').filter({ hasText: title })).toContainText('выплачено');
  await snap(sp, 'Эксперт', 'Выплаты', 'Сколько выплачено и за какие дела. Выплата — после выдачи результата заказчику.');
  await sp.goto('/kabinet#assistant');
  await sp.getByLabel('О какой заявке (можно не выбирать)').selectOption({ index: 1 });
  await sp.getByLabel('Вопрос').fill('Какие фото ещё нужны для оценки фургона?');
  await sp.getByRole('button', { name: 'Спросить' }).click();
  await expect(sp.locator('#as-messages li')).toHaveCount(2, { timeout: AI_WAIT });
  await snap(sp, 'Эксперт', 'Ассистент по делам', 'Личный ИИ-ассистент: отвечает о конкретном деле, помнит разговор. Память личная и отдельно по каждой организации.', '#assistant-box');
  await sp.goto('/kabinet#specialist');
  await snap(sp, 'Эксперт', 'Профиль специалиста', 'Принимаю ли новые дела, от какой организации работаю, мои допуски на услуги.');

  // ——— Диспетчер: деньги ———
  await dp.goto('/kabinet#money');
  await expect(dp.locator('#money-payments li').filter({ hasText: title })).toContainText(/20\s000 ₽/);
  await snap(dp, 'Диспетчер', 'Деньги платформы', 'Оплаты заказчиков, выплаты исполнителям и возвраты; при сбое — повтор выплаты.');
  await ap.goto('/kabinet#admin');
  await snap(ap, 'Администратор', 'Управление', 'Администратор назначает служебные роли, допуски специалистам и видит, какая модель ИИ работает.');

  for (const p of [ap, dp, sp, hp, ep]) await p.context().close();
});
