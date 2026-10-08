// Повторная оценка того же объекта (2.118): эксперт в новом деле берёт из своего прошлого дела с тем же объектом описание
// объекта (приметы объекта остаются, данные прошлого заказчика вычищаются), аналоги (копия, без подтверждения) и запрос тех же
// документов у нового заказчика. Чужое дело, другой объект, другая услуга — «не найдено»; файлы прошлого заказчика не переходят.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { compareObject, objectKey } from '../../src/orders/repeat.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import { PAST_MARK } from '../../src/docs/reuse.mjs';

let S, owner1, owner2, dispatcher, spec, other;
const today = todayMsk();
const OBJ = { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, ул. Ленина, д. 5, кв. 12', cadastral: '77:01:0001001:1234', area: '45.5', floor: '5 / 9' };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('repeat-analog-screen')]);

before(async () => {
  S = await startApp();
  owner1 = await login(S, '+79990003701');
  owner2 = await login(S, '+79990003702');
  dispatcher = await login(S, '+79990003703');
  spec = await login(S, '+79990003704');
  other = await login(S, '+79990003705');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await owner1.req('PATCH', '/api/me', { full_name: 'Иванов Иван Петрович' });
  for (const c of [spec, other]) await makeSpecialist(S.sql, c.user.id, { permits: [['expertise', 'realty'], ['expertise', 'land']] });
});
after(async () => { await S?.close(); });

async function inWork(owner, fields, { who = spec, service = 'realty', title = 'Оценка квартиры' } = {}) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service, title })).body.order;
  const r = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(today, 9), fields });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: who.user.id, from: 'matching' })).status, 200);
  assert.equal((await who.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  return o;
}

const PAST_DRAFT = [
  '## 3. Общие сведения: основание, заказчик, номер и дата отчёта',
  'Заказчик — Иванов Иван Петрович, договор от прошлого раза.',
  '## 7. Описание объекта оценки',
  'Квартира по адресу г. Москва, ул. Ленина, д. 5, кв. 12, кадастровый номер 77:01:0001001:1234, площадь 45.5 кв. м, этаж 5 / 9.',
  'Собственник — Иванов Иван Петрович, тел. +7 999 000 12 34. Ремонт косметический, санузел раздельный.',
  '## 8. Местоположение и анализ рынка',
  'Дом в пяти минутах от метро, рядом школа и парк. Средняя цена предложения — 350 000 руб. за кв. м.',
].join('\n');

test('узнавание объекта: адрес без «г.», «ул.», «д.»; кадастровый номер; хотя бы одно совпало и ни одно не расходится', () => {
  assert.equal(objectKey('address', 'г. Москва, ул. Ленина, д. 5, кв. 12'), objectKey('address', 'Москва, Ленина 5, кв 12'));
  assert.equal(objectKey('address', 'ул. Ленина, д. 5к2'), objectKey('address', 'Ленина 5 к 2'));
  assert.notEqual(objectKey('address', 'Ленина 5, кв 12'), objectKey('address', 'Ленина 5, кв 15'));
  const spec = createRegistry().repeat('expertise', 'realty');
  const f = (fields) => ({ fields });
  assert.equal(compareObject(spec, f({ address: 'Ленина 5' }), f({ address: 'г. Москва, Ленина, д. 5' })).same, true);
  assert.equal(compareObject(spec, f({ address: 'Ленина 5', cadastral: '77:01:1:1' }), f({ address: 'Ленина 5', cadastral: '77:01:1:2' })).same, false, 'кадастровый расходится');
  assert.equal(compareObject(spec, f({ address: 'Ленина 5', cadastral: '77:01:1:1' }), f({ address: 'Ленина 5' })).same, true, 'в новом деле номера нет — по адресу');
  assert.equal(compareObject(spec, f({}), f({ address: 'Ленина 5' })).same, false);
  assert.equal(createRegistry().repeat('expertise', 'goods'), null, 'у товароведческой повторной оценки нет');
});

test('описание модуля: repeat с чужим полем, чужим разделом или методическим разделом — ошибка', async () => {
  const { default: expertise } = await import('../../src/modules/expertise.mjs');
  const bad = (repeat) => () => createRegistry([{ ...structuredClone(expertise), repeat }]);
  assert.throws(bad([{ services: ['realty'], match: ['vin'], sections: ['r_object'] }]), /match/);
  assert.throws(bad([{ services: ['realty'], match: ['area'], sections: ['r_object'] }]), /match/, 'число — не примета');
  assert.throws(bad([{ services: ['realty'], match: ['address'], sections: ['v_object'] }]), /раздела v_object нет/);
  assert.throws(bad([{ services: ['realty'], match: ['address'], sections: ['r_standards'] }]), /не методический/);
  assert.throws(bad([{ services: ['realty'], match: ['address'], sections: ['r_object'] }, { services: ['realty'], match: ['address'], sections: ['r_object'] }]), /в одном описании/);
});

test('эксперт берёт из своего прошлого дела описание объекта, аналоги и документы — данные прошлого заказчика не переходят', async () => {
  // Прошлое дело: черновик, аналог со скриншотом (подтверждён), запрос документов.
  const past = await inWork(owner1, OBJ, { title: 'Квартира Иванова на Ленина' });
  assert.equal((await spec.req('PUT', `/api/orders/${past.id}/draft`, { body: PAST_DRAFT, from: null })).status, 200);
  const a = (await spec.req('POST', `/api/orders/${past.id}/analogs`, { url: 'https://example.ru/flat/101?utm=1' })).body.id;
  assert.equal((await spec.req('POST', `/api/orders/${past.id}/analogs/${a}/file`, PNG, { raw: true, headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'a.png' } })).status, 200);
  const conf = await spec.req('PUT', `/api/orders/${past.id}/analogs/${a}`, { fields: { price_rub: '15 000 000', listed_on: addDays(today, -20), region: 'moscow', address: 'Москва, Ленина 7', area: '44' }, confirm: true });
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  const pastAnalog = (await S.sql`select * from order_analogs where id = ${a}`)[0];
  assert.equal((await spec.req('POST', `/api/orders/${past.id}/doc-requests`, { items: ['egrn', 'tech_plan'], custom: ['Справка Иванова о прописке'] })).status, 201);
  // Другой объект у того же эксперта и тот же объект у другого эксперта — не предлагаются.
  const elsewhere = await inWork(owner1, { ...OBJ, address: 'Москва, Пушкина 7', cadastral: '77:01:0001001:9999' });
  assert.equal((await spec.req('PUT', `/api/orders/${elsewhere.id}/draft`, { body: PAST_DRAFT, from: null })).status, 200);
  const foreign = await inWork(owner1, OBJ, { who: other });
  assert.equal((await other.req('PUT', `/api/orders/${foreign.id}/draft`, { body: PAST_DRAFT, from: null })).status, 200);

  // Новое дело: другой заказчик, тот же объект (адрес написан иначе), площадь после перепланировки другая.
  const o = await inWork(owner2, { ...OBJ, purpose: 'bank', address: 'Москва, Ленина 5, кв 12', area: '47.1' }, { title: 'Квартира для банка' });
  const base = `/api/orders/${o.id}/repeat`;
  let v = (await spec.req('GET', base)).body;
  assert.equal(v.cases.length, 1, JSON.stringify(v));
  const c = v.cases[0];
  assert.equal(c.id, past.id);
  assert.deepEqual(c.fields.map((x) => [x.id, x.same]), [['cadastral', true], ['address', true]]);
  assert.deepEqual(c.changed.map((x) => [x.label, x.past, x.now]), [['Площадь, кв. м', '45.5', '47.1']]);
  assert.deepEqual(c.sections, ['7. Описание объекта оценки', '8. Местоположение и анализ рынка']);
  assert.equal(c.analogs, 1);
  assert.deepEqual(c.docs, ['Выписка из ЕГРН', 'Технический паспорт БТИ или поэтажный план']);
  // Заказчик, диспетчер и другой эксперт прошлых дел эксперта не видят.
  for (const who of [owner2, dispatcher]) assert.deepEqual((await who.req('GET', base)).body, { cases: [] });
  assert.equal((await other.req('GET', base)).status, 404);

  // Чужое, другой объект, мусор — «не найдено»; ничего не отмечено — ошибка.
  for (const id of [foreign.id, elsewhere.id, o.id, 'x', null]) {
    assert.equal((await spec.req('POST', base, { past_id: id, take: { analogs: true } })).status, 404, String(id));
  }
  assert.equal((await spec.req('POST', base, { past_id: past.id, take: {} })).body.error, 'nothing_selected');
  assert.equal((await spec.req('POST', base, { past_id: past.id, take: { analogs: 'да' } })).body.error, 'bad_input');

  // Описание объекта — новой версией черновика.
  let r = await spec.req('POST', base, { past_id: past.id, from: null, take: { sections: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.taken.sections, ['7. Описание объекта оценки', '8. Местоположение и анализ рынка']);
  const d = (await spec.req('GET', `/api/orders/${o.id}/draft`)).body.draft;
  assert.equal(d.source, 'past');
  assert.ok(d.body.includes('77:01:0001001:1234'), 'кадастровый номер того же объекта остаётся');
  assert.ok(d.body.includes('ул. Ленина'), 'адрес остаётся');
  assert.ok(d.body.includes('санузел раздельный'), 'описание остаётся');
  assert.ok(d.body.includes('рядом школа и парк'));
  for (const gone of ['Иванов', '+7 999', '45.5', '350 000']) assert.ok(!d.body.includes(gone), `${gone} вычищено`);
  assert.ok(d.body.includes(PAST_MARK));
  assert.ok(!d.body.includes('договор от прошлого раза'), 'раздел «Общие сведения» не берётся');
  // Версию видел старую — «уже изменился».
  assert.equal((await spec.req('POST', base, { past_id: past.id, from: null, take: { sections: true } })).body.error, 'draft_changed');

  // Аналоги: копия со скриншотом, отпечаток и время получения прежние, подтверждения нет; файл — свой.
  r = await spec.req('POST', base, { past_id: past.id, take: { analogs: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.taken.analogs, 1);
  const list = (await spec.req('GET', `/api/orders/${o.id}/analogs`)).body.analogs;
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].url, list[0].confirmed, list[0].copied, list[0].fields.price_rub], ['https://example.ru/flat/101?utm=1', false, true, pastAnalog.fields.price_rub]);
  const copy = (await S.sql`select * from order_analogs where order_id = ${o.id}`)[0];
  assert.notEqual(copy.file_key, pastAnalog.file_key);
  assert.equal(copy.file_sha256, pastAnalog.file_sha256);
  assert.equal(copy.received_at.getTime(), pastAnalog.received_at.getTime());
  assert.equal(String(copy.copied_from), String(pastAnalog.id));
  assert.ok((await S.providers.storage.get(copy.file_key))?.equals(PNG), 'скриншот скопирован');
  // Повтор — брать нечего (ссылка уже в деле).
  assert.equal((await spec.req('POST', base, { past_id: past.id, take: { analogs: true } })).body.error, 'nothing_to_take');

  // Документы: запрос тех же из списка услуги новому заказчику; своя строка прошлого дела не переходит.
  const before = (await S.sql`select count(*)::int as n from notifications where user_id = ${owner2.user.id} and event = 'docs_requested'`)[0].n;
  r = await spec.req('POST', base, { past_id: past.id, take: { docs: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const reqs = (await owner2.req('GET', `/api/orders/${o.id}/doc-requests`)).body.requests;
  assert.deepEqual(reqs.map((x) => x.title), ['Выписка из ЕГРН', 'Технический паспорт БТИ или поэтажный план']);
  assert.equal((await S.sql`select count(*)::int as n from notifications where user_id = ${owner2.user.id} and event = 'docs_requested'`)[0].n, before + 1);
  assert.equal((await S.sql`select count(*)::int as n from documents where order_id = ${o.id}`)[0].n, 0, 'файлы прошлого заказчика не переходят');
  // Всё взято — дело больше не предлагается, кроме описания (его можно взять снова поверх своей правки).
  v = (await spec.req('GET', base)).body;
  assert.deepEqual([v.cases[0]?.analogs, v.cases[0]?.docs], [0, []]);
  assert.equal((await spec.req('POST', base, { past_id: past.id, take: { docs: true, analogs: true } })).body.error, 'nothing_to_take');

  const audit = await S.sql`select count(*)::int as n from audit_log where action = 'order.repeat' and subject_id = ${o.id}`;
  assert.equal(audit[0].n, 3);
});
