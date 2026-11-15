// Задача 2.506 — телефон 412×915: в заявке оценки квартиры для наследства заказчик пишет другие объекты (гараж, машина) и
// просит общую стоимость — в деле подсказка «В составе наследства 3 объекта …». В черновике от ИИ — строка «Оценивается в
// составе наследства: …»; ИИ-проверка отчёта, где машины нет и общей стоимости нет, называет оба места.
// Номера +7 999 000-53-45…46 — только здесь.
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
const ru = (d) => d.toISOString().slice(0, 10).split('-').reverse().join('.');

test('2.506: несколько объектов наследства — заявка, черновик, ИИ-проверка', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };
  await page.setViewportSize({ width: 412, height: 915 });
  await signIn(page, '+79990005345');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Квартира, гараж и машина: наследство' }, headers: H })).json()).order;
  await page.goto(`/kabinet#order=${o.id}`);
  const form = page.locator('#details-form');
  await expect(form).toBeVisible();
  await form.getByLabel('Для чего нужна оценка').selectOption({ label: 'Наследство, нотариус' });
  await form.getByLabel('Где находится объект').selectOption({ label: 'Москва' });
  await form.getByLabel('Что оцениваем').selectOption({ label: 'Квартира' });
  await form.getByLabel('Адрес объекта').fill('г. Москва, Тестовая ул., д. 1, кв. 1');
  await form.getByLabel('Если наследство — дата открытия наследства (день смерти)').fill(ru(new Date(Date.now() - 120 * 86400_000)));
  await form.getByLabel('Если наследство — другие объекты в его составе').fill('Гараж, ГСК «Ромашка», бокс 12\nЛада Веста, 2019');
  await form.getByLabel('Если объектов несколько — общая стоимость').selectOption({ label: 'Каждого и общую' });
  await form.getByRole('button', { name: 'Сохранить' }).click();
  const box = page.locator('#quote-box');
  await expect(box.locator('[data-notice="inheritance_objects"]')).toHaveText('В составе наследства 3 объекта: г. Москва, Тестовая ул., д. 1, кв. 1; Гараж, ГСК «Ромашка», бокс 12; Лада Веста, 2019. В отчёте — стоимость каждого и общая стоимость всех.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await box.locator('[data-notice="inheritance_objects"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/screens/nh10-nasledstvo-obekty.png', fullPage: false });

  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  expect((await page.request.patch(`/api/orders/${o.id}`, { data: { deadline }, headers: H })).status()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 800000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_heirobj_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005346');
  await db(async (c) => {
    await c.query("update users set full_name = 'Объектов Иван Петрович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  const made = (await (await ep.request.post(`/api/orders/${o.id}/draft/ai`, { data: {}, headers: H })).json()).draft;
  expect(made.body).toContain('Оценивается в составе наследства: 1) г. Москва, Тестовая ул., д. 1, кв. 1; 2) Гараж, ГСК «Ромашка», бокс 12; 3) Лада Веста, 2019.');

  const report = ['ОТЧЁТ ОБ ОЦЕНКЕ № 22/2026', 'Цель оценки: для нотариуса (наследство)', 'Предполагаемый пользователь результатов оценки: нотариус',
    'Вид стоимости: рыночная', '14. Согласование результатов', 'Рыночная стоимость квартиры — 9 800 000 руб.',
    'Рыночная стоимость гаража в ГСК «Ромашка», бокс 12 — 650 000 руб.'].join('\n');
  expect((await ep.request.post(`/api/orders/${o.id}/results`, {
    data: Buffer.from(report), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') },
  })).status()).toBe(201);
  await ep.goto(`/kabinet#order=${o.id}`);
  await ep.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(ep.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  const found = ep.locator('#review-checks > li[data-check="appraiser"] .ai-found li');
  const car = found.filter({ hasText: 'Объект из заявки «Лада Веста, 2019» в отчёте не найден' });
  await expect(car).toHaveCount(1);
  await expect(found.filter({ hasText: 'Заказчик просил общую стоимость всех объектов наследства (3), а в отчёте её нет' })).toHaveCount(1);
  await expect(found.filter({ hasText: 'Гараж' })).toHaveCount(0);
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await car.scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/nh11-nasledstvo-obekty-proverka.png', fullPage: false });
  expect(problems).toEqual([]);
  await ectx.close();
});
