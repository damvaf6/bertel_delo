// Проверка юриста перед соглашением (задача штаба 40217197-…-81f7, решение Дамира 24.10.2026) на телефоне 412×915: заказчик
// с главной («Проверить юриста») вводит ФИО → однофамильцы списком → карточка (реестр, дела — о чём и чем закончилось, без
// участников) → «Подтвердить» у карточки, «Оспорить» у дела с пояснением; администратор видит его отметки. Юристы
// вымышленные; на автотестах источник открыт (на stage и prod вымышленные — только администратору, сервер — lawyer-check.test.mjs).
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { DB_URL, TEST_TOKEN } from '../helpers.mjs';

const CONTROL = process.env.UI_TEST_CONTROL_TOKEN || TEST_TOKEN;
const H = { 'x-delo-request': '1' };

async function signIn(page, phone) {
  expect((await page.request.post('/api/auth/code', { data: { phone }, headers: H })).status()).toBe(200);
  const r = await page.request.get('/__test/fakes/sms/calls', { headers: { 'x-test-control': CONTROL } });
  const code = (await r.json()).calls.filter((c) => c.method === 'sendCode' && c.args.phone === phone).at(-1).args.code;
  const v = await page.request.post('/api/auth/verify', { data: { phone, code }, headers: H });
  expect(v.status()).toBe(200);
  return (await v.json()).user;
}

async function shot(page, name) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), `${name}: страница шире экрана`).toBeLessThanOrEqual(412);
  await page.screenshot({ path: `test-results/screens/${name}.png`, fullPage: true });
}

test('проверка юриста: заказчик — ФИО → карточка с исходами → подтвердить и оспорить; администратор видит отметки', async ({ page, browser }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const cust = await signIn(page, '+79990000976');
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  try {
    await page.goto('/kabinet');
    await page.locator('#to-lawyers').click();
    const box = page.locator('#lawyer-box');
    await expect(box).toBeVisible();
    await expect(box).toContainText('чем закончилось');
    await expect(page.locator('#lawyer-admin-only')).toBeHidden();
    await page.getByLabel('Фамилия, имя и отчество юриста').fill('Нет Такого');
    await page.getByRole('button', { name: 'Проверить', exact: true }).click();
    await expect(page.locator('#lawyer-msg')).toContainText('без статуса адвоката в реестр не входит');

    await page.getByLabel('Фамилия, имя и отчество юриста').fill('пробный адвокат');
    await page.getByRole('button', { name: 'Проверить', exact: true }).click();
    await expect(page.locator('#lawyer-msg')).toContainText('Нашлось 2');
    await expect(page.locator('#lawyer-found li')).toHaveCount(2);
    await shot(page, 'yurist-01-odnofamilcy');

    await page.locator('[data-lawyer="77/99001"] button').click();
    const card = page.locator('#lawyer-card');
    await expect(card).toContainText('Статус адвоката действует');
    await expect(card).toContainText('Адвокатская палата г. Москвы');
    await expect(page.locator('#lawyer-cases li')).toHaveCount(2);
    await expect(page.locator('[data-case="fake-1"]')).toContainText('О взыскании долга по договору займа');
    await expect(page.locator('[data-case="fake-2"]')).toContainText('(участник скрыт)');
    await expect(page.locator('[data-case="fake-1"] [data-outcome]')).toHaveText('Иск удовлетворён частично · юрист — представитель истца');
    await expect(page.locator('[data-case="fake-2"] [data-outcome]')).toHaveText('В иске отказано · юрист — представитель ответчика');
    await expect(page.locator('#lawyer-outcome-note')).toContainText('Исход одного дела мало говорит о юристе');
    await expect(card).not.toContainText('Ромашка');
    await expect(card).not.toContainText('процент');
    await shot(page, 'yurist-02-kartochka');

    await page.locator('[data-mark="card"]').getByRole('button', { name: 'Подтвердить' }).click();
    await expect(page.locator('#lawyer-msg')).toContainText('Отмечено: сведения верны');
    await expect(page.locator('[data-mark="card"]')).toContainText('Вы подтвердили');
    const mark2 = page.locator('[data-case="fake-2"] [data-mark]');
    await mark2.getByRole('button', { name: 'Оспорить' }).click();
    await mark2.getByRole('button', { name: 'Отправить' }).click();
    await expect(mark2.locator('.msg')).toContainText('Напишите, что не так');
    await mark2.getByLabel('Что в сведениях не так').fill('Это дело однофамильца');
    await mark2.getByRole('button', { name: 'Отправить' }).click();
    await expect(page.locator('#lawyer-msg')).toContainText('сведения оспорены');
    await page.locator('#lawyer-marks summary').click();
    await expect(page.locator('#lawyer-marks li').first()).toContainText('Оспорено — дело № А40-2002/2025');
    await expect(page.locator('#lawyer-marks li').first()).toContainText('Это дело однофамильца');
    await page.locator('#lawyer-marks').scrollIntoViewIfNeeded();
    await shot(page, 'yurist-03-otmetki');

    // Администратор видит отметки заказчика с именем и пояснением.
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
    const ap = await ctx.newPage();
    const adm = await signIn(ap, '+79990000975');
    await db.query("update users set platform_role = 'admin' where id = $1", [adm.id]);
    await ap.goto('/kabinet#lawyers');
    await ap.getByLabel('Фамилия, имя и отчество юриста').fill('Пробный Адвокат Иванович');
    await ap.getByRole('button', { name: 'Проверить', exact: true }).click();
    await ap.locator('#lawyer-marks summary').click();
    await expect(ap.locator('#lawyer-marks')).toContainText('Это дело однофамильца');
    await expect(ap.locator('#lawyer-marks li .muted').first()).not.toBeEmpty();
    await ctx.close();
    expect(errors).toEqual([]);
  } finally {
    await db.query("delete from lawyer_check_marks where user_id = $1", [cust.id]);
    await db.end();
  }
});
