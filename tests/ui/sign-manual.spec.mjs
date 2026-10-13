// Подписанный результат при ручной проверке (задача штаба 3f817197-…-81ac) — телефон 412×915: эксперт загружает файл подписи
// .sig и видит памятку «Как подписать файл КЭП»; диспетчер проверяет подпись на Госуслугах и отмечает итог («не подтвердилась»
// с причиной — эксперт загружает заново; «подпись верна» — «Подписано КЭП, проверено»); заказчик видит отметку и памятку
// «Как подать отчёт в суд электронно» (со строкой про нотариальное заверение перевода).
// Стенд на время проверки переключается на SIGN_PROVIDER=manual служебной операцией. Номера +7 999 000-77-xx — только здесь.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import fs from 'node:fs';
import { DB_URL, TEST_TOKEN } from '../helpers.mjs';

const CONTROL = process.env.UI_TEST_CONTROL_TOKEN || TEST_TOKEN;
const H = { 'x-delo-request': '1' };
const FIX = new URL('../server/fixtures/', import.meta.url);
const DOC = fs.readFileSync(new URL('cms-test.txt', FIX));
const SIG = fs.readFileSync(new URL('cms-test.txt.sig', FIX));
const SIG_PEM = fs.readFileSync(new URL('cms-test.txt.pem.sig', FIX));
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
const mode = async (request, m) => expect((await request.post('/__test/sign/mode', { data: { mode: m }, headers: { ...H, 'x-test-control': CONTROL } })).status()).toBe(200);

test('подписанный результат: загрузка .sig, проверка на Госуслугах диспетчером, отметка и памятки', async ({ page, browser, baseURL }) => {
  const problems = [];
  const watch = (p) => {
    p.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
    p.on('request', (r) => { const u = new URL(r.url()); if (u.protocol.startsWith('http') && u.origin !== new URL(baseURL).origin && !process.env.UI_ALLOWED_ORIGINS?.includes(u.origin)) problems.push(`внешний запрос: ${r.url()}`); });
  };
  watch(page);
  await mode(page.request, 'manual');
  try {
    // Заказчик, диспетчер, эксперт; заявка оплачена и в работе — через API.
    await signIn(page, '+79990007701');
    const id = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Квартира: подпись .sig' }, headers: H })).json()).order.id;
    expect((await page.request.patch(`/api/orders/${id}`, { data: { deadline: inDays(9), fields: { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 77', area: '48' } }, headers: H })).status()).toBe(200);
    expect((await page.request.post(`/api/orders/${id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
    const dctx = await phoneContext(browser, baseURL);
    const dp = await dctx.newPage();
    watch(dp);
    const disp = await signIn(dp, '+79990007702');
    const sctx = await phoneContext(browser, baseURL);
    const sp = await sctx.newPage();
    watch(sp);
    const spec = await signIn(sp, '+79990007703');
    await db(async (c) => {
      await c.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]);
      await c.query("update users set full_name = 'Иванов Иван Иванович' where id = $1", [spec.id]);
      await c.query('insert into specialists (user_id) values ($1)', [spec.id]);
      await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [spec.id]);
      await c.query('update orders set price_kop = 1500000, paid_at = now() where id = $1', [id]);
      await c.query("insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at) values ($1, 1500000, 'succeeded', $2, $3, now())", [id, `pay_ui_${id}`, disp.id]);
    });
    expect((await dp.request.post(`/api/orders/${id}/offer`, { data: { specialist_id: spec.id, from: 'matching' }, headers: H })).status()).toBe(200);
    expect((await sp.request.post(`/api/orders/${id}/status`, { data: { from: 'awaiting_executor', to: 'in_work' }, headers: H })).status()).toBe(200);
    expect((await sp.request.post(`/api/orders/${id}/results`, { data: DOC, headers: { ...H, 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('Заключение.pdf') } })).status()).toBe(201);

    // Эксперт: в кабинете не подписать — только загрузить файл подписи; памятка «Как подписать файл КЭП».
    await sp.goto(`/kabinet#order=${id}`);
    const doc = sp.locator('#docs li').filter({ hasText: 'Заключение.pdf' });
    await expect(doc).toContainText('Не подписан КЭП');
    await expect(doc.getByRole('button', { name: 'Подписать', exact: true })).toHaveCount(0);
    await expect(doc.locator('[data-action=sig-upload]')).toHaveText('Загрузить файл подписи (.sig)');
    await expect(sp.locator('#result-sign-note')).toContainText('Платформа проверит подпись на Госуслугах');
    await doc.locator('[data-memo=sign-howto] summary').click();
    await expect(doc.locator('[data-memo=sign-howto]')).toContainText('отсоединённая');
    await expect(doc.locator('[data-memo=sign-howto]')).toContainText('не нотариально заверенный перевод');
    await shot(sp, 'sig-01-ekspert-kak-podpisat');
    sp.once('dialog', (d) => d.accept());
    await doc.locator('[data-action=sig-file]').setInputFiles({ name: 'Заключение.pdf.sig', mimeType: 'application/pkcs7-signature', buffer: SIG });
    await expect(sp.locator('#doc-msg')).toHaveText('Подпись загружена — платформа проверит её на Госуслугах');
    await expect(doc.locator('[data-sig=manual-pending]')).toContainText('ждёт проверки платформой на Госуслугах · Иванов Иван Иванович');
    await shot(sp, 'sig-02-ekspert-zhdet-proverki');

    // Диспетчер: ссылка на проверку Госуслуг; «Не подтвердилась» — с причиной.
    await dp.goto(`/kabinet#order=${id}`);
    const ddoc = dp.locator('#docs li').filter({ hasText: 'Заключение.pdf' });
    await expect(ddoc.locator('[data-role=gosuslugi]')).toHaveAttribute('href', 'https://www.gosuslugi.ru/eds');
    await shot(dp, 'sig-03-dispetcher-proverka');
    dp.once('dialog', (d) => d.accept('Госуслуги: подпись не соответствует файлу'));
    await ddoc.getByRole('button', { name: 'Не подтвердилась' }).click();
    await expect(dp.locator('#doc-msg')).toContainText('подпись не подтвердилась');
    await expect(ddoc.locator('[data-sig=manual-bad]')).toContainText('Госуслуги: подпись не соответствует файлу');

    // Эксперт видит причину и загружает подпись заново.
    await sp.reload();
    await expect(doc.locator('[data-sig=manual-bad]')).toContainText('не подтвердилась при проверке: Госуслуги: подпись не соответствует файлу');
    await shot(sp, 'sig-04-ekspert-ne-podtverdilas');
    sp.once('dialog', (d) => d.accept());
    await doc.locator('[data-action=sig-file]').setInputFiles({ name: 'Заключение.pdf.sig', mimeType: 'application/pkcs7-signature', buffer: SIG_PEM });
    await expect(doc.locator('[data-sig=manual-pending]')).toBeVisible();
    expect((await sp.request.post(`/api/orders/${id}/status`, { data: { from: 'in_work', to: 'review' }, headers: H })).status()).toBe(200);

    // Диспетчер: правила проверки в порядке, «Подпись верна» — «Подписано КЭП, проверено»; выдача.
    const rv = await (await dp.request.get(`/api/orders/${id}/review`)).json();
    for (const c of rv.checks) expect((await dp.request.put(`/api/orders/${id}/review/${c.id}`, { data: { verdict: 'ok', round: rv.round }, headers: H })).status()).toBe(200);
    const early = await dp.request.post(`/api/orders/${id}/status`, { data: { from: 'review', to: 'done' }, headers: H });
    expect((await early.json()).error).toBe('signature_unchecked');
    await dp.reload();
    dp.once('dialog', (d) => d.accept());
    await ddoc.getByRole('button', { name: 'Подпись верна' }).click();
    await expect(ddoc.locator('[data-sig=manual-ok]')).toHaveText('Подписано КЭП, проверено: Иванов Иван Иванович (ООО «Тестовая оценка»)');
    await shot(dp, 'sig-05-dispetcher-provereno');
    expect((await dp.request.post(`/api/orders/${id}/status`, { data: { from: 'review', to: 'done' }, headers: H })).status()).toBe(200);

    // Заказчик: отметка, «Проверить подпись», памятка «Как подать отчёт в суд электронно».
    await page.goto(`/kabinet#order=${id}`);
    const cdoc = page.locator('#docs li').filter({ hasText: 'Заключение.pdf' });
    await expect(cdoc.locator('[data-sig=manual-ok]')).toContainText('Подписано КЭП, проверено');
    await cdoc.getByRole('button', { name: 'Проверить подпись' }).click();
    await expect(page.locator('#doc-msg')).toContainText('подпись верна — Иванов Иван Иванович');
    await cdoc.locator('[data-memo=court-howto] summary').click();
    await expect(cdoc.locator('[data-memo=court-howto]')).toContainText('Мой арбитр');
    await expect(cdoc.locator('[data-memo=court-howto]')).toContainText('ГАС «Правосудие»');
    await expect(cdoc.locator('[data-memo=court-howto]')).toContainText('не нотариально заверенный перевод');
    await shot(page, 'sig-06-zakazchik-v-sud');

    // Памятки — и в «Как работать».
    await page.goto('/kabinet#help');
    await expect(page.locator('#help-view')).toContainText('Подать отчёт в суд электронно');
    await expect(page.locator('#help-view')).toContainText('Как подписать файл КЭП');
    await dctx.close();
    await sctx.close();
  } finally {
    await mode(page.request, 'fake');
  }
  expect(problems, problems.join('\n')).toEqual([]);
});
