// Готовые фразы эксперта заказчику по оценке транспорта (задача 2.495): ПТС и СТС, машина на осмотр (чистая, при дневном
// свете, с ключами и документами), сервисная книжка, договор лизинга или залога — данными в описании модуля (phrases).
// «ПТС и СТС» — два пункта запроса: фразы нет, только когда получены оба. Отправляет эксперт сам.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry, validateModule } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';
import { messagePhrases } from '../../src/orders/phrases.mjs';

let S, owner, dispatcher, spec, stranger;
const FIELDS = { purpose: 'deal', region: 'moscow', vehicle_type: 'car', make_model: 'Тестомобиль 3', year: 2019, mileage: 84000 };
const V = ['v_docs', 'v_show', 'v_service', 'v_lease'];

before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990009581');
  dispatcher = await login(S, '+79990009582');
  spec = await login(S, '+79990009583');
  stranger = await login(S, '+79990009584');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'vehicle']] });
});
after(async () => { await S?.close(); });

async function inWork() {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'vehicle', title: 'Машина: фразы' })).body.order;
  const r = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: FIELDS });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  return o;
}

test('фразы по транспорту — только у оценки транспорта; ПТС и СТС — одна фраза на два пункта', () => {
  const reg = createRegistry([expertise]);
  const def = reg.service('expertise', 'vehicle');
  const now = new Date('2026-10-06T21:30:00Z');
  const all = messagePhrases({ def, fields: FIELDS, now });
  assert.deepEqual(all.map((p) => p.id), ['access', 'address', 'docs', ...V]);
  assert.deepEqual(all.slice(3).map((p) => p.title), ['ПТС и СТС', 'Машина на осмотр', 'Сервисная книжка', 'Договор лизинга или залога']);
  for (const p of all) assert.ok(!p.text.includes('{'), p.text);
  for (const id of ['v_docs', 'v_service', 'v_lease']) {
    const p = all.find((x) => x.id === id);
    assert.match(p.text, /до 12 октября/, id);
    assert.match(p.text, /Приложить можно в деле или ответом здесь\.$/, id);
  }
  // Осмотр — без документа и без «до …»: чистая, днём, ключи и документы.
  const show = all.find((x) => x.id === 'v_show').text;
  assert.match(show, /вымытую[\s\S]*дневном свете[\s\S]*ключи[\s\S]*ПТС и СТС/);
  assert.ok(!/Приложить можно|до 12 октября/.test(show));
  // Запрошен один из двух — к пункту; оба — к пунктам; один получен — фраза остаётся; оба — фразы нет.
  const one = messagePhrases({ def, fields: FIELDS, now, docItems: { pts: 'open' } });
  assert.match(one[3].text, /к пункту «ПТС или выписка из электронного ПТС» списка «Запрошенные документы»\.$/);
  const both = messagePhrases({ def, fields: FIELDS, now, docItems: { pts: 'open', sts: 'open', service_book: 'open' } });
  assert.match(both[3].text, /к пунктам «ПТС или выписка из электронного ПТС» и «Свидетельство о регистрации \(СТС\)» списка/);
  assert.match(both[5].text, /к пункту «Сервисная книжка» списка/);
  const half = messagePhrases({ def, fields: FIELDS, now, docItems: { pts: 'got', sts: 'open' } });
  assert.match(half[3].text, /к пункту «Свидетельство о регистрации \(СТС\)» списка/);
  const got = messagePhrases({ def, fields: FIELDS, now, docItems: { pts: 'got', sts: 'got', encumbrance: 'got' } });
  assert.deepEqual(got.map((p) => p.id), ['access', 'address', 'docs', 'v_show', 'v_service']);
  // У других услуг этих фраз нет.
  for (const s of ['realty', 'land', 'car_damage', 'goods', 'movable']) {
    assert.ok(!messagePhrases({ def: reg.service('expertise', s), fields: {} }).some((p) => p.id.startsWith('v_')), s);
  }
  // Сервисная книжка — в списке запроса документов у транспорта, у ущерба после ДТП — нет.
  const rd = expertise.request_docs.find((d) => d.id === 'service_book');
  assert.deepEqual(rd.services, ['vehicle']);
});

test('doc фразы списком проверяется при запуске (2.495)', () => {
  const bad = (phrases) => assert.throws(() => validateModule({ ...expertise, phrases }), undefined, JSON.stringify(phrases));
  const ok = { id: 'x', title: 'Т', services: ['vehicle'], doc: ['pts', 'sts'], text: 'Текст' };
  validateModule({ ...expertise, phrases: [ok] });
  validateModule({ ...expertise, phrases: [{ ...ok, doc: 'pts' }] });
  bad([{ ...ok, doc: [] }]);
  bad([{ ...ok, doc: ['pts', 'pts'] }]);
  bad([{ ...ok, doc: ['pts', 'nope'] }]);
  // Документ не для всех услуг фразы: сервисная книжка — не для ущерба после ДТП.
  bad([{ ...ok, services: ['vehicle', 'car_damage'], doc: ['service_book'] }]);
});

test('в деле по транспорту: фразы у эксперта; ПТС и СТС получены — без фразы; заказчик и чужой не видят', async () => {
  const o = await inWork();
  const msgs = (c) => c.req('GET', `/api/orders/${o.id}/messages`);
  let p = (await msgs(spec)).body.phrases;
  assert.deepEqual(p.map((x) => x.id), ['access', 'address', 'docs', ...V]);
  assert.deepEqual((await msgs(owner)).body.phrases, []);
  assert.deepEqual((await msgs(dispatcher)).body.phrases, []);
  assert.equal((await msgs(stranger)).status, 404);

  assert.equal((await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['pts', 'sts'] })).status, 201);
  p = (await msgs(spec)).body.phrases;
  assert.match(p.find((x) => x.id === 'v_docs').text, /к пунктам «ПТС или выписка из электронного ПТС» и «Свидетельство о регистрации \(СТС\)»/);
  const reqs = (await owner.req('GET', `/api/orders/${o.id}/doc-requests`)).body.requests;
  for (const item of ['pts', 'sts']) {
    const d = (await owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from('скан'), {
      raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(`${item}.pdf`) } })).body.document;
    const rq = reqs.find((x) => x.item_id === item);
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/doc-requests/${rq.id}/attach`, { document_id: d.id })).status, 200);
    p = (await msgs(spec)).body.phrases;
    assert.equal(p.some((x) => x.id === 'v_docs'), item === 'pts', item);
  }
  assert.deepEqual(p.map((x) => x.id), ['access', 'address', 'docs', 'v_show', 'v_service', 'v_lease']);
  assert.equal((await msgs(spec)).body.messages.length, 0);
});
