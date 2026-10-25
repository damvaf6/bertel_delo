// Перечень отчётов для СРО (задача 2.401) — телефон 412×915: в профиле специалиста свои сданные отчёты об оценке за год —
// номер, дата и стоимость из файла отчёта; у дела без файла — «не нашлось, допишите». Что попадает в перечень — считает
// сервер (тест «2.401» в tests/server/access.test.mjs); здесь — как это видно на экране. Номера +7 999 000-24-0x — только здесь.
// 2.402 — тот же перечень у руководителя организации по всем её экспертам.
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
async function shot(page, name) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, `${name}: страница шире экрана`).toBeLessThanOrEqual(412);
  await page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: true });
}

test('2.401: перечень отчётов для СРО — номер, дата и стоимость из файла; без файла — «допишите»; таблица Excel', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU',
    storageState: { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'delo.folds', value: 'open' }] }] } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(page, '+79990002403');
  const ids = await db(async (c) => {
    await c.query("update users set full_name = 'Оценщикова Анна' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, created_at) values ($1, now() - interval '2 years')", [expert.id]);
    const mk = async (title, service, fields) => {
      const id = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields)
        values ($1, $2, 'expertise', $3, 'done', $1, current_date, $4) returning id`, [expert.id, title, service, fields])).rows[0].id;
      await c.query("insert into order_status_history (order_id, from_status, to_status, side) values ($1, 'review', 'done', 'dispatcher')", [id]);
      return id;
    };
    const flat = await mk('Квартира на Тихой', 'realty', { purpose: 'bank', address: 'г. Москва, Тихая ул., д. 3, кв. 12' });
    await c.query("update order_status_history set at = at - interval '1 minute' where order_id = $1", [flat]);
    const car = await mk('Лада в суд', 'vehicle', { purpose: 'court', make_model: 'Лада Веста', year: 2020 });
    return { flat, car };
  });
  const text = 'ОТЧЁТ ОБ ОЦЕНКЕ № 77/2026 от 12.10.2026\nИтоговая величина рыночной стоимости объекта оценки составляет 9 870 000 руб.\nОтчёт № 77/2026';
  const up = await page.request.post(`/api/orders/${ids.flat}/documents`, { data: Buffer.from(text), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') } });
  expect(up.status()).toBe(201);
  await db((c) => c.query("update documents set kind = 'result' where order_id = $1", [ids.flat]));

  await page.goto('/kabinet#specialist');
  const box = page.locator('#registry-box');
  await expect(box.getByRole('heading', { name: 'Перечень отчётов для СРО' })).toBeVisible();
  await expect(page.locator('#registry-year option')).toHaveCount(4);
  await expect(page.locator('#registry-total')).toContainText('2 отчёта · дописать — в 1');
  const rows = page.locator('#registry-rows > li');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('1. Отчёт № 77/2026 от 12 октября 2026');
  await expect(rows.nth(0)).toContainText('г. Москва, Тихая ул., д. 3, кв. 12');
  await expect(rows.nth(0)).toContainText('Оценка недвижимости · Ипотека, залог, банк · заказчик — Оценщикова Анна');
  await expect(rows.nth(0)).toContainText('Итоговая стоимость: 9 870 000');
  await expect(rows.nth(1)).toContainText('2. Отчёт без номера');
  await expect(rows.nth(1).locator('[data-registry-missing]')).toContainText('номер отчёта, дата составления, итоговая стоимость — допишите');
  // 2.404: у дела без файла — почему не нашлось и переход к делу; подсказок по тексту нет — искать негде.
  await expect(rows.nth(1).locator('[data-registry-missing]')).toContainText('Файла отчёта в деле нет');
  await expect(rows.nth(1).locator('[data-registry-where]')).toHaveCount(0);
  await expect(rows.nth(1).locator('[data-registry-open]')).toHaveText('Открыть дело');
  await box.scrollIntoViewIfNeeded();
  await shot(page, 'r01-2401-perechen-otchetov-sro');
  // Таблица для Excel — с сервера по той же учётке.
  const csv = await page.request.get(`/api/specialist/me/registry?format=csv&year=${await page.locator('#registry-year').inputValue()}`);
  expect(csv.status()).toBe(200);
  expect(await csv.text()).toContain('1;77/2026;12.10.2026;г. Москва, Тихая ул., д. 3, кв. 12;Оценка недвижимости;Ипотека, залог, банк');
  // 2.407: заключения за период одним архивом — кнопка со счётом; закрытое заказчиком дело из перечня не пропадает.
  await db((c) => c.query("update orders set status = 'closed' where id = $1", [ids.car]));
  await page.reload();
  await expect(rows).toHaveCount(2);
  const zipBtn = page.locator('#registry-archive');
  await expect(zipBtn).toHaveText('Заключения архивом (2)');
  await zipBtn.scrollIntoViewIfNeeded();
  await shot(page, 'r07-2407-zaklyucheniya-arhivom');
  const [download] = await Promise.all([page.waitForEvent('download'), zipBtn.click()]);
  expect(download.suggestedFilename()).toMatch(/^Мои заключения за \d{4} год\.zip$/);
  // Прошлый год — пусто, кнопки архива нет; строка ведёт в дело.
  await page.locator('#registry-year').selectOption({ index: 1 });
  await expect(page.locator('#registry-empty')).toBeVisible();
  await expect(rows).toHaveCount(0);
  await expect(zipBtn).toBeHidden();
  await page.locator('#registry-year').selectOption({ index: 0 });
  await expect(rows).toHaveCount(2);
  await rows.nth(1).getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`#order=${ids.car}`));
  expect(problems).toEqual([]);
  await ctx.close();
});

test('2.402: перечень отчётов для СРО у руководителя — все эксперты организации с именем, итог по экспертам; Excel', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU',
    storageState: { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'delo.folds', value: 'open' }] }] } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const head = await signIn(page, '+79990002409');
  const ids = await db(async (c) => {
    const user = async (phone) => (await c.query('insert into users (phone) values ($1) on conflict (phone) do update set phone = excluded.phone returning id', [phone])).rows[0];
    const ex1 = await user('+79990002407');
    const ex2 = await user('+79990002408');
    const org = (await c.query("insert into organizations (name) values ('ООО «Оценка-Перечень»') returning id")).rows[0].id;
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head')", [org, head.id]);
    for (const [u, name] of [[ex1, 'Альфина Анна'], [ex2, 'Борисов Борис']]) {
      await c.query('update users set full_name = $2 where id = $1', [u.id, name]);
      await c.query("insert into org_members (org_id, user_id, role, created_at) values ($1, $2, 'member', now() - interval '1 day')", [org, u.id]);
      await c.query("insert into specialists (user_id, org_id, created_at) values ($1, $2, now() - interval '2 years')", [u.id, org]);
    }
    const mk = async (executor, title, service, fields) => {
      const id = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields)
        values ($1, $2, 'expertise', $3, 'done', $5, current_date, $4) returning id`, [head.id, title, service, fields, executor])).rows[0].id;
      await c.query("insert into order_status_history (order_id, from_status, to_status, side) values ($1, 'review', 'done', 'dispatcher')", [id]);
      return id;
    };
    const flat = await mk(ex1.id, 'Квартира на Липовой', 'realty', { purpose: 'bank', address: 'г. Москва, Липовая ул., д. 7, кв. 1' });
    await c.query("update order_status_history set at = at - interval '1 minute' where order_id = $1", [flat]);
    const car = await mk(ex2.id, 'Лада Гранта в суд', 'vehicle', { purpose: 'court', make_model: 'Лада Гранта', year: 2019 });
    const text = 'ОТЧЁТ ОБ ОЦЕНКЕ № 24/2026-П от 14.10.2026\nИтоговая величина рыночной стоимости объекта оценки составляет 6 300 000 руб.\nОтчёт № 24/2026-П';
    return { org, flat, car, text, ex1: ex1.id };
  });
  // Файл отчёта — через сервер (хранилище знает только сервер); заказчик в этих делах — сам руководитель.
  const up = await page.request.post(`/api/orders/${ids.flat}/documents`, { data: Buffer.from(ids.text), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') } });
  expect(up.status()).toBe(201);
  await db((c) => c.query("update documents set kind = 'result', uploaded_by = $2 where order_id = $1", [ids.flat, ids.ex1]));

  await page.goto(`/kabinet#org=${ids.org}`);
  const box = page.locator('#org-registry-box');
  await expect(box.getByRole('heading', { name: 'Перечень отчётов для СРО' })).toBeVisible();
  await expect(page.locator('#org-registry-total')).toContainText('2 отчёта · дописать — в 1');
  const experts = page.locator('#org-registry-experts > li');
  await expect(experts).toHaveCount(2);
  await expect(experts.nth(0)).toContainText('Альфина Анна');
  await expect(experts.nth(0)).toContainText('1 отчёт · всё нашлось в файлах');
  await expect(experts.nth(1)).toContainText('Борисов Борис1 отчёт · дописать — в 1');
  const rows = page.locator('#org-registry-rows > li');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('1. Отчёт № 24/2026-П от 14 октября 2026');
  await expect(rows.nth(0)).toContainText('Альфина Анна · г. Москва, Липовая ул., д. 7, кв. 1');
  await expect(rows.nth(0)).toContainText('Итоговая стоимость: 6 300 000');
  await expect(rows.nth(1)).toContainText('2. Отчёт без номера');
  await expect(rows.nth(1)).toContainText('Борисов Борис · Лада Гранта, 2019 г.');
  await expect(rows.nth(1)).toContainText('допишите в таблице');
  await box.scrollIntoViewIfNeeded();
  await shot(page, 'r02-2402-perechen-otchetov-organizacii');
  await box.screenshot({ path: 'test-results/screens/r03-2402-kartochka-perechnya.png' });
  const csv = await page.request.get(`/api/orgs/${ids.org}/registry?format=csv`);
  expect(csv.status()).toBe(200);
  const body = await csv.text();
  expect(body).toContain('Перечень отчётов об оценке — ООО «Оценка-Перечень»');
  expect(body).toContain('1;24/2026-П;14.10.2026;Альфина Анна;г. Москва, Липовая ул., д. 7, кв. 1');
  // Прошлый год — пусто.
  await page.locator('#org-registry-year').selectOption({ index: 1 });
  await expect(page.locator('#org-registry-empty')).toBeVisible();
  await expect(rows).toHaveCount(0);
  expect(problems).toEqual([]);
  await ctx.close();
});

test('2.403: ИИ-проверка — номер отчёта уже был в другом деле эксперта этого года', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU',
    storageState: { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'delo.folds', value: 'open' }] }] } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(page, '+79990024031');
  const ids = await db(async (c) => {
    await c.query('insert into specialists (user_id) values ($1)', [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [expert.id]);
    const mk = async (title, status) => (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields)
      values ($1, $2, 'expertise', 'realty', $3, $1, current_date + 7, '{}') returning id`, [expert.id, title, status])).rows[0].id;
    return { past: await mk('Квартира на Садовой', 'done'), now: await mk('Квартира на Луговой', 'in_work') };
  });
  const put = async (id, num) => {
    const text = `ОТЧЁТ ОБ ОЦЕНКЕ № ${num} от 20.10.2026\nДата составления отчёта: 20.10.2026\nОтчёт № ${num}`;
    const up = await page.request.post(`/api/orders/${id}/documents`, { data: Buffer.from(text), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') } });
    expect(up.status()).toBe(201);
    await db((c) => c.query("update documents set kind = 'result' where order_id = $1", [id]));
  };
  await put(ids.past, '41/2026');
  await put(ids.now, '41/2026');
  await page.goto(`/kabinet#order=${ids.now}`);
  await page.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(page.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  const hit = page.locator('#review-checks').getByText(/Номер отчёта № 41\/2026 уже был в Вашем деле «Квартира на Садовой»/);
  await expect(hit).toBeVisible();
  await hit.scrollIntoViewIfNeeded();
  await shot(page, 'r04-2403-nomer-uzhe-byl');
  expect(problems).toEqual([]);
  await ctx.close();
});

test('2.404: перечень — чего не нашлось: скан или нет в тексте, где это обычно пишут, переход к файлу в деле', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU',
    storageState: { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'delo.folds', value: 'open' }] }] } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(page, '+79990004492');
  const ids = await db(async (c) => {
    await c.query("update users set full_name = 'Подсказкина Вера' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, created_at) values ($1, now() - interval '2 years')", [expert.id]);
    const mk = async (title, address) => {
      const id = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields)
        values ($1, $2, 'expertise', 'realty', 'done', $1, current_date, $3) returning id`, [expert.id, title, { purpose: 'deal', address }])).rows[0].id;
      await c.query("insert into order_status_history (order_id, from_status, to_status, side) values ($1, 'review', 'done', 'dispatcher')", [id]);
      return id;
    };
    const part = await mk('Квартира на Ясной', 'г. Москва, Ясная ул., д. 5, кв. 9');
    await c.query("update order_status_history set at = at - interval '1 minute' where order_id = $1", [part]);
    const scan = await mk('Дом в Истре', 'Московская обл., г. Истра, ул. Лесная, д. 2');
    return { part, scan };
  });
  const files = [[ids.part, 'отчёт.txt', 'ОТЧЁТ ОБ ОЦЕНКЕ № 52/2026 от 08.10.2026\nОтчёт № 52/2026'], [ids.scan, 'скан.txt', 'картинка']];
  for (const [id, name, text] of files) {
    const up = await page.request.post(`/api/orders/${id}/documents`, { data: Buffer.from(text), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) } });
    expect(up.status()).toBe(201);
  }
  await db(async (c) => {
    await c.query("update documents set kind = 'result' where order_id = any($1)", [[ids.part, ids.scan]]);
    await c.query("update documents set mime = 'image/jpeg', filename = 'скан.jpg' where order_id = $1", [ids.scan]);
  });

  await page.goto('/kabinet#specialist');
  const rows = page.locator('#registry-rows > li');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('1. Отчёт № 52/2026 от 8 октября 2026');
  await expect(rows.nth(0).locator('[data-registry-missing]')).toHaveText('Не нашлось в файле отчёта: итоговая стоимость — допишите в таблице');
  await expect(rows.nth(0).locator('[data-registry-where]')).toContainText('Обычно итоговая стоимость — в разделе «Итоговая величина стоимости» и в сопроводительном письме');
  await expect(rows.nth(1).locator('[data-registry-missing]')).toContainText('Файл отчёта не читается (скан или картинка): номер отчёта, дата составления, итоговая стоимость');
  await expect(rows.nth(1).locator('[data-registry-where]')).toHaveCount(0);
  await expect(rows.nth(1).locator('[data-registry-open]')).toHaveText('Открыть файл отчёта в деле');
  await rows.nth(0).scrollIntoViewIfNeeded();
  await shot(page, 'r05-2404-gde-pishut');
  // Переход — к файлам результата в деле.
  await rows.nth(0).locator('[data-registry-open]').click();
  await expect(page).toHaveURL(new RegExp(`#order=${ids.part}&to=result`));
  await expect(page.locator('#docs-box')).toBeVisible();
  await expect(page.locator('#docs-box')).toContainText('отчёт.txt');
  await shot(page, 'r06-2404-delo-fajl');
  expect(problems).toEqual([]);
  await ctx.close();
});
