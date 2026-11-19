// Задача 2.549 (машино-место или кладовая): в «Что оцениваем» — «Машино-место или кладовая»; в заявке что именно, паркинг,
// уровень, номер места, как оформлено (отдельный объект или доля в праве на паркинг), размер доли, вместе ли с квартирой
// (необязательные); подсказка в деле; строкой «Из заявки: …» — в «7. Описание объекта оценки». Номера +7 999 000-60-11…13 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { FACTS_HEAD, factsLine } from '../../src/orders/facts.mjs';
import { PARKING_ASSUME_HEAD, PARKING_TASK_HEAD, parkingAssumption, parkingNotices, parkingTaskLine, placeParkingAssumption, placeParkingTask } from '../../src/orders/parking.mjs';
import { createRegistry } from '../../src/modules/index.mjs';

const P = { parking_kind: 'space', parking_type: 'underground', parking_level: '−2', parking_number: '17', parking_right: 'own', parking_with_flat: 'yes' };
const LINE = `${FACTS_HEAD} что именно — машино-место; паркинг — подземный; уровень — −2; номер места — 17; как оформлено — отдельный объект (своя выписка ЕГРН); вместе с квартирой — да, с квартирой в этом доме.`;

test('подсказки и строка «Из заявки»', () => {
  const ids = (f) => parkingNotices('realty', f).map((n) => n.id);
  assert.deepEqual(ids({ object_type: 'flat' }), [], 'квартира без сведений о месте — молчим');
  assert.deepEqual(ids({ object_type: 'flat', parking_number: '17' }), ['parking_extra'], 'квартира и место — два объекта');
  assert.deepEqual(ids({ object_type: 'ddu', parking_kind: 'space' }), ['parking_extra']);
  assert.deepEqual(ids({ object_type: 'house', parking_kind: 'space' }), ['parking_check']);
  assert.deepEqual(ids({ object_type: 'parking' }), ['parking_object', 'parking_number']);
  assert.deepEqual(ids({ object_type: 'parking', ...P }), ['parking_object', 'parking_flat']);
  assert.deepEqual(ids({ object_type: 'parking', ...P, parking_with_flat: 'no' }), ['parking_object']);
  assert.deepEqual(ids({ object_type: 'parking', ...P, parking_right: 'share' }), ['parking_share', 'parking_share_size', 'parking_flat']);
  assert.deepEqual(ids({ object_type: 'parking', ...P, parking_right: 'share', parking_share: '1/120' }), ['parking_share', 'parking_flat']);
  const text = (f) => parkingNotices('realty', f)[0].text;
  assert.match(text({ object_type: 'parking', ...P }), /отдельный объект недвижимости \(ст\. 130 ГК РФ/);
  assert.match(text({ object_type: 'parking', ...P, parking_right: 'share', parking_share: '1/120' }), /доля в праве на паркинг \(1\/120\), а не машино-место/);
  assert.match(text({ object_type: 'parking', parking_kind: 'storage' }), /Кладовая — нежилое помещение/);
  assert.match(parkingNotices('realty', { object_type: 'parking', parking_kind: 'storage' })[1].text, /номер кладовой/);
  assert.deepEqual(parkingNotices('vehicle', { object_type: 'parking' }), []);

  const registry = createRegistry();
  const fields = registry.service('expertise', 'realty').fields;
  assert.ok(fields.find((f) => f.id === 'object_type').options.some((o) => o.id === 'parking' && o.name === 'Машино-место или кладовая'));
  const sec = registry.draftSections('expertise', 'realty').find((s) => s.facts);
  assert.equal(factsLine(fields, sec.facts, P), LINE);
  assert.match(factsLine(fields, sec.facts, { parking_right: 'share', parking_share: '1/120' }), /как оформлено — доля в праве на паркинг; размер доли — 1\/120\.$/);
});

let S, owner, dispatcher, spec;
const BASE = { purpose: 'bank', region: 'moscow', object_type: 'parking', address: 'г. Москва, ул. Тестовая, д. 5, машино-место 17', area: 13.3 };
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990006011');
  dispatcher = await login(S, '+79990006012');
  spec = await login(S, '+79990006013');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

test('поля необязательны и проверяются; подсказка в деле; строка — в черновике от ИИ', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Машино-место для ипотеки' })).body.order;
  const patch = (fields) => owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields });
  assert.equal((await patch(BASE)).status, 200, 'без новых полей — как раньше');
  assert.deepEqual((await owner.req('GET', `/api/orders/${o.id}`)).body.notices.map((n) => n.id), ['parking_object', 'parking_number']);
  for (const wrong of [{ parking_kind: 'garage' }, { parking_right: 'rent' }, { parking_number: 'x'.repeat(21) }, { parking_level: 'x'.repeat(21) }]) {
    assert.equal((await patch({ ...BASE, ...wrong })).status, 400, JSON.stringify(wrong));
  }
  assert.equal((await patch({ ...BASE, ...P })).status, 200);
  assert.deepEqual((await owner.req('GET', `/api/orders/${o.id}`)).body.notices.map((n) => n.id), ['parking_object', 'parking_flat']);

  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);
  assert.deepEqual((await spec.req('GET', `/api/orders/${o.id}`)).body.notices.map((n) => n.id), ['parking_object', 'parking_flat'], 'эксперт видит ту же подсказку');

  const r = await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const lines = r.body.draft.body.split('\n');
  const h = lines.findIndex((l) => /^#{1,3}\s*7\. Описание объекта оценки/.test(l));
  assert.ok(h >= 0, r.body.draft.body.slice(0, 400));
  assert.equal(lines[h + 1], LINE);
  assert.equal(lines.filter((l) => l.startsWith(FACTS_HEAD)).length, 1);
  // 2.551: объект и права — в «Задание на оценку», границы места — в раздел допущений; по одной строке.
  const t = lines.findIndex((l) => /^#{1,3}\s*2\. Задание на оценку/.test(l));
  assert.equal(lines[t + 1], parkingTaskLine('realty', { ...BASE, ...P }));
  const a = lines.findIndex((l) => /^#{1,3}\s*5\. Допущения/.test(l));
  assert.equal(lines[a + 1], parkingAssumption('realty', { ...BASE, ...P }));
  assert.equal(lines.filter((l) => l.startsWith(PARKING_TASK_HEAD)).length, 1);
  assert.equal(lines.filter((l) => l.startsWith(PARKING_ASSUME_HEAD)).length, 1);
  const [{ inputs }] = await S.sql`select inputs from result_drafts where order_id = ${o.id} order by id desc limit 1`;
  assert.equal(inputs.parking, true);
});

test('2.551: строка «Объект оценки в паркинге» и допущение о границах — только у машино-места, заменяются, пропуски — [заполнить]', () => {
  const own = parkingTaskLine('realty', { object_type: 'parking', ...P });
  assert.equal(own, `${PARKING_TASK_HEAD} машино-место № 17 (подземный паркинг, уровень −2) — отдельный объект недвижимости (ст. 130 ГК РФ). Оцениваемые права — право собственности на машино-место; номер, уровень и площадь — по выписке ЕГРН. Вид стоимости — рыночная стоимость. Оценивается вместе с квартирой в этом доме: стоимость каждого объекта определяется отдельно, общая — суммой.`);
  const share = parkingTaskLine('realty', { object_type: 'parking', ...P, parking_right: 'share', parking_share: '1/120', parking_with_flat: 'no' });
  assert.equal(share, `${PARKING_TASK_HEAD} доля 1/120 в праве общей долевой собственности на нежилое помещение (паркинг) (подземный паркинг, уровень −2); по порядку пользования за долей закреплено машино-место № 17. Оцениваемые права — право общей долевой собственности (доля в праве), не право собственности на машино-место как отдельный объект. Вид стоимости — рыночная стоимость.`);
  assert.match(parkingTaskLine('realty', { object_type: 'parking', parking_right: 'share' }), /доля \[заполнить\] в праве .*закреплено машино-место № \[заполнить\]\./);
  assert.match(parkingTaskLine('realty', { object_type: 'parking', parking_kind: 'storage', parking_number: '4' }), /нежилое помещение — кладовая № 4\. Оцениваемые права — право собственности на нежилое помещение;/);
  assert.match(parkingTaskLine('realty', { object_type: 'parking', parking_kind: 'storage', parking_right: 'share' }), /закреплена кладовая № \[заполнить\]/);
  assert.match(parkingTaskLine('realty', { object_type: 'parking' }, 'ликвидационная стоимость'), /Вид стоимости — ликвидационная стоимость \(по заданию на оценку\)\.$/);
  for (const [s, f] of [['realty', { object_type: 'flat', ...P }], ['land', { object_type: 'parking' }], ['realty', {}]]) {
    assert.equal(parkingTaskLine(s, f), null);
    assert.equal(parkingAssumption(s, f), null);
  }
  assert.match(parkingAssumption('realty', { object_type: 'parking' }), /границы машино-места приняты по разметке на полу паркинга/);
  assert.match(parkingAssumption('realty', { object_type: 'parking', parking_kind: 'storage' }), /границы кладовой приняты по поэтажному плану/);
  assert.match(parkingAssumption('realty', { object_type: 'parking', parking_right: 'share' }), /доля в праве на паркинг в натуре не выделена; место определено по порядку пользования/);

  const sections = [{ title: '2. Задание на оценку', table: 'task' }, { title: '5. Допущения и ограничительные условия' }];
  const body = '## 2. Задание на оценку\nтекст\n## 5. Допущения и ограничительные условия\nабзац';
  const assume = parkingAssumption('realty', { object_type: 'parking' });
  const once = placeParkingAssumption(placeParkingTask(body, sections, own), sections, assume);
  assert.equal(once.split('\n')[1], own);
  assert.equal(once.split('\n')[4], assume);
  const twice = placeParkingTask(once, sections, share);
  assert.equal(twice.split('\n').filter((l) => l.startsWith(PARKING_TASK_HEAD)).length, 1, 'прежняя строка заменяется');
  assert.equal(twice.split('\n')[1], share);
  assert.equal(placeParkingTask(body, sections, null), body);
});

// 2.550: запрос документов — выписка ЕГРН на машино-место (или на долю в паркинге) и документ о праве остаются; техпаспорта
// квартиры нет; план паркинга с местом; при доле — порядок пользования местами; вместе с квартирой — выписка и на квартиру.
test('2.550: перечень документов по машино-месту', () => {
  const registry = createRegistry();
  const ids = (f) => registry.requestDocs('expertise', 'realty', null, f).map((c) => c.id);
  assert.deepEqual(ids({ object_type: 'parking' }), ['egrn', 'title_deed', 'parking_plan', 'encumbrance']);
  assert.deepEqual(ids({ object_type: 'parking', parking_right: 'share' }), ['egrn', 'title_deed', 'parking_plan', 'parking_use', 'encumbrance']);
  assert.deepEqual(ids({ object_type: 'parking', parking_with_flat: 'yes' }), ['egrn', 'title_deed', 'parking_plan', 'parking_flat_egrn', 'encumbrance']);
  assert.ok(!ids({ object_type: 'parking', parking_with_flat: 'no' }).includes('parking_flat_egrn'));
  const flat = ids({ object_type: 'flat', parking_right: 'share', parking_with_flat: 'yes' });
  assert.ok(flat.includes('tech_plan'), 'у квартиры техпаспорт остаётся');
  for (const id of ['parking_plan', 'parking_use', 'parking_flat_egrn']) assert.ok(!flat.includes(id), `${id} — не у квартиры`);
  const plan = registry.requestDocs('expertise', 'realty', null, { object_type: 'parking' }).find((c) => c.id === 'parking_plan');
  assert.match(plan.hint, /номер, уровень и границы места/);
});

test('2.550: в деле эксперт запрашивает план паркинга и порядок пользования; старая выписка на место — «запросите свежую»', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Машино-место: документы' })).body.order;
  const F = { ...BASE, ...P, parking_right: 'share', parking_share: '1/120' };
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: F })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);

  const list = async (c = spec) => (await c.req('GET', `/api/orders/${o.id}/doc-requests`)).body;
  const cat = (await list()).catalog.map((c) => c.id);
  assert.deepEqual(cat.filter((x) => x !== 'bank_task'), ['egrn', 'title_deed', 'parking_plan', 'parking_use', 'parking_flat_egrn', 'encumbrance']);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['tech_plan'] })).status, 400, 'техпаспорта квартиры нет');
  const res = await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['egrn', 'parking_plan', 'parking_use'] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const mine = await list(owner);
  assert.ok(mine.requests.some((x) => x.item_id === 'parking_use' && /закреплено/.test(x.hint ?? '')), JSON.stringify(mine.requests));

  const ru = (iso) => iso.split('-').reverse().join('.');
  const body = `Выписка из Единого государственного реестра недвижимости\n${ru(addDays(todayMsk(), -60))} № КУВИ-001/2026-6011001\nМашино-место № 17`;
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(body), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('Выписка на машино-место.txt') } })).status, 201);
  assert.ok((await list()).egrn_old, 'выписка на само место старше 30 дней — запросить свежую');
});
