// Чек-лист Сбербанка к отчёту об оценке (задача штаба 3f917197) — телефон 412×915: заказчик в заявке выбирает «для
// Сбербанка»; эксперт после ИИ-проверки видит пункты «Сбер: …», диспетчер на проверке отмечает их, как остальные правила.
// Номера +7 999 000-86-xx — только здесь.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DB_URL, TEST_TOKEN } from '../helpers.mjs';

const CONTROL = process.env.UI_TEST_CONTROL_TOKEN || TEST_TOKEN;
const H = { 'x-delo-request': '1' };
const inDays = (n) => new Date(Date.now() + 3 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);

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
function phoneContext(browser, baseURL) {
  return browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU',
    storageState: { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'delo.folds', value: 'open' }] }] } });
}
async function shot(page, name) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, `${name}: страница шире экрана`).toBeLessThanOrEqual(412);
  await page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: true });
}

test('отчёт для Сбербанка: выбор банка в заявке, пункты «Сбер» в ИИ-проверке и в проверке диспетчера', async ({ page, browser, baseURL }) => {
  const problems = [];
  const watch = (p) => {
    p.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
    p.on('request', (r) => { const u = new URL(r.url()); if (u.protocol.startsWith('http') && u.origin !== new URL(baseURL).origin && !process.env.UI_ALLOWED_ORIGINS?.includes(u.origin)) problems.push(`внешний запрос: ${r.url()}`); });
  };
  watch(page);

  // Заказчик заполняет заявку на телефоне и выбирает банк.
  await signIn(page, '+79990008601');
  await page.goto('/kabinet');
  await page.locator('#new-order').getByLabel('Услуга').selectOption({ label: 'Оценка недвижимости' });
  await page.getByRole('button', { name: 'Создать заявку' }).click();
  await expect(page.getByRole('heading', { name: 'Оценка недвижимости' })).toBeVisible();
  await page.getByLabel('Для чего нужна оценка').selectOption({ label: 'Ипотека, залог, банк' });
  await page.getByLabel('Где находится объект').selectOption({ label: 'Москва' });
  await page.getByLabel('Что оцениваем').selectOption({ label: 'Квартира' });
  await page.getByLabel('Адрес объекта').fill('г. Москва, ул. Тестовая, д. 86, кв. 1');
  const bank = page.getByLabel('Если отчёт для банка — для какого');
  await bank.selectOption({ label: 'Сбербанк' });
  await expect(page.getByText('Для Сбербанка отчёт проверим ещё и по требованиям банка')).toBeVisible();
  await page.getByLabel(/^Срок/).fill(inDays(14));
  await bank.scrollIntoViewIfNeeded();
  await shot(page, 'sber-01-zayavka-bank');
  await page.getByRole('button', { name: 'Отправить заявку' }).click();
  await expect(page.locator('#order-status')).toHaveText('Подбор исполнителя');
  await expect(page.locator('#facts')).toContainText('Сбербанк');
  const id = new URL(page.url()).hash.match(/order=(\d+)/)[1];

  // Диспетчер и эксперт; заявка оплачена и в работе — через API.
  const dctx = await phoneContext(browser, baseURL);
  const dp = await dctx.newPage();
  watch(dp);
  const disp = await signIn(dp, '+79990008602');
  const sctx = await phoneContext(browser, baseURL);
  const sp = await sctx.newPage();
  watch(sp);
  const spec = await signIn(sp, '+79990008603');
  await db(async (c) => {
    await c.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]);
    await c.query("update users set full_name = 'Тестовый оценщик Сбер' where id = $1", [spec.id]);
    await c.query('insert into specialists (user_id) values ($1)', [spec.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [spec.id]);
    await c.query('update orders set price_kop = 1500000, paid_at = now() where id = $1', [id]);
    await c.query("insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at) values ($1, 1500000, 'succeeded', $2, $3, now())", [id, `pay_ui_sber_${id}`, disp.id]);
  });
  expect((await dp.request.post(`/api/orders/${id}/offer`, { data: { specialist_id: spec.id, from: 'matching' }, headers: H })).status()).toBe(200);
  expect((await sp.request.post(`/api/orders/${id}/status`, { data: { from: 'awaiting_executor', to: 'in_work' }, headers: H })).status()).toBe(200);
  expect((await sp.request.post(`/api/orders/${id}/results`, { data: Buffer.from('Отчёт об оценке квартиры для ПАО Сбербанк. Итог 9 000 000 руб.'), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт-сбер.txt') } })).status()).toBe(201);

  // Эксперт: ИИ-проверка перед сдачей — пункты «Сбер» среди правил.
  await sp.goto(`/kabinet#order=${id}`);
  await sp.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(sp.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  await expect(sp.locator('#review-checks')).toContainText('Сбер: аналоги — не меньше трёх');
  await expect(sp.locator('#review-checks')).toContainText('Сбер: фото объекта');
  await sp.locator('#ai-review-box').scrollIntoViewIfNeeded();
  await shot(sp, 'sber-02-ekspert-ii-proverka');

  // Эксперт подписывает и сдаёт; диспетчер видит пункты «Сбер» с кнопками отметок.
  const btn = sp.locator('#docs li').getByRole('button', { name: 'Подписать' });
  while (await btn.count()) {
    sp.once('dialog', (d) => d.accept());
    await btn.first().click();
    await expect(sp.locator('#doc-msg')).toHaveText('Файл подписан');
  }
  await sp.getByRole('button', { name: 'Сдать на проверку' }).click();
  await expect(sp.locator('#order-status')).toHaveText('Проверка результата');
  await dp.goto(`/kabinet#order=${id}`);
  const photos = dp.locator('#review-checks > li').filter({ hasText: 'Сбер: фото объекта' });
  await expect(photos.getByRole('button', { name: 'В порядке' })).toBeVisible();
  await expect(dp.locator('#review-checks > li').filter({ hasText: /^.*Сбер: / })).toHaveCount(10);
  await photos.getByRole('textbox').fill('Нет фото санузла и вида из окна');
  await photos.getByRole('button', { name: 'Замечание' }).click();
  await expect(photos.locator('.verdict')).toHaveText('Замечание');
  await photos.scrollIntoViewIfNeeded();
  await shot(dp, 'sber-03-dispetcher-proverka');

  expect(problems, problems.join('\n')).toEqual([]);
  await dctx.close();
  await sctx.close();
});
