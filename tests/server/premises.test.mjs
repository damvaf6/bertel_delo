// Задача 2.519 (нежилое помещение): в заявке на оценку недвижимости — «Если нежилое — назначение», «сдаётся ли в аренду»,
// «Если сдаётся — арендная плата в месяц» и «вход» (необязательные); подсказка в деле — сдаётся: доходный подход и договор
// аренды, не сдаётся — аналоги аренды, не указано — уточнить; строкой «Из заявки: …» — в «7. Описание объекта оценки».
// Номера +7 999 000-55-71…73 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { FACTS_HEAD, factsLine } from '../../src/orders/facts.mjs';
import { premisesNotices } from '../../src/orders/premises.mjs';
import { createRegistry } from '../../src/modules/index.mjs';

const LINE = `${FACTS_HEAD} назначение — офис; сдаётся ли в аренду — сдаётся целиком; арендная плата в месяц — 180 000 руб.; вход — отдельный, с улицы.`;

test('подсказки и строка «Из заявки»', () => {
  const ids = (f) => premisesNotices('realty', f).map((n) => n.id);
  assert.deepEqual(ids({ object_type: 'flat' }), [], 'квартира без сведений о нежилом — молчим');
  assert.deepEqual(ids({ object_type: 'flat', lease: 'full' }), ['premises_type']);
  assert.deepEqual(ids({ object_type: 'commercial' }), ['premises_ask']);
  assert.deepEqual(ids({ object_type: 'commercial', lease: 'full', lease_rent: 180000 }), ['premises_lease']);
  assert.deepEqual(ids({ object_type: 'commercial', lease: 'part' }), ['premises_lease', 'premises_rent']);
  assert.deepEqual(ids({ object_type: 'commercial', lease: 'no' }), ['premises_free']);
  assert.deepEqual(ids({ object_type: 'commercial', lease: 'no', lease_rent: 50000 }), ['premises_rent']);
  assert.match(premisesNotices('realty', { object_type: 'commercial', lease: 'full', lease_rent: 180000 })[0].text,
    /^Помещение сдаётся целиком, арендная плата — 180 000 руб\. в месяц: в отчёте — доходный подход/);
  assert.match(premisesNotices('realty', { object_type: 'commercial', lease: 'no', lease_rent: 50000 })[0].text, /50 000 руб\. в месяц, а помещение «не сдаётся»/);
  assert.deepEqual(premisesNotices('vehicle', { object_type: 'commercial' }), []);

  const registry = createRegistry();
  const fields = registry.service('expertise', 'realty').fields;
  const sec = registry.draftSections('expertise', 'realty').find((s) => s.facts);
  assert.equal(sec.id, 'r_object');
  const values = { premises_use: 'office', lease: 'full', lease_rent: 180000, entrance: 'street' };
  assert.equal(factsLine(fields, sec.facts, values), LINE);
  assert.equal(factsLine(fields, sec.facts, { lease: 'no' }), `${FACTS_HEAD} сдаётся ли в аренду — не сдаётся.`);
});

let S, owner, dispatcher, spec;
const BASE = { purpose: 'bank', region: 'moscow', object_type: 'commercial', address: 'г. Москва, Тестовая ул., д. 5, пом. I', area: 140 };
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005571');
  dispatcher = await login(S, '+79990005572');
  spec = await login(S, '+79990005573');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

test('поля необязательны и проверяются; подсказка в деле; строка — в черновике от ИИ', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Офис для банка' })).body.order;
  const patch = (fields) => owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields });
  assert.equal((await patch(BASE)).status, 200, 'без новых полей — как раньше');
  assert.deepEqual((await owner.req('GET', `/api/orders/${o.id}`)).body.notices.map((n) => n.id), ['premises_ask']);
  for (const wrong of [{ premises_use: 'mall' }, { lease: 'yes' }, { lease_rent: 0 }, { lease_rent: 'много' }, { entrance: 'roof' }]) {
    assert.equal((await patch({ ...BASE, ...wrong })).status, 400, JSON.stringify(wrong));
  }
  const all = { ...BASE, premises_use: 'office', lease: 'full', lease_rent: 180000, entrance: 'street' };
  assert.equal((await patch(all)).status, 200);
  assert.deepEqual((await owner.req('GET', `/api/orders/${o.id}`)).body.notices.map((n) => n.id), ['premises_lease']);

  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);
  assert.deepEqual((await spec.req('GET', `/api/orders/${o.id}`)).body.notices.map((n) => n.id), ['premises_lease'], 'эксперт видит ту же подсказку');

  const r = await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const lines = r.body.draft.body.split('\n');
  const h = lines.findIndex((l) => /^#{1,3}\s*7\. Описание объекта оценки/.test(l));
  assert.ok(h >= 0, r.body.draft.body.slice(0, 400));
  assert.equal(lines[h + 1], LINE);
  assert.equal(lines.filter((l) => l.startsWith(FACTS_HEAD)).length, 1);
});
