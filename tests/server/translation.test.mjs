// Модуль «Переводы» (задача штаба 3f617197, решение Дамира 11.10.2026): три услуги, «Куда подаёте», цены настройками.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole } from '../helpers.mjs';
import { createRegistry, validateModule } from '../../src/modules/index.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import translation from '../../src/modules/translation.mjs';
import { TRANSLATION_PRICES, quoteTranslation, translationNotices } from '../../src/translation/prices.mjs';

let S, owner, dispatcher, stranger;
const soon = addDays(todayMsk(), 7);
// Паспорт, английский, одна страница.
const PASSPORT = { recipient: 'mvd', language: 'en', direction: 'to_ru', doc_kind: 'identity', docs: 1, pages: 1 };

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990000951');
  dispatcher = await login(S, '+79990000952');
  stranger = await login(S, '+79990000953');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
});
after(async () => { await S?.close(); });

const rub = (kop) => kop / 100;
const sum = (q) => ({ total: rub(q.total_kop), platform: rub(q.commission_kop), translator: rub(q.executor_kop), transit: rub(q.transit_kop) });

test('описание «Переводов» проходит проверку: три услуги, «Куда подаёте» обязательно у всех', () => {
  validateModule(translation);
  const m = createRegistry().catalog().find((x) => x.id === 'translation');
  assert.deepEqual(m.services.map((s) => s.name), [
    'Нотариальный перевод (бумага)', 'Нотариальный перевод (электронный файл)', 'Перевод без нотариуса (с сертификатом платформы)',
  ]);
  assert.deepEqual(m.basis.map((b) => b.id), ['contract']);
  for (const s of m.services) {
    const f = s.fields.find((x) => x.id === 'recipient');
    assert.ok(f?.required, s.id);
    assert.ok(m.checks.some((c) => c.services.includes(s.id)), s.id);
  }
  // Оригинал нужен только нотариусу; срочности у электронного файла нет.
  const ids = (id) => m.services.find((s) => s.id === id).fields.map((f) => f.id);
  assert.ok(ids('notary_paper').includes('original') && ids('notary_file').includes('original') && !ids('plain').includes('original'));
  assert.ok(!ids('notary_file').includes('urgent'));
});

test('цены по таблице — проверочные суммы Дамира: паспорт и 10 страниц', () => {
  const pickup = { ...PASSPORT, urgent: 'no', delivery: 'pickup' };
  assert.deepEqual(sum(quoteTranslation('notary_paper', pickup)), { total: 1550, platform: 200, translator: 800, transit: 550 });
  assert.equal(rub(quoteTranslation('notary_file', { ...PASSPORT, delivery: 'none' }).total_kop), 2050);
  assert.deepEqual(sum(quoteTranslation('plain', { ...PASSPORT, urgent: 'no', delivery: 'none' })), { total: 750, platform: 150, translator: 600, transit: 0 });
  assert.equal(rub(quoteTranslation('notary_paper', { ...pickup, pages: 10 }).total_kop), 8300);
  assert.equal(rub(quoteTranslation('plain', { ...pickup, pages: 10, delivery: 'none' }).total_kop), 6150);
});

test('цены: срочно, курьер, восточный язык ×2, пачка от 5 документов, равнозначность со скидкой с 15-й страницы', () => {
  const P = TRANSLATION_PRICES;
  const base = { ...PASSPORT, urgent: 'no', delivery: 'none' };
  const plain = quoteTranslation('plain', base).total_kop;
  assert.equal(quoteTranslation('plain', { ...base, urgent: 'yes' }).total_kop - plain, P.urgent_kop);
  const courier = quoteTranslation('plain', { ...base, delivery: 'courier' });
  assert.equal(courier.total_kop - plain, P.courier_kop);
  assert.equal(courier.commission_kop, quoteTranslation('plain', base).commission_kop, 'с доставки комиссии нет — транзит');
  assert.equal(quoteTranslation('plain', { ...base, language: 'zh' }).total_kop - plain, P.page_kop, 'китайский — перевод вдвое дороже');
  const org = (docs) => quoteTranslation('notary_paper', { ...base, docs, pages: docs, delivery: 'pickup' }).lines.find((l) => l.title.startsWith('Организация')).kop;
  assert.equal(org(4), 4 * P.organize_kop);
  assert.equal(org(5), 5 * P.organize_batch_kop);
  // 10 страниц оригинала → 20 страниц электронного документа: 14 × 250 + 6 × 230.
  const eq = quoteTranslation('notary_file', { ...base, pages: 10 }).lines.find((l) => l.title.includes('равнозначность')).kop;
  assert.equal(eq, (14 * 250 + 6 * 230) * 100);
  assert.equal(quoteTranslation('plain', { ...base, pages: undefined }), null, 'без числа страниц — расчёта нет');
});

test('«Куда подаёте»: туда, где нужен нотариальный, без нотариуса — предупреждение; для бизнеса — нет', () => {
  const plain = (recipient) => translationNotices('plain', { ...PASSPORT, recipient, doc_kind: 'diploma' }).map((n) => n.id);
  for (const r of ['mvd', 'zags', 'court', 'tax', 'notary', 'university', 'bank']) assert.deepEqual(plain(r), ['notary_needed'], r);
  for (const r of ['business', 'abroad', 'personal', 'other']) assert.deepEqual(plain(r), [], r);
  assert.deepEqual(translationNotices('notary_paper', PASSPORT), [], 'нотариальный — без предупреждения');
  assert.deepEqual(translationNotices('notary_file', PASSPORT).map((n) => n.id), ['file_identity'], 'паспорт электронным файлом — пока нельзя');
  assert.deepEqual(translationNotices('notary_file', { ...PASSPORT, doc_kind: 'diploma' }), []);
});

test('заявка на перевод: расчёт — заказчику и диспетчеру, посторонний заявку не видит; паспорт файлом не отправить', async () => {
  const mk = async (service, fields) => {
    const r = await owner.req('POST', '/api/orders', { module: 'translation', service });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const p = await owner.req('PATCH', `/api/orders/${r.body.order.id}`, { deadline: soon, fields });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    return r.body.order;
  };
  const o = await mk('plain', { ...PASSPORT, urgent: 'no', delivery: 'none' });
  const mine = (await owner.req('GET', `/api/orders/${o.id}`)).body;
  assert.equal(mine.quote.total_kop, 75000);
  assert.deepEqual(mine.notices.map((n) => n.id), ['notary_needed'], 'МВД — нужен нотариальный');
  assert.equal((await stranger.req('GET', `/api/orders/${o.id}`)).status, 404);
  // Предупреждение не запрещает: клиента предупредили — он решает сам.
  const sent = await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal((await dispatcher.req('GET', `/api/orders/${o.id}`)).body.quote.total_kop, 75000);

  const f = await mk('notary_file', { ...PASSPORT, original: 'courier', delivery: 'none' });
  const view = (await owner.req('GET', `/api/orders/${f.id}`)).body;
  assert.deepEqual(view.submit_missing, ['нотариальный перевод паспорта — только на бумаге']);
  const r = await owner.req('POST', `/api/orders/${f.id}/status`, { to: 'matching', from: 'new' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /только на бумаге/);
});
