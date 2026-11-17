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
