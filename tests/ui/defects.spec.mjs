// Недостатки товара таблицей (2.482) — телефон 412×915: эксперт по товароведческой экспертизе берёт недостаток из заявки
// одним нажатием, записывает где и какой размер, характер, признаки и номера фото осмотра, правит, вставляет таблицу в
// раздел «5. Исследование» черновика; заказчик видит список, но не пишет. Номера +7 999 000-48-25…26 — только здесь.
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

test('недостатки товара (2.482): из заявки, записать, изменить, таблица в черновик; заказчик только видит', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990004825');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'goods', title: 'Ноутбук: недостатки' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'court', region: 'moscow', subject: 'Ноутбук перестал включаться', questions: 'Есть ли недостаток? Каков его характер?',
    purchase: '12.03.2026, магазин, 54 990 ₽', goods_kind: 'gadget', model: 'Тестовый ноутбук X1, s/n TEST0001',
    defects: 'не включается\nтрещина на крышке', found_date: '20.04.2026', warranty_months: 12, seller_check: 'denied' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 600000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_defects_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990004826');
  await db(async (c) => {
    await c.query("update users set full_name = 'Товаров Илья Петрович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'goods') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  // Фото осмотра в деле: Фото 1 — товар целиком, Фото 2 и 3 — недостаток крупно.
  const link = await ep.request.post(`/api/orders/${o.id}/inspection`, { data: {}, headers: H });
  expect(link.status()).toBe(201);
  const linkId = (await link.json()).link.id;
  await db(async (c) => {
    for (const st of ['goods_overview', 'goods_defect', 'goods_defect']) {
      const d = await c.query(`insert into documents (order_id, uploaded_by, kind, filename, mime, size_bytes, storage_key)
        values ($1, $2, 'inspection', $3, 'image/jpeg', 10, $4) returning id`, [o.id, expert.id, `${st}.jpg`, `ui-defects/${o.id}/${Math.random()}`]);
      await c.query('insert into inspection_photos (document_id, link_id, step) values ($1, $2, $3)', [d.rows[0].id, linkId, st]);
    }
  });
  expect((await ep.request.post(`/api/orders/${o.id}/draft/ai`, { data: {}, headers: H })).status()).toBe(201);

  await ep.goto(`/kabinet#order=${o.id}`);
  const box = ep.locator('#defects-box');
  await expect(box).toBeVisible();
  await expect(ep.locator('#defects-lead')).toContainText('производственный, эксплуатационный');
  await expect(ep.locator('#defects-claimed')).toHaveText('Из заявки ещё не записаны: не включается, трещина на крышке');

  // Недостаток из заявки — одним нажатием в форму.
  await ep.locator('#defects-claimed button', { hasText: 'трещина на крышке' }).click();
  await expect(ep.locator('#defects-defect')).toHaveValue('Трещина на крышке');
  await expect(ep.locator('#defects-natures label')).toHaveText(['производственный', 'эксплуатационный', 'не установлен', 'не подтвердился']);
  await expect(ep.locator('#defects-photos-hint')).toHaveText('В деле 3 фото осмотра: 1 — Товар целиком; 2 — Недостаток крупно; 3 — Недостаток крупно.');
  await ep.locator('#defects-place').fill('Левый верхний угол крышки, 4 см');
  await ep.locator('#defects-save').click();
  await expect(ep.locator('#defects-msg')).toContainText('Выберите характер недостатка');
  await ep.locator('#defects-natures label', { hasText: 'производственный' }).click();
  await ep.locator('#defects-signs').fill('Трещина идёт от места литья, следов удара и вмятин нет');
  await ep.locator('#defects-photos').fill('3, 2');
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.locator('#defects-form').scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/gw03-nedostatki-forma.png', fullPage: false });
  await ep.locator('#defects-save').click();
  await expect(ep.locator('#defects-msg')).toHaveText('Недостаток записан');
  await expect(ep.locator('#defects-form')).toBeHidden();
  const li = ep.locator('#defects-list li');
  await expect(li).toHaveCount(1);
  await expect(li.first()).toContainText('1. Трещина на крышке');
  await expect(li.first()).toContainText('Производственный · фото 2, 3');
  await expect(li.first()).toContainText('Признаки: Трещина идёт от места литья');
  await expect(ep.locator('#defects-claimed')).toHaveText('Из заявки ещё не записаны: не включается');

  // Второй — без фото; потом изменить: характер и фото.
  await ep.locator('#defects-claimed button', { hasText: 'не включается' }).click();
  await ep.locator('#defects-place').fill('Плата питания');
  await ep.locator('#defects-natures label', { hasText: 'не установлен' }).click();
  await ep.locator('#defects-save').click();
  await expect(li).toHaveCount(2);
  await expect(ep.locator('#defects-claimed')).toBeHidden();
  await expect(ep.locator('#defects-lead')).toHaveText('Недостатков: 2. Без фото осмотра: 1.');
  await li.nth(1).getByRole('button', { name: 'Изменить' }).click();
  await expect(ep.locator('#defects-defect')).toHaveValue('Не включается');
  await expect(ep.locator('#defects-natures input[value="unknown"]')).toBeChecked();
  await ep.locator('#defects-natures label', { hasText: 'эксплуатационный' }).click();
  await ep.locator('#defects-place').fill('Плата питания, следы окисления 3 мм');
  await ep.locator('#defects-signs').fill('Следы жидкости');
  await ep.locator('#defects-photos').fill('1');
  await ep.locator('#defects-save').click();
  await expect(ep.locator('#defects-msg')).toHaveText('Недостаток сохранён');
  await expect(li.nth(1)).toContainText('Эксплуатационный · фото 1');
  await expect(ep.locator('#defects-lead')).toHaveText('Недостатков: 2.');

  // Таблица — в черновик раздела «5. Исследование»; второй раз — «уже есть».
  await expect(ep.locator('#defects-draft-row')).toBeVisible();
  await box.scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/gw04-nedostatki-spisok.png', fullPage: false });
  await ep.locator('#defects-draft').click();
  await expect(ep.locator('#defects-msg')).toContainText('вставлена в раздел «Исследование»');
  const text = await ep.locator('#draft-text').inputValue();
  expect(text).toContain([
    '## 5. Исследование',
    '| № | Недостаток | Где и размер | Характер | Признаки | Фото осмотра |',
    '| 1 | Трещина на крышке | Левый верхний угол крышки, 4 см | производственный | Трещина идёт от места литья, следов удара и вмятин нет | Фото 2, 3 |',
    '| 2 | Не включается | Плата питания, следы окисления 3 мм | эксплуатационный | Следы жидкости | Фото 1 |',
  ].join('\n'));
  await ep.locator('#defects-draft').click();
  await expect(ep.locator('#defects-msg')).toHaveText('Эта таблица уже есть в черновике.');

  // Удалить → «Вставить» заменяет прежнюю таблицу целиком.
  await li.nth(0).getByRole('button', { name: 'Удалить' }).click();
  await expect(li).toHaveCount(1);
  await ep.locator('#defects-draft').click();
  await expect(ep.locator('#defects-msg')).toContainText('вставлена');
  const saved = await (await ep.request.get(`/api/orders/${o.id}/draft`, { headers: H })).json();
  expect(saved.draft.body.split('| № | Недостаток |').length).toBe(2);
  expect(saved.draft.body).toContain('| 1 | Не включается | Плата питания, следы окисления 3 мм | эксплуатационный | Следы жидкости | Фото 1 |');
  expect(saved.draft.body).not.toContain('| Трещина на крышке | Левый');

  // Заказчик: видит список, кнопок записи и подсказки из заявки нет.
  await page.goto(`/kabinet#order=${o.id}`);
  await expect(page.locator('#defects-box')).toBeVisible();
  await expect(page.locator('#defects-list li')).toContainText('Не включается');
  await expect(page.locator('#defects-open')).toBeHidden();
  await expect(page.locator('#defects-claimed')).toBeHidden();
  await expect(page.locator('#defects-list').getByRole('button', { name: 'Изменить' })).toHaveCount(0);
  await expect(page.locator('#defects-draft-row')).toBeHidden();

  expect(problems).toEqual([]);
  await ectx.close();
});
