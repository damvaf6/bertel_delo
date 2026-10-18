// Ответ заказчику сразу после отправки заявки (задача штаба 3fd17197) на телефоне 412×915: администратор задаёт срок
// первого ответа по модулю (пока не задавал — осторожные 72 и 48 часов, решение Дамира 18.10.2026, и «Как на деле»); заказчик
// сразу после «Отправить» видит «Заявка № … принята. Цену назначит диспетчер — как правило, в течение 24 часов» без точного
// часа; срок прошёл — «задерживаемся». В конце сроки возвращаются к осторожным по умолчанию.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DB_URL, TEST_TOKEN } from '../helpers.mjs';

const CONTROL = process.env.UI_TEST_CONTROL_TOKEN || TEST_TOKEN;
const H = { 'x-delo-request': '1' };
const inDays = (n) => new Date(Date.now() + 3 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);

async function signIn(page, phone) {
  expect((await page.request.post('/api/auth/code', { data: { phone }, headers: H })).status()).toBe(200);
  const r = await page.request.get('/__test/fakes/sms/calls', { headers: { 'x-test-control': CONTROL } });
  const code = (await r.json()).calls.filter((c) => c.method === 'sendCode' && c.args.phone === phone).at(-1).args.code;
  const v = await page.request.post('/api/auth/verify', { data: { phone, code }, headers: H });
  expect(v.status()).toBe(200);
  return (await v.json()).user;
}

async function shot(page, name) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), `${name}: страница шире экрана`).toBeLessThanOrEqual(412);
  await page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: true });
}

test('срок первого ответа: администратор задаёт; заказчик сразу после отправки видит срок, потом «задерживаемся»', async ({ page, browser }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const adm = await signIn(page, '+79990000995');
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  const ctx = await browser.newContext();
  try {
    await db.query("update users set platform_role = 'admin' where id = $1", [adm.id]);
    await page.goto('/kabinet#admin');
    await expect(page.locator('#ack-expertise')).toHaveValue('72');
    await expect(page.locator('#ack-translation')).toHaveValue('48');
    await expect(page.locator('#ack-facts li').first()).toContainText('Экспертиза и оценка');
    await page.getByLabel('Экспертиза и оценка, часов (1–168)').fill('сутки');
    await page.getByRole('button', { name: 'Сохранить сроки' }).click();
    await expect(page.locator('#ack-msg')).toContainText('срок — целое число часов от 1 до 168 или пусто');
    await page.getByLabel('Экспертиза и оценка, часов (1–168)').fill('24');
    await page.getByRole('button', { name: 'Сохранить сроки' }).click();
    await expect(page.locator('#ack-msg')).toContainText('Сохранено: Экспертиза и оценка — 24 ч');
    await page.locator('#ack-history-box summary').click();
    await expect(page.locator('#ack-history li').first()).toContainText('Экспертиза и оценка: 24 ч');
    await page.locator('#ack-box').scrollIntoViewIfNeeded();
    await shot(page, 'otvet-01-admin-srok');

    // Заказчик: заявка на оценку квартиры заполнена, «Отправить» — на экране сразу срок.
    const cp = await ctx.newPage();
    cp.on('pageerror', (e) => errors.push(e.message));
    await signIn(cp, '+79990000996');
    const o = (await (await cp.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Оценка квартиры (тест ответа)' }, headers: H })).json()).order;
    const fields = { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 5' };
    expect((await cp.request.patch(`/api/orders/${o.id}`, { data: { deadline: inDays(20), fields }, headers: H })).status()).toBe(200);
    await cp.goto(`/kabinet#order=${o.id}`);
    await expect(cp.locator('#order-ack')).toBeHidden();
    await cp.getByRole('button', { name: 'Отправить заявку' }).click();
    await expect(cp.locator('#status-msg')).toHaveText('Заявка отправлена');
    const ref = o.id.slice(0, 8).toUpperCase();
    await expect(cp.locator('#order-ack')).toHaveText(new RegExp(`^Заявка № ${ref} принята\\. Цену назначит диспетчер — как правило, в течение 24 часов\\. Если понадобится больше времени — сообщим\\.$`));
    await shot(cp, 'otvet-02-zakazchik-srok');

    // Срок прошёл, цены нет — «задерживаемся» (отметку ставит обход раз в минуту; здесь — сразу).
    await db.query('update orders set ack_due_at = now() - interval \'1 minute\', ack_late_at = now() where id = $1', [o.id]);
    await cp.reload();
    await expect(cp.locator('#order-ack')).toHaveText(`Заявка № ${ref}: задерживаемся с ценой — диспетчер уже видит заявку, ответим в ближайшее время.`);
    await expect(cp.locator('#order-ack')).toHaveClass(/overdue/);
    await shot(cp, 'otvet-03-zakazchik-zaderzhivaemsya');
  } finally {
    expect((await page.request.put('/api/admin/order-ack', { data: { hours: { expertise: 72, translation: 48 } }, headers: H })).status()).toBe(200);
    await ctx.close();
    await db.end();
  }
  expect(errors).toEqual([]);
});
