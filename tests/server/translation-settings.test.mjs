// Цены и правила «Переводов» правит администратор в кабинете (задача 2а.9, задача штаба 3f617197): проверка значений,
// история (кто, когда, что), новая цена — в расчёте заявки сразу; назначенная цена и строки нотариуса в заявке не меняются.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { DEFAULT_SETTINGS, applySettings, quoteTranslation, settingsFrom, translationNotices } from '../../src/translation/prices.mjs';
import { refreshTranslationSettings, resetTranslationSettings } from '../../src/translation/settings.mjs';

let S, admin, owner, dispatcher;
const soon = addDays(todayMsk(), 7);
const PASSPORT = { recipient: 'mvd', language: 'en', direction: 'to_ru', doc_kind: 'identity', docs: 1, pages: 1, urgent: 'no', delivery: 'pickup', original: 'courier' };

before(async () => {
  S = await startApp();
  admin = await login(S, '+79990000971');
  owner = await login(S, '+79990000972');
  dispatcher = await login(S, '+79990000973');
  await setPlatformRole(S.sql, admin.user.id, 'admin');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
});
after(async () => { applySettings(null); await S?.close(); });

const save = (values) => admin.req('PUT', '/api/admin/translation-settings', { values });

test('проверка значений: суммы в копейках, границы, неизвестное — ошибка; пустое — стартовые значения', () => {
  assert.deepEqual(settingsFrom({}), DEFAULT_SETTINGS);
  const bad = (v, re) => assert.throws(() => settingsFrom(v), re);
  bad({ page_kop: 50 }, /Перевод, за страницу/);
  bad({ page_kop: 600.5 }, /Перевод, за страницу/);
  bad({ courier_kop: -1 }, /Курьер/);
  bad({ courier_kop: 1_000_000_01 }, /Курьер/);
  bad({ eastern_factor: 2.25 }, /Восточные/);
  bad({ eastern_factor: 6 }, /Восточные/);
  bad({ redo_days: 0 }, /переделка/);
  bad({ file_for_identity: 'да' }, /Паспорт/);
  bad({ equivalence3_from: 10 }, /третья цена должна начинаться позже второй/);
  bad({ commission_percent: 10 }, /Неизвестная настройка/);
  bad(null, /Нет значений/);
  assert.equal(settingsFrom({ eastern_factor: 1.5 }).eastern_factor, 1.5);
});

test('без правки — стартовые цены; правка администратора — сразу в расчёте заявки, с историей; заказанное не меняется', async () => {
  const first = (await admin.req('GET', '/api/admin/translation-settings')).body.settings;
  assert.equal(first.commission_percent, 20);
  assert.deepEqual(first.history, []);
  const page = first.fields.find((f) => f.key === 'page_kop');
  assert.deepEqual([page.value, page.default, page.kind, page.group], [600_00, 600_00, 'rub', 'Перевод']);
  assert.ok(first.fields.some((f) => f.key === 'file_for_identity' && f.value === false));

  // Заявка с назначенной ценой до правки: 1 550 ₽, нотариус 550 ₽ — двумя строками.
  const o = (await owner.req('POST', '/api/orders', { module: 'translation', service: 'notary_paper', title: 'Перевод паспорта' })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: soon, fields: PASSPORT })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  assert.equal((await dispatcher.req('PUT', `/api/orders/${o.id}/price`, { price: '1550' })).status, 200);
  const snap = await S.sql.one`select price_kop, transit_kop, transit_lines from orders where id = ${o.id}`;
  assert.equal(Number(snap.transit_kop), 550_00);
  assert.deepEqual(snap.transit_lines.map((l) => l.kop), [400_00, 150_00]);

  // Ошибка — 400, ничего не сохранено.
  const wrong = await save({ page_kop: 0 });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.message, /Перевод, за страницу/);

  const r = await save({ page_kop: 700_00, notary_signature_kop: 450_00, file_for_identity: true, redo_days: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.changes.map((c) => `${c.title}: ${c.from} → ${c.to}`), [
    'Перевод, за страницу: 600 ₽ → 700 ₽',
    'Подпись переводчика, за документ: 400 ₽ → 450 ₽',
    'Паспорт можно заказать нотариальным файлом: нет → да',
    'Бесплатная переделка — срок, дней: 2 → 3',
  ]);
  const h = r.body.settings.history;
  assert.equal(h.length, 1);
  assert.equal(h[0].changes.length, 4);
  assert.ok(h[0].by, 'кто правил');

  // То же ещё раз — новой записи нет.
  const same = await save({ page_kop: 700_00 });
  assert.deepEqual(same.body.changes, []);
  assert.equal(same.body.settings.history.length, 1);

  // Новая заявка считается по новым ценам: 700 + 400 + 450 + 150 = 1 700 ₽; паспорт файлом теперь можно.
  const n = (await owner.req('POST', '/api/orders', { module: 'translation', service: 'notary_paper', title: 'Перевод паспорта 2' })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${n.id}`, { deadline: soon, fields: PASSPORT })).status, 200);
  assert.equal((await owner.req('GET', `/api/orders/${n.id}`)).body.quote.total_kop, 1700_00);
  assert.deepEqual(translationNotices('notary_file', PASSPORT), []);
  assert.deepEqual(S.app.locals.registry.proofread('translation').redo_days, 3, 'вычитка и переделка — по новым числам');

  // Заявка с назначенной ценой: цена и строки нотариуса — прежние.
  const old = await S.sql.one`select price_kop, transit_kop, transit_lines from orders where id = ${o.id}`;
  assert.deepEqual(old, snap);

  // Вторая правка — в истории сверху, с тем, что изменилось относительно прошлой.
  const r2 = await save({ page_kop: 650_00 });
  assert.deepEqual(r2.body.settings.history.map((x) => x.changes.map((c) => `${c.from} → ${c.to}`)), [['700 ₽ → 650 ₽'], ['600 ₽ → 700 ₽', '400 ₽ → 450 ₽', 'нет → да', '2 → 3']]);
  // Запись в журнал действий.
  assert.ok(await S.sql.one`select 1 from audit_log where action = 'translation_settings.save' and actor_id = ${admin.user.id}`);
});

test('другая копия сервера видит правку: значения перечитываются из базы', async () => {
  await save({ page_kop: 800_00 });
  // Как будто процесс другой копии: в памяти стартовые значения, база — с правкой.
  resetTranslationSettings();
  assert.equal(quoteTranslation('plain', { ...PASSPORT, delivery: 'none' }).total_kop, 750_00, 'до чтения из базы — стартовые');
  await refreshTranslationSettings(S.sql);
  assert.equal(quoteTranslation('plain', { ...PASSPORT, delivery: 'none' }).total_kop, 950_00, '800 + 150');
  // Вернуть стартовые значения — тоже правка.
  const back = await save(DEFAULT_SETTINGS);
  assert.equal(back.status, 200);
  assert.equal(quoteTranslation('plain', { ...PASSPORT, delivery: 'none' }).total_kop, 750_00);
});
