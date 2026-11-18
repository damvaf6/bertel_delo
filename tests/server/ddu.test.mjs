// Задача 2.539 (квартира в новостройке, права по ДДУ): в «Что оцениваем» — «Квартира в новостройке (права по ДДУ)»; в заявке
// номер и дата ДДУ, застройщик, ЖК и корпус, условный номер, проектная площадь, срок передачи и цена по договору
// (необязательные); подсказка в деле — оценивается право требования, не указаны номер или дата, кадастровый номер в заявке,
// срок передачи прошёл; строкой «Из заявки: …» — в «7. Описание объекта оценки». Номера +7 999 000-59-11…13 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { FACTS_HEAD, factsLine } from '../../src/orders/facts.mjs';
import { dduNotices, dduDay } from '../../src/orders/ddu.mjs';
import { createRegistry } from '../../src/modules/index.mjs';

const LINE = `${FACTS_HEAD} номер ДДУ — ЖК-12/3-145; дата ДДУ — 14.03.2025; застройщик — ООО «СЗ Тестовый»; ЖК, корпус, секция — ЖК «Тестовый», корп. 3, секция 2; условный номер квартиры — 145; проектная площадь — 41,3 кв. м; срок передачи квартиры по договору — IV квартал 2027; цена по договору — 9 850 000 руб.`;
const DDU = { ddu_number: 'ЖК-12/3-145', ddu_date: '14.03.2025', ddu_developer: 'ООО «СЗ Тестовый»', ddu_complex: 'ЖК «Тестовый», корп. 3, секция 2', ddu_unit: '145', ddu_area: 41.3, ddu_handover: 'IV квартал 2027', ddu_price: 9850000 };

test('подсказки и строка «Из заявки»', () => {
  const ids = (f, today = '2026-11-18') => dduNotices('realty', f, today).map((n) => n.id);
  assert.deepEqual(ids({ object_type: 'flat' }), [], 'квартира без сведений о ДДУ — молчим');
  assert.deepEqual(ids({ object_type: 'flat', ddu_number: '1' }), ['ddu_type']);
  assert.deepEqual(ids({ object_type: 'ddu' }), ['ddu_right', 'ddu_doc']);
  assert.deepEqual(ids({ object_type: 'ddu', ddu_number: '1' }), ['ddu_right', 'ddu_doc'], 'без даты — уточнить');
  assert.deepEqual(ids({ object_type: 'ddu', ...DDU }), ['ddu_right']);
  assert.deepEqual(ids({ object_type: 'ddu', ...DDU, cadastral: '50:20:0010101:55' }), ['ddu_right', 'ddu_cadastral']);
  assert.deepEqual(ids({ object_type: 'ddu', ...DDU, ddu_handover: '30.09.2026' }), ['ddu_right', 'ddu_late']);
  assert.deepEqual(ids({ object_type: 'ddu', ...DDU, ddu_handover: '31.12.2027' }), ['ddu_right'], 'срок впереди — молчим');
  assert.deepEqual(ids({ object_type: 'ddu', ...DDU, ddu_handover: '18.11.2026' }), ['ddu_right'], 'срок сегодня — ещё не прошёл');
  assert.equal(dduDay('31.12.2027'), '2027-12-31');
  assert.equal(dduDay('IV квартал 2027'), null);
  assert.match(dduNotices('realty', { object_type: 'ddu' })[0].text, /право требования по ДДУ \(214-ФЗ\), а не квартира/);
  assert.match(dduNotices('realty', { object_type: 'ddu', ...DDU, ddu_handover: '30.09.2026' }, '2026-11-18')[1].text, /\(30\.09\.2026\) уже прошёл/);
  assert.deepEqual(dduNotices('vehicle', { object_type: 'ddu' }), []);

  const registry = createRegistry();
  const fields = registry.service('expertise', 'realty').fields;
  assert.ok(fields.find((f) => f.id === 'object_type').options.some((o) => o.id === 'ddu' && o.name === 'Квартира в новостройке (права по ДДУ)'));
  const sec = registry.draftSections('expertise', 'realty').find((s) => s.facts);
  assert.equal(sec.id, 'r_object');
  assert.equal(factsLine(fields, sec.facts, DDU), LINE);
});

let S, owner, dispatcher, spec;
const BASE = { purpose: 'bank', region: 'moscow', object_type: 'ddu', address: 'г. Москва, ЖК «Тестовый», корп. 3 (строительный адрес)' };
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005911');
  dispatcher = await login(S, '+79990005912');
  spec = await login(S, '+79990005913');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

test('поля необязательны и проверяются; подсказка в деле; строка — в черновике от ИИ', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Новостройка для ипотеки' })).body.order;
  const patch = (fields) => owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields });
  assert.equal((await patch(BASE)).status, 200, 'без новых полей — как раньше');
  assert.deepEqual((await owner.req('GET', `/api/orders/${o.id}`)).body.notices.map((n) => n.id), ['ddu_right', 'ddu_doc']);
  for (const wrong of [{ ddu_date: '2025-03-14' }, { ddu_date: '14.3.25' }, { ddu_area: 0 }, { ddu_area: 'сорок' }, { ddu_price: 0 }, { ddu_number: 'x'.repeat(61) }]) {
    assert.equal((await patch({ ...BASE, ...wrong })).status, 400, JSON.stringify(wrong));
  }
  assert.equal((await patch({ ...BASE, ...DDU })).status, 200);
  assert.deepEqual((await owner.req('GET', `/api/orders/${o.id}`)).body.notices.map((n) => n.id), ['ddu_right']);

  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);
  assert.deepEqual((await spec.req('GET', `/api/orders/${o.id}`)).body.notices.map((n) => n.id), ['ddu_right'], 'эксперт видит ту же подсказку');

  const r = await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const lines = r.body.draft.body.split('\n');
  const h = lines.findIndex((l) => /^#{1,3}\s*7\. Описание объекта оценки/.test(l));
  assert.ok(h >= 0, r.body.draft.body.slice(0, 400));
  assert.equal(lines[h + 1], LINE);
  assert.equal(lines.filter((l) => l.startsWith(FACTS_HEAD)).length, 1);
});
