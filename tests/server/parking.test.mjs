// Задача 2.549 (машино-место или кладовая): в «Что оцениваем» — «Машино-место или кладовая»; в заявке что именно, паркинг,
// уровень, номер места, как оформлено (отдельный объект или доля в праве на паркинг), размер доли, вместе ли с квартирой
// (необязательные); подсказка в деле; строкой «Из заявки: …» — в «7. Описание объекта оценки». Номера +7 999 000-60-11…13 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { FACTS_HEAD, factsLine } from '../../src/orders/facts.mjs';
import { parkingNotices } from '../../src/orders/parking.mjs';
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
});
