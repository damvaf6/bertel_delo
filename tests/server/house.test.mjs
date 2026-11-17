// Задача 2.529 (жилой дом): в заявке на оценку недвижимости — материал стен, участок под домом, его кадастровый номер и
// площадь, газ, для круглогодичного проживания (необязательные); подсказка в деле — участок в собственности: оценить дом и
// участок, не указан номер участка, участок в аренде, не оформлен — уточнить, летний дом для банка; строкой «Из заявки: …» —
// в «7. Описание объекта оценки». Номера +7 999 000-59-01…03 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { FACTS_HEAD, factsLine } from '../../src/orders/facts.mjs';
import { houseNotices } from '../../src/orders/house.mjs';
import { createRegistry } from '../../src/modules/index.mjs';

const LINE = `${FACTS_HEAD} материал стен — кирпич, блоки; участок под домом — оформлен в собственность; кадастровый номер участка — 50:20:0010101:55; площадь участка — 12 сот.; газ — магистральный; для круглогодичного проживания — да, отапливается зимой.`;

test('подсказки и строка «Из заявки»', () => {
  const ids = (f) => houseNotices('realty', f).map((n) => n.id);
  assert.deepEqual(ids({ object_type: 'flat' }), [], 'квартира без сведений о доме — молчим');
  assert.deepEqual(ids({ object_type: 'flat', house_gas: 'main' }), ['house_type']);
  assert.deepEqual(ids({ object_type: 'house' }), ['house_land_ask']);
  assert.deepEqual(ids({ object_type: 'house', house_land: 'none' }), ['house_land_ask']);
  assert.deepEqual(ids({ object_type: 'house', house_land: 'own', land_cadastral: '50:20:0010101:55' }), ['house_land_own']);
  assert.deepEqual(ids({ object_type: 'house', house_land: 'own' }), ['house_land_own', 'house_land_cad']);
  assert.deepEqual(ids({ object_type: 'house', house_land: 'lease' }), ['house_land_lease']);
  assert.deepEqual(ids({ object_type: 'house', house_land: 'lease', purpose: 'bank', house_winter: 'no' }), ['house_land_lease', 'house_bank']);
  assert.deepEqual(ids({ object_type: 'house', house_land: 'lease', purpose: 'deal', house_winter: 'no' }), ['house_land_lease'], 'летний не для банка — молчим');
  assert.match(houseNotices('realty', { object_type: 'house', house_land: 'own' })[0].text, /единый объект \(ст\. 35 ЗК РФ\)/);
  assert.deepEqual(houseNotices('vehicle', { object_type: 'house' }), []);

  const registry = createRegistry();
  const fields = registry.service('expertise', 'realty').fields;
  const sec = registry.draftSections('expertise', 'realty').find((s) => s.facts);
  assert.equal(sec.id, 'r_object');
  const values = { house_walls: 'brick', house_land: 'own', land_cadastral: '50:20:0010101:55', land_area: 12, house_gas: 'main', house_winter: 'yes' };
  assert.equal(factsLine(fields, sec.facts, values), LINE);
  assert.equal(factsLine(fields, sec.facts, { land_area: 6.5 }), `${FACTS_HEAD} площадь участка — 6,5 сот.`);
});

let S, owner, dispatcher, spec;
const BASE = { purpose: 'bank', region: 'mo', object_type: 'house', address: 'Московская обл., д. Тестовая, ул. Садовая, д. 7', area: 120 };
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005901');
  dispatcher = await login(S, '+79990005902');
  spec = await login(S, '+79990005903');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

test('поля необязательны и проверяются; подсказка в деле; строка — в черновике от ИИ', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Дом для банка' })).body.order;
  const patch = (fields) => owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields });
  assert.equal((await patch(BASE)).status, 200, 'без новых полей — как раньше');
  assert.deepEqual((await owner.req('GET', `/api/orders/${o.id}`)).body.notices.map((n) => n.id), ['house_land_ask']);
  for (const wrong of [{ house_walls: 'glass' }, { house_land: 'yes' }, { land_cadastral: '12345' }, { land_area: 0 }, { land_area: 'много' }, { house_gas: 'coal' }, { house_winter: 'maybe' }]) {
    assert.equal((await patch({ ...BASE, ...wrong })).status, 400, JSON.stringify(wrong));
  }
  const all = { ...BASE, house_walls: 'brick', house_land: 'own', land_cadastral: '50:20:0010101:55', land_area: 12, house_gas: 'main', house_winter: 'yes' };
  assert.equal((await patch(all)).status, 200);
  assert.deepEqual((await owner.req('GET', `/api/orders/${o.id}`)).body.notices.map((n) => n.id), ['house_land_own']);

  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);
  assert.deepEqual((await spec.req('GET', `/api/orders/${o.id}`)).body.notices.map((n) => n.id), ['house_land_own'], 'эксперт видит ту же подсказку');

  const r = await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const lines = r.body.draft.body.split('\n');
  const h = lines.findIndex((l) => /^#{1,3}\s*7\. Описание объекта оценки/.test(l));
  assert.ok(h >= 0, r.body.draft.body.slice(0, 400));
  assert.equal(lines[h + 1], LINE);
  assert.equal(lines.filter((l) => l.startsWith(FACTS_HEAD)).length, 1);
});

// Задача 2.530: запрос документов по дому — выписка ЕГРН на участок (участок «не оформлен» — её нет), технический план или
// паспорт дома вместо поэтажного плана, договор аренды участка — только «в аренде»; выписка на участок старше 30 дней — как у
// дома: подсказка в деле и в «Сегодня», свежая на участок запрашивается её пунктом. Свежая на участок не прикрывает старую на дом.
test('2.530: перечень документов по дому', () => {
  const registry = createRegistry();
  const ids = (f) => registry.requestDocs('expertise', 'realty', null, f).map((c) => c.id);
  const flat = ids({ object_type: 'flat' });
  assert.ok(flat.includes('tech_plan'));
  for (const id of ['land_egrn', 'house_tech', 'land_lease']) assert.ok(!flat.includes(id), id);
  const house = ids({ object_type: 'house' });
  assert.ok(!house.includes('tech_plan'), 'у дома — техплан дома вместо поэтажного плана');
  assert.ok(house.includes('land_egrn') && house.includes('house_tech') && !house.includes('land_lease'));
  assert.ok(ids({ object_type: 'house', house_land: 'own' }).includes('land_egrn'));
  assert.ok(!ids({ object_type: 'house', house_land: 'none' }).includes('land_egrn'), 'участок не оформлен — выписки нет');
  const lease = ids({ object_type: 'house', house_land: 'lease' });
  assert.ok(lease.includes('land_lease') && lease.includes('land_egrn'));
  assert.ok(!ids({ object_type: 'commercial' }).includes('tech_plan'), 'нежилое — как раньше, поэтажный план');
});

test('2.530: выписка на участок под домом старше 30 дней — подсказка, «Сегодня» и запрос её пунктом', async () => {
  const ru = (iso) => iso.split('-').reverse().join('.');
  const today = todayMsk();
  const egrn = (day, kind) => `Выписка из Единого государственного реестра недвижимости об объекте недвижимости\n${ru(day)} № КУВИ-001/2026-5530${kind.length}\nВид объекта недвижимости: ${kind}`;
  const put = async (o, body, name) => (await owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(body), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) } })).body.document;
  const list = async (o, c = spec) => (await c.req('GET', `/api/orders/${o.id}/doc-requests`)).body;
  const todayRows = async () => (await spec.req('GET', '/api/today')).body.expert.egrn_old ?? [];
  const inWork = async (title, extra) => {
    const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(today, 10), fields: { ...BASE, ...extra } })).status, 200);
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
    await ensurePaid(S.sql, o.id);
    assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
    const [cur] = await S.sql`select status from orders where id = ${o.id}`;
    assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);
    return o;
  };

  // Свежая выписка на дом, старая на участок — подсказка про участок.
  const o = await inWork('Дом: старая выписка на участок', { house_land: 'own', land_cadastral: '50:20:0010101:55' });
  const r0 = await list(o);
  assert.ok(r0.catalog.some((c) => c.id === 'land_egrn') && r0.catalog.some((c) => c.id === 'house_tech'));
  await put(o, egrn(addDays(today, -3), 'Здание'), 'Выписка ЕГРН дом.txt');
  assert.equal((await list(o)).egrn_old, null, 'выписка на дом свежая, на участок нет — молчим');
  await put(o, egrn(addDays(today, -45), 'Земельный участок'), 'Выписка ЕГРН участок.txt');
  let r = await list(o);
  assert.equal(r.egrn_old?.item, 'land_egrn', JSON.stringify(r.egrn_old));
  assert.equal(r.egrn_old.land, true);
  assert.equal(r.egrn_old.age, 45);
  assert.equal(r.egrn_old.name, 'Выписка ЕГРН участок.txt');
  const row = (await todayRows()).find((x) => x.id === o.id);
  assert.equal(row?.egrn.item, 'land_egrn');
  assert.equal((await list(o, owner)).egrn_old, null, 'заказчик подсказки не видит');

  // «Запросить свежую выписку на участок» — пункт участка с пояснением; из «Сегодня» уходит.
  const res = await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['land_egrn'], fresh_egrn: true });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const asked = res.body.requests.find((x) => x.item_id === 'land_egrn' && !x.done);
  assert.match(asked.note, /^Выписка ЕГРН на участок под домом в деле от .* — старше 30 дней на сегодня\. Дом и участок оцениваются вместе/);
  assert.equal(res.body.egrn_old.asked, true);
  assert.ok(!(await todayRows()).some((x) => x.id === o.id));

  // Заказчик приложил к пункту участка свежую — даже без «Земельный участок» в тексте она считается выпиской на участок.
  const fresh = await put(o, `Выписка из ЕГРН\n${ru(addDays(today, -1))} № КУВИ-001/2026-55309999`, 'скан.txt');
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/doc-requests/${asked.id}/attach`, { document_id: fresh.id })).status, 200);
  assert.equal((await list(o)).egrn_old, null);

  // Старая на дом, свежая на участок — подсказка про дом (пункт «Выписка из ЕГРН»), свежая на участок её не прикрывает.
  const o2 = await inWork('Дом: старая выписка на дом', { house_land: 'own' });
  await put(o2, egrn(addDays(today, -50), 'Здание'), 'Выписка ЕГРН дом.txt');
  await put(o2, egrn(addDays(today, -2), 'Земельный участок'), 'Выписка ЕГРН участок.txt');
  r = await list(o2);
  assert.equal(r.egrn_old?.item, 'egrn');
  assert.equal(r.egrn_old.land, false);
  assert.equal(r.egrn_old.age, 50);

  // Участок не оформлен — пункта нет, выписки судятся вместе, как раньше.
  const o3 = await inWork('Дом: участок не оформлен', { house_land: 'none' });
  assert.ok(!(await list(o3)).catalog.some((c) => c.id === 'land_egrn'));
  await put(o3, egrn(addDays(today, -50), 'Здание'), 'Выписка ЕГРН дом.txt');
  await put(o3, egrn(addDays(today, -2), 'Земельный участок'), 'Выписка ЕГРН участок.txt');
  assert.equal((await list(o3)).egrn_old, null);
});
