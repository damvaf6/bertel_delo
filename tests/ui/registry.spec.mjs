// Перечень отчётов для СРО (задача 2.401) — телефон 412×915: в профиле специалиста свои сданные отчёты об оценке за год —
// номер, дата и стоимость из файла отчёта; у дела без файла — «не нашлось, допишите». Что попадает в перечень — считает
// сервер (тест «2.401» в tests/server/access.test.mjs); здесь — как это видно на экране. Номера +7 999 000-24-0x — только здесь.
// 2.402 — тот же перечень у руководителя организации по всем её экспертам.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DB_URL, TEST_TOKEN } from '../helpers.mjs';
import { extractPages } from '../../src/ai/extract.mjs';

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
  // 2.429: в архиве и акты осмотра — строкой под кнопкой.
  await expect(page.locator('#registry-archive-note')).toContainText('акты осмотра');
  await zipBtn.scrollIntoViewIfNeeded();
  await shot(page, 'r07-2407-zaklyucheniya-arhivom');
  const [download] = await Promise.all([page.waitForEvent('download'), zipBtn.click()]);
  expect(download.suggestedFilename()).toMatch(/^Мои заключения за \d{4} год\.zip$/);
  // Прошлый год — пусто, кнопки архива нет; строка ведёт в дело.
  await page.locator('#registry-year').selectOption({ index: 1 });
  await expect(page.locator('#registry-empty')).toBeVisible();
  await expect(rows).toHaveCount(0);
  await expect(zipBtn).toBeHidden();
  await expect(page.locator('#registry-archive-note')).toBeHidden();
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

test('прогон 2.410: перечень — номер повторяется у эксперта; дело старше 90 дней — без ссылки, где взять файлы', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU',
    storageState: { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'delo.folds', value: 'open' }] }] } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const head = await signIn(page, '+79990024101');
  const ids = await db(async (c) => {
    const ex = (await c.query("insert into users (phone, full_name) values ('+79990024102', 'Повторова Вера') on conflict (phone) do update set full_name = excluded.full_name returning id")).rows[0].id;
    const org = (await c.query("insert into organizations (name) values ('ООО «Оценка-Повтор»') returning id")).rows[0].id;
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head')", [org, head.id]);
    await c.query("insert into org_members (org_id, user_id, role, created_at) values ($1, $2, 'member', date_trunc('year', now()) - interval '1 day')", [org, ex]);
    await c.query("insert into specialists (user_id, org_id, created_at) values ($1, $2, now() - interval '2 years')", [ex, org]);
    const mk = async (title, address, ago) => {
      const id = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields, updated_at)
        values ($1, $2, 'expertise', 'realty', 'done', $3, current_date, $4, now() - $5::interval) returning id`, [head.id, title, ex, { purpose: 'deal', address }, ago])).rows[0].id;
      await c.query("insert into order_status_history (order_id, from_status, to_status, side, at) values ($1, 'review', 'done', 'dispatcher', now() - $2::interval)", [id, ago]);
      return id;
    };
    // Самое раннее — в начале года: дальше 90 дней, если сейчас не январь — март; иначе дело просто свежее.
    const old = await mk('Дом в Истре', 'Московская обл., г. Истра, ул. Луговая, д. 5', `${Math.min(95, Math.floor((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 2)) / 86_400_000))} days`);
    const fresh = await mk('Квартира на Садовой', 'г. Москва, Садовая ул., д. 9, кв. 4', '1 minute');
    return { org, ex, old, fresh };
  });
  for (const [id, text] of [[ids.old, 'ОТЧЁТ ОБ ОЦЕНКЕ № 15/2026 от 10.07.2026'], [ids.fresh, 'ОТЧЁТ ОБ ОЦЕНКЕ № 15/2026 от 20.10.2026']]) {
    const up = await page.request.post(`/api/orders/${id}/documents`, { data: Buffer.from(text), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') } });
    expect(up.status()).toBe(201);
  }
  await db((c) => c.query("update documents set kind = 'result', uploaded_by = $2 where order_id = any($1)", [[ids.old, ids.fresh], ids.ex]));
  const oldDays = await db(async (c) => (await c.query("select now() - updated_at > interval '90 days' as old from orders where id = $1", [ids.old])).rows[0].old);

  await page.goto(`/kabinet#org=${ids.org}`);
  await expect(page.locator('#org-registry-total')).toContainText('2 отчёта · дописать — в 2 · номер повторяется — в 2');
  await expect(page.locator('#org-registry-experts > li').nth(0)).toContainText('номер повторяется — в 2');
  const rows = page.locator('#org-registry-rows > li');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('[data-registry-dup]')).toHaveText('Номер № 15/2026 повторяется в отчётах эксперта Повторова Вера — у каждого отчёта оценщика свой номер');
  await expect(rows.nth(1).locator('[data-registry-dup]')).toBeVisible();
  if (oldDays) {
    await expect(rows.nth(0).getByRole('link')).toHaveCount(0);
    await expect(rows.nth(0).locator('[data-registry-old]')).toContainText('Сдано больше 90 дней назад');
  }
  await expect(rows.nth(1).getByRole('link')).toHaveCount(1);
  await expect(rows.nth(1).locator('[data-registry-old]')).toHaveCount(0);
  await page.locator('#org-registry-box').scrollIntoViewIfNeeded();
  await shot(page, 'r10-2410-perechen-povtor-nomera');
  expect(problems).toEqual([]);
  await ctx.close();
});

// 2.411: «Нумерация отчётов» в профиле — образец по последнему отчёту одной кнопкой, следующий номер, сохранение.
test('2.411, 2.412: нумерация отчётов — подсказка образца, следующий номер, неверный образец, сохранение, номер в Word', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU',
    storageState: { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'delo.folds', value: 'open' }] }] } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(page, '+79990002411');
  const year = Number(new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 4));
  const id = await db(async (c) => {
    await c.query("insert into specialists (user_id) values ($1)", [expert.id]);
    return (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields)
      values ($1, 'Дом в Кратове', 'expertise', 'realty', 'done', $1, current_date, '{}') returning id`, [expert.id])).rows[0].id;
  });
  const text = `ОТЧЁТ ОБ ОЦЕНКЕ № 145/${year} от 12.10.${year}\nОтчёт № 145/${year}`;
  const up = await page.request.post(`/api/orders/${id}/documents`, { data: Buffer.from(text), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') } });
  expect(up.status()).toBe(201);
  await db((c) => c.query("update documents set kind = 'result' where order_id = $1", [id]));

  await page.goto('/kabinet#specialist');
  const box = page.locator('#numbering-box');
  await expect(box.getByRole('heading', { name: 'Нумерация отчётов' })).toBeVisible();
  await expect(page.locator('#numbering-last')).toContainText(`№ 145/${year}`);
  await expect(page.locator('#numbering-last')).toContainText('«Дом в Кратове»');
  await expect(page.locator('#numbering-guess')).toHaveText('Взять образец по последнему отчёту: {N}/{ГГГГ}');
  await expect(page.locator('#numbering-next')).toContainText(`Следующий номер по этому образцу: № 146/${year}`);
  await box.scrollIntoViewIfNeeded();
  await shot(page, 'r11-2411-numeraciya-podskazka');
  // Неверный образец — понятная причина; образец по подсказке — сохраняется.
  await page.locator('#numbering-pattern').fill('{ГГГГ}-О');
  await page.locator('#numbering-save').click();
  await expect(page.locator('#numbering-msg')).toContainText('{N}');
  await page.locator('#numbering-guess').click();
  await expect(page.locator('#numbering-pattern')).toHaveValue('{N}/{ГГГГ}');
  await page.locator('#numbering-save').click();
  await expect(page.locator('#numbering-msg')).toHaveText('Образец сохранён');
  await expect(page.locator('#numbering-guess')).toBeHidden();
  await expect(page.locator('#numbering-next')).toContainText(`Следующий номер: № 146/${year} — после № 145/${year}`);
  await box.scrollIntoViewIfNeeded();
  await shot(page, 'r12-2411-numeraciya-sohraneno');
  // 2.412: с образцом — подсказка, что номер ставится в Word; сборка Word в деле — № 146 на титуле, следующий — 147.
  await expect(page.locator('#numbering-word')).toBeVisible();
  const work = await db(async (c) => {
    const o = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields)
      values ($1, 'Квартира в Люберцах', 'expertise', 'realty', 'in_work', $1, current_date + 7, '{}') returning id`, [expert.id])).rows[0].id;
    await c.query("insert into result_drafts (order_id, author_id, source, body) values ($1, $2, 'edit', '1. Общие сведения\nТекст.')", [o, expert.id]);
    return o;
  });
  const w = await page.request.get(`/api/orders/${work}/draft/docx`);
  expect(w.status()).toBe(200);
  expect((await extractPages(Buffer.from(await w.body()), 'Отчёт.docx')).pages.join('\n')).toContain(`№ 146/${year}`);
  await page.reload();
  await expect(page.locator('#numbering-next')).toContainText(`Следующий номер: № 147/${year} — после № 146/${year}`);
  await box.scrollIntoViewIfNeeded();
  await shot(page, 'r13-2412-nomer-v-word');
  expect(problems).toEqual([]);
  await ctx.close();
});

// 2.413: номер отчёта в деле — виден у черновика, меняется вручную; номер другого своего дела — нельзя.
test('2.413: номер отчёта в деле — виден, меняется вручную, занятый другим делом — нельзя', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU',
    storageState: { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'delo.folds', value: 'open' }] }] } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(page, '+79990002413');
  const year = Number(new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 4));
  const ids = await db(async (c) => {
    await c.query("insert into specialists (user_id, report_pattern) values ($1, '{N}/{ГГГГ}')", [expert.id]);
    const mk = async (title, number) => {
      const o = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields, report_number, report_number_on, report_number_by)
        values ($1, $2, 'expertise', 'realty', 'in_work', $1, current_date + 7, '{}', $3, current_date, $4) returning id`, [expert.id, title, number, number ? expert.id : null])).rows[0].id;
      await c.query("insert into result_drafts (order_id, author_id, source, body) values ($1, $2, 'edit', '1. Общие сведения\nТекст.')", [o, expert.id]);
      return o;
    };
    return { busy: await mk('Квартира в Химках', `12/${year}`), open: await mk('Гараж в Мытищах', null) };
  });
  await page.goto(`/kabinet#order=${ids.open}`);
  const line = page.locator('#draft-number-line');
  await expect(line).toContainText('выдастся по Вашему образцу при первой сборке Word');
  await page.locator('#draft-number-edit').click();
  await page.locator('#draft-number-input').fill(`12/${year}`);
  await page.locator('#draft-number-save').click();
  await expect(page.locator('#draft-msg')).toContainText(`Номер № 12/${year} уже у дела «Квартира в Химках»`);
  await page.locator('#draft-number-input').fill(`№ 13/${year}`);
  await page.locator('#draft-number-save').click();
  await expect(line).toContainText(`Номер отчёта: № 13/${year}`);
  await expect(page.locator('#draft-number-edit')).toHaveText('Изменить номер');
  const w = await page.request.get(`/api/orders/${ids.open}/draft/docx`);
  expect(w.status()).toBe(200);
  expect((await extractPages(Buffer.from(await w.body()), 'Отчёт.docx')).pages.join('\n')).toContain(`№ 13/${year}`);
  await page.locator('#draft-number').scrollIntoViewIfNeeded();
  await shot(page, 'r14-2413-nomer-v-dele');
  expect(problems).toEqual([]);
  await ctx.close();
});

test('2.414: ИИ-проверка — номер в файле отчёта не тот, что выдан делу', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU',
    storageState: { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'delo.folds', value: 'open' }] }] } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(page, '+79990002414');
  const id = await db(async (c) => {
    await c.query("insert into specialists (user_id, report_pattern) values ($1, '{N}/{ГГГГ}')", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [expert.id]);
    return (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields, report_number, report_number_on, report_number_by)
      values ($1, 'Дача в Звенигороде', 'expertise', 'realty', 'in_work', $1, current_date + 7, '{}', '15/2026', current_date, $1) returning id`, [expert.id])).rows[0].id;
  });
  const text = 'ОТЧЁТ ОБ ОЦЕНКЕ № 14/2026 от 20.10.2026\nДата составления отчёта: 20.10.2026\nОтчёт № 14/2026';
  const up = await page.request.post(`/api/orders/${id}/documents`, { data: Buffer.from(text), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') } });
  expect(up.status()).toBe(201);
  await db((c) => c.query("update documents set kind = 'result' where order_id = $1", [id]));
  await page.goto(`/kabinet#order=${id}`);
  await page.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(page.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  const hit = page.locator('#review-checks').getByText(/Номер отчёта № 14\/2026 не тот, что выдан делу: в деле выдан № 15\/2026/);
  await expect(hit).toBeVisible();
  await hit.scrollIntoViewIfNeeded();
  await shot(page, 'r15-2414-nomer-ne-tot');
  expect(problems).toEqual([]);
  await ctx.close();
});

// 2.415: нумерация организации — руководитель задаёт один образец и видит общий счёт; эксперт от организации видит, что
// номера выдаёт организация, и свой образец не действует.
test('2.415: нумерация организации — образец руководителя, общий счёт, у эксперта — «номера выдаёт организация»', async ({ browser, baseURL }) => {
  const opts = { baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU',
    storageState: { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'delo.folds', value: 'open' }] }] } };
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const head = await signIn(page, '+79990002415');
  const ectx = await browser.newContext(opts);
  const epage = await ectx.newPage();
  epage.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(epage, '+79990002416');
  const year = Number(new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 4));
  const org = await db(async (c) => {
    const id = (await c.query("insert into organizations (name) values ('ООО «Оценка-Счёт»') returning id")).rows[0].id;
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head')", [id, head.id]);
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'member')", [id, expert.id]);
    await c.query("update users set full_name = 'Счётова Ева' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, org_id, report_pattern) values ($1, $2, '{N}/{ГГГГ}')", [expert.id, id]);
    return id;
  });

  await page.goto(`/kabinet#org=${org}`);
  const box = page.locator('#org-numbering-box');
  await expect(box.getByRole('heading', { name: 'Нумерация отчётов организации' })).toBeVisible();
  await expect(page.locator('#org-numbering-experts')).toHaveText('Свои образцы экспертов: Счётова Ева — {N}/{ГГГГ}.');
  await expect(page.locator('#org-numbering-guess')).toHaveText('Взять образец экспертов: {N}/{ГГГГ}');
  // Неверный образец — причина; свой образец организации — сохраняется.
  await page.locator('#org-numbering-pattern').fill('ОРГ/{ГГГГ}');
  await page.locator('#org-numbering-save').click();
  await expect(page.locator('#org-numbering-msg')).toContainText('{N}');
  await page.locator('#org-numbering-pattern').fill('ОРГ-{N}/{ГГГГ}');
  await page.locator('#org-numbering-save').click();
  await expect(page.locator('#org-numbering-msg')).toHaveText('Образец сохранён — номера всем экспертам организации выдаются по нему');
  await expect(page.locator('#org-numbering-next')).toContainText(`Следующий номер: № ОРГ-1/${year} — в ${year} году номеров по образцу ещё не было`);
  // Номер, выданный делу эксперта по счёту организации, — в счёт следующего, с именем эксперта.
  await db(async (c) => {
    await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields, report_number,
      report_number_on, report_number_by, report_number_org) values ($1, 'Квартира в Мытищах', 'expertise', 'realty', 'in_work', $1,
      current_date + 7, '{}', $3, current_date, $1, $2)`, [expert.id, org, `ОРГ-7/${year}`]);
  });
  await page.reload();
  await expect(page.locator('#org-numbering-next')).toContainText(`Следующий номер: № ОРГ-8/${year} — после № ОРГ-7/${year}`);
  await expect(page.locator('#org-numbering-next')).toContainText(`Счётова Ева); выдано по счёту организации в ${year} году — 1`);
  await expect(page.locator('#org-numbering-experts')).toContainText('Пока у организации есть образец, они не действуют.');
  await box.scrollIntoViewIfNeeded();
  await shot(page, 'r16-2415-numeraciya-organizacii');

  // Эксперт: номера выдаёт организация, свой образец не правится, следующий — из общего счёта.
  await epage.goto('/kabinet#specialist');
  const ebox = epage.locator('#numbering-box');
  await expect(epage.locator('#numbering-org')).toHaveText('Номера отчётов выдаёт организация «ООО «Оценка-Счёт»» по образцу ОРГ-{N}/{ГГГГ} — общий счёт для всех её экспертов. Свой образец не действует, пока Вы работаете от неё.');
  await expect(epage.locator('#numbering-own')).toBeHidden();
  await expect(epage.locator('#numbering-save')).toBeHidden();
  await expect(epage.locator('#numbering-next')).toContainText(`Следующий номер: № ОРГ-8/${year} — после № ОРГ-7/${year}`);
  await expect(epage.locator('#numbering-word')).toBeVisible();
  await ebox.scrollIntoViewIfNeeded();
  await shot(epage, 'r17-2415-nomera-vydaet-organizaciya');
  expect(problems).toEqual([]);
  await ctx.close();
  await ectx.close();
});

test('2.416: перечень — пропуски в нумерации за год у эксперта и руководителя: дело отменено, ещё не сдано, неизвестно', async ({ browser, baseURL }) => {
  const opts = { baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU',
    storageState: { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'delo.folds', value: 'open' }] }] } };
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(page, '+79990004164');
  const ids = await db(async (c) => {
    await c.query("update users set full_name = 'Пропускова Вера' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, report_pattern) values ($1, 'В-{N}')", [expert.id]);
    const mk = async (title, status, number = null) => (await c.query(`insert into orders (owner_user_id, title, module, service, status,
      executor_user_id, deadline, fields, report_number, report_number_on, report_number_by) values ($1, $2, 'expertise', 'realty', $3, $1,
      current_date, $4, $5::text, case when $5::text is null then null else current_date end, case when $5::text is null then null else $1::uuid end) returning id`,
    [expert.id, title, status, { purpose: 'deal', address: `г. Москва, ${title}` }, number])).rows[0].id;
    const out = {};
    for (const n of [1, 5]) {
      out[n] = await mk(`Пропуски, № ${n}`, 'done', `В-${n}`);
      await c.query("insert into order_status_history (order_id, from_status, to_status, side) values ($1, 'review', 'done', 'dispatcher')", [out[n]]);
    }
    out.cancelled = await mk('Квартира на Садовой', 'cancelled', 'В-2');
    out.open = await mk('Дом в Химках', 'in_work', 'В-3');
    return out;
  });
  for (const n of [1, 5]) {
    const up = await page.request.post(`/api/orders/${ids[n]}/documents`, { data: Buffer.from(`ОТЧЁТ ОБ ОЦЕНКЕ № В-${n} от 12.10.2026`),
      headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') } });
    expect(up.status()).toBe(201);
  }
  await db((c) => c.query("update documents set kind = 'result' where order_id = any($1)", [[ids[1], ids[5]]]));

  await page.goto('/kabinet#specialist');
  const holes = page.locator('#registry-holes');
  const year = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 4);
  await expect(holes.locator('[data-holes-total]')).toHaveText(`Пропуски в нумерации за ${year} год: 3 (с № В-1 по № В-5)`);
  const items = holes.locator('[data-hole]');
  await expect(items).toHaveText([
    '№ В-2 нет — дело «Квартира на Садовой» отменено после выдачи номера',
    '№ В-3 выдан делу «Дом в Химках» — оно ещё не сдано',
    '№ В-4 нет — дело отменено или номер пропущен?',
  ]);
  await page.locator('#registry-box').scrollIntoViewIfNeeded();
  await shot(page, 'r18-2416-propuski-nomerov');
  // За квартал — не считаем; весь год — снова видно; пропуск ведёт к делу.
  await page.locator('#registry-quarter').selectOption('4');
  await expect(holes).toBeHidden();
  await page.locator('#registry-quarter').selectOption('');
  await expect(items).toHaveCount(3);
  await items.nth(0).getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`#order=${ids.cancelled}`));

  // Руководитель: общий счёт организации — пропуск с именем эксперта; у эксперта — «пропуски видит руководитель».
  const hctx = await browser.newContext(opts);
  const hpage = await hctx.newPage();
  hpage.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const head = await signIn(hpage, '+79990004165');
  const org = await db(async (c) => {
    const id = (await c.query("insert into organizations (name, report_pattern) values ('ООО «Без пропусков»', 'В-{N}') returning id")).rows[0].id;
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head')", [id, head.id]);
    await c.query("insert into org_members (org_id, user_id, role, created_at) values ($1, $2, 'member', now() - interval '1 hour')", [id, expert.id]);
    await c.query('update specialists set org_id = $1 where user_id = $2', [id, expert.id]);
    await c.query('update orders set report_number_org = $1 where report_number_by = $2', [id, expert.id]);
    return id;
  });
  await hpage.goto(`/kabinet#org=${org}`);
  const oh = hpage.locator('#org-registry-holes');
  await expect(oh.locator('[data-holes-total]')).toContainText('3 (с № В-1 по № В-5)');
  await expect(oh.locator('[data-hole]').nth(0)).toContainText('№ В-2 нет — дело «Квартира на Садовой» отменено после выдачи номера');
  await expect(oh.locator('[data-hole]').nth(0)).toContainText('эксперт Пропускова Вера');
  await hpage.locator('#org-registry-box').scrollIntoViewIfNeeded();
  await shot(hpage, 'r19-2416-propuski-organizacii');
  await page.goto('/kabinet#specialist');
  await expect(holes.locator('[data-holes-org]')).toHaveText('Номера выдаёт организация «ООО «Без пропусков»» — пропуски в общем счёте видит руководитель');
  expect(problems).toEqual([]);
  await ctx.close();
  await hctx.close();
});

test('2.417: «Дела экспертов» — поиск по номеру отчёта: в списке и среди сданных давно, с архивом за месяц', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU',
    storageState: { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'delo.folds', value: 'open' }] }] } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const head = await signIn(page, '+79990024171');
  const year = new Date(Date.now() + 3 * 3_600_000).getUTCFullYear();
  const ids = await db(async (c) => {
    const ex = (await c.query("insert into users (phone, full_name) values ('+79990024172', 'Номерова Нина') on conflict (phone) do update set full_name = excluded.full_name returning id")).rows[0].id;
    const org = (await c.query("insert into organizations (name) values ('ООО «Оценка-Номер»') returning id")).rows[0].id;
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head')", [org, head.id]);
    await c.query("insert into org_members (org_id, user_id, role, created_at) values ($1, $2, 'member', now() - interval '2 years')", [org, ex]);
    await c.query("insert into specialists (user_id, org_id, created_at) values ($1, $2, now() - interval '2 years')", [ex, org]);
    const mk = async (title, status, number, ago) => (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id,
        deadline, fields, updated_at, report_number, report_number_on, report_number_by)
      values ($1, $2, 'expertise', 'realty', $3, $4, current_date + 7, $5, now() - $6::interval, $7, case when $7::text is null then null else current_date end,
        case when $7::text is null then null else $4::uuid end) returning id`,
    [head.id, title, status, ex, { purpose: 'deal', address: 'г. Москва, ул. Тестовая, д. 1' }, ago, number])).rows[0].id;
    const work = await mk('Квартира на Лесной', 'in_work', `Ф-21/${year}`, '1 minute');
    await mk('Дача в Рузе', 'in_work', null, '1 minute');
    const old = await mk('Дом в Истре', 'done', null, '95 days');
    await c.query("insert into order_status_history (order_id, from_status, to_status, side, at) values ($1, 'review', 'done', 'dispatcher', now() - interval '95 days')", [old]);
    return { org, ex, work, old };
  });
  const up = await page.request.post(`/api/orders/${ids.old}/documents`, { data: Buffer.from(`ОТЧЁТ ОБ ОЦЕНКЕ № В-20/${year} от 10.07.${year}`),
    headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') } });
  expect(up.status()).toBe(201);
  await db((c) => c.query("update documents set kind = 'result', uploaded_by = $2 where order_id = $1", [ids.old, ids.ex]));

  await page.goto(`/kabinet#org=${ids.org}`);
  const search = page.locator('#org-cases-search');
  await expect(search).toHaveAttribute('placeholder', 'Поиск: номер дела или отчёта, услуга, эксперт');
  await search.fill('ф-21');
  const list = page.locator('#org-cases > li');
  await expect(list).toHaveCount(1);
  await expect(list.nth(0).locator('[data-role="report-number"]')).toHaveText(`Отчёт № Ф-21/${year}`);
  await expect(page.locator('#org-cases-number')).toBeHidden();
  await search.scrollIntoViewIfNeeded();
  await shot(page, 'r20-2417-poisk-po-nomeru');

  // Латинская B вместо русской В — тот же номер; дела в списке нет (сдано 95 дней назад) — находится среди сданных.
  await search.fill(`B-20/${year}`);
  const found = page.locator('#org-cases-number li');
  await expect(found).toHaveCount(1);
  await expect(found.nth(0)).toContainText(`Отчёт № В-20/${year}`);
  await expect(found.nth(0)).toContainText('эксперт: Номерова Нина');
  await expect(found.nth(0).locator('[data-role="old-case"]')).toContainText('Сдано больше 90 дней назад');
  await expect(found.nth(0).locator('[data-action="number-archive"]')).toContainText('Заключения архивом за');
  await expect(found.nth(0)).not.toContainText('Истре');
  await page.locator('#org-cases-number').scrollIntoViewIfNeeded();
  await shot(page, 'r21-2417-nomer-sredi-sdannyh');

  await search.fill('Ромашка 777');
  await expect(page.locator('#org-cases-none')).toContainText('по номеру дела или отчёта');
  await expect(page.locator('[data-role="number-head"]')).toContainText('не нашёлся и среди сданных');
  await search.fill('');
  await expect(page.locator('#org-cases-number')).toBeHidden();
  expect(problems).toEqual([]);
  await ctx.close();
});

test('2.418: дело отменено после выдачи номера — в «Сегодня» отдать номер следующему делу или оставить пропуском; в перечне — что выбрано', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU',
    storageState: { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'delo.folds', value: 'open' }] }] } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(page, '+79990004181');
  const ids = await db(async (c) => {
    await c.query("update users set full_name = 'Отменова Ирина' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, report_pattern) values ($1, 'К-{N}')", [expert.id]);
    const mk = async (title, status, number) => (await c.query(`insert into orders (owner_user_id, title, module, service, status,
      executor_user_id, deadline, fields, report_number, report_number_on, report_number_by) values ($1, $2, 'expertise', 'realty', $3, $1,
      current_date, $4, $5, current_date, $1) returning id`, [expert.id, title, status, { purpose: 'deal', address: `г. Москва, ${title}` }, number])).rows[0].id;
    const out = {};
    for (const n of [1, 5]) {
      out[n] = await mk(`Отмены, № ${n}`, 'done', `К-${n}`);
      await c.query("insert into order_status_history (order_id, from_status, to_status, side) values ($1, 'review', 'done', 'dispatcher')", [out[n]]);
    }
    out.keep = await mk('Квартира на Садовой', 'cancelled', 'К-2');
    out.free = await mk('Дача в Истре', 'cancelled', 'К-3');
    for (const id of [out.keep, out.free]) {
      await c.query("insert into order_status_history (order_id, from_status, to_status, side) values ($1, 'in_work', 'cancelled', 'customer')", [id]);
    }
    return out;
  });
  for (const n of [1, 5]) {
    const up = await page.request.post(`/api/orders/${ids[n]}/documents`, { data: Buffer.from(`ОТЧЁТ ОБ ОЦЕНКЕ № К-${n} от 12.10.2026`),
      headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') } });
    expect(up.status()).toBe(201);
  }
  await db((c) => c.query("update documents set kind = 'result' where order_id = any($1)", [[ids[1], ids[5]]]));

  await page.goto('/kabinet');
  const box = page.locator('#today-box');
  await expect(box.locator('li[data-today="number-cancelled"]')).toHaveText('Дело отменено, а номер отчёта уже выдан · 2');
  const items = box.locator('li[data-today-item="number-cancelled"]');
  await expect(items).toHaveCount(2);
  const keep = items.filter({ hasText: 'Квартира на Садовой' });
  await expect(keep.locator('[data-role="number-cancelled-what"]')).toContainText('№ К-2 выдан');
  await expect(keep.locator('[data-role="number-cancelled-what"]')).toContainText('дело отменено');
  await keep.scrollIntoViewIfNeeded();
  await shot(page, 'r22-2418-nomer-otmenennogo');
  await keep.locator('[data-action="number-keep"]').click();
  await expect(keep.locator('[data-role="number-cancelled-msg"]')).toHaveText('№ К-2 останется пропуском — в перечне для СРО будет видно, что дело отменено');
  const free = items.filter({ hasText: 'Дача в Истре' });
  await free.locator('[data-action="number-free"]').click();
  await expect(free.locator('[data-role="number-cancelled-msg"]')).toHaveText('№ К-3 получит следующее дело при сборке Word');
  await expect(free.locator('[data-action="number-keep"]')).toHaveCount(0);
  // Следующий номер в профиле — освобождённый К-3; в перечне для СРО — что выбрано у каждого пропуска.
  await page.goto('/kabinet#specialist');
  await expect(page.locator('[data-numbering-next]')).toHaveAttribute('data-numbering-next', 'К-3');
  await expect(page.locator('#numbering-next')).toContainText('номер отменённого дела «Дача в Истре», Вы отдали его следующему делу');
  const holes = page.locator('#registry-holes');
  await expect(holes.locator('[data-hole]')).toHaveText([
    '№ К-2 нет — дело «Квартира на Садовой» отменено, номер оставлен пропуском',
    '№ К-3 нет — дело «Дача в Истре» отменено, номер освобождён: его получит следующее дело',
    '№ К-4 нет — дело отменено или номер пропущен?',
  ]);
  await page.locator('#registry-box').scrollIntoViewIfNeeded();
  await shot(page, 'r23-2418-propuski-vybor');
  // Выбор сделан — в «Сегодня» строки больше нет.
  await page.goto('/kabinet');
  await expect(page.locator('#today-box li[data-today="number-cancelled"]')).toHaveCount(0);
  expect(problems).toEqual([]);
  await ctx.close();
});

// 2.419: в первые рабочие дни января «Сегодня» подсказывает, что в образце номера нет года. Правило окна и подсказки проверяет
// `tests/server/draft.test.mjs`; здесь январский ответ подставлен, чтобы не зависеть от даты прогона, а «Взять образец»
// сохраняет по-настоящему.
test('2.419: новый год — в «Сегодня» образец номера без года, «Взять образец» у эксперта и руководителя', async ({ browser, baseURL }) => {
  const opts = { baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU',
    storageState: { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'delo.folds', value: 'open' }] }] } };
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(page, '+79990004191');
  const hctx = await browser.newContext(opts);
  const hpage = await hctx.newPage();
  hpage.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const head = await signIn(hpage, '+79990004192');
  const org = await db(async (c) => {
    await c.query("insert into specialists (user_id, report_pattern) values ($1, 'Н-{N}')", [expert.id]);
    const id = (await c.query("insert into organizations (name, report_pattern) values ('ООО «Оценка-Январь»', 'ОРГ-{N}/2026') returning id")).rows[0].id;
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head')", [id, head.id]);
    return id;
  });
  const hint = { kind: 'no_year', pattern: 'Н-{N}', year: 2027, first: 'Н-1', suggest: 'Н-{N}/{ГГГГ}', suggest_first: 'Н-1/2027', last: { number: 'Н-146', on: '2026-12-29' } };
  let mine = hint;
  await page.route('**/api/today', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.today = '2027-01-11';
    body.expert.number_year = mine;
    await route.fulfill({ response: res, json: body });
  });
  await page.goto('/kabinet');
  const box = page.locator('#today-box');
  await expect(box.locator('li[data-today="number-year"]')).toHaveText('Нумерация отчётов: 2027 год — счёт с 1 · 1');
  const row = box.locator('li[data-today-item="number-year"]');
  await expect(row.locator('[data-role="number-year-what"]')).toHaveText('в образце Н-{N} нет года — первым в 2027 году будет № Н-1, а в 2026 году последним был № Н-146 (29 декабря): номера повторят прошлогодние');
  await expect(row).toContainText('возьмите образец Н-{N}/{ГГГГ} — первым будет № Н-1/2027');
  await expect(row.locator('.title')).toHaveText('Образец номера отчёта');
  await row.scrollIntoViewIfNeeded();
  await shot(page, 'r24-2419-obrazec-bez-goda');
  await row.locator('[data-action="number-year"]').click();
  await expect(row.locator('[data-role="number-year-msg"]')).toHaveText('Образец Н-{N}/{ГГГГ} сохранён — первым в 2027 году будет № Н-1/2027');
  await expect(row.locator('[data-action="number-year"]')).toHaveCount(0);
  expect((await db((c) => c.query('select report_pattern from specialists where user_id = $1', [expert.id]))).rows[0].report_pattern).toBe('Н-{N}/{ГГГГ}');
  // Строка — к «Нумерации отчётов» в профиле.
  await row.locator('button.open').click();
  await expect(page).toHaveURL(/#specialist&to=numbering$/);
  await expect(page.locator('#numbering-box')).toBeInViewport();
  await expect(page.locator('#numbering-pattern')).toHaveValue('Н-{N}/{ГГГГ}');
  // Номера выдаёт организация — кнопки нет, сказать руководителю.
  mine = { ...hint, org: { id: org, name: 'ООО «Оценка-Январь»' } };
  await page.goto('/kabinet');
  await expect(row.locator('[data-action="number-year"]')).toHaveCount(0);
  await expect(row).toContainText('образец организации «ООО «Оценка-Январь»» — поменять может только руководитель, скажите ему');

  // Руководитель: в образце организации вписан прошлый год — «Взять образец» сохраняет образец организации с {ГГГГ}.
  await hpage.route('**/api/today', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.today = '2027-01-11';
    for (const g of body.orgs) g.number_year = { kind: 'fixed', pattern: 'ОРГ-{N}/2026', year: 2027, fixed: 2026, first: 'ОРГ-1/2026', suggest: 'ОРГ-{N}/{ГГГГ}', suggest_first: 'ОРГ-1/2027', last: null };
    await route.fulfill({ response: res, json: body });
  });
  await hpage.goto('/kabinet');
  const hrow = hpage.locator(`#today-box li[data-today-item="org-number-year-${org}"]`);
  await expect(hrow.locator('[data-role="number-year-what"]')).toHaveText('в образце ОРГ-{N}/2026 вписан 2026 год — номера 2027 года выйдут как № ОРГ-1/2026');
  await expect(hrow.locator('.title')).toHaveText('Образец номера организации');
  await hrow.scrollIntoViewIfNeeded();
  await shot(hpage, 'r25-2419-obrazec-organizacii');
  await hrow.locator('[data-action="number-year"]').click();
  await expect(hrow.locator('[data-role="number-year-msg"]')).toHaveText('Образец ОРГ-{N}/{ГГГГ} сохранён — первым в 2027 году будет № ОРГ-1/2027');
  expect((await db((c) => c.query('select report_pattern from organizations where id = $1', [org]))).rows[0].report_pattern).toBe('ОРГ-{N}/{ГГГГ}');
  await hrow.locator('button.open').click();
  await expect(hpage).toHaveURL(new RegExp(`#org=${org}&to=numbering$`));
  await expect(hpage.locator('#org-numbering-box')).toBeInViewport();
  await expect(hpage.locator('#org-numbering-pattern')).toHaveValue('ОРГ-{N}/{ГГГГ}');
  expect(problems).toEqual([]);
  await ctx.close();
  await hctx.close();
});

// Прогон 2.420: номер отчёта набран латинской «B» вместо русской «В» — тот же номер: ИИ-проверка не пишет «не тот»,
// вручную занять его другим делом нельзя.
test('прогон 2.420: номер с латинской «B» — тот же, что «В»: ИИ-проверка молчит, занять другим делом нельзя', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU',
    storageState: { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'delo.folds', value: 'open' }] }] } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`ошибка JS: ${e.message}`));
  const expert = await signIn(page, '+79990002420');
  const year = Number(new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 4));
  const ids = await db(async (c) => {
    await c.query("insert into specialists (user_id, report_pattern) values ($1, 'В-{N}/{ГГГГ}')", [expert.id]);
    await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [expert.id]);
    const mk = async (title, number) => {
      const o = (await c.query(`insert into orders (owner_user_id, title, module, service, status, executor_user_id, deadline, fields, report_number, report_number_on, report_number_by)
        values ($1, $2, 'expertise', 'realty', 'in_work', $1, current_date + 7, '{}', $3, current_date, $4) returning id`, [expert.id, title, number, number ? expert.id : null])).rows[0].id;
      await c.query("insert into result_drafts (order_id, author_id, source, body) values ($1, $2, 'edit', '1. Общие сведения\nТекст.')", [o, expert.id]);
      return o;
    };
    return { issued: await mk('Склад в Подольске', `В-15/${year}`), open: await mk('Офис в Реутове', null) };
  });
  const text = `ОТЧЁТ ОБ ОЦЕНКЕ № B-15/${year} от 20.10.${year}\nДата составления отчёта: 20.10.${year}\nОтчёт № B-15/${year}`;
  const up = await page.request.post(`/api/orders/${ids.issued}/documents`, { data: Buffer.from(text), headers: { ...H, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') } });
  expect(up.status()).toBe(201);
  await db((c) => c.query("update documents set kind = 'result' where order_id = $1", [ids.issued]));
  await page.goto(`/kabinet#order=${ids.issued}`);
  await page.getByRole('button', { name: 'Проверить с помощью ИИ' }).click();
  await expect(page.locator('#review-msg')).toHaveText('ИИ-проверка готова');
  await expect(page.locator('#review-checks')).not.toContainText('не тот, что выдан делу');
  await page.goto(`/kabinet#order=${ids.open}`);
  await page.locator('#draft-number-edit').click();
  await page.locator('#draft-number-input').fill(`B-15/${year}`);
  await page.locator('#draft-number-save').click();
  await expect(page.locator('#draft-msg')).toContainText('уже у дела «Склад в Подольске»');
  await page.locator('#draft-number').scrollIntoViewIfNeeded();
  await shot(page, 'r26-2420-nomer-latinica');
  expect(problems).toEqual([]);
  await ctx.close();
});
