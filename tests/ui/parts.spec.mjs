// Повреждённые детали таблицей (2.471) — телефон 412×915: эксперт по делу «Ущерб после ДТП» записывает детали
// (деталь, повреждение, замена/ремонт/окраска, номера фото осмотра), правит, вставляет таблицу в раздел «Исследование
// повреждений» черновика; заказчик видит список, но не пишет; ИИ-проверка заключения сверяет детали (2.472). Номера +7 999 000-47-93…94 — только здесь.
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

test('повреждённые детали (2.471): записать, изменить, таблица в черновик; заказчик только видит', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990004793');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'car_damage', title: 'ДТП: детали' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'damage', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая Модель', year: 2021, reg_number: 'А001АА777',
    accident_date: '14.09.2026', accident_place: 'г. Москва, Тестовый пр-т', damage: 'Задний бампер, крышка багажника', method: 'osago' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 600000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_parts_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990004794');
  await db(async (c) => {
    await c.query("update users set full_name = 'Деталев Пётр Сергеевич' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'car_damage') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  // Фото осмотра в деле: Фото 1 — спереди, Фото 2 и 3 — сзади.
  const link = await ep.request.post(`/api/orders/${o.id}/inspection`, { data: {}, headers: H });
  expect(link.status()).toBe(201);
  const linkId = (await link.json()).link.id;
  await db(async (c) => {
    for (const st of ['car_front', 'car_rear', 'car_rear']) {
      const d = await c.query(`insert into documents (order_id, uploaded_by, kind, filename, mime, size_bytes, storage_key)
        values ($1, $2, 'inspection', $3, 'image/jpeg', 10, $4) returning id`, [o.id, expert.id, `${st}.jpg`, `ui-parts/${o.id}/${Math.random()}`]);
      await c.query('insert into inspection_photos (document_id, link_id, step) values ($1, $2, $3)', [d.rows[0].id, linkId, st]);
    }
  });
  expect((await ep.request.post(`/api/orders/${o.id}/draft/ai`, { data: {}, headers: H })).status()).toBe(201);

  await ep.goto(`/kabinet#order=${o.id}`);
  const box = ep.locator('#parts-box');
  await expect(box).toBeVisible();
  await expect(ep.locator('#parts-lead')).toContainText('замена, ремонт, окраска');
  await ep.locator('#parts-open').click();
  await expect(ep.locator('#parts-actions label')).toHaveText(['замена', 'ремонт', 'окраска']);
  await expect(ep.locator('#parts-photos-hint')).toHaveText('В деле 3 фото осмотра: 1 — Спереди; 2 — Сзади; 3 — Сзади.');
  await ep.locator('#parts-part').fill('Бампер задний');
  await ep.locator('#parts-damage').fill('Разрыв пластика в правой части, 10 см');
  await ep.locator('#parts-actions label', { hasText: 'замена' }).click();
  await ep.locator('#parts-actions label', { hasText: 'окраска' }).click();
  await ep.locator('#parts-photos').fill('9');
  await ep.locator('#parts-save').click();
  await expect(ep.locator('#parts-msg')).toContainText('нет фото осмотра № 9');
  await ep.locator('#parts-photos').fill('3, 2');
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.locator('#parts-form').scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/dp01-detali-forma.png', fullPage: false });
  await ep.locator('#parts-save').click();
  await expect(ep.locator('#parts-msg')).toHaveText('Деталь записана');
  await expect(ep.locator('#parts-form')).toBeHidden();
  const li = ep.locator('#parts-list li');
  await expect(li).toHaveCount(1);
  await expect(li.first()).toContainText('1. Бампер задний');
  await expect(li.first()).toContainText('Замена, окраска · фото 2, 3');

  // Вторая деталь без фото, потом — изменить: добавить фото.
  await ep.locator('#parts-open').click();
  await ep.locator('#parts-part').fill('Крышка багажника');
  await ep.locator('#parts-damage').fill('Вмятина');
  await ep.locator('#parts-actions label', { hasText: 'ремонт' }).click();
  await ep.locator('#parts-save').click();
  await expect(li).toHaveCount(2);
  await expect(ep.locator('#parts-lead')).toHaveText('Деталей: 2. Без фото осмотра: 1.');
  await li.nth(1).getByRole('button', { name: 'Изменить' }).click();
  await expect(ep.locator('#parts-part')).toHaveValue('Крышка багажника');
  await expect(ep.locator('#parts-actions input[value="repair"]')).toBeChecked();
  await ep.locator('#parts-actions label', { hasText: 'окраска' }).click();
  await ep.locator('#parts-photos').fill('2');
  await ep.locator('#parts-save').click();
  await expect(ep.locator('#parts-msg')).toHaveText('Деталь сохранена');
  await expect(li.nth(1)).toContainText('Ремонт, окраска · фото 2');
  await expect(ep.locator('#parts-lead')).toHaveText('Деталей: 2.');

  // Таблица — в черновик раздела «5. Исследование повреждений»; второй раз — «уже есть».
  await expect(ep.locator('#parts-draft-row')).toBeVisible();
  await box.scrollIntoViewIfNeeded();
  await ep.screenshot({ path: 'test-results/screens/dp02-detali-spisok.png', fullPage: false });
  await ep.locator('#parts-draft').click();
  await expect(ep.locator('#parts-msg')).toContainText('вставлена в раздел «Исследование повреждений»');
  const text = await ep.locator('#draft-text').inputValue();
  expect(text).toContain([
    '## 5. Исследование повреждений',
    '| № | Деталь | Повреждение | Ремонтное воздействие | Фото осмотра |',
    '| 1 | Бампер задний | Разрыв пластика в правой части, 10 см | замена, окраска | Фото 2, 3 |',
    '| 2 | Крышка багажника | Вмятина | ремонт, окраска | Фото 2 |',
  ].join('\n'));
  await ep.locator('#parts-draft').click();
  await expect(ep.locator('#parts-msg')).toHaveText('Эта таблица уже есть в черновике.');

  // Удалить деталь → «Вставить» заменяет прежнюю таблицу целиком.
  await li.nth(0).getByRole('button', { name: 'Удалить' }).click();
  await expect(li).toHaveCount(1);
  await ep.locator('#parts-draft').click();
  await expect(ep.locator('#parts-msg')).toContainText('вставлена');
  const saved = await (await ep.request.get(`/api/orders/${o.id}/draft`, { headers: H })).json();
  expect(saved.draft.body.split('| № | Деталь |').length).toBe(2);
  expect(saved.draft.body).toContain('| 1 | Крышка багажника | Вмятина | ремонт, окраска | Фото 2 |');
  expect(saved.draft.body).not.toContain('Бампер задний | Разрыв');

  // Заказчик: видит список, кнопок записи нет.
  await page.goto(`/kabinet#order=${o.id}`);
  await expect(page.locator('#parts-box')).toBeVisible();
  await expect(page.locator('#parts-list li')).toContainText('Крышка багажника');
  await expect(page.locator('#parts-open')).toBeHidden();
  await expect(page.locator('#parts-list').getByRole('button', { name: 'Изменить' })).toHaveCount(0);
  await expect(page.locator('#parts-draft-row')).toBeHidden();

  // 2.472: ИИ-проверка заключения — деталь из таблицы без строки в калькуляции и деталь из заявки без исследования.
  const report = '5. Исследование повреждений\nКрышка багажника — вмятина.\n7. Расчёт стоимости восстановительного ремонта\nОкраска 3 000 руб.\n9. Выводы\n';
  expect((await ep.request.post(`/api/orders/${o.id}/results`, {
    data: Buffer.from(report), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('заключение.txt') },
  })).status()).toBe(201);
  await ep.goto(`/kabinet#order=${o.id}`);
  await ep.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(ep.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  const dmg = ep.locator('#review-checks > li[data-check="cd_damage"]');
  await expect(dmg.locator('.ai-found li')).toHaveCount(2);
  await expect(dmg).toContainText('Деталь «Крышка багажника» есть в таблице повреждённых деталей, а в калькуляции ремонта её не нашлось');
  await expect(dmg).toContainText('В заявке «Что повреждено» указано «задний бампер», а в исследовании повреждений этой детали нет');
  await dmg.scrollIntoViewIfNeeded();
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.screenshot({ path: 'test-results/screens/dp03-detali-ii-proverka.png', fullPage: false });
  expect(problems).toEqual([]);
  await ectx.close();
});
