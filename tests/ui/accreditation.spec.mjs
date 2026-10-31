// Аккредитация в банке (задача 2.451) — телефон 412×915: эксперт вносит аккредитацию в досье (банк из списка — без названия,
// свой — с названием), руководитель — аккредитацию организации с копией, сотрудник видит список без правки. Что разрешено и
// кому — считает сервер (tests/server/accreditation.test.mjs). Номера +7 999 000-45-2x — только здесь.
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
async function phone(browser, baseURL) {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'ru-RU',
    storageState: { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'delo.folds', value: 'open' }] }] } });
  const page = await ctx.newPage();
  page.problems = [];
  page.on('pageerror', (e) => page.problems.push(`ошибка JS: ${e.message}`));
  return page;
}
const plusDays = (n) => new Date(Date.now() + 3 * 3600 * 1000 + n * 86400000).toISOString().slice(0, 10);

test('2.451: эксперт вносит аккредитацию в банке в досье — банк из списка или свой', async ({ browser, baseURL }) => {
  const sp = await phone(browser, baseURL);
  const expert = await signIn(sp, '+79990004521');
  await db((c) => c.query('insert into specialists (user_id) values ($1)', [expert.id]));
  await sp.goto('/kabinet#specialist');
  await expect(sp.locator('#dossier-box')).toBeVisible();
  await sp.getByLabel('Документ', { exact: true }).selectOption({ label: 'Аккредитация в банке' });
  // Банк из списка — название не нужно; полей полиса нет; дата — решения банка.
  await expect(sp.getByLabel('Банк', { exact: true })).toBeVisible();
  await expect(sp.locator('#dossier-title-box')).toBeHidden();
  await expect(sp.getByLabel('Страховая сумма, руб.', { exact: true })).toBeHidden();
  await sp.getByLabel('Банк', { exact: true }).selectOption({ label: 'Сбербанк' });
  await sp.getByLabel('Номер решения банка', { exact: true }).fill('АК-4521');
  await sp.getByLabel('Дата решения банка', { exact: true }).fill(plusDays(-200));
  await sp.getByLabel('Действует до', { exact: true }).fill(plusDays(20));
  await sp.locator('#dossier-save').click();
  await expect(sp.locator('#dossier-msg')).toHaveText('Документ добавлен — загрузите копию');
  const sber = sp.locator('#dossier-items li').filter({ hasText: 'Аккредитация в банке: Сбербанк' });
  await expect(sber).toContainText('№ АК-4521');
  await expect(sber).toContainText('решение от');
  await expect(sber).toContainText('срок кончается');
  // Свой банк — без названия не сохранится.
  await sp.getByLabel('Документ', { exact: true }).selectOption({ label: 'Аккредитация в банке' });
  await sp.getByLabel('Банк', { exact: true }).selectOption({ label: 'Другой банк' });
  await expect(sp.getByLabel('Название банка', { exact: true })).toBeVisible();
  await sp.locator('#dossier-save').click();
  await expect(sp.locator('#dossier-msg')).toContainText('Название банка');
  await sp.getByLabel('Название банка', { exact: true }).fill('Тестовый банк «Пример»');
  await sp.getByLabel('Действует до', { exact: true }).fill(plusDays(300));
  await sp.locator('#dossier-save').click();
  await expect(sp.locator('#dossier-items li').filter({ hasText: 'Аккредитация в банке: Тестовый банк «Пример»' })).toBeVisible();
  await sber.getByLabel('Копия: Аккредитация в банке').setInputFiles({ name: 'Решение Сбербанка.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF решение') });
  await expect(sp.locator('#dossier-msg')).toHaveText('Копия сохранена');
  await expect(sber).toContainText('Копия: Решение Сбербанка.pdf');
  // Изменить: свой банк открывается с названием.
  await sp.locator('#dossier-items li').filter({ hasText: 'Тестовый банк' }).getByRole('button', { name: 'Изменить' }).click();
  await expect(sp.getByLabel('Название банка', { exact: true })).toHaveValue('Тестовый банк «Пример»');
  await sp.locator('#dossier-cancel').click();
  await sp.locator('#dossier-box').scrollIntoViewIfNeeded();
  await shot(sp, 'ak01-2451-dosie-akkreditaciya');
  expect(sp.problems).toEqual([]);
});

test('2.451: руководитель вносит аккредитацию организации с копией, сотрудник видит без правки', async ({ browser, baseURL }) => {
  const hp = await phone(browser, baseURL);
  const mp = await phone(browser, baseURL);
  const head = await signIn(hp, '+79990004522');
  const member = await signIn(mp, '+79990004523');
  const orgId = await db(async (c) => {
    const org = (await c.query("insert into organizations (name) values ('Тестовая оценочная организация 4522') returning id")).rows[0];
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head'), ($1, $3, 'member')", [org.id, head.id, member.id]);
    return org.id;
  });
  await hp.goto(`/kabinet#org=${orgId}`);
  const box = hp.locator('#org-accr-box');
  await expect(box).toBeVisible();
  await expect(hp.locator('#org-accr-empty')).toBeVisible();
  await expect(hp.locator('#org-accr-title-box')).toBeHidden();
  await hp.getByLabel('Какой банк').selectOption({ label: 'Другой банк' });
  await expect(hp.getByLabel('Название своего банка')).toBeVisible();
  await hp.locator('#org-accr-save').click();
  await expect(hp.locator('#org-accr-msg')).toContainText('Название банка');
  await hp.getByLabel('Название своего банка').fill('Тестовый банк «Залог»');
  await hp.getByLabel('Аккредитация действует до').fill(plusDays(-3));
  await hp.locator('#org-accr-save').click();
  await expect(hp.locator('#org-accr-msg')).toHaveText('Аккредитация добавлена — загрузите копию решения банка');
  await hp.getByLabel('Какой банк').selectOption({ label: 'Сбербанк' });
  await hp.getByLabel('Номер решения').fill('Р-2026/45');
  await hp.getByLabel('Дата решения').fill(plusDays(-60));
  await hp.getByLabel('Аккредитация действует до').fill(plusDays(300));
  await hp.locator('#org-accr-save').click();
  const sber = hp.locator('#org-accr-items li').filter({ hasText: 'Сбербанк' });
  await expect(sber).toContainText('№ Р-2026/45');
  await expect(hp.locator('#org-accr-items li').filter({ hasText: 'Тестовый банк «Залог»' })).toContainText('срок истёк');
  await sber.getByLabel('Копия: Сбербанк').setInputFiles({ name: 'Решение банка.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF решение') });
  await expect(hp.locator('#org-accr-msg')).toHaveText('Копия сохранена');
  await box.scrollIntoViewIfNeeded();
  await shot(hp, 'ak02-2451-organizaciya-akkreditacii');

  await mp.goto(`/kabinet#org=${orgId}`);
  await expect(mp.locator('#org-accr-box')).toBeVisible();
  await expect(mp.locator('#org-accr-items li')).toHaveCount(2);
  await expect(mp.locator('#org-accr-form')).toBeHidden();
  const msb = mp.locator('#org-accr-items li').filter({ hasText: 'Сбербанк' });
  await expect(msb.getByRole('button', { name: 'Скачать' })).toBeVisible();
  await expect(msb.getByRole('button', { name: 'Изменить' })).toHaveCount(0);
  await mp.locator('#org-accr-box').scrollIntoViewIfNeeded();
  await shot(mp, 'ak03-2451-sotrudnik-vidit');
  expect([...hp.problems, ...mp.problems]).toEqual([]);
});

test('2.452: подбор для заявки Сбербанка — аккредитованные первыми с пометкой, никого — предупреждение', async ({ browser, baseURL }) => {
  const cp = await phone(browser, baseURL);
  const dp = await phone(browser, baseURL);
  const owner = await signIn(cp, '+79990004541');
  const disp = await signIn(dp, '+79990004542');
  const mk = async (phoneNo, name) => {
    const u = await signIn(await phone(browser, baseURL), phoneNo);
    await db(async (c) => {
      await c.query('update users set full_name = $2 where id = $1', [u.id, name]);
      await c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5)", [u.id]);
      await c.query("insert into specialist_permits (user_id, module, service) values ($1, 'expertise', 'realty')", [u.id]);
    });
    return u;
  };
  await mk('+79990004543', 'Тестов Свободный 2452');
  const acc = await mk('+79990004544', 'Тестов Аккредитованный 2452');
  await db(async (c) => {
    await c.query("update users set platform_role = 'dispatcher' where id = $1", [disp.id]);
    await c.query('update specialists set external_load = 3 where user_id = $1', [acc.id]);
    await c.query("insert into dossier_items (user_id, kind, title, bank, valid_until) values ($1, 'bank', 'Сбербанк', 'sber', current_date + 200)", [acc.id]);
  });
  const order = async () => {
    const id = (await (await cp.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Квартира для банка' }, headers: H })).json()).order.id;
    expect((await cp.request.patch(`/api/orders/${id}`, {
      data: { deadline: plusDays(20), fields: { purpose: 'bank', bank: 'sber', region: 'mo', object_type: 'flat', address: 'тестовый адрес, 1' } }, headers: H,
    })).status()).toBe(200);
    expect((await cp.request.post(`/api/orders/${id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
    return id;
  };
  const id = await order();
  await dp.goto(`/kabinet#order=${id}`);
  await expect(dp.locator('#match-bank')).toHaveText(/Отчёт для банка «Сбербанк»: первыми — аккредитованные/);
  await expect(dp.locator('#match-bank')).not.toHaveClass(/overdue/);
  // Свободный выше по оценке, но первым — аккредитованный.
  const first = dp.locator('#candidates > li').filter({ hasText: '2452' }).first();
  await expect(first).toContainText('Тестов Аккредитованный 2452');
  await expect(first.locator('[data-role=bank-accr]')).toHaveText(/^Аккредитован в банке «Сбербанк» · до /);
  await expect(dp.locator('#candidates > li').filter({ hasText: 'Тестов Свободный 2452' }).locator('[data-role=bank-accr]')).toHaveCount(0);
  await first.scrollIntoViewIfNeeded();
  await shot(dp, 'ak04-podbor-bank');
  // Аккредитация истекла — предупреждение диспетчеру.
  await db((c) => c.query("update dossier_items set valid_until = current_date - 1 where user_id = $1 and kind = 'bank'", [acc.id]));
  const id2 = await order();
  await dp.goto(`/kabinet#order=${id2}`);
  await expect(dp.locator('#match-bank')).toHaveText(/никто из подходящих не аккредитован в нём/);
  await expect(dp.locator('#match-bank')).toHaveClass(/overdue/);
  await expect(dp.locator('#candidates [data-role=bank-accr]')).toHaveCount(0);
  await dp.locator('#match-bank').scrollIntoViewIfNeeded();
  await shot(dp, 'ak05-podbor-bank-nikogo');
  expect([...dp.problems, ...cp.problems]).toEqual([]);
});

test('2.453: дело для банка без аккредитации — предупреждение эксперту при принятии и строкой в «Сегодня»', async ({ browser, baseURL }) => {
  const cp = await phone(browser, baseURL);
  const sp = await phone(browser, baseURL);
  await signIn(cp, '+79990004551');
  const expert = await signIn(sp, '+79990004553');
  await db((c) => c.query("insert into specialists (user_id, regions, capacity) values ($1, '{moscow,mo}', 5)", [expert.id]));
  const id = (await (await cp.request.post('/api/orders', { data: { module: 'expertise', service: 'realty', title: 'Квартира для Сбербанка 2453' }, headers: H })).json()).order.id;
  expect((await cp.request.patch(`/api/orders/${id}`, {
    data: { deadline: plusDays(15), fields: { purpose: 'bank', bank: 'sber', region: 'mo', object_type: 'flat', address: 'тестовый адрес, 1' } }, headers: H,
  })).status()).toBe(200);
  expect((await cp.request.post(`/api/orders/${id}/status`, { data: { from: 'new', to: 'matching' }, headers: H })).status()).toBe(200);
  await db((c) => c.query("update orders set status = 'awaiting_executor', executor_user_id = $2, price_kop = 1500000, paid_at = now() where id = $1", [id, expert.id]));

  // «Сегодня»: у предложения — предупреждение.
  await sp.goto('/kabinet');
  const offer = sp.locator('#today-box li[data-today-item="offers"]').filter({ hasText: 'Квартира для Сбербанка 2453' });
  await expect(offer.locator('[data-role=bank-gap]')).toHaveText(/^Отчёт для банка «Сбербанк»: у Вас и Вашей организации нет аккредитации в нём/);
  await offer.scrollIntoViewIfNeeded();
  await shot(sp, 'ak06-segodnya-predlozhenie-bez-akkr');
  // В деле — рядом с «Принять дело».
  await sp.goto(`/kabinet#order=${id}`);
  await expect(sp.locator('#next-warn')).toHaveText(/нет аккредитации в нём — банк может не принять отчёт\. Уточните у заказчика или откажитесь от дела\./);
  await expect(sp.locator('#next-main [data-next=main]')).toHaveText('Принять дело');
  await shot(sp, 'ak07-delo-predlozhenie-bez-akkr');
  // В списке дел — пометка и вопрос при «Принять дело» с тем же предупреждением.
  await sp.goto('/kabinet');
  const li = sp.locator('#orders > li').filter({ hasText: 'Квартира для Сбербанка 2453' });
  await expect(li.locator('[data-role=bank-gap]')).toBeVisible();
  let asked = '';
  sp.once('dialog', (d) => { asked = d.message(); d.accept(); });
  await li.locator('[data-action=accept]').click();
  await expect(sp).toHaveURL(new RegExp(`#order=${id}$`));
  expect(asked).toContain('нет аккредитации');
  await expect(sp.locator('#next-warn')).toHaveText(/Уточните у заказчика или попросите руководителя передать дело\./);
  // «Сегодня»: дело в работе — своей строкой.
  await sp.goto('/kabinet');
  await expect(sp.locator('#today-box li[data-today="bank-gap"]')).toHaveText('Дело для банка, а аккредитации в нём нет · 1');
  const row = sp.locator('#today-box li[data-today-item="bank-gap"]');
  await expect(row).toContainText('Квартира для Сбербанка 2453');
  await expect(row.locator('[data-role=bank-gap]')).toContainText('попросите руководителя передать дело аккредитованному коллеге');
  await row.scrollIntoViewIfNeeded();
  await shot(sp, 'ak08-segodnya-delo-bez-akkr');
  // Внёс аккредитацию в досье — строки нет.
  await db((c) => c.query("insert into dossier_items (user_id, kind, title, bank, valid_until) values ($1, 'bank', 'Сбербанк', 'sber', current_date + 100)", [expert.id]));
  await sp.reload();
  await expect(sp.locator('#today-box')).toBeVisible();
  await expect(sp.locator('#today-box li[data-today="bank-gap"]')).toHaveCount(0);
  expect([...sp.problems, ...cp.problems]).toEqual([]);
});

test('2.454: срок аккредитации кончается — строкой в «Сегодня» эксперта и руководителя', async ({ browser, baseURL }) => {
  const hp = await phone(browser, baseURL);
  const sp = await phone(browser, baseURL);
  const head = await signIn(hp, '+79990004571');
  const expert = await signIn(sp, '+79990004572');
  const orgId = await db(async (c) => {
    const org = (await c.query("insert into organizations (name) values ('Тестовая оценочная организация 4571') returning id")).rows[0];
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head'), ($1, $3, 'member')", [org.id, head.id, expert.id]);
    await c.query("update users set full_name = 'Тестова Анна' where id = $1", [expert.id]);
    await c.query("insert into specialists (user_id, regions, capacity, org_id) values ($1, '{moscow,mo}', 5, $2)", [expert.id, org.id]);
    await c.query("insert into dossier_items (user_id, kind, title, bank, valid_until) values ($1, 'bank', 'Сбербанк', 'sber', $2)", [expert.id, plusDays(12)]);
    await c.query("insert into org_accreditations (org_id, bank, title, valid_until, created_by) values ($1, 'other', 'Тестовый банк «Залог»', $2, $3)", [org.id, plusDays(-2), head.id]);
    return org.id;
  });

  // Эксперт: своя — «продлите и внесите в досье», организации — истекла, продлевает руководитель.
  await sp.goto('/kabinet');
  await expect(sp.locator('#today-box li[data-today="bank-terms"]')).toHaveText('Аккредитация в банке: срок · 2');
  const rows = sp.locator('#today-box li[data-today-item="bank-terms"]');
  await expect(rows.nth(0)).toContainText('Тестовый банк «Залог» · аккредитация организации «Тестовая оценочная организация 4571»');
  await expect(rows.nth(0).locator('[data-role=bank-term-what]')).toHaveText(/^истекла .* — банк может не принять отчёт$/);
  await expect(rows.nth(1)).toContainText('Сбербанк · Ваша аккредитация');
  await expect(rows.nth(1).locator('[data-role=bank-term-what]')).toContainText('осталось 12 дн.');
  await rows.nth(0).scrollIntoViewIfNeeded();
  await shot(sp, 'ak09-2454-segodnya-ekspert-srok-akkr');
  await rows.nth(1).locator('button.open').click();
  await expect(sp).toHaveURL(/#specialist&to=dossier$/);

  // Руководитель: аккредитация организации и эксперта; нажатие — к «Аккредитациям в банках».
  await hp.goto('/kabinet');
  const g = hp.locator(`#today-box li[data-today="org-bank-terms-${orgId}"]`);
  await expect(g).toHaveText('Аккредитации в банках: срок · 2');
  const hr = hp.locator(`#today-box li[data-today-item="org-bank-terms-${orgId}"]`);
  await expect(hr.nth(0)).toContainText('Тестовый банк «Залог» · аккредитация организации');
  await expect(hr.nth(0)).toContainText('внесите новый срок в «Аккредитации в банках»');
  await expect(hr.nth(1)).toContainText('Тестова Анна · Сбербанк');
  await g.scrollIntoViewIfNeeded();
  await shot(hp, 'ak10-2454-segodnya-rukovoditel-srok-akkr');
  await hr.nth(0).locator('button.open').click();
  await expect(hp).toHaveURL(new RegExp(`#org=${orgId}&to=accr$`));
  await expect(hp.locator('#org-accr-box')).toBeInViewport();
  expect([...hp.problems, ...sp.problems]).toEqual([]);
});

test('2.455: руководитель — организация и эксперты по банкам, отбор «кончается»', async ({ browser, baseURL }) => {
  const hp = await phone(browser, baseURL);
  const head = await signIn(hp, '+79990004581');
  const orgId = await db(async (c) => {
    const org = (await c.query("insert into organizations (name) values ('Тестовая оценочная организация 4581') returning id")).rows[0];
    await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'head')", [org.id, head.id]);
    for (const [phone, name, rows] of [
      ['+79990004582', 'Тестова Анна', [['sber', 'Сбербанк', plusDays(12)]]],
      ['+79990004583', 'Тестов Борис', [['other', 'Тестовый банк «Залог»', null], ['sber', 'Сбербанк', plusDays(300)]]],
      ['+79990004584', 'Тестов Виктор', []],
    ]) {
      const u = (await c.query("insert into users (phone, full_name) values ($1, $2) returning id", [phone, name])).rows[0];
      await c.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'member')", [org.id, u.id]);
      await c.query("insert into specialists (user_id, regions, capacity, org_id) values ($1, '{moscow,mo}', 5, $2)", [u.id, org.id]);
      for (const [bank, title, until] of rows) {
        await c.query("insert into dossier_items (user_id, kind, title, bank, valid_until) values ($1, 'bank', $2, $3, $4)", [u.id, title, bank, until]);
      }
    }
    await c.query("insert into org_accreditations (org_id, bank, title, valid_until, created_by) values ($1, 'sber', 'Сбербанк', $2, $3), ($1, 'other', 'Тестовый банк «Залог»', $4, $3)",
      [org.id, plusDays(200), head.id, plusDays(-2)]);
    return org.id;
  });
  await hp.goto(`/kabinet#org=${orgId}`);
  const box = hp.locator('#org-accr-table-box');
  await expect(box).toBeVisible();
  const sber = box.locator('li[data-bank="Сбербанк"]');
  await expect(sber.locator('[data-cell="Организация"]')).toContainText('Организация: до');
  await expect(sber.locator('[data-cell="Тестова Анна"]')).toContainText('срок кончается');
  await expect(sber.locator('[data-cell="Тестов Борис"]')).not.toContainText('срок');
  await expect(sber).toContainText('Нет у экспертов: Тестов Виктор');
  const zalog = box.locator('li[data-bank="Тестовый банк «Залог»"]');
  await expect(zalog.locator('[data-cell="Организация"]')).toContainText('срок истёк');
  await expect(zalog.locator('[data-cell="Тестов Борис"]')).toHaveText('Тестов Борис: без срока');
  await expect(zalog).toContainText(/Нет у экспертов: (Тестов Виктор, Тестова Анна|Тестова Анна, Тестов Виктор)/);
  await box.scrollIntoViewIfNeeded();
  await shot(hp, 'ak11-2455-tablica-akkreditaciy');
  // Отбор «кончается»: только Анна в Сбербанке и истёкшая аккредитация организации в своём банке.
  await hp.getByLabel('Только кончается в 30 дней или истёк').check();
  await expect(box.locator('[data-cell]')).toHaveCount(2);
  await expect(sber.locator('[data-cell="Тестова Анна"]')).toBeVisible();
  await expect(zalog.locator('[data-cell="Организация"]')).toBeVisible();
  await expect(box).not.toContainText('Нет у экспертов');
  await shot(hp, 'ak12-2455-tablica-konchaetsya');
  // Из «Сегодня» — сразу к таблице с отбором.
  await hp.goto('/kabinet');
  await hp.locator(`#today-box li[data-today-item="org-bank-terms-${orgId}"]`).last().locator('button.open').click();
  await expect(hp).toHaveURL(new RegExp(`#org=${orgId}&to=accr$`));
  await expect(hp.getByLabel('Только кончается в 30 дней или истёк')).toBeChecked();
  await expect(box.locator('[data-cell]')).toHaveCount(2);
  expect(hp.problems).toEqual([]);
});

test('2.456: «Документы для продления» у аккредитации — архив с досье и перечнем отчётов', async ({ browser, baseURL }) => {
  const sp = await phone(browser, baseURL);
  const expert = await signIn(sp, '+79990004529');
  await db(async (c) => {
    await c.query('insert into specialists (user_id) values ($1)', [expert.id]);
    await c.query(`insert into dossier_items (user_id, kind, title, number, valid_until, bank) values
      ($1, 'certificate', 'Оценка недвижимости', '031234-1', $2, null), ($1, 'sro', 'Тестовая СРО оценщиков', '4529', null, null),
      ($1, 'bank', 'Сбербанк', 'АК-4529', $3, 'sber')`, [expert.id, plusDays(-2), plusDays(25)]);
  });
  await sp.goto('/kabinet#specialist');
  const sber = sp.locator('#dossier-items li').filter({ hasText: 'Аккредитация в банке: Сбербанк' });
  await expect(sber).toContainText('диплом, аттестат, СРО, полисы с копиями и перечень отчётов за 12 месяцев');
  // У других документов кнопки нет.
  await expect(sp.locator('#dossier-items li').filter({ hasText: 'Членство в СРО' }).getByRole('button', { name: 'Документы для продления' })).toHaveCount(0);
  await sber.scrollIntoViewIfNeeded();
  await shot(sp, 'ak13-2456-dokumenty-dlya-prodleniya');
  const [download] = await Promise.all([sp.waitForEvent('download'), sber.getByRole('button', { name: 'Документы для продления' }).click()]);
  expect(download.suggestedFilename()).toBe('Продление аккредитации · Сбербанк.zip');
  expect(sp.problems).toEqual([]);
});
