// Задача 2.502 — телефон 412×915: оценка квартиры для наследства задним числом — дата оценки (день открытия наследства)
// на четыре месяца раньше выезда помощника, а в отчёте нет допущения о состоянии на дату оценки и курс валют взят на дату
// составления. ИИ-проверка в пункте «Допущения и погрешности указаны» называет оба места; «Вставить в черновик допущение»
// ставит строку «Оценка ретроспективная: …» в раздел допущений черновика. Номера +7 999 000-53-14…15 — только здесь.
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

test('2.502: оценка задним числом — допущение и курс на дату оценки', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005314');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Квартира: задним числом' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const death = ru(new Date(Date.now() - 120 * 86400_000));
  const fields = { purpose: 'inheritance', region: 'moscow', object_type: 'flat', address: 'г. Москва, Тестовая ул., д. 4, кв. 5', area: 52, death_date: death };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 800000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_retro_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005315');
  await db(async (c) => {
    await c.query("update users set full_name = 'Задним Пётр Ильич' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  const made = (await (await ep.request.post(`/api/orders/${o.id}/draft/ai`, { data: {}, headers: H })).json()).draft;
  expect(made.body).not.toContain('Оценка ретроспективная:');
  // Осмотр — выезд помощника сегодня, через четыре месяца после даты оценки.
  await db((c) => c.query(`insert into onsite_visits (order_id, helper_id, assigned_by, planned_at, finished_at)
                           values ($1, $2, $2, now(), now())`, [o.id, expert.id]));
  const today = ru(new Date(Date.now() + 3 * 3600_000));
  const report = ['ОТЧЁТ ОБ ОЦЕНКЕ № 22/2026', 'Цель оценки: для нотариуса (наследство)', `Дата оценки: ${death}`, `Дата составления отчёта: ${today}`,
    'Предполагаемый пользователь результатов оценки: нотариус г. Москвы', 'Вид стоимости: рыночная',
    `Курс доллара США, установленный ЦБ РФ на ${today}, — 92,10 руб.`,
    '13. Согласование результатов', 'Рыночная стоимость — 9 800 000 руб.'].join('\n');
  expect((await ep.request.post(`/api/orders/${o.id}/results`, {
    data: Buffer.from(report), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') },
  })).status()).toBe(201);

  await ep.goto(`/kabinet#order=${o.id}`);
  await ep.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(ep.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  const item = ep.locator('#review-checks > li[data-check="error_margin"]');
  const found = item.locator('.ai-found li');
  const retro = found.filter({ hasText: `Дата оценки в отчёте ${death}, а осмотр в деле — ${today}: оценка задним числом, а допущения нет` });
  await expect(retro).toHaveCount(1);
  await expect(found.filter({ hasText: `Курс валют в отчёте — на ${today}, позже даты оценки ${death}` })).toHaveCount(1);
  const put = retro.getByRole('button', { name: 'Вставить в черновик допущение' });
  await expect(put).toBeVisible();
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await retro.scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/nh04-zadnim-chislom.png', fullPage: false });

  await put.click();
  await expect(retro.locator('[data-role="retro-done"]')).toHaveText('Допущение об оценке задним числом вставлено в раздел допущений черновика и сохранено — соберите Word заново.');
  const after = (await (await ep.request.get(`/api/orders/${o.id}/draft`, { headers: H })).json()).draft.body;
  expect(after).toMatch(new RegExp(`5\\. Допущения и ограничительные условия\\nОценка ретроспективная: дата оценки \\(${death.replace(/\./g, '\\.')}\\) раньше даты осмотра \\(${today.replace(/\./g, '\\.')}\\)`));
  await retro.scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/nh05-zadnim-chislom-dopushchenie.png', fullPage: false });
  expect(problems).toEqual([]);
  await ectx.close();
});
