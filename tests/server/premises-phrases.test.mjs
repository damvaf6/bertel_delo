// Готовые фразы эксперта заказчику по нежилому помещению (задача 2.525): договор аренды и арендаторы, осмотр при арендаторе,
// расходы на содержание, поэтажный план — данными в описании модуля (phrases, when: «Нежилое помещение»). Отправляет
// эксперт сам. Номера +7 999 000-58-03…06 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';
import { messagePhrases } from '../../src/orders/phrases.mjs';

let S, owner, dispatcher, spec, stranger;
const FIELDS = { purpose: 'deal', region: 'moscow', object_type: 'commercial', address: 'г. Москва, Тестовая ул., д. 5, пом. 2', area: 120 };
const PH = ['p_lease', 'p_access', 'p_costs', 'p_plan'];

before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005803');
  dispatcher = await login(S, '+79990005804');
  spec = await login(S, '+79990005805');
  stranger = await login(S, '+79990005806');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

test('фразы по нежилому — только у нежилого; не сдаётся — без фразы об аренде; план получен — без фразы о плане', () => {
  const reg = createRegistry([expertise]);
  const def = reg.service('expertise', 'realty');
  const now = new Date('2026-10-06T21:30:00Z');
  const by = (list, id) => list.find((x) => x.id === id).text;
  const all = messagePhrases({ def, fields: FIELDS, now });
  assert.deepEqual(all.map((p) => p.id), ['access', 'address', 'docs', ...PH]);
  assert.deepEqual(all.slice(3).map((p) => p.title), ['Договор аренды и арендаторы', 'Осмотр при арендаторе', 'Расходы на содержание', 'Поэтажный план']);
  for (const p of all) assert.ok(!p.text.includes('{'), p.text);
  assert.match(by(all, 'p_lease'), /до 12 октября договоры аренды[\s\S]*кто арендаторы[\s\S]*Приложить можно в деле или ответом здесь\.$/);
  assert.match(by(all, 'p_access'), /где работает арендатор[\s\S]*управляющей компанией здания\.$/);
  assert.match(by(all, 'p_costs'), /доходного подхода[\s\S]*налог на имущество[\s\S]*до 12 октября[\s\S]*какие\.$/);
  assert.ok(!/Приложить можно|В заявке указано/.test(by(all, 'p_costs')));
  assert.match(by(all, 'p_plan'), /поэтажный план и экспликацию[\s\S]*Приложить можно в деле или ответом здесь\.$/);

  // Сдаётся и вход — «В заявке указано: …» названием варианта; не сдаётся — фразы об аренде нет.
  const filled = messagePhrases({ def, now, fields: { ...FIELDS, lease: 'part', entrance: 'common' } });
  assert.match(by(filled, 'p_lease'), /В заявке указано: «Сдаётся частично»\. Приложить можно/);
  assert.match(by(filled, 'p_access'), /В заявке указано: «Через общий подъезд или холл»\.$/);
  const free = messagePhrases({ def, now, fields: { ...FIELDS, lease: 'no' } });
  assert.deepEqual(free.slice(3).map((p) => p.id), ['p_access', 'p_costs', 'p_plan']);

  // Запрошено — к пункту; получено — фразы нет.
  const open = messagePhrases({ def, fields: { ...FIELDS, lease: 'full' }, now, docItems: { lease_contract: 'open', premises_plan: 'open' } });
  assert.match(by(open, 'p_lease'), /к пункту «Договор аренды и дополнительные соглашения к нему» списка/);
  assert.match(by(open, 'p_plan'), /к пункту «Поэтажный план и экспликация помещения \(БТИ\)» списка/);
  const got = messagePhrases({ def, fields: { ...FIELDS, lease: 'full' }, now, docItems: { lease_contract: 'got', premises_plan: 'got' } });
  assert.deepEqual(got.slice(3).map((p) => p.id), ['p_access', 'p_costs']);

  // Квартира, доля, вид не указан — фраз по нежилому нет; у других услуг — тоже.
  for (const f of [{ object_type: 'flat' }, { object_type: 'share', share_size: '1/2' }, { object_type: '' }]) {
    assert.ok(!messagePhrases({ def, fields: { ...FIELDS, ...f }, now }).some((p) => p.id.startsWith('p_')), JSON.stringify(f));
  }
  for (const s of ['land', 'vehicle', 'car_damage', 'goods']) {
    assert.ok(!messagePhrases({ def: reg.service('expertise', s), fields: FIELDS, now }).some((p) => p.id.startsWith('p_')), s);
  }
  // Нежилое для наследства — и фразы по наследству, и по нежилому.
  const heir = messagePhrases({ def, fields: { ...FIELDS, purpose: 'inheritance' }, now }).map((p) => p.id);
  assert.ok(heir.includes('h_show') && heir.includes('p_costs'), heir.join());
});

test('в деле по нежилому: фразы у эксперта; договор аренды получен — без фразы; заказчик и чужой не видят', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Нежилое: фразы' })).body.order;
  const r = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: { ...FIELDS, lease: 'full', lease_rent: 150000 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);

  const msgs = (c) => c.req('GET', `/api/orders/${o.id}/messages`);
  let p = (await msgs(spec)).body.phrases;
  assert.deepEqual(p.filter((x) => x.id.startsWith('p_')).map((x) => x.id), PH);
  assert.match(p.find((x) => x.id === 'p_lease').text, /В заявке указано: «Сдаётся целиком»/);
  assert.deepEqual((await msgs(owner)).body.phrases, []);
  assert.deepEqual((await msgs(dispatcher)).body.phrases, []);
  assert.equal((await msgs(stranger)).status, 404);

  assert.equal((await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['lease_contract'] })).status, 201);
  p = (await msgs(spec)).body.phrases;
  assert.match(p.find((x) => x.id === 'p_lease').text, /к пункту «Договор аренды и дополнительные соглашения к нему»/);
  const rq = (await owner.req('GET', `/api/orders/${o.id}/doc-requests`)).body.requests.find((x) => x.item_id === 'lease_contract');
  const d = (await owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from('договор'), {
    raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('аренда.pdf') } })).body.document;
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/doc-requests/${rq.id}/attach`, { document_id: d.id })).status, 200);
  p = (await msgs(spec)).body.phrases;
  assert.deepEqual(p.filter((x) => x.id.startsWith('p_')).map((x) => x.id), ['p_access', 'p_costs', 'p_plan']);
  assert.equal((await msgs(spec)).body.messages.length, 0);
});
