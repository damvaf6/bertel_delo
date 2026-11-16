// Задача 2.521 — телефон 412×915: черновик от ИИ по нежилому помещению — в конце «13. Доходный подход» таблица «Расчёт
// доходным подходом». Эксперт удалил её — в деле «таблицы нет», «Вставить таблицу в черновик» ставит её в конец раздела.
// Эксперт вписал суммы — таблица не «устаревает» (подсказки нет). Заказчик поменял арендную плату — «таблица устарела»,
// «Обновить» заменяет её целиком. Номера +7 999 000-55-94…95 — только здесь.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DB_URL, TEST_TOKEN } from '../helpers.mjs';

const CONTROL = process.env.UI_TEST_CONTROL_TOKEN || TEST_TOKEN;
const H = { 'x-delo-request': '1' };
const HEAD = '| Расчёт доходным подходом | Значение |';

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

test('2.521: таблица «Расчёт доходным подходом» в черновике, вставка, суммы и обновление', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005594');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Нежилое: доходный' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'bank', bank: 'other', region: 'moscow', object_type: 'commercial', address: 'г. Москва, Тестовая ул., д. 5, пом. 1',
    area: 120.5, premises_use: 'office', lease: 'full', lease_rent: 180000 };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 800000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_incomecalc_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005595');
  await db(async (c) => {
    await c.query("update users set full_name = 'Доходов Илья Петрович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  const d = await ep.request.post(`/api/orders/${o.id}/draft/ai`, { data: {}, headers: H });
  expect(d.status(), await d.text()).toBe(201);
  const draft = (await d.json()).draft;
  expect(draft.body).toContain('| Арендная плата по договору, руб. в месяц | 180 000 (по заявке — сравните с рыночной ставкой) |');

  // Эксперт убрал таблицу из черновика — в деле подсказка и «Вставить таблицу в черновик».
  const lines = draft.body.split('\n');
  const at = lines.indexOf(HEAD);
  lines.splice(at - 1, 12);
  expect((await ep.request.put(`/api/orders/${o.id}/draft`, { data: { body: lines.join('\n'), from: draft.id }, headers: H })).status()).toBe(200);
  await ep.goto(`/kabinet#order=${o.id}`);
  const text = ep.locator('#draft-text');
  await expect(text).toBeVisible();
  const box = ep.locator('#draft-income');
  await expect(box).toBeVisible();
  await expect(box).toContainText('Таблицы «Расчёт доходным подходом» в черновике нет');
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await box.scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/np04-dohodnyj-net.png', fullPage: false });
  await box.getByRole('button', { name: 'Вставить таблицу в черновик' }).click();
  await expect(ep.locator('#draft-msg')).toContainText('Таблица «Расчёт доходным подходом» в черновике, черновик сохранён');
  await expect(box).toBeHidden();
  const v = (await text.inputValue()).split('\n');
  const h = v.findIndex((l) => /^#{1,3}\s*\d+\. Доходный подход/.test(l));
  const t = v.indexOf(HEAD);
  const next = v.findIndex((l, i) => i > h && /^#{1,3}\s/.test(l));
  expect(t > h && (next < 0 || t < next)).toBe(true);
  expect(v[t - 1]).toBe('');
  await ep.screenshot({ path: 'test-results/screens/np05-dohodnyj-v-chernovike.png', fullPage: false });

  // Эксперт вписал суммы — таблица не устарела, подсказки нет.
  const cur = await (await ep.request.get(`/api/orders/${o.id}/draft`)).json();
  const sums = cur.draft.body.replace('| Ставка капитализации, % | [заполнить] (источник — [заполнить]) |', '| Ставка капитализации, % | 10,5 (источник — справочник, табл. 5) |')
    .replace('| Стоимость доходным подходом (ЧОД / ставка), руб. | [заполнить] |', '| Стоимость доходным подходом (ЧОД / ставка), руб. | 17 100 000 |');
  expect((await ep.request.put(`/api/orders/${o.id}/draft`, { data: { body: sums, from: cur.draft.id }, headers: H })).status()).toBe(200);
  await ep.reload();
  await expect(text).toHaveValue(/17 100 000/);
  await expect(box).toBeHidden();

  // Заказчик поменял арендную плату — таблица устарела, обновление заменяет её целиком.
  await db((c) => c.query(`update orders set fields = fields || '{"lease_rent":200000}'::jsonb where id = $1`, [o.id]));
  await ep.reload();
  await expect(box).toBeVisible();
  await expect(box).toContainText('устарела');
  await box.getByRole('button', { name: 'Обновить таблицу в черновике' }).click();
  await expect(ep.locator('#draft-msg')).toContainText('черновик сохранён');
  await expect(box).toBeHidden();
  await expect(text).toHaveValue(/\| Арендная плата по договору, руб\. в месяц \| 200 000 \(по заявке — сравните с рыночной ставкой\) \|/);
  expect((await text.inputValue()).split('\n').filter((l) => l === HEAD).length).toBe(1);
  expect(problems).toEqual([]);
  await ectx.close();
});
