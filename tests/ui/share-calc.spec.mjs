// Задача 2.511 — телефон 412×915: черновик от ИИ по оценке доли — в конце «14. Согласование результатов» таблица «Расчёт
// стоимости доли». Эксперт удалил её — в деле «таблицы нет», «Вставить таблицу в черновик» ставит её в конец раздела. Заказчик
// поменял способ на «часть стоимости целого» — «таблица устарела», «Обновить» заменяет её целиком.
// Номера +7 999 000-54-14…15 — только здесь.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DB_URL, TEST_TOKEN } from '../helpers.mjs';

const CONTROL = process.env.UI_TEST_CONTROL_TOKEN || TEST_TOKEN;
const H = { 'x-delo-request': '1' };
const HEAD = '| Расчёт стоимости доли | Значение |';

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

test('2.511: таблица «Расчёт стоимости доли» в черновике, вставка и обновление', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005414');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Доля: расчёт' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'division', region: 'moscow', object_type: 'share', address: 'г. Москва, Тестовая ул., д. 1, кв. 3', area: 54,
    share_size: '1/3', share_method: 'market' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 800000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_sharecalc_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005415');
  await db(async (c) => {
    await c.query("update users set full_name = 'Долин Пётр Иванович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  const d = await ep.request.post(`/api/orders/${o.id}/draft/ai`, { data: {}, headers: H });
  expect(d.status(), await d.text()).toBe(201);
  const draft = (await d.json()).draft;
  expect(draft.body).toContain('| Скидка на долю, % | [заполнить] (источник — [заполнить]) |');

  // Эксперт убрал таблицу из черновика — в деле подсказка и «Вставить таблицу в черновик».
  const lines = draft.body.split('\n');
  const at = lines.indexOf(HEAD);
  lines.splice(at - 1, 7);
  expect((await ep.request.put(`/api/orders/${o.id}/draft`, { data: { body: lines.join('\n'), from: draft.id }, headers: H })).status()).toBe(200);
  await ep.goto(`/kabinet#order=${o.id}`);
  const text = ep.locator('#draft-text');
  await expect(text).toBeVisible();
  const box = ep.locator('#draft-share');
  await expect(box).toBeVisible();
  await expect(box).toContainText('Таблицы «Расчёт стоимости доли» в черновике нет');
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await box.scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/dl02-raschet-doli-net.png', fullPage: false });
  await box.getByRole('button', { name: 'Вставить таблицу в черновик' }).click();
  await expect(ep.locator('#draft-msg')).toContainText('Таблица «Расчёт стоимости доли» в черновике, черновик сохранён');
  await expect(box).toBeHidden();
  const v = (await text.inputValue()).split('\n');
  const h = v.findIndex((l) => /^#{1,3}\s*14\. Согласование результатов/.test(l));
  const t = v.indexOf(HEAD);
  const next = v.findIndex((l, i) => i > h && /^#{1,3}\s/.test(l));
  expect(t > h && (next < 0 || t < next)).toBe(true);
  expect(v[t - 1]).toBe('');
  await ep.screenshot({ path: 'test-results/screens/dl03-raschet-doli-v-chernovike.png', fullPage: false });

  // Заказчик поменял способ — таблица устарела, обновление заменяет её целиком.
  await db((c) => c.query(`update orders set fields = fields || '{"share_method":"pro_rata"}'::jsonb where id = $1`, [o.id]));
  await ep.reload();
  await expect(box).toBeVisible();
  await expect(box).toContainText('устарела');
  await box.getByRole('button', { name: 'Обновить таблицу в черновике' }).click();
  await expect(ep.locator('#draft-msg')).toContainText('черновик сохранён');
  await expect(box).toBeHidden();
  await expect(text).toHaveValue(/\| Скидка на долю \| не применяется — оценивается часть стоимости всего объекта \|/);
  expect((await text.inputValue()).split('\n').filter((l) => l === HEAD).length).toBe(1);
  const saved = await (await ep.request.get(`/api/orders/${o.id}/draft`)).json();
  expect(saved.draft.body).toContain('| Стоимость доли (равна части стоимости объекта), руб. | [заполнить] |');
  expect(problems).toEqual([]);
  await ectx.close();
});
