// Оплата по счёту (2.464, схема 5 экранов — решение Дамира 31.10/02.11.2026) — телефон 412×915: заказчик «Экспертизы» видит,
// как платить по счёту, скачивает счёт и нажимает «Я оплатил(а) по счёту»; диспетчер в «Деньгах» видит заявку в «Ждут
// оплаты по счёту» первой и отмечает «Оплата поступила»; заказчику — «оплачено по счёту». Отмена до начала работы — возврат
// вручную: «Вернуть вручную» и «Возвращено». Номера +7 999 000-47-0x — только здесь.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DB_URL, TEST_TOKEN } from '../helpers.mjs';

const CONTROL = process.env.UI_TEST_CONTROL_TOKEN || TEST_TOKEN;
const H = { 'x-delo-request': '1' };

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
const narrow = async (p) => expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);

test('оплата по счёту (2.464): «Я оплатил(а)» → «Оплата поступила» → оплачено; отмена — возврат вручную', async ({ browser, baseURL }) => {
  const problems = [];
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU', acceptDownloads: true };
  const cp = await (await browser.newContext(ctx)).newPage();
  const dp = await (await browser.newContext(ctx)).newPage();
  for (const p of [cp, dp]) p.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));

  await signIn(cp, '+79990004701');
  const disp = await signIn(dp, '+79990004702');
  await db((c) => c.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]));
  const title = 'Квартира — оплата по счёту';
  const o = (await (await cp.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  expect((await cp.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, Учебная ул., 7' } }, headers: H })).status()).toBe(200);
  expect((await cp.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  expect((await dp.request.put(`/api/orders/${o.id}/price`, { data: { price: '10000' }, headers: H })).status()).toBe(200);

  // Заказчик: как платить по счёту, счёт Word, «Я оплатил(а) по счёту» с пометкой.
  await cp.goto(`/kabinet#order=${o.id}`);
  await expect(cp.locator('#order-title')).toHaveText(title);
  await expect(cp.locator('#invoice-pay')).toBeVisible();
  await expect(cp.locator('#invoice-pay-text')).toContainText('Оплата — по счёту ООО «АИС Переводчик»');
  await expect(cp.locator('#money-facts')).toContainText(/нужна оплата (картой или )?по счёту/);
  await expect(cp.locator('#money-facts')).toContainText(/12\s000 ₽/);
  const [file] = await Promise.all([cp.waitForEvent('download'), cp.getByRole('button', { name: 'Скачать счёт на оплату (Word)' }).click()]);
  expect(file.suggestedFilename()).toMatch(/^Счёт СЧ-[0-9A-F]{8}\.docx$/);
  await cp.getByLabel('Когда и как оплатили (необязательно)').fill('12.11, платёжка № 15');
  await cp.locator('#money-box').scrollIntoViewIfNeeded();
  await narrow(cp);
  await cp.screenshot({ path: 'test-results/screens/iv01-zakazchik-oplata-po-schetu.png', fullPage: true });
  await cp.getByRole('button', { name: 'Я оплатил(а) по счёту' }).click();
  await expect(cp.locator('#money-msg')).toHaveText('Спасибо — диспетчер проверит поступление и отметит оплату');
  await expect(cp.locator('#money-facts')).toContainText('Вы сообщили об оплате');
  await expect(cp.locator('#invoice-claim-form')).toBeHidden();

  // Диспетчер: «Деньги» → «Ждут оплаты по счёту» — заявка с пометкой заказчика; «Оплата поступила».
  await dp.goto('/kabinet#money');
  const row = dp.locator('#money-invoices li').filter({ hasText: title });
  await expect(row).toContainText(/12\s000 ₽/);
  await expect(row).toContainText('12.11, платёжка № 15');
  await expect(row).toContainText('заказчик: «оплатил»');
  await expect(dp.locator('#money-invoices-sum')).toContainText('заказчик сообщил об оплате');
  await row.scrollIntoViewIfNeeded();
  await narrow(dp);
  await dp.screenshot({ path: 'test-results/screens/iv02-dispetcher-zhdut-oplaty.png', fullPage: true });
  // В карточке заявки — то же действие с пометкой.
  await dp.goto(`/kabinet#order=${o.id}`);
  await expect(dp.locator('#money-facts')).toContainText('заказчик сообщил об оплате');
  await expect(dp.locator('#next-main button')).toHaveText('Оплата поступила');
  await dp.getByLabel('Пометка к оплате (необязательно)').fill('п/п 15 от 12.11');
  await dp.getByRole('button', { name: 'Оплата поступила' }).last().click();
  await expect(dp.locator('#money-msg')).toHaveText('Оплата отмечена');
  await expect(dp.locator('#money-facts')).toContainText('оплачено по счёту');
  await expect(dp.locator('#money-facts')).toContainText('п/п 15 от 12.11');
  await dp.goto('/kabinet#money');
  await expect(dp.locator('#money-invoices li').filter({ hasText: title })).toHaveCount(0);

  // Заказчик: «оплачено по счёту», кнопок оплаты больше нет.
  await cp.reload();
  await expect(cp.locator('#money-facts')).toContainText('оплачено по счёту');
  await expect(cp.locator('#money-facts')).not.toContainText('п/п 15', { timeout: 1000 });
  await expect(cp.locator('#invoice-pay')).toBeHidden();
  await cp.locator('#money-box').scrollIntoViewIfNeeded();
  await cp.screenshot({ path: 'test-results/screens/iv03-zakazchik-oplacheno-po-schetu.png', fullPage: true });

  // Отмена до начала работы — возврат вручную: диспетчер в «Деньгах» → «Вернуть вручную» → «Возвращено».
  expect((await cp.request.post(`/api/orders/${o.id}/status`, { data: { from: 'matching', to: 'cancelled' }, headers: H })).status()).toBe(200);
  await dp.goto('/kabinet#money');
  await dp.reload(); // та же страница «Деньги» — перечитать
  const back = dp.locator('#money-refunds li').filter({ hasText: title });
  await expect(back).toContainText(/12\s000 ₽/);
  await expect(back).toContainText('+79990004701');
  await back.scrollIntoViewIfNeeded();
  await narrow(dp);
  await dp.screenshot({ path: 'test-results/screens/iv04-dispetcher-vernut-vruchnuyu.png', fullPage: true });
  await back.getByRole('button', { name: 'Возвращено' }).click();
  await expect(dp.locator('#money-refunds-msg')).toHaveText('Возврат отмечен');
  await expect(dp.locator('#money-refunds li').filter({ hasText: title })).toHaveCount(0);
  await cp.reload();
  await expect(cp.locator('#money-facts')).toContainText(/Возврат заказчику\s*12\s000 ₽ — возвращено/);
  expect(problems).toEqual([]);
});
