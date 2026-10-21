// Показательное дело «Бентли» (задача штаба 3fb17197): как отчёт об оценке легкового автомобиля выглядит в «Дело:
// Экспертиза» — от заявки до сдачи на телефоне 412×915. Заказчик — на экране, диспетчер — через API, эксперт — на экране.
// Машина, VIN, госномер, люди и объявления — вымышленные (номера +7999000xxxx). Готовый Word — test-results/obrazec/,
// снимки экранов — test-results/screens/bentley-*.png; образец в docs/obrazec-bentley/ собирается из них (см. README там).
import { test as base, expect } from '@playwright/test';
import pg from 'pg';
import fs from 'node:fs';
import { DB_URL, TEST_TOKEN } from '../helpers.mjs';
import { makePdf } from '../tools/make-docs.mjs';
import { extractPages } from '../../src/ai/extract.mjs';
import { orderRef } from '../../src/notify/registry.mjs';
import { BENTLEY, ADS, fillBentley } from './bentley-text.mjs';

const CONTROL = process.env.UI_TEST_CONTROL_TOKEN || TEST_TOKEN;
const EXTRA_ORIGINS = (process.env.UI_ALLOWED_ORIGINS || '').split(',').filter(Boolean);
const H = { 'x-delo-request': '1' };
const inDays = (n) => new Date(Date.now() + 3 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);

const test = base.extend({
  page: async ({ page, baseURL }, use) => {
    const allowed = new Set([new URL(baseURL).origin, ...EXTRA_ORIGINS]);
    const problems = [];
    page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (!['data:', 'blob:'].includes(u.protocol) && !allowed.has(u.origin)) problems.push(`внешний запрос: ${r.url()}`);
    });
    await use(page);
    expect(problems, problems.join('\n')).toEqual([]);
  },
});

async function shot(page, name, el = null) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, `${name}: страница шире экрана`).toBeLessThanOrEqual(412);
  await page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: true });
  // Для образца — нужный блок целиком или один экран телефона, как его видит человек.
  const path = `test-results/obrazec/ekran/${name}.png`;
  await (el ? el.screenshot({ path }) : page.screenshot({ path }));
}

async function signIn(page, phone) {
  expect((await page.request.post('/api/auth/code', { data: { phone }, headers: H })).status()).toBe(200);
  const r0 = await page.request.get('/__test/fakes/sms/calls', { headers: { 'x-test-control': CONTROL } });
  const code = (await r0.json()).calls.filter((c) => c.method === 'sendCode' && c.args.phone === phone).at(-1).args.code;
  const r = await page.request.post('/api/auth/verify', { data: { phone, code }, headers: H });
  expect(r.status()).toBe(200);
  return (await r.json()).user;
}

const phoneContext = (browser, baseURL, extra = {}) => browser.newContext({ baseURL, viewport: { width: 412, height: 915 },
  deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU', acceptDownloads: true,
  storageState: { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'delo.folds', value: 'open' }] }] }, ...extra });

async function db(fn) {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

// Картинка «фото» или «скриншот» рисуется в браузере: цветной фон и подпись — чтобы в Word было видно, что где.
async function picture(page, { w = 640, h = 480, bg, title, lines = [], type = 'image/jpeg' }) {
  return Buffer.from((await page.evaluate(({ w, h, bg, title, lines, type }) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(0, h - 70 - lines.length * 30, w, 70 + lines.length * 30);
    g.fillStyle = '#1c1c1c'; g.font = 'bold 30px sans-serif'; g.fillText(title, 20, h - 30 - lines.length * 30);
    g.font = '24px sans-serif';
    lines.forEach((l, i) => g.fillText(l, 20, h - 20 - (lines.length - 1 - i) * 30));
    return c.toDataURL(type, 0.85);
  }, { w, h, bg, title, lines, type })).split(',')[1], 'base64');
}

async function download(page, button) {
  const [d] = await Promise.all([page.waitForEvent('download'), button.click()]);
  const chunks = [];
  for await (const ch of await d.createReadStream()) chunks.push(ch);
  return Buffer.concat(chunks);
}

test('показательное дело «Бентли»: отчёт об оценке легкового автомобиля от заявки до сдачи', async ({ page, browser, baseURL }) => {
  test.setTimeout(240_000);
  const C = '+79990001771', D = '+79990001772', S = '+79990001773';
  const dctx = await phoneContext(browser, baseURL), sctx = await phoneContext(browser, baseURL);
  const dp = await dctx.newPage(), sp = await sctx.newPage();
  const disp = await signIn(dp, D), spec = await signIn(sp, S);
  await sp.request.patch('/api/me', { data: { full_name: BENTLEY.expert }, headers: H });
  await db(async (c) => {
    await c.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]);
    await c.query('insert into specialists (user_id) values ($1) on conflict do nothing', [spec.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'vehicle') on conflict do nothing", [spec.id]);
  });

  // 1. Заказчик заполняет заявку на телефоне.
  await signIn(page, C);
  await page.goto('/kabinet');
  await page.locator('#new-order').getByLabel('Услуга').selectOption({ label: 'Оценка транспортного средства' });
  await page.getByLabel('Коротко: что нужно').fill(BENTLEY.title);
  await page.getByRole('button', { name: 'Создать заявку' }).click();
  await expect(page.locator('#order-status')).toHaveText('Новая');
  const id = new URL(page.url()).hash.split('=')[1];
  await page.getByLabel('Для чего нужна оценка').selectOption({ label: 'Купля-продажа' });
  await page.getByLabel('Где находится объект').selectOption({ label: 'Москва' });
  await page.getByLabel('Вид транспорта').selectOption({ label: 'Легковой автомобиль' });
  await page.getByLabel('Марка и модель').fill(BENTLEY.makeModel);
  await page.getByLabel('Год выпуска').fill(String(BENTLEY.year));
  await page.getByLabel('VIN', { exact: true }).fill(BENTLEY.vin);
  await page.getByLabel('Госномер').fill(BENTLEY.reg);
  await page.getByLabel('Пробег, км').fill(String(BENTLEY.mileage));
  await page.getByLabel(/^Срок/).fill(inDays(7));
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, 'bentley-01-zayavka');
  await page.getByRole('button', { name: 'Отправить заявку' }).click();
  await expect(page.locator('#order-status')).toHaveText('Подбор исполнителя');

  // 2. Диспетчер назначает цену, заказчик платит, дело предлагается эксперту.
  expect((await dp.request.put(`/api/orders/${id}/price`, { data: { price: '15000' }, headers: H })).status()).toBe(200);
  await page.request.post(`/api/orders/${id}/payments`, { headers: H });
  expect((await page.request.post(`/api/orders/${id}/payments/refresh`, { headers: H })).status()).toBe(200);
  expect((await dp.request.post(`/api/orders/${id}/offer`, { data: { specialist_id: spec.id, from: 'matching' }, headers: H })).status()).toBe(200);

  // 3. Эксперт видит предложение и принимает дело.
  await sp.goto('/kabinet');
  const offer = sp.locator('#orders li').filter({ hasText: BENTLEY.title });
  await expect(offer.locator('.brief')).toContainText(BENTLEY.makeModel);
  await shot(sp, 'bentley-02-predlozhenie', offer);
  sp.once('dialog', (d) => d.accept());
  await offer.getByRole('button', { name: 'Принять дело' }).click();
  await expect(sp.locator('#order-status')).toHaveText('В работе');

  // 4. Документы: эксперт запрашивает ПТС и СТС, заказчик прикладывает.
  await sp.locator('#next-steps li[data-step="docs"] button').click();
  const box = sp.locator('#docreq-box');
  await box.getByLabel('ПТС или выписка из электронного ПТС').check();
  await box.getByLabel('Свидетельство о регистрации (СТС)').check();
  await box.getByRole('button', { name: 'Запросить у заказчика' }).click();
  await expect(sp.locator('#docreq-msg')).toHaveText('Запрошено документов: 2. Заказчику отправлено уведомление.');
  await page.reload();
  for (const [title, name, pages] of [
    ['ПТС или выписка', 'Выписка из ЭПТС.pdf', BENTLEY.epts],
    ['Свидетельство о регистрации', 'СТС.pdf', BENTLEY.sts],
  ]) {
    const li = page.locator('#docreq-list li').filter({ hasText: title });
    await li.locator('input[type=file]').setInputFiles({ name, mimeType: 'application/pdf', buffer: makePdf([pages]) });
    await expect(li.locator('.badge')).toHaveText('получен');
  }
  await shot(page, 'bentley-03-zakazchik-dokumenty', page.locator('#docreq-box'));
  await sp.reload();
  await expect(sp.locator('#next-steps li[data-step="docs"]')).toContainText('✓ Документы от заказчика (получено 2 из 2)');

  // 5. Подходы: сравнительный и затратный; доходный не применяется.
  await sp.locator('#next-steps li[data-step="approaches"] button').click();
  await sp.locator('#draft-approaches').getByLabel('Сравнительный').check();
  await expect(sp.locator('#draft-msg')).toHaveText('Подходы сохранены');
  await sp.locator('#draft-approaches').getByLabel('Затратный').check();
  await expect(sp.locator('#draft-msg')).toHaveText('Подходы сохранены');

  // 6. Осмотр по ссылке: владелец снимает машину по шагам — с временем и геометкой.
  await sp.getByRole('button', { name: 'Выдать ссылку владельцу' }).click();
  await expect(sp.locator('#inspect-url')).toContainText('http');
  const url = await sp.locator('#inspect-url').textContent();
  const octx = await phoneContext(browser, baseURL, { permissions: ['geolocation'], geolocation: { latitude: 55.7415, longitude: 37.5302, accuracy: 10 } });
  const op = await octx.newPage();
  await op.goto(url);
  await op.getByRole('button', { name: 'Начать: разрешить определение места' }).click();
  await expect(op.locator('#geo-state')).toContainText('Место определено');
  for (const [st, title, bg] of BENTLEY.photos) {
    const jpeg = await picture(op, { bg, title, lines: [`${BENTLEY.makeModel}, ${BENTLEY.reg}`] });
    await op.locator(`#steps li[data-step="${st}"] input[type=file]`).setInputFiles({ name: `${st}.jpg`, mimeType: 'image/jpeg', buffer: jpeg });
    await expect(op.locator(`#steps li[data-step="${st}"] .badge`)).toHaveText('Фото: 1');
  }
  await shot(op, 'bentley-04-osmotr-vladelec');
  op.once('dialog', (d) => d.accept());
  await op.getByRole('button', { name: 'Готово' }).click();
  await expect(op.locator('#closed-text')).toContainText(`Эксперт получил ${BENTLEY.photos.length} фото`);
  await octx.close();

  // 7. Аналоги: три объявления со скриншотами; ИИ берёт признаки, эксперт дописывает корректировки и подтверждает.
  await sp.reload();
  const abox = sp.locator('#analogs-box');
  for (const [n, a] of ADS.entries()) {
    const png = await picture(sp, { w: 540, h: 900, bg: '#e9eef5', title: `${a.price.toLocaleString('ru-RU')} ₽`, lines: a.text.split('\n').slice(0, 4), type: 'image/png' });
    await abox.getByLabel('Ссылка на объявление').fill(a.link);
    await sp.locator('#analogs-file').setInputFiles({ name: `Скриншот ${n + 1}.png`, mimeType: 'image/png', buffer: Buffer.concat([png, Buffer.from(`OCR:${a.text}`)]) });
    await abox.getByRole('button', { name: 'Добавить аналог' }).click();
    await expect(sp.locator('#analogs-list li.analog')).toHaveCount(n + 1);
    await expect(sp.locator('#analogs-msg')).toContainText('ИИ заполнил');
    const card = sp.locator('#analogs-list li.analog').nth(n);
    await card.getByLabel('Двигатель, коробка, комплектация').fill(a.modification);
    await card.getByLabel('Состояние').fill(a.condition);
    await card.locator('.analog-adj summary').click();
    for (const adj of a.adjustments) {
      await card.getByRole('button', { name: 'Добавить корректировку' }).click();
      const row = card.locator('.analog-adj-row').last();
      await row.getByLabel('Корректировка', { exact: true }).selectOption({ label: adj.kind });
      if (adj.name) await row.getByLabel('Название корректировки').fill(adj.name);
      await row.getByLabel('Значение, %').fill(adj.value);
      await row.getByLabel('Справочник или источник').fill(adj.source);
      await row.getByLabel('Год справочника').fill(adj.year);
      await row.getByLabel('Таблица').fill(adj.table);
    }
    if (n === 0) {
      await card.scrollIntoViewIfNeeded();
      await shot(sp, 'bentley-05-analog-korrektirovki', card);
    }
    await card.getByRole('button', { name: 'Подтвердить' }).click();
    await expect(sp.locator('#analogs-msg')).toHaveText('Аналог подтверждён');
    await expect(sp.locator('#analogs-list li.analog').nth(n).locator('.analog-adj summary')).toContainText(`цена после — ${a.after} руб.`);
  }
  await expect(sp.locator('#next-steps li[data-step="analogs"]')).toContainText('✓ Аналоги (подтверждено 3 из 3)');
  await sp.locator('#analogs-box').scrollIntoViewIfNeeded();
  await shot(sp, 'bentley-06-analogi', sp.locator('#analogs-list'));

  // 8. Черновик от ИИ: разделы по образцу отчёта о транспорте, данные заявки, фото и таблицы — на местах.
  await sp.getByRole('button', { name: 'Подготовить черновик с помощью ИИ' }).click();
  await expect(sp.locator('#draft-msg')).toHaveText('Черновик готов — проверьте и поправьте');
  const text = sp.getByLabel('Текст заключения');
  const draft = await text.inputValue();
  fs.mkdirSync('test-results/obrazec', { recursive: true });
  fs.writeFileSync('test-results/obrazec/chernovik-ot-ii.md', draft);
  await sp.locator('#draft-msg').scrollIntoViewIfNeeded();
  await shot(sp, 'bentley-07-chernovik-ot-ii', sp.locator('#draft-box'));
  // Эксперт дописывает разделы — так выглядит готовый отчёт.
  const body = fillBentley(draft, { no: orderRef(id) });
  expect(body).not.toMatch(/\[(?:заполнить|описать)/i);
  fs.writeFileSync('test-results/obrazec/otchet.md', body);
  await text.fill(body);
  await sp.getByRole('button', { name: 'Сохранить правку' }).click();
  await expect(sp.locator('#draft-msg')).toHaveText('Правка сохранена');
  const word = await download(sp, sp.getByRole('button', { name: 'Скачать Word' }));
  fs.writeFileSync('test-results/obrazec/Отчёт об оценке Bentley.docx', word);
  const wtext = (await extractPages(word, 'r.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).pages.join('\n');
  expect(wtext).toContain(BENTLEY.vin);
  expect(wtext).toContain('Фотоматериалы осмотра');
  expect(wtext).toContain(ADS[1].link);
  // 2.361: у машины 11 столбцов не умещаются — две таблицы: признаки и цены после корректировок.
  expect(wtext).toContain('Признаки аналогов:');
  expect(wtext).toContain('Цены аналогов после корректировок:');

  // 9. Файл результата, ИИ-проверка, подпись, сдача.
  await sp.locator('#next-main button').click();
  await sp.locator('#draft-confirm').check();
  await sp.getByRole('button', { name: 'Приложить как файл результата' }).click();
  await expect(sp.locator('#draft-msg')).toHaveText('Файл «Отчёт об оценке.docx» добавлен в результат работы');
  await sp.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(sp.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  const review = sp.locator('#review-box');
  fs.writeFileSync('test-results/obrazec/ii-proverka.txt', await review.innerText());
  await review.scrollIntoViewIfNeeded();
  await shot(sp, 'bentley-08-ii-proverka', review);
  await expect(sp.locator('#next-main button')).toHaveText('Подписать файл');
  sp.once('dialog', (d) => d.accept());
  await sp.locator('#next-main button').click();
  await expect(sp.locator('#next-main button')).toHaveText('Сдать на проверку');
  await sp.locator('#next-main button').click();
  await expect(sp.locator('#order-status')).toHaveText('Проверка результата');
  await sp.evaluate(() => window.scrollTo(0, 0));
  await shot(sp, 'bentley-09-sdano');
  await sctx.close();
  await dctx.close();
});
