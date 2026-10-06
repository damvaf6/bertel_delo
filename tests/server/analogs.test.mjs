// Аналоги в деле (2.32; план docs/analogi-plan.md): ссылка + скриншот со временем платформы и отпечатком, ИИ предлагает
// признаки — эксперт подтверждает; предупреждения; таблица и приложение со скриншотами в Word. С сайтов ничего не берём.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry, validateModule } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';
import { cleanUrl } from '../../src/analogs/analogs.mjs';
import { buildReport, imageSize } from '../../src/docs/docx.mjs';
import { ANALOGS_MARK } from '../../src/docs/report.mjs';
import { extractPages } from '../../src/ai/extract.mjs';
import { makeDocx, makePdf } from '../tools/make-docs.mjs';

let S, owner, dispatcher, spec;
const CAR = { purpose: 'court', region: 'moscow', vehicle_type: 'car', make_model: 'Toyota Camry', year: 2019 };
const FLAT = { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 9', area: '54.3' };

// Настоящий маленький PNG (1×1, 4×8 и т. п.) — с текстом для поддельного распознавания после конца картинки.
function png(w, h, ocr = '') {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0xcc);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    Buffer.from(ocr ? `OCR:${ocr}` : '', 'utf8')]);
}

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990003201');
  dispatcher = await login(S, '+79990003202');
  spec = await login(S, '+79990003203');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty'], ['expertise', 'vehicle'], ['expertise', 'goods']] });
  await spec.req('PATCH', '/api/me', { full_name: 'Тестов Эксперт' });
});
after(async () => { await S?.close(); });

async function step(c, o, to) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status });
}

async function inWork(service, fields, title) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service, title })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields })).status, 200);
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  return o;
}

const add = (o, url) => spec.req('POST', `/api/orders/${o.id}/analogs`, { url });
const put = (o, a, buf, name = 'screen.png', c = spec) => c.req('POST', `/api/orders/${o.id}/analogs/${a}/file`, buf, {
  raw: true, headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) },
});
const byId = (r, id) => r.body.analogs.find((a) => a.id === id);

test('описание модуля: аналоги — у оценки, не у товароведческой; ошибки описания не пропускаются', () => {
  const reg = createRegistry();
  const car = reg.analogs('expertise', 'vehicle');
  assert.equal(car.min, 3);
  assert.ok(car.fields.some((f) => f.id === 'mileage_km') && !car.fields.some((f) => f.id === 'floor'));
  assert.ok(reg.analogs('expertise', 'realty').fields.some((f) => f.id === 'floor'));
  assert.equal(reg.analogs('expertise', 'goods'), null);
  assert.equal(reg.analogs('expertise', 'construction'), null);
  // Нигде в признаках нет продавца (имя, телефон) — 152-ФЗ.
  assert.ok(!expertise.analogs.fields.some((f) => /продав|телефон|имя/i.test(f.label)));
  const bad = (patch) => { const m = structuredClone(expertise); patch(m.analogs, m); return () => validateModule(m); };
  assert.throws(bad((a) => { a.fields.push({ id: 'price_rub', label: 'Цена', type: 'number' }); }), /занят признаком ядра/);
  assert.throws(bad((a) => { a.fields[0].near = { field: 'year', within: 1 }; }), /только у числового/);
  assert.throws(bad((a) => { a.fields[1].near = { field: 'make_model', within: 1 }; }), /числовое поле заявки/);
  assert.throws(bad((a) => { a.fields[1].near = { field: 'year' }; }), /within или pct/);
  assert.throws(bad((a) => { a.min = 0; }), /min/);
  assert.throws(bad((a) => { a.services = ['nope']; }), /services/);
  assert.throws(bad((a) => { a.fields.push({ id: 'notes', label: 'Заметки', type: 'longtext' }); }), /одной строкой/);
  // Корректировки (2.74): виды — по услуге, «Другая» — у всех; ошибки описания не пропускаются.
  assert.deepEqual(reg.analogs('expertise', 'vehicle').adjustments.map((k) => k.id), ['bargain', 'date', 'location', 'age', 'mileage', 'condition', 'equipment', 'region']);
  assert.ok(reg.analogs('expertise', 'realty').adjustments.some((k) => k.id === 'floor' && k.covers.length === 0));
  assert.throws(bad((a) => { a.adjustments.push({ id: 'other', name: 'Своя' }); }), /занят корректировкой ядра/);
  assert.throws(bad((a) => { a.adjustments.push({ id: 'x1', name: 'X', covers: ['floor'] }); }), /covers/);
  assert.throws(bad((a) => { a.adjustments.push({ id: 'x2', name: 'X', services: ['goods'] }); }), /services/);
  assert.throws(bad((a) => { a.adjustments.push({ id: 'x3', name: '' }); }), /name/);
});

test('ссылка: только http(s); ключ для повторов — без меток рекламы, якоря, «www» и «/» в конце', () => {
  const a = cleanUrl('https://www.avito.ru/moskva/avtomobili/toyota_camry_123/?utm_source=x&context=abc#photo');
  const b = cleanUrl('https://m.avito.ru/moskva/avtomobili/toyota_camry_123');
  assert.equal(a.key, b.key);
  assert.equal(a.host, 'avito.ru');
  assert.notEqual(cleanUrl('https://auto.ru/cars/used/sale/1/?id=2').key, cleanUrl('https://auto.ru/cars/used/sale/1/?id=3').key);
  for (const u of ['', 'avito.ru/1', 'javascript:alert(1)', 'ftp://x.ru/1', 'https://localhost/1', 'https://x.ru/a b']) {
    assert.throws(() => cleanUrl(u), /ссылку/, u);
  }
});

test('эксперт: ссылка и скриншот → ИИ предлагает признаки → эксперт подтверждает; время платформы, отпечаток, без продавца', async () => {
  const o = await inWork('vehicle', CAR, 'Машина: аналоги');
  let r = await spec.req('GET', `/api/orders/${o.id}/analogs`);
  assert.equal(r.status, 200);
  assert.equal(r.body.can_edit, true);
  assert.equal(r.body.min, 3);
  assert.deepEqual(r.body.fields.slice(0, 3).map((f) => f.id), ['price_rub', 'listed_on', 'region']);
  assert.match(r.body.hints[0], /не меньше 3/);
  // Где искать: программа строит ссылки на поиск, открывает их эксперт сам.
  assert.match(r.body.search.criteria, /Toyota Camry, 2017–2021/);
  assert.ok(r.body.search.links.some((l) => l.url.startsWith('https://www.avito.ru/moskva/avtomobili?q=Toyota%20Camry')));

  r = await add(o, 'https://www.avito.ru/moskva/avtomobili/toyota_camry_1?utm_source=tg');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.id;
  let a = byId(r, id);
  assert.equal(a.host, 'avito.ru');
  assert.ok(a.warnings.some((w) => /Нет скриншота/.test(w)));
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/analogs/${id}`, { fields: { price_rub: 1 }, confirm: true })).status, 400, 'без обязательных');
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/analogs/${id}`, { fields: { price_rub: 1, make_model: 'X' }, confirm: true })).body.error, 'no_file');
  // Не картинка и не PDF — не принимается (по содержимому, а не по имени).
  assert.equal((await put(o, id, Buffer.from('<html>не скриншот</html>'), 'screen.png')).body.error, 'bad_file');

  const ad = 'Toyota Camry 2.5 AT, 2018 г.\nЦена 2 150 000 ₽\nПробег 85 000 км\nМосква, Тестовый район\nРазмещено 20.09.2026\nПродавец: Иван Тестов, +7 999 000-11-22';
  const shot = png(4, 8, ad);
  const before = Date.now();
  r = await put(o, id, shot, 'Скриншот 2026-10-04.png');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  a = byId(r, id);
  assert.equal(a.file.sha256, crypto.createHash('sha256').update(shot).digest('hex'), 'отпечаток файла');
  assert.equal(a.file.mime, 'image/png');
  assert.ok(new Date(a.file.received_at).getTime() >= before - 1000, 'время — платформы');
  assert.equal(a.file.name, 'Скриншот 2026-10-04.png');

  // ИИ: признаки со скриншота (распознавание → модель). Ничего не подтверждено само.
  S.providers.ai.reset();
  r = await spec.req('POST', `/api/orders/${o.id}/analogs/${id}/ai`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.found >= 5);
  a = byId(r, id);
  assert.equal(a.confirmed, false);
  assert.equal(a.fields.price_rub, 2150000);
  assert.equal(a.fields.year, 2018);
  assert.equal(a.fields.mileage_km, 85000);
  assert.equal(a.fields.region, 'moscow');
  assert.equal(a.fields.listed_on, '2026-09-20');
  assert.equal(a.fields.make_model, 'Toyota Camry');
  assert.ok(a.warnings.some((w) => /предложил ИИ/.test(w)));
  const prompt = S.providers.ai.calls.at(-1).args.messages.map((m) => m.content).join('\n');
  assert.match(prompt, /Не пиши имя, телефон/);
  // Продавец не сохраняется нигде: ни в признаках, ни в предложении ИИ; текст скриншота не хранится.
  const [row] = await S.sql`select * from order_analogs where id = ${id}`;
  assert.ok(!/Иван|999 000-11-22|79990001122/.test(JSON.stringify(row)), 'нет данных продавца');

  // Эксперт поправил и подтвердил; ИИ второй раз не затирает подтверждённое.
  r = await spec.req('PUT', `/api/orders/${o.id}/analogs/${id}`, { fields: { ...a.fields, modification: '2.5 AT', price_rub: '2 100 000' }, confirm: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  a = byId(r, id);
  assert.equal(a.confirmed, true);
  assert.equal(a.fields.price_rub, 2100000, 'число с пробелами');
  r = await spec.req('POST', `/api/orders/${o.id}/analogs/${id}/ai`, {});
  assert.equal(byId(r, id).fields.price_rub, 2100000);
  assert.equal(byId(r, id).confirmed, true, 'ничего нового — подтверждение остаётся');
  assert.equal((await S.sql`select count(*)::int as n from audit_log where action = 'analogs.ai' and subject_id = ${o.id}`)[0].n, 2);
  // Дата в будущем — нельзя.
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/analogs/${id}`, { fields: { ...a.fields, listed_on: addDays(todayMsk(), 3) } })).body.error, 'bad_date');
  // Новый скриншот снимает подтверждение: признаки нужно сверить заново.
  r = await put(o, id, png(2, 2, ad));
  assert.equal(byId(r, id).confirmed, false);
});

test('предупреждения: повтор ссылки, старое объявление, другой регион, год далеко от объекта, цена далеко от остальных; подсказки', async () => {
  const o = await inWork('vehicle', CAR, 'Машина: предупреждения');
  const mk = async (url, fields) => {
    const id = (await add(o, url)).body.id;
    await put(o, id, png(2, 2));
    const r = await spec.req('PUT', `/api/orders/${o.id}/analogs/${id}`, { fields: { make_model: 'Toyota Camry', ...fields }, confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return id;
  };
  const recent = addDays(todayMsk(), -10);
  const a1 = await mk('https://auto.ru/cars/used/sale/toyota/camry/1/', { price_rub: 2000000, year: 2019, region: 'moscow', listed_on: recent });
  const a2 = await mk('https://www.auto.ru/cars/used/sale/toyota/camry/1?from=search', { price_rub: 2100000, year: 2019, region: 'moscow', listed_on: recent });
  const a3 = await mk('https://auto.drom.ru/moscow/toyota/camry/3.html', { price_rub: 2050000, year: 2014, region: 'mo', listed_on: addDays(todayMsk(), -200) });
  let r = await spec.req('GET', `/api/orders/${o.id}/analogs`);
  assert.ok(byId(r, a1).warnings.some((w) => /уже есть в деле/.test(w)) && byId(r, a2).warnings.some((w) => /уже есть в деле/.test(w)));
  const w3 = byId(r, a3).warnings.join('\n');
  assert.match(w3, /старше полугода/);
  assert.match(w3, /Другой регион \(объект — Москва\)/);
  assert.match(w3, /Год выпуска: 2014 у аналога, 2019 у объекта/);
  assert.ok(!byId(r, a1).warnings.some((w) => /Год|регион|полугода|Цена/.test(w)));
  assert.equal(r.body.confirmed, 3);
  assert.ok(r.body.hints.some((h) => /повторяющиеся/.test(h)));
  assert.ok(!r.body.hints.some((h) => /не меньше/.test(h)), 'три подтверждены');
  const a4 = await mk('https://www.avito.ru/moskva/avtomobili/camry_4', { price_rub: 4000000, year: 2019, region: 'moscow', listed_on: recent });
  r = await spec.req('GET', `/api/orders/${o.id}/analogs`);
  assert.ok(byId(r, a4).warnings.some((w) => /Цена сильно отличается/.test(w)));
  assert.ok(!byId(r, a1).warnings.some((w) => /Цена сильно/.test(w)));
  // Убрали повтор — предупреждение ушло; запись осталась в истории.
  r = await spec.req('DELETE', `/api/orders/${o.id}/analogs/${a2}`);
  assert.equal(r.status, 200);
  assert.ok(!byId(r, a1).warnings.some((w) => /уже есть/.test(w)));
  assert.equal((await S.sql`select count(*)::int as n from order_analogs where id = ${a2} and deleted_at is not null`)[0].n, 1);
});

test('ИИ без скриншота: по вставленному тексту и по PDF страницы; нечего читать — понятная подсказка', async () => {
  const o = await inWork('realty', FLAT, 'Квартира: аналоги по тексту');
  const id = (await add(o, 'https://www.cian.ru/sale/flat/300/')).body.id;
  let r = await spec.req('POST', `/api/orders/${o.id}/analogs/${id}/ai`, {});
  assert.equal(r.status, 409);
  assert.match(r.body.message, /Вставьте текст объявления/);
  r = await spec.req('POST', `/api/orders/${o.id}/analogs/${id}/ai`, { text: '2-комн. квартира, 52 м², этаж 5/9\nЦена 14 500 000 ₽\nАдрес: г. Москва, тестовая ул., 11' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(byId(r, id).fields.price_rub, 14500000);
  assert.equal(byId(r, id).fields.area, 52);
  assert.equal(byId(r, id).fields.floor, '5/9');
  assert.equal(byId(r, id).fields.address, 'г. Москва, тестовая ул., 11');
  // PDF страницы («Печать → Сохранить как PDF»): текст читается без распознавания.
  const id2 = (await add(o, 'https://www.avito.ru/moskva/kvartiry/301')).body.id;
  r = await put(o, id2, makePdf([['Квартира 48 м²', 'Цена 13 900 000 руб.']]), 'page.pdf');
  assert.equal(byId(r, id2).file.mime, 'application/pdf');
  r = await spec.req('POST', `/api/orders/${o.id}/analogs/${id2}/ai`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(byId(r, id2).fields.price_rub, 13900000);
});

test('Word: таблица аналогов под разделом и приложение со скриншотами; без подтверждённых — метки в файле нет', async () => {
  const o = await inWork('realty', FLAT, 'Квартира: аналоги в Word');
  let d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).body.draft;
  assert.ok(d.body.includes(ANALOGS_MARK), 'метка в разделе «Аналоги и корректировки»');
  const fill = (t) => t.replace(/\[(?:заполнить|описать)[^\]]*\]/g, 'заполнено экспертом');
  d = (await spec.req('PUT', `/api/orders/${o.id}/draft`, { body: fill(d.body), from: d.id })).body.draft;
  const docText = async () => {
    const w = await fetch(`${S.base}/api/orders/${o.id}/draft/docx`, { headers: { cookie: spec.cookie } });
    assert.equal(w.status, 200);
    const buf = Buffer.from(await w.arrayBuffer());
    return { buf, text: (await extractPages(buf, 'r.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).pages.join('\n') };
  };
  const empty = await docText();
  assert.ok(!empty.text.includes(ANALOGS_MARK) && !/Скриншоты объявлений/.test(empty.text), 'без аналогов — ни метки, ни приложения');
  let r;

  for (const [i, price] of [14000000, 14500000, 15000000].entries()) {
    const id = (await add(o, `https://www.cian.ru/sale/flat/40${i}/`)).body.id;
    const shot = png(30 + i, 60);
    await put(o, id, shot);
    r = await spec.req('PUT', `/api/orders/${o.id}/analogs/${id}`, { fields: { price_rub: price, address: `г. Москва, ул. Аналогов, ${i + 1}`, area: 50 + i, listed_on: addDays(todayMsk(), -5), region: 'moscow' }, confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  // Черновик заново — модель получает подтверждённые аналоги для текста о корректировках.
  S.providers.ai.reset();
  d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from: d.id })).body.draft;
  assert.equal(d.inputs.analogs, 3);
  assert.match(S.providers.ai.calls.at(-1).args.messages.at(-1).content, /Аналог 2: Цена, руб\. — 14 500 000/);

  const { buf, text } = await docText();
  assert.match(text, /14 500 000/);
  assert.match(text, /г\. Москва, ул\. Аналогов, 3/);
  assert.match(text, /Приложение\. Скриншоты объявлений/);
  assert.match(text, /Ссылка: https:\/\/www\.cian\.ru\/sale\/flat\/401\//);
  assert.match(text, /Отпечаток файла \(SHA-256\): [0-9a-f]{64}/);
  assert.ok(!text.includes(ANALOGS_MARK), 'метка заменена таблицей');
  assert.ok(buf.includes(Buffer.from('word/media/delo3.png')), 'три скриншота в файле');

  d = (await spec.req('PUT', `/api/orders/${o.id}/draft`, { body: fill(d.body), from: d.id })).body.draft;
  r = await spec.req('POST', `/api/orders/${o.id}/draft/result`, { from: d.id, confirm: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const [doc] = await S.sql`select * from documents where id = ${r.body.document.id}`;
  assert.match((await extractPages(await S.providers.storage.get(doc.storage_key), doc.filename, doc.mime)).pages.join('\n'), /Аналог 3 — cian\.ru/);

  // 2.75: ИИ-проверка сверяет таблицу аналогов в отчёте с аналогами дела. Собранный программой отчёт — сходится.
  const found = async () => {
    const res = await spec.req('POST', `/api/orders/${o.id}/review/ai`);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return (res.body.ai.items.find((i) => i.id === 'analogs').found ?? []).map((f) => f.text);
  };
  assert.deepEqual((await found()).filter((t) => /из дела|не из аналогов/.test(t)), [], 'отчёт из Word программы сходится с делом');
  // Эксперт поправил цену аналога в деле, а отчёт не пересобрал; добавил четвёртый аналог — в отчёте его нет.
  const list = (await spec.req('GET', `/api/orders/${o.id}/analogs`)).body.analogs;
  r = await spec.req('PUT', `/api/orders/${o.id}/analogs/${list[1].id}`, { fields: { ...list[1].fields, price_rub: 14700000 }, confirm: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id4 = (await add(o, 'https://www.cian.ru/sale/flat/409/')).body.id;
  await put(o, id4, png(40, 60));
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/analogs/${id4}`, { fields: { price_rub: 14900000, area: 53.5, listed_on: addDays(todayMsk(), -3), region: 'moscow', address: 'г. Москва, ул. Аналогов, 9' }, confirm: true })).status, 200);
  assert.deepEqual((await found()).filter((t) => /из дела|в деле подтверждено/.test(t)), [
    'Аналог 2 из дела (cian.ru): цена 14 700 000 руб. в отчёте не найдена — проверьте цену в таблице аналогов',
    'Аналог 4 из дела (cian.ru): ссылки на объявление в отчёте нет — добавьте его в таблицу аналогов или уберите из дела',
    'Аналог 4 из дела (cian.ru): цена 14 900 000 руб. в отчёте не найдена — проверьте цену в таблице аналогов',
    'Аналог 4 из дела (cian.ru): площадь 53,5 кв. м в отчёте не найдена — проверьте площадь в таблице аналогов',
  ]);
});

test('Word: картинки — PNG и JPEG по размеру из файла, по ширине страницы; в шаблоне организации тоже', () => {
  assert.deepEqual(imageSize(png(1080, 2400)), { ext: 'png', w: 1080, h: 2400 });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0x2c, 0x02, 0x58, 3, 1, 0x22, 0, 0xff, 0xd9]);
  assert.deepEqual(imageSize(jpeg), { ext: 'jpeg', w: 600, h: 300 });
  assert.equal(imageSize(Buffer.from('не картинка')), null);
  const appendix = { title: 'Приложение. Скриншоты объявлений (аналоги)', items: [{ title: 'Аналог 1 — cian.ru', lines: ['Ссылка: https://www.cian.ru/sale/flat/1/'], image: png(1080, 2400) }, { title: 'Аналог 2', lines: ['Без картинки'], image: Buffer.from('%PDF-1.4') }] };
  const meta = { title: 'Отчёт об оценке', number: '№ Т-1', date: '04.10.2026' };
  for (const tpl of [null, makeDocx(['Бланк организации', '{{ОТЧЁТ}}'])]) {
    const out = buildReport('## Раздел\nТекст', meta, tpl, { appendix });
    const s = out.toString('latin1');
    assert.ok(s.includes('word/media/delo1.png'));
    assert.ok(!s.includes('word/media/delo2'), 'неизвестная картинка не вставляется');
  }
});

// 2.37: в Word — ещё и фото осмотра приложением: по шагам, с временем получения и местом; картинки — в файле.
test('Word: фото осмотра — приложение «Фотоматериалы осмотра» по шагам, со временем и местом; потом скриншоты аналогов', async () => {
  const o = await inWork('vehicle', CAR, 'Машина: фото осмотра в Word');
  const r = await spec.req('POST', `/api/orders/${o.id}/inspection`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const token = r.body.path.split('#')[1];
  const anon = (await import('../helpers.mjs')).client(S);
  for (const [step, geo] of [['car_rear', {}], ['car_front', { 'x-lat': '55.7512', 'x-lon': '37.6184', 'x-accuracy': '12' }]]) {
    const up = await anon.req('POST', '/api/inspect/photos', png(640, 480), { raw: true, headers: { 'x-inspect-token': token, 'content-type': 'image/png', 'x-step': step, ...geo } });
    assert.equal(up.status, 201, JSON.stringify(up.body));
  }
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).status, 201);
  const w = await fetch(`${S.base}/api/orders/${o.id}/draft/docx`, { headers: { cookie: spec.cookie } });
  assert.equal(w.status, 200);
  const buf = Buffer.from(await w.arrayBuffer());
  const text = (await extractPages(buf, 'r.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).pages.join('\n');
  assert.match(text, /Приложение\. Фотоматериалы осмотра/);
  // По порядку шагов осмотра: сначала «Спереди», потом «Сзади», хотя сняты наоборот.
  assert.ok(text.indexOf('Фото 1 — Спереди') >= 0 && text.indexOf('Фото 1 — Спереди') < text.indexOf('Фото 2 — Сзади'), text.slice(-800));
  assert.match(text, /Получено платформой «БЕРТЕЛ Дело»: \d\d\.\d\d\.\d{4}/);
  assert.match(text, /Место съёмки: 55\.75120, 37\.61840 \(±12 м\)/);
  assert.match(text, /Место съёмки не определено/);
  const s = buf.toString('latin1');
  assert.ok(s.includes('word/media/delo1.png') && s.includes('word/media/delo2.png'), 'обе картинки в файле');
});

// 2.74: корректировки к аналогу — вид, значение в процентах, источник; цена после корректировок; предупреждения; Word.
test('корректировки: по порядку одна за другой, источник обязателен для спокойствия, снимают «нужна корректировка»; в Word — таблицей', async () => {
  const o = await inWork('realty', FLAT, 'Квартира: корректировки');
  const old = addDays(todayMsk(), -200);
  const ids = [];
  for (const [i, price] of [14000000, 14500000, 15000000].entries()) {
    const id = (await add(o, `https://www.cian.ru/sale/flat/74${i}/`)).body.id;
    await put(o, id, png(10, 10));
    const r = await spec.req('PUT', `/api/orders/${o.id}/analogs/${id}`, { fields: { price_rub: price, address: `г. Москва, ул. Поправок, ${i + 1}`, area: i === 0 ? 80 : 50, listed_on: i === 0 ? old : addDays(todayMsk(), -5), region: 'moscow' }, confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    ids.push(id);
  }
  let r = await spec.req('GET', `/api/orders/${o.id}/analogs`);
  assert.ok(r.body.adjust_kinds.some((k) => k.id === 'floor') && r.body.adjust_kinds.at(-1).id === 'other');
  let w = byId(r, ids[0]).warnings.join('\n');
  assert.match(w, /старше полугода/);
  assert.match(w, /Площадь, кв\. м: 80 у аналога/);
  assert.equal(byId(r, ids[0]).adjusted, null);

  // Неверные корректировки не принимаются, прежнее не меняется.
  const fields0 = byId(r, ids[0]).fields;
  for (const [adj, msg] of [
    [[{ kind: 'nope', pct: 1 }], /выберите вид/],
    [[{ kind: 'bargain', pct: 'много' }], /число процентов/],
    [[{ kind: 'bargain', pct: -95 }], /от −90 до 300/],
    [[{ kind: 'other', pct: 2 }], /что это за корректировка/],
    [[{ kind: 'bargain', pct: 1, year: 1900 }], /год справочника/],
    [Array.from({ length: 16 }, () => ({ kind: 'bargain', pct: 1 })), /не больше 15/],
    ['торг', /списком/],
  ]) {
    const bad = await spec.req('PUT', `/api/orders/${o.id}/analogs/${ids[0]}`, { fields: fields0, adjustments: adj, confirm: true });
    assert.equal(bad.status, 400, JSON.stringify(adj));
    assert.match(bad.body.message, msg);
  }
  // Торг −5 %, на дату +2,5 %, площадь +10 % (без таблицы), своя «Вид из окна» −1 %.
  const adj = [
    { kind: 'bargain', pct: '−5', book: 'Справочник оценщика недвижимости (Лейфер)', year: 2025, table: 'Табл. 12' },
    { kind: 'date', pct: '2,5', book: 'Индекс цен Росстата', year: '2026', table: '3' },
    { kind: 'area', pct: 10, book: 'Справочник оценщика недвижимости (Лейфер)', year: 2025 },
    { kind: 'other', name: 'Вид из окна', pct: '-1 %', book: 'Анализ рынка эксперта', year: 2026, table: '—' },
  ];
  r = await spec.req('PUT', `/api/orders/${o.id}/analogs/${ids[0]}`, { fields: fields0, adjustments: adj, confirm: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a0 = byId(r, ids[0]);
  assert.deepEqual(a0.adjustments.map((x) => x.pct), [-5, 2.5, 10, -1]);
  assert.equal(a0.adjustments[0].table, 'Табл. 12');
  assert.equal(a0.adjustments[3].name, 'Вид из окна');
  // 14 000 000 × 0,95 × 1,025 × 1,10 × 0,99 = 14 845 792,5 → 14 845 793; всего +6,04 %; за кв. м — 185 572.
  assert.deepEqual(a0.adjusted, { pct: 6.04, price: 14845793, per_sqm: 185572 });
  assert.ok(a0.confirmed);
  w = a0.warnings.join('\n');
  assert.doesNotMatch(w, /старше полугода|Площадь, кв\. м: 80/, 'корректировки на дату и площадь сняли предупреждения');
  assert.match(w, /Корректировка «Площадь \(масштаб\)»: укажите таблицу/);
  assert.doesNotMatch(w, /«Торг»|«На дату/);
  // Сохранили признаки без adjustments — корректировки остаются.
  r = await spec.req('PUT', `/api/orders/${o.id}/analogs/${ids[0]}`, { fields: fields0, confirm: true });
  assert.equal(byId(r, ids[0]).adjustments.length, 4);
  // Слишком большая общая корректировка — предупреждение.
  r = await spec.req('PUT', `/api/orders/${o.id}/analogs/${ids[1]}`, { fields: byId(r, ids[1]).fields, adjustments: [{ kind: 'finish', pct: 40, book: 'Лейфер', year: 2025, table: '20' }], confirm: true });
  assert.match(byId(r, ids[1]).warnings.join('\n'), /Корректировки всего \+40 % — больше 30 %/);
  // Диспетчер видит, но не меняет.
  assert.equal((await dispatcher.req('GET', `/api/orders/${o.id}/analogs`)).body.analogs.length, 3);
  assert.equal((await dispatcher.req('PUT', `/api/orders/${o.id}/analogs/${ids[2]}`, { fields: {}, adjustments: [] })).status, 403);

  // Черновик: модель получает корректировки и цену после них. Word: столбцы итога и таблица корректировок.
  S.providers.ai.reset();
  const d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).body.draft;
  assert.match(S.providers.ai.calls.at(-1).args.messages.at(-1).content, /Аналог 1: .*корректировки — Торг −5 % \(Справочник оценщика недвижимости \(Лейфер\), 2025 г\., табл\. 12\).*цена после корректировок — 14 845 793 руб\./);
  const fill = (t) => t.replace(/\[(?:заполнить|описать)[^\]]*\]/g, 'заполнено экспертом');
  await spec.req('PUT', `/api/orders/${o.id}/draft`, { body: fill(d.body), from: d.id });
  const res = await fetch(`${S.base}/api/orders/${o.id}/draft/docx`, { headers: { cookie: spec.cookie } });
  const text = (await extractPages(Buffer.from(await res.arrayBuffer()), 'r.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).pages.join('\n');
  for (const s of ['Цена после корректировок, руб.', 'За кв. м после корректировок, руб.', '14 845 793', '185 572', '+6,04 %',
    'Корректировки к аналогам (применяются по порядку, одна за другой):', 'Вид из окна', 'Индекс цен Росстата, 2026 г., табл. 3', '+40 %']) {
    assert.ok(text.includes(s), `в Word нет «${s}»`);
  }
});
