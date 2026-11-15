// Задача 2.507 (справка для нотариуса): Word из отчёта об оценке для наследства — объект, дата открытия наследства и дата
// оценки, рыночная стоимость цифрами и прописью, номер и дата отчёта, оценщик; заказчик скачивает после выдачи.
// Номера +7 999 000-53-51…54 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, signResults } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { extractPages } from '../../src/ai/extract.mjs';
import { heirValues } from '../../src/ai/report-checks.mjs';
import { rubText } from '../../src/docs/heir-note.mjs';

let S, owner, dispatcher, spec, other;
const HEIR = { purpose: 'inheritance', region: 'moscow', object_type: 'flat', address: 'г. Москва, Тестовая ул., д. 7, кв. 3', area: '44',
  death_date: '03.06.2026', notary: 'нотариус г. Москвы Тестова Т. Т., дело № 12/2026' };
const REPORT = [
  'ОТЧЁТ ОБ ОЦЕНКЕ № 507/2026 от 10.11.2026',
  'Объект оценки: квартира, г. Москва, Тестовая ул., д. 7, кв. 3',
  'Дата оценки: 03.06.2026',
  'Итоговая рыночная стоимость объекта оценки составляет 8 450 000 руб.',
].join('\n');

before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005351');
  dispatcher = await login(S, '+79990005352');
  spec = await login(S, '+79990005353');
  other = await login(S, '+79990005354');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id);
});
after(async () => { await S?.close(); });

async function step(c, o, to) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status });
}
const upload = (o, text) => spec.req('POST', `/api/orders/${o.id}/results`, Buffer.from(text), {
  raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('Отчёт.txt') },
});
const note = async (c, o) => {
  const r = await fetch(`${S.base}/api/orders/${o.id}/heir-note`, { headers: { cookie: c.cookie } });
  if (r.status !== 200) return { status: r.status, body: await r.json() };
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: 200, name: decodeURIComponent(r.headers.get('content-disposition').split("''")[1]),
    text: (await extractPages(buf, 'a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).pages.join('\n') };
};
const flag = async (c, o) => (await c.req('GET', `/api/orders/${o.id}/documents`)).body.heir_note === true;

async function inWork(title, fields, report) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields })).status, 200);
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  if (report) assert.equal((await upload(o, report)).status, 201);
  return o;
}
async function finish(o) {
  await signResults(S, spec, o.id);
  assert.equal((await step(spec, o, 'review')).status, 200);
  const rv = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
  assert.equal((await step(dispatcher, o, 'done')).status, 200);
}

test('сумма цифрами и прописью', () => {
  assert.equal(rubText(8_450_000), '8 450 000 (Восемь миллионов четыреста пятьдесят тысяч) рублей');
  assert.equal(rubText(1_021), '1 021 (Одна тысяча двадцать один) рубль');
  assert.equal(rubText(32_000_003), '32 000 003 (Тридцать два миллиона три) рубля');
});

test('справка для нотариуса: заказчик — после выдачи, эксперт — сразу; стоимость, номер и даты — из отчёта', async () => {
  const o = await inWork('Квартира: справка нотариусу', HEIR, REPORT);
  assert.equal(await flag(spec, o), true, 'эксперт видит справку, как только есть файл отчёта');
  assert.equal(await flag(owner, o), false, 'заказчик — не до выдачи');
  assert.equal((await note(owner, o)).status, 409);
  assert.equal((await note(other, o)).status, 404, 'чужой — не видит дела');
  const pre = await note(spec, o);
  assert.equal(pre.status, 200);
  await finish(o);
  assert.equal(await flag(owner, o), true);
  const r = await note(owner, o);
  assert.equal(r.status, 200);
  assert.equal(r.name, 'Справка для нотариуса 507-2026.docx');
  for (const want of ['Справка об оценке для нотариуса', '№ 507/2026 от 10.11.2026', 'г. Москва, Тестовая ул., д. 7, кв. 3',
    'Дата открытия наследства', '03.06.2026', 'Тестова Т. Т., дело № 12/2026', 'Рыночная',
    '8 450 000 (Восемь миллионов четыреста пятьдесят тысяч) рублей', 'Тестовый Эксперт', 'не заменяет']) {
    assert.ok(r.text.includes(want), `в справке есть «${want}»:\n${r.text}`);
  }
  assert.equal((await note(dispatcher, o)).status, 200, 'диспетчер — тоже');
  const [a] = await S.sql`select count(*)::int as n from audit_log where action = 'heir.note' and subject_id = ${o.id}`;
  assert.ok(a.n >= 3);
});

test('справка: не наследство — нет; в отчёте нет стоимости — понятный отказ', async () => {
  const bank = await inWork('Квартира: банк', { ...HEIR, purpose: 'bank', death_date: '' }, REPORT);
  assert.equal(await flag(spec, bank), false);
  assert.equal((await note(spec, bank)).status, 409);
  const empty = await inWork('Квартира: без стоимости', HEIR, null);
  assert.equal(await flag(spec, empty), false, 'файла отчёта нет — справки нет');
  assert.equal((await upload(empty, 'ОТЧЁТ ОБ ОЦЕНКЕ № 1\nОписание объекта')).status, 201);
  const r = await note(spec, empty);
  assert.equal(r.status, 409);
  assert.match(r.body.message, /не нашлась рыночная стоимость/);
});

test('несколько объектов наследства: стоимость каждого и общая — таблицей', async () => {
  const fields = { ...HEIR, heir_objects: 'Гараж, ГСК «Ромашка», бокс 12\nЛада Веста, 2019', heir_total: 'total' };
  const text = [
    'ОТЧЁТ ОБ ОЦЕНКЕ № 508/2026 от 11.11.2026',
    'Рыночная стоимость квартиры составляет 8 000 000 руб.',
    'Гараж, ГСК «Ромашка», бокс 12 — 450 000 руб.',
    'Лада Веста, 2019 — 900 000 руб.',
    'Общая рыночная стоимость: 9 350 000 руб.',
  ].join('\n');
  const docs = [{ name: 'Отчёт.txt', pages: [text], text }];
  const v = heirValues(docs, 'realty', fields);
  assert.deepEqual(v.rows.map((x) => x.value_rub), [8_000_000, 450_000, 900_000]);
  assert.equal(v.total, 9_350_000);
  assert.equal(heirValues(docs, 'realty', HEIR), null, 'других объектов нет');
  const o = await inWork('Квартира и гараж: справка', fields, text);
  const r = await note(spec, o);
  assert.equal(r.status, 200);
  for (const want of ['Рыночная стоимость по объектам', '1) г. Москва, Тестовая ул., д. 7, кв. 3', 'Гараж, ГСК «Ромашка», бокс 12',
    '450 000 (Четыреста пятьдесят тысяч) рублей', '900 000 (Девятьсот тысяч) рублей', 'Общая рыночная стоимость',
    '9 350 000 (Девять миллионов триста пятьдесят тысяч) рублей']) {
    assert.ok(r.text.includes(want), `в справке есть «${want}»:\n${r.text}`);
  }
});
