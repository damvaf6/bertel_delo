// Прогон 2.538 (пачка «Жилой дом с участком») — телефон 412×915: выписка на участок пришла после черновика — таблица
// «Стоимость дома и участка» в деле «устарела», «Обновить» ставит номер и площадь участка из выписки; ИИ-проверка отчёта о
// доме не путает номер участка с номером дома. Логика — tests/server/house-run.test.mjs. Номера +7 999 000-59-83…84 — только здесь.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DB_URL, TEST_TOKEN } from '../helpers.mjs';

const CONTROL = process.env.UI_TEST_CONTROL_TOKEN || TEST_TOKEN;
const H = { 'x-delo-request': '1' };
const HEAD = '| Стоимость дома и участка | Значение |';

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

test('прогон 2.538: дом — участок из выписки в таблицу, номер участка не «чужой»', async ({ page, browser, baseURL }) => {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const ctx = { baseURL, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ru-RU' };

  await signIn(page, '+79990005983');
  const o = (await (await page.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Дом: прогон пачки' }, headers: H })).json()).order;
  const deadline = new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10);
  const fields = { purpose: 'bank', region: 'mo', object_type: 'house', address: 'Московская обл., д. Тестовая, ул. Садовая, д. 7', area: 120,
    house_land: 'own', land_cadastral: '50:20:0010101:15', land_area: 15, house_walls: 'brick', house_gas: 'main', house_winter: 'yes' };
  const r0 = await page.request.patch(`/api/orders/${o.id}`, { data: { deadline, fields }, headers: H });
  expect(r0.status(), await r0.text()).toBe(200);
  expect((await page.request.post(`/api/orders/${o.id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db(async (c) => {
    await c.query('update orders set price_kop = 800000 where id = $1', [o.id]);
    await c.query(`insert into payments (order_id, amount_kop, status, provider_id, created_by, paid_at)
                   select id, price_kop, 'succeeded', 'pay_test_houserun_' || id, owner_user_id, now() from orders where id = $1`, [o.id]);
    await c.query('update orders set paid_at = now() where id = $1', [o.id]);
  });

  const ectx = await browser.newContext(ctx);
  const ep = await ectx.newPage();
  ep.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(ep, '+79990005984');
  await db(async (c) => {
    await c.query("update users set full_name = 'Участков Иван Петрович' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5) on conflict do nothing", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty') on conflict do nothing", [expert.id]);
  });
  expect((await ep.request.post(`/api/specialist/feed/${o.id}/take`, { headers: H })).status()).toBe(200);
  const d = await ep.request.post(`/api/orders/${o.id}/draft/ai`, { data: {}, headers: H });
  expect(d.status(), await d.text()).toBe(201);
  expect((await d.json()).draft.body).toContain('15 сот. — по заявке, сверьте с выпиской ЕГРН на участок');

  // Выписки на дом и на участок пришли после черновика.
  const day = new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
  const put = async (text, name) => expect((await page.request.post(`/api/orders/${o.id}/documents`, {
    data: Buffer.from(text), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) } })).status()).toBe(201);
  await put(['Выписка из Единого государственного реестра недвижимости об объекте недвижимости', `${day} № КУВИ-001/2026-77001`,
    'Вид объекта недвижимости: Здание', 'Назначение: жилой дом', 'Кадастровый номер: 50:20:0010101:301', 'Площадь: 120 кв. м'].join('\n'), 'Выписка на дом.txt');
  await put(['Выписка из Единого государственного реестра недвижимости об объекте недвижимости', `${day} № КУВИ-001/2026-77002`,
    'Вид объекта недвижимости: Земельный участок', 'Кадастровый номер: 50:20:0010101:15', 'Площадь: 1200 +/- 12 кв. м'].join('\n'), 'Выписка на участок.txt');

  await ep.goto(`/kabinet#order=${o.id}`);
  const text = ep.locator('#draft-text');
  await expect(text).toBeVisible();
  const box = ep.locator('#draft-house');
  await expect(box).toBeVisible();
  await expect(box).toContainText('пришла выписка ЕГРН на участок');
  await box.scrollIntoViewIfNeeded();
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.screenshot({ path: 'test-results/screens/hs14-2538-uchastok-po-vypiske.png', fullPage: false });
  await box.getByRole('button', { name: 'Обновить таблицу в черновике' }).click();
  await expect(ep.locator('#draft-msg')).toContainText('черновик сохранён');
  await expect(box).toBeHidden();
  await expect(text).toHaveValue(/\| Земельный участок под домом \(кадастровый номер 50:20:0010101:15, 1 200 кв\. м — по выписке ЕГРН на участок\), руб\. \| \[заполнить\] \|/);
  expect((await text.inputValue()).split('\n').filter((l) => l === HEAD).length).toBe(1);

  // Отчёт: номер дома и номер участка — ИИ-проверка не пишет «не совпадает с выпиской на дом» про номер участка.
  const report = [
    'ОТЧЁТ ОБ ОЦЕНКЕ № 38/2026',
    'Объект оценки: жилой дом с земельным участком, Московская обл., д. Тестовая, ул. Садовая, д. 7',
    'Жилой дом с кадастровым номером 50:20:0010101:301, общая площадь 120 кв. м, расположен на земельном участке с кадастровым номером 50:20:0010101:15 площадью 1200 кв. м.',
    'Стоимость дома и участка',
    '| Жилой дом, руб. | 8 000 000 |',
    '| Земельный участок под домом (кадастровый номер 50:20:0010101:15, 1 200 кв. м — по выписке ЕГРН на участок), руб. | 2 000 000 |',
    '| Итого: дом и участок (единый объект, ст. 35 ЗК РФ), руб. | 10 000 000 |',
  ].join('\n');
  expect((await ep.request.post(`/api/orders/${o.id}/results`, {
    data: Buffer.from(report), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') },
  })).status()).toBe(201);
  await ep.reload();
  await ep.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(ep.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  // Раньше пункт «Недвижимость и земля» был с находкой «50:20:0010101:15 не совпадает с выпиской на дом»; теперь — без замечаний.
  const quiet = ep.locator('#review-checks details.ai-quiet summary');
  await expect(quiet).toContainText('Недвижимость и земля');
  await expect(quiet).toContainText('Дом с участком');
  await expect(ep.locator('#review-checks')).not.toContainText('не совпадает с номером в выписке ЕГРН');
  await quiet.scrollIntoViewIfNeeded();
  expect(await ep.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
  await ep.screenshot({ path: 'test-results/screens/hs15-2538-nomer-uchastka.png', fullPage: false });

  expect(problems).toEqual([]);
  await ectx.close();
});
