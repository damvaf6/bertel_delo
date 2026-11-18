// Готовые фразы эксперта заказчику по жилому дому (задача 2.535): выписка на участок, технический план, кто покажет дом,
// газ и котёл — данными в описании модуля (phrases, when: «Жилой дом»). Отправляет эксперт сам.
// Номера +7 999 000-59-50…53 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';
import { messagePhrases } from '../../src/orders/phrases.mjs';

let S, owner, dispatcher, spec, stranger;
const FIELDS = { purpose: 'deal', region: 'mo', object_type: 'house', address: 'Московская обл., д. Тестовая, ул. Садовая, д. 7', area: 140 };
const PH = ['d_land', 'd_tech', 'd_show', 'd_gas'];

before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005950');
  dispatcher = await login(S, '+79990005951');
  spec = await login(S, '+79990005952');
  stranger = await login(S, '+79990005953');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

test('фразы по дому — только у дома; участок не оформлен — без выписки на участок; техплан получен — без фразы о нём', () => {
  const reg = createRegistry([expertise]);
  const def = reg.service('expertise', 'realty');
  const now = new Date('2026-10-06T21:30:00Z');
  const by = (list, id) => list.find((x) => x.id === id).text;
  const all = messagePhrases({ def, fields: FIELDS, now });
  assert.deepEqual(all.map((p) => p.id), ['access', 'address', 'docs', ...PH]);
  assert.deepEqual(all.slice(3).map((p) => p.title), ['Выписка на участок', 'Технический план дома', 'Кто покажет дом', 'Газ и котёл']);
  for (const p of all) assert.ok(!p.text.includes('{'), p.text);
  assert.match(by(all, 'd_land'), /не старше месяца[\s\S]*до 12 октября[\s\S]*договор аренды участка[\s\S]*Приложить можно в деле или ответом здесь\.$/);
  assert.match(by(all, 'd_tech'), /до 12 октября технический план или технический паспорт дома[\s\S]*Приложить можно в деле или ответом здесь\.$/);
  assert.match(by(all, 'd_show'), /со всех сторон[\s\S]*пропуск в посёлок[\s\S]*собака\.$/);
  assert.ok(!/Приложить можно|В заявке указано/.test(by(all, 'd_show')));
  assert.match(by(all, 'd_gas'), /как отапливается дом[\s\S]*до 12 октября договор на поставку газа[\s\S]*корректировки\.$/);

  // Участок и газ — «В заявке указано: …» названием варианта; участок не оформлен — фразы о выписке нет.
  const filled = messagePhrases({ def, now, fields: { ...FIELDS, house_land: 'lease', house_gas: 'tank' } });
  assert.match(by(filled, 'd_land'), /В заявке указано: «Взят в аренду»\. Приложить можно/);
  assert.match(by(filled, 'd_gas'), /В заявке указано: «Газгольдер или баллоны»\.$/);
  const none = messagePhrases({ def, now, fields: { ...FIELDS, house_land: 'none' } });
  assert.deepEqual(none.slice(3).map((p) => p.id), ['d_tech', 'd_show', 'd_gas']);

  // Запрошено — к пункту; получено — фразы нет.
  const open = messagePhrases({ def, fields: { ...FIELDS, house_land: 'own' }, now, docItems: { land_egrn: 'open', house_tech: 'open' } });
  assert.match(by(open, 'd_land'), /к пункту «Выписка из ЕГРН на земельный участок под домом» списка/);
  assert.match(by(open, 'd_tech'), /к пункту «Технический план или технический паспорт дома» списка/);
  const got = messagePhrases({ def, fields: { ...FIELDS, house_land: 'own' }, now, docItems: { land_egrn: 'got', house_tech: 'got' } });
  assert.deepEqual(got.slice(3).map((p) => p.id), ['d_show', 'd_gas']);

  // Квартира, нежилое, доля, вид не указан — фраз по дому нет; у других услуг — тоже.
  for (const f of [{ object_type: 'flat' }, { object_type: 'commercial' }, { object_type: 'share', share_size: '1/2' }, { object_type: '' }]) {
    assert.ok(!messagePhrases({ def, fields: { ...FIELDS, ...f }, now }).some((p) => p.id.startsWith('d_')), JSON.stringify(f));
  }
  for (const s of ['land', 'vehicle', 'car_damage', 'goods']) {
    assert.ok(!messagePhrases({ def: reg.service('expertise', s), fields: FIELDS, now }).some((p) => p.id.startsWith('d_')), s);
  }
  // Дом для наследства — и фразы по наследству, и по дому.
  const heir = messagePhrases({ def, fields: { ...FIELDS, purpose: 'inheritance' }, now }).map((p) => p.id);
  assert.ok(heir.includes('h_show') && heir.includes('d_gas'), heir.join());
});

test('в деле по дому: фразы у эксперта; выписка на участок получена — без фразы; заказчик и чужой не видят', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Дом: фразы' })).body.order;
  const r = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: { ...FIELDS, house_land: 'own', house_gas: 'main' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);

  const msgs = (c) => c.req('GET', `/api/orders/${o.id}/messages`);
  let p = (await msgs(spec)).body.phrases;
  assert.deepEqual(p.filter((x) => x.id.startsWith('d_')).map((x) => x.id), PH);
  assert.match(p.find((x) => x.id === 'd_land').text, /В заявке указано: «Оформлен в собственность»/);
  assert.match(p.find((x) => x.id === 'd_gas').text, /В заявке указано: «Магистральный»/);
  assert.deepEqual((await msgs(owner)).body.phrases, []);
  assert.deepEqual((await msgs(dispatcher)).body.phrases, []);
  assert.equal((await msgs(stranger)).status, 404);

  assert.equal((await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['land_egrn'] })).status, 201);
  p = (await msgs(spec)).body.phrases;
  assert.match(p.find((x) => x.id === 'd_land').text, /к пункту «Выписка из ЕГРН на земельный участок под домом»/);
  const rq = (await owner.req('GET', `/api/orders/${o.id}/doc-requests`)).body.requests.find((x) => x.item_id === 'land_egrn');
  const d = (await owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from('выписка'), {
    raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('участок.pdf') } })).body.document;
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/doc-requests/${rq.id}/attach`, { document_id: d.id })).status, 200);
  p = (await msgs(spec)).body.phrases;
  assert.deepEqual(p.filter((x) => x.id.startsWith('d_')).map((x) => x.id), ['d_tech', 'd_show', 'd_gas']);
  assert.equal((await msgs(spec)).body.messages.length, 0);
});
