// «Напомнить заказчику» о запрошенных документах (задача 2.234) — телефон 412×915: документ запрошен 3 дня назад и не
// пришёл — строка в «Сегодня» эксперта и в деле с кнопкой; после нажатия — «снова можно завтра», заказчику уведомление.
// Номера +7 999 000-87-xx — только здесь.
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

test('2.234: документы не пришли 3 дня — «Напомнить заказчику» в «Сегодня» и в деле, раз в сутки', async ({ browser, baseURL }) => {
  const problems = [];
  const watch = (p) => {
    p.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
    p.on('request', (r) => { const u = new URL(r.url()); if (u.protocol.startsWith('http') && u.origin !== new URL(baseURL).origin && !process.env.UI_ALLOWED_ORIGINS?.includes(u.origin)) problems.push(`внешний запрос: ${r.url()}`); });
  };
  const dctx = await phoneContext(browser, baseURL);
  const dp = await dctx.newPage();
  const sctx = await phoneContext(browser, baseURL);
  const sp = await sctx.newPage();
  watch(dp); watch(sp);
  const disp = await signIn(dp, '+79990008701');
  const spec = await signIn(sp, '+79990008702');
  await db(async (c) => {
    await c.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]);
    await c.query('insert into specialists (user_id) values ($1)', [spec.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [spec.id]);
  });
  const ids = [];
  for (const title of ['Квартира: документы не пришли', 'Квартира: ждём выписку']) {
    const id = (await (await dp.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title }, headers: H })).json()).order.id;
    expect((await dp.request.patch(`/api/orders/${id}`, {
      data: { deadline: inDays(9), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, Напоминальная ул., 4' } }, headers: H,
    })).status()).toBe(200);
    expect((await dp.request.post(`/api/orders/${id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
    await db(async (c) => {
      await c.query('update orders set price_kop = 1500000, paid_at = now() where id = $1', [id]);
      await c.query("insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at) values ($1, 1500000, 'succeeded', $2, $3, now())", [id, `pay_ui_${id}`, disp.id]);
    });
    expect((await dp.request.post(`/api/orders/${id}/offer`, { data: { specialist_id: spec.id, from: 'matching' }, headers: H })).status()).toBe(200);
    expect((await sp.request.post(`/api/orders/${id}/status`, { data: { from: 'awaiting_executor', to: 'in_work' }, headers: H })).status()).toBe(200);
    ids.push(id);
  }
  expect((await sp.request.post(`/api/orders/${ids[0]}/doc-requests`, { data: { items: ['egrn', 'tech_plan'] }, headers: H })).status()).toBe(201);
  expect((await sp.request.post(`/api/orders/${ids[1]}/doc-requests`, { data: { items: ['egrn'] }, headers: H })).status()).toBe(201);
  // Запросили 4 дня назад.
  await db((c) => c.query("update doc_requests set requested_at = now() - interval '4 days' where order_id = any($1::uuid[])", [ids]));

  // «Сегодня»: «Документы не пришли» — что ждём и сколько; кнопка напоминает прямо здесь.
  await sp.goto('/kabinet');
  const rows = sp.locator('li[data-today-item="docs-wait"]');
  await expect(rows).toHaveCount(2);
  const first = rows.filter({ hasText: 'Квартира: документы не пришли' });
  await expect(first.locator('[data-role="docs-wait-what"]')).toHaveText('Ждём 4 дн.: Выписка из ЕГРН, Технический паспорт БТИ или поэтажный план');
  await expect(first).toContainText('заказчику ещё не напоминали');
  await first.scrollIntoViewIfNeeded();
  await shot(sp, 'dr1-2234-segodnya-dokumenty-ne-prishli');
  await first.getByRole('button', { name: 'Напомнить заказчику' }).click();
  await expect(first.locator('[data-role="docs-remind-msg"]')).toHaveText('Напомнили — заказчику отправлено уведомление; снова можно завтра');
  await shot(sp, 'dr2-2234-segodnya-napomnili');

  // В деле: строка у «Запрошенных документов» и кнопка; после нажатия — «снова можно завтра».
  await sp.goto(`/kabinet#order=${ids[1]}&to=docs`);
  const box = sp.locator('#docreq-wait');
  await expect(box).toBeVisible();
  await expect(sp.locator('#docreq-wait-text')).toHaveText('Заказчик не прислал «Выписка из ЕГРН» — ждём 4 дн. Напомните заказчику одной кнопкой.');
  await box.scrollIntoViewIfNeeded();
  await shot(sp, 'dr3-2234-delo-dokumenty-ne-prishli');
  await sp.locator('#docreq-remind').click();
  await expect(sp.locator('#docreq-msg')).toHaveText('Напомнили — заказчику отправлено уведомление.');
  await expect(sp.locator('#docreq-wait-text')).toContainText('— снова можно завтра.');
  await expect(sp.locator('#docreq-remind')).toBeHidden();
  await shot(sp, 'dr4-2234-delo-napomnili');

  // Заказчик: в ленте — напоминание; подсказки «не прислал» у него нет.
  const feed = await (await dp.request.get('/api/notifications', { headers: H })).json();
  expect(feed.notifications.filter((n) => n.title.startsWith('Исполнитель напоминает: ждёт документы'))).toHaveLength(2);
  await dp.goto(`/kabinet#order=${ids[1]}&to=docs`);
  await expect(dp.locator('#docreq-list li').filter({ hasText: 'Выписка из ЕГРН' })).toBeVisible();
  await expect(dp.locator('#docreq-wait')).toBeHidden();
  await shot(dp, 'dr5-2234-zakazchik-vidit-zapros');
  // В «Сегодня» эксперта строк больше нет — до завтра.
  await sp.goto('/kabinet');
  await expect(sp.locator('li[data-today-item="docs-wait"]')).toHaveCount(0);
  expect(problems, problems.join('\n')).toEqual([]);
  await dctx.close();
  await sctx.close();
});
