// Готовые фразы эксперта заказчику по квартире в новостройке (задача 2.545): договор ДДУ с отметкой о регистрации, справка
// об оплате, план квартиры из договора — данными в описании модуля (phrases, when: «права по ДДУ»). Отправляет эксперт сам.
// Номера +7 999 000-59-90…93 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';
import { messagePhrases } from '../../src/orders/phrases.mjs';

let S, owner, dispatcher, spec, stranger;
const FIELDS = { purpose: 'bank', bank: 'sber', region: 'moscow', object_type: 'ddu', address: 'Москва, ЖК «Тестовый», корп. 3', area: 54 };
const PH = ['u_contract', 'u_payment', 'u_plan'];

before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005990');
  dispatcher = await login(S, '+79990005991');
  spec = await login(S, '+79990005992');
  stranger = await login(S, '+79990005993');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

test('фразы по ДДУ — только у квартиры в новостройке; номер ДДУ из заявки; запрошено — к пункту, получено — без фразы', () => {
  const reg = createRegistry([expertise]);
  const def = reg.service('expertise', 'realty');
  const now = new Date('2026-10-06T21:30:00Z');
  const by = (list, id) => list.find((x) => x.id === id).text;
  const all = messagePhrases({ def, fields: FIELDS, now });
  const ids = all.map((p) => p.id);
  assert.deepEqual(ids.filter((id) => id.startsWith('u_')), PH);
  assert.deepEqual(all.filter((p) => p.id.startsWith('u_')).map((p) => p.title), ['Договор с отметкой о регистрации', 'Справка об оплате', 'План квартиры из договора']);
  // Ни фраз по дому, доле, нежилому.
  assert.ok(!ids.some((id) => /^(d|s|p)_/.test(id)), ids.join());
  for (const p of all) assert.ok(!p.text.includes('{'), p.text);
  assert.match(by(all, 'u_contract'), /право требования[\s\S]*до 12 октября все страницы[\s\S]*штампом Росреестра[\s\S]*договор уступки[\s\S]*срок передачи\. Приложить можно в деле или ответом здесь\.$/);
  assert.match(by(all, 'u_payment'), /до 12 октября справку застройщика об оплате[\s\S]*рассрочку[\s\S]*Приложить можно в деле или ответом здесь\.$/);
  assert.match(by(all, 'u_plan'), /до 12 октября план квартиры из договора[\s\S]*обмерам БТИ[\s\S]*Приложить можно в деле или ответом здесь\.$/);
  assert.ok(!/В заявке указано/.test(by(all, 'u_payment') + by(all, 'u_plan')));

  const filled = messagePhrases({ def, now, fields: { ...FIELDS, ddu_number: 'ЖК-12/3-145' } });
  assert.match(by(filled, 'u_contract'), /В заявке указано: «ЖК-12\/3-145»\. Приложить можно/);

  const open = messagePhrases({ def, fields: FIELDS, now, docItems: { ddu_contract: 'open', ddu_payment: 'open', ddu_plan: 'open' } });
  assert.match(by(open, 'u_contract'), /к пункту «Договор участия в долевом строительстве с отметкой о регистрации» списка/);
  assert.match(by(open, 'u_payment'), /к пункту «Справка застройщика об оплате по договору» списка/);
  assert.match(by(open, 'u_plan'), /к пункту «План квартиры из договора» списка/);
  const got = messagePhrases({ def, fields: FIELDS, now, docItems: { ddu_contract: 'got', ddu_plan: 'got' } });
  assert.deepEqual(got.map((p) => p.id).filter((id) => id.startsWith('u_')), ['u_payment']);

  // Квартира, дом, нежилое, доля, вид не указан — фраз по ДДУ нет; у других услуг — тоже.
  for (const f of [{ object_type: 'flat' }, { object_type: 'house' }, { object_type: 'commercial' }, { object_type: 'share', share_size: '1/2' }, { object_type: '' }]) {
    assert.ok(!messagePhrases({ def, fields: { ...FIELDS, ...f }, now }).some((p) => p.id.startsWith('u_')), JSON.stringify(f));
  }
  for (const s of ['land', 'vehicle', 'car_damage', 'goods']) {
    assert.ok(!messagePhrases({ def: reg.service('expertise', s), fields: FIELDS, now }).some((p) => p.id.startsWith('u_')), s);
  }
});

test('в деле по ДДУ: фразы у эксперта; договор получен — без фразы; заказчик, диспетчер и чужой не видят', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'ДДУ: фразы' })).body.order;
  const r = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: { ...FIELDS, ddu_number: 'ЖК-12/3-145' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);

  const msgs = (c) => c.req('GET', `/api/orders/${o.id}/messages`);
  let p = (await msgs(spec)).body.phrases;
  assert.deepEqual(p.filter((x) => x.id.startsWith('u_')).map((x) => x.id), PH);
  assert.match(p.find((x) => x.id === 'u_contract').text, /В заявке указано: «ЖК-12\/3-145»/);
  assert.deepEqual((await msgs(owner)).body.phrases, []);
  assert.deepEqual((await msgs(dispatcher)).body.phrases, []);
  assert.equal((await msgs(stranger)).status, 404);

  assert.equal((await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['ddu_contract'] })).status, 201);
  p = (await msgs(spec)).body.phrases;
  assert.match(p.find((x) => x.id === 'u_contract').text, /к пункту «Договор участия в долевом строительстве с отметкой о регистрации»/);
  const rq = (await owner.req('GET', `/api/orders/${o.id}/doc-requests`)).body.requests.find((x) => x.item_id === 'ddu_contract');
  const d = (await owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from('договор'), {
    raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('ДДУ.pdf') } })).body.document;
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/doc-requests/${rq.id}/attach`, { document_id: d.id })).status, 200);
  p = (await msgs(spec)).body.phrases;
  assert.deepEqual(p.filter((x) => x.id.startsWith('u_')).map((x) => x.id), ['u_payment', 'u_plan']);
  assert.equal((await msgs(spec)).body.messages.length, 0);
});
