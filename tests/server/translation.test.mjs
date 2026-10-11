// Модуль «Переводы» (задача штаба 3f617197, решение Дамира 11.10.2026): три услуги, «Куда подаёте», цены настройками.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, signResults } from '../helpers.mjs';
import { cancelSplit, splitAmount } from '../../src/money/money.mjs';
import { extractPages } from '../../src/ai/extract.mjs';
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

// Деньги перевода (2а.2): 20% — только от услуг; тарифы нотариуса и доставка — транзитом, без вознаграждения.
test('деньги перевода: 20% только с услуг, нотариус и доставка — транзитом; отдельной строкой в счёте, акте и отчёте агента', async () => {
  assert.deepEqual(splitAmount(155_000, 55_000), { priceKop: 155_000, transitKop: 55_000, commissionKop: 20_000, payoutKop: 80_000 });
  assert.deepEqual(splitAmount(30_000, 55_000), { priceKop: 30_000, transitKop: 30_000, commissionKop: 0, payoutKop: 0 }, 'транзит не больше цены');
  assert.deepEqual(cancelSplit(155_000, 50, 55_000), { workKop: 50_000, refundKop: 105_000 }, 'при отмене нотариус возвращается целиком');
  for (const [price, transit] of [[155_000, 55_000], [101, 33], [999_999, 1]]) {
    const x = splitAmount(price, transit);
    assert.equal(x.transitKop + x.commissionKop + x.payoutKop, price);
  }

  const spec = await login(S, '+79990000954');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['translation', 'notary_paper'], ['translation', 'plain']], capacity: 20, taxStatus: 'ip', languages: ['en'] });
  // Паспорт, английский, бумага, самовывоз: 1 550 ₽ = платформа 200 + переводчик 800 + нотариус 550.
  const priced = async (fields) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'translation', service: 'notary_paper', title: 'Перевод паспорта' })).body.order;
    assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: soon, fields })).status, 200);
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
    const q = (await dispatcher.req('GET', `/api/orders/${o.id}`)).body.quote;
    const r = await dispatcher.req('PUT', `/api/orders/${o.id}/price`, { price: String(q.total_kop / 100) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { o, m: r.body.money };
  };
  const pay = async (o) => {
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/payments`)).status, 201);
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/payments/refresh`)).body.money.paid, true);
  };
  const inWork = async (o) => {
    assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
    assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  };
  const fields = { ...PASSPORT, original: 'courier', urgent: 'no', delivery: 'pickup' };

  const { o, m } = await priced(fields);
  assert.deepEqual([m.price_kop, m.transit_kop, m.commission_kop, m.fee_kop], [155_000, 55_000, 20_000, 80_000]);
  const mo = (await owner.req('GET', `/api/orders/${o.id}/money`)).body.money;
  assert.deepEqual([mo.transit_kop, mo.commission_kop], [55_000, null], 'заказчик видит транзит, вознаграждение — нет');

  const docx = async (c, path) => {
    const r = await fetch(`${S.base}/api/orders/${o.id}/${path}`, { headers: { cookie: c.cookie } });
    assert.equal(r.status, 200, path);
    const buf = Buffer.from(await r.arrayBuffer());
    return (await extractPages(buf, 'x.docx')).pages.join('\n');
  };
  const inv = await docx(owner, 'invoice');
  assert.match(inv, /услуги[\s\S]*1\s000,00 ₽/);
  assert.match(inv, /Тарифы нотариуса и доставка[\s\S]*550,00 ₽/);
  assert.match(inv, /Итого к оплате: 1\s550,00 ₽/);
  assert.match(inv, /20% от услуг/);

  await pay(o);
  await inWork(o);
  // До выдачи переводчику в списке и в «Сегодня» — его 800 ₽, а не 80% от 1 550.
  assert.equal((await spec.req('GET', '/api/orders')).body.orders.find((x) => x.id === o.id).fee_kop, 80_000);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/results`, Buffer.from('перевод'), { raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': 'p.pdf' } })).status, 201);
  await signResults(S, spec, o.id);
  // Шаги до сдачи (2а.6): оригинал получен, подписано у нотариуса.
  for (const step of ['original', 'notarized']) assert.equal((await spec.req('POST', `/api/orders/${o.id}/steps/${step}`, {})).status, 200, step);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { to: 'review', from: 'in_work' })).status, 200);
  const rv = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/status`, { to: 'done', from: 'review' })).status, 200);

  const [po] = await S.sql`select amount_kop, commission_kop, transit_kop from payouts where order_id = ${o.id}`;
  assert.deepEqual([Number(po.amount_kop), Number(po.commission_kop), Number(po.transit_kop)], [80_000, 20_000, 55_000]);
  const ms = (await spec.req('GET', `/api/orders/${o.id}/money`)).body.money;
  assert.equal(ms.payout.amount_kop, 80_000);
  assert.equal(ms.transit_kop, null, 'переводчику транзит не показывается');
  const act = (await owner.req('GET', `/api/orders/${o.id}/money`)).body.money.documents.find((d) => d.kind === 'act');
  assert.deepEqual([act.data.services_kop, act.data.transit_kop, act.data.commission_kop], [100_000, 55_000, 20_000]);
  assert.deepEqual(act.data.transit_lines.map((l) => l.kop), [40_000, 15_000], 'подпись переводчика и копия у нотариуса');
  const at = await docx(owner, `closing/${act.id}`);
  assert.match(at, /Нотариус — подпись переводчика[\s\S]*400,00 ₽/);
  assert.match(at, /Нотариус — копия оригинала[\s\S]*150,00 ₽/);
  assert.match(at, /вознаграждение агента \(20% от услуг\): 200,00 ₽/);
  const rt = await docx(spec, `closing/${ms.documents[0].id}`);
  assert.match(rt, /1\s550,00 ₽[\s\S]*550,00 ₽[\s\S]*200,00 ₽ \(20% от услуг 1\s000,00 ₽\)[\s\S]*800,00 ₽/);
  const sum = (await dispatcher.req('GET', '/api/money')).body.totals;
  assert.ok(sum.transit_kop >= 55_000, 'в сводке — транзит отдельно');

  // Отказ заказчика после начала работ, сделано 50%: переводчику 80% от 500 ₽, нотариус (550 ₽) — возврат целиком.
  const { o: b } = await priced(fields);
  await pay(b);
  await inWork(b);
  assert.equal((await dispatcher.req('POST', `/api/orders/${b.id}/status`, { to: 'cancelled', from: 'in_work', reason: 'Заказчик отказался', fault: 'customer', done_percent: 50 })).status, 200);
  const [pb] = await S.sql`select amount_kop, commission_kop, transit_kop from payouts where order_id = ${b.id}`;
  assert.deepEqual([Number(pb.amount_kop), Number(pb.commission_kop), Number(pb.transit_kop)], [40_000, 10_000, 0]);
  const [rb] = await S.sql`select amount_kop from refunds where order_id = ${b.id}`;
  assert.equal(Number(rb.amount_kop), 105_000);
});

// Исполнители-переводчики (2а.3; задачи штаба 3f617197 и 3f417197-…-813c): статус, документ о знании языка, чек на выплату.
test('переводчики: без статуса не допускаются; к нотариальным — только с проверенным дипломом по языку; самозанятый — чек на выплату', async () => {
  const admin = await login(S, '+79990000955');
  await setPlatformRole(S.sql, admin.user.id, 'admin');
  const tr = await login(S, '+79990000956');
  const id = tr.user.id;
  const adm = (method, path, body) => admin.req(method, `/api/admin/specialists/${id}${path}`, body);

  // Физлицо без статуса: допуск к переводам не выдаётся (иначе платформа — налоговый агент); к экспертизе — как раньше.
  assert.equal((await adm('PUT', '', { regions: ['moscow'] })).status, 200);
  const noTax = await adm('POST', '/permits', { module: 'translation', service: 'plain' });
  assert.equal(noTax.status, 409);
  assert.match(noTax.body.message, /самозанятый, ИП или ООО\/бюро/);
  assert.equal((await adm('PUT', '', { tax_status: 'физлицо' })).status, 400);
  const prof = (await adm('PUT', '', { tax_status: 'self_employed' })).body.specialist;
  assert.equal(prof.tax_status_name, 'Самозанятый');
  assert.ok(prof.tax_rules.some((r) => /чек в приложении «Мой налог»/.test(r)), 'правило: чек на каждую выплату');
  for (const service of ['notary_paper', 'plain']) assert.equal((await adm('POST', '/permits', { module: 'translation', service })).status, 201);
  assert.equal((await adm('PUT', '', { tax_status: null })).status, 409, 'статус не снять, пока есть допуски к переводам');
  assert.deepEqual((await tr.req('GET', '/api/specialist/me')).body.specialist.tax_rules, prof.tax_rules, 'переводчик видит свои правила');

  // Документ о знании языка — в досье, по языку из списка заявки.
  const add = (b) => tr.req('POST', '/api/specialist/me/dossier', { kind: 'language', title: 'Диплом МГЛУ, переводчик', ...b });
  assert.equal((await add({})).status, 400, 'без языка');
  assert.equal((await add({ language: 'xx' })).status, 400, 'язык не из списка');
  assert.equal((await tr.req('POST', '/api/specialist/me/dossier', { kind: 'sro', title: 'СРО', number: '1', language: 'en' })).status, 400);
  const d = await add({ language: 'en', number: 'ВСА 0000001' });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const item = d.body.items.find((i) => i.kind === 'language');
  assert.deepEqual([item.language_name, item.verified], ['Английский', false]);
  assert.ok(d.body.languages.some((l) => l.id === 'zh'));
  const verify = (v) => adm('PUT', `/languages/${item.id}`, { verified: v });
  assert.equal((await verify(true)).status, 409, 'без копии проверять нечего');
  const upload = () => tr.req('POST', `/api/specialist/me/dossier/${item.id}/file`, Buffer.from('скан диплома'), { raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': 'diplom.pdf' } });
  assert.equal((await upload()).status, 200);
  assert.ok((await adm('GET', `/languages/${item.id}/file`)).body.url, 'администратор открывает копию');
  assert.equal((await tr.req('GET', `/api/admin/specialists/${id}/languages/${item.id}/file`)).status, 404, 'переводчик — не через служебный путь');
  assert.equal((await verify('да')).status, 400);
  const ok = (await verify(true)).body.specialist;
  assert.deepEqual(ok.languages.map((l) => [l.language_name, l.verified, l.has_copy]), [['Английский', true, true]]);
  assert.equal(ok.languages[0].number, undefined, 'номер документа в карточке не показывается');

  // Подбор: нотариальный английский — переводчик есть; нотариальный немецкий — нет; без нотариуса немецкий — есть.
  const ready = async (service, fields) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'translation', service, title: 'Перевод для подбора' })).body.order;
    assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: soon, fields })).status, 200);
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
    return o;
  };
  const paper = { ...PASSPORT, original: 'courier', urgent: 'no', delivery: 'pickup' };
  const cands = async (o) => (await dispatcher.req('GET', `/api/orders/${o.id}/candidates`)).body.candidates.map((c) => c.user_id);
  const en = await ready('notary_paper', paper);
  assert.ok((await cands(en)).includes(id), 'нотариальный английский — с проверенным дипломом');
  assert.ok(!(await cands(await ready('notary_paper', { ...paper, language: 'de' }))).includes(id), 'немецкого диплома нет');
  assert.ok((await cands(await ready('plain', { ...PASSPORT, language: 'de', urgent: 'no', delivery: 'none' }))).includes(id), 'без нотариуса — по допуску');
  // Изменил сведения или копию — проверка заново, до неё к нотариальным не подбирается.
  assert.equal((await tr.req('PUT', `/api/specialist/me/dossier/${item.id}`, { title: 'Другой диплом', language: 'en' })).status, 200);
  assert.ok(!(await cands(en)).includes(id), 'после правки — снова на проверке');
  assert.equal((await verify(true)).status, 200);
  assert.equal((await tr.req('PUT', `/api/specialist/me/dossier/${item.id}`, { title: 'Другой диплом', language: 'en' })).body.items.find((i) => i.id === item.id).verified, true, 'те же сведения — отметка остаётся');
  assert.equal((await upload()).status, 200);
  assert.ok(!(await cands(en)).includes(id), 'новая копия — снова на проверке');
  assert.equal((await verify(true)).status, 200);
  // Статус снят администратором напрямую (например, самозанятость прекращена) — к переводам не подбирается.
  await S.sql`update specialists set tax_status = null where user_id = ${id}`;
  assert.ok(!(await cands(en)).includes(id), 'без статуса — не подбирается');
  await S.sql`update specialists set tax_status = 'self_employed' where user_id = ${id}`;
  // Диплом в досье переводчика не попадает в сведения эксперта для черновика оценки.
  const { loadDossier } = await import('../../src/dossier/dossier.mjs');
  assert.deepEqual(await loadDossier(S.sql, id), []);

  // Выплата самозанятому: «нужен чек», в сводке — без чека; чек прикладывает сам по ссылке ФНС.
  const q = (await dispatcher.req('GET', `/api/orders/${en.id}`)).body.quote;
  assert.equal((await dispatcher.req('PUT', `/api/orders/${en.id}/price`, { price: String(q.total_kop / 100) })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${en.id}/payments`)).status, 201);
  assert.equal((await owner.req('POST', `/api/orders/${en.id}/payments/refresh`)).body.money.paid, true);
  assert.equal((await dispatcher.req('POST', `/api/orders/${en.id}/offer`, { specialist_id: id, from: 'matching' })).status, 200);
  assert.equal((await tr.req('POST', `/api/orders/${en.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  const receipt = (url) => tr.req('PUT', `/api/orders/${en.id}/payout/receipt`, { url });
  const URL_OK = 'https://lknpd.nalog.ru/api/v1/receipt/770000000000/20abc0001/print';
  assert.equal((await receipt(URL_OK)).status, 404, 'выплаты ещё нет');
  assert.equal((await tr.req('POST', `/api/orders/${en.id}/results`, Buffer.from('перевод'), { raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': 'p.pdf' } })).status, 201);
  await signResults(S, tr, en.id);
  for (const step of ['original', 'notarized']) assert.equal((await tr.req('POST', `/api/orders/${en.id}/steps/${step}`, {})).status, 200, step);
  assert.equal((await tr.req('POST', `/api/orders/${en.id}/status`, { to: 'review', from: 'in_work' })).status, 200);
  const rv = (await dispatcher.req('GET', `/api/orders/${en.id}/review`)).body;
  for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${en.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
  assert.equal((await dispatcher.req('POST', `/api/orders/${en.id}/status`, { to: 'done', from: 'review' })).status, 200);
  const m = (await tr.req('GET', `/api/orders/${en.id}/money`)).body.money;
  assert.deepEqual([m.payout.status, m.payout.receipt_needed, m.can_add_receipt], ['succeeded', true, true]);
  assert.equal((await dispatcher.req('GET', `/api/orders/${en.id}/money`)).body.money.can_add_receipt, false, 'диспетчер чек не прикладывает');
  const missing = (await dispatcher.req('GET', '/api/money')).body.totals.receipts_missing;
  assert.ok(missing >= 1);
  assert.ok((await tr.req('GET', '/api/payouts')).body.payouts.find((p) => p.order_id === en.id).receipt_needed);
  for (const bad of ['http://lknpd.nalog.ru/x', 'https://lknpd.nalog.ru.evil.ru/x', 'чек', '']) assert.equal((await receipt(bad)).status, 400, bad);
  const done = (await receipt(URL_OK)).body.money.payout;
  assert.deepEqual([done.receipt_url, done.receipt_needed], [URL_OK, false]);
  assert.equal((await dispatcher.req('GET', '/api/money')).body.totals.receipts_missing, missing - 1);
});

// Оферта (2а.8): главные условия в карточке заявки — черновик, пока юрист не проверил; полный текст — docs/legal.
test('условия заказа: заказчику — его пункты по услуге, исполнителю и диспетчеру — и свои; гарантия по сертификату — в пределах стоимости заказа', async () => {
  const { existsSync } = await import('node:fs');
  assert.ok(existsSync(new URL(`../../${translation.offer.doc}`, import.meta.url)), 'полный текст оферты лежит в docs');
  const reg = createRegistry([translation]);
  const plain = reg.offer('translation', 'plain');
  assert.equal(plain.draft, true);
  assert.ok(plain.customer.some((p) => p.id === 'guarantee' && /в пределах стоимости заказа/.test(p.text)));
  assert.ok(plain.customer.some((p) => p.id === 'quality' && /отвечает переводчик/.test(p.text)));
  assert.ok(!plain.customer.some((p) => p.id === 'notary'), 'без нотариуса — без пункта о нотариусе');
  const paper = reg.offer('translation', 'notary_paper');
  assert.ok(paper.customer.some((p) => p.id === 'notary') && !paper.customer.some((p) => p.id === 'guarantee'));
  assert.equal(createRegistry().offer('expertise', 'any'), null, 'у экспертизы оферты в карточке пока нет');

  // Ошибки в описании — сервер не стартует.
  const bad = (offer) => assert.throws(() => validateModule({ ...translation, offer }), /оферта/);
  bad({ ...translation.offer, version: '12.10.2026' });
  bad({ ...translation.offer, doc: 'https://example.ru/oferta' });
  bad({ ...translation.offer, points: translation.offer.points.filter((p) => p.to === 'executor') });
  bad({ ...translation.offer, points: [{ id: 'x', to: 'all', text: 'т' }] });
  bad({ ...translation.offer, points: [{ id: 'x', to: 'customer', text: 'т', services: ['nope'] }] });

  const r = await owner.req('POST', '/api/orders', { module: 'translation', service: 'plain' });
  const id = r.body.order.id;
  const mine = (await owner.req('GET', `/api/orders/${id}`)).body.terms;
  assert.deepEqual(mine.customer.map((p) => p.id), plain.customer.map((p) => p.id));
  assert.deepEqual(mine.executor, [], 'заказчику пункты переводчика не показываются');
  await owner.req('PATCH', `/api/orders/${id}`, { deadline: soon, fields: { ...PASSPORT, recipient: 'business', urgent: 'no', delivery: 'none' } });
  assert.equal((await owner.req('POST', `/api/orders/${id}/status`, { to: 'matching', from: 'new' })).status, 200);
  const staff = (await dispatcher.req('GET', `/api/orders/${id}`)).body.terms;
  assert.ok(staff.executor.some((p) => p.id === 'executor_money' && /80%/.test(p.text)));
  const tr = await login(S, '+79990000957');
  await S.sql`update orders set executor_user_id = ${tr.user.id}, status = 'in_work' where id = ${id}`;
  const exec = await tr.req('GET', `/api/orders/${id}`);
  assert.equal(exec.status, 200);
  assert.deepEqual(exec.body.terms.executor.map((p) => p.id), staff.executor.map((p) => p.id));
});
