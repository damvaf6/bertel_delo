// Задача 2.501 — телефон 412×915: оценка квартиры для наследства, в заявке день открытия наследства, а в отчёте дата оценки —
// день осмотра и пользователь — банк. ИИ-проверка в пункте «Сведения по закону об оценке» называет оба расхождения, у даты —
// «Заменить на значение из заявки»: дата в черновике меняется на день открытия наследства.
// Номера +7 999 000-53-06…07 — только здесь.
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

test('2.501: оценка для наследства — дата оценки и пользователь в отчёте', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005306');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Квартира: наследство' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const death = ru(new Date(Date.now() - 120 * 86400_000));
  const fields = { purpose: 'inheritance', region: 'moscow', object_type: 'flat', address: 'г. Москва, Тестовая ул., д. 1, кв. 1', area: 45, death_date: death };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 800000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_heir_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005307');
  await db(async (c) => {
    await c.query("update users set full_name = 'Наследов Иван Петрович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  const made = (await (await ep.request.post(`/api/orders/${o.id}/draft/ai`, { data: {}, headers: H })).json()).draft;
  // В черновике строка со старой датой (текст прошлого отчёта) — её заменит кнопка.
  const body = `${made.body}\nДата оценки: 10.11.2026`;
  expect((await ep.request.put(`/api/orders/${o.id}/draft`, { data: { body, from: made.id }, headers: H })).status()).toBe(200);

  const report = ['ОТЧЁТ ОБ ОЦЕНКЕ № 21/2026', 'Цель оценки: для нотариуса (наследство)', 'Дата оценки: 10.11.2026',
    'Предполагаемый пользователь результатов оценки: ПАО Сбербанк', 'Вид стоимости: рыночная',
    '13. Согласование результатов', 'Рыночная стоимость — 9 800 000 руб.'].join('\n');
  expect((await ep.request.post(`/api/orders/${o.id}/results`, {
    data: Buffer.from(report), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') },
  })).status()).toBe(201);

  await ep.goto(`/kabinet#order=${o.id}`);
  await ep.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(ep.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  const item = ep.locator('#review-checks > li[data-check="appraiser"]');
  const found = item.locator('.ai-found li');
  const date = found.filter({ hasText: `Дата оценки в отчёте 10.11.2026, а день открытия наследства в заявке — ${death}` });
  await expect(date).toHaveCount(1);
  await expect(found.filter({ hasText: 'Предполагаемый пользователь в отчёте — «ПАО Сбербанк», а оценка для наследства: пользователь результатов — нотариус (наследники)' })).toHaveCount(1);
  const swap = date.getByRole('button', { name: 'Заменить на значение из заявки' });
  await expect(swap).toBeVisible();
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await date.scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/nh02-nasledstvo-proverka.png', fullPage: false });

  await swap.click();
  await expect(date.locator('[data-role="fix-swap-done"]')).toContainText(`Было «10.11.2026» — стало «${death}», как в заявке`);
  const after = (await (await ep.request.get(`/api/orders/${o.id}/draft`, { headers: H })).json()).draft.body;
  expect(after).toContain(`Дата оценки: ${death}`);
  expect(after).not.toContain('10.11.2026');
  await date.scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/nh03-nasledstvo-zamena.png', fullPage: false });
  expect(problems).toEqual([]);
  await ectx.close();
});
