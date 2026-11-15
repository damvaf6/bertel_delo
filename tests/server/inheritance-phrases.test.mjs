// Готовые фразы эксперта заказчику по наследству (задача 2.505): дата смерти, справка нотариуса, документы на объект, кто
// покажет объект на осмотре — данными в описании модуля (phrases, when: цель «наследство»). Отправляет эксперт сам.
// Номера +7 999 000-53-28…31 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry, validateModule } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';
import { messagePhrases } from '../../src/orders/phrases.mjs';

let S, owner, dispatcher, spec, stranger;
const FIELDS = { purpose: 'inheritance', region: 'moscow', object_type: 'flat', address: 'г. Москва, Тестовая ул., д. 9, кв. 4', area: 41, death_date: '03.06.2026' };
const H = ['h_date', 'h_notary', 'h_deed', 'h_show'];

before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005328');
  dispatcher = await login(S, '+79990005329');
  spec = await login(S, '+79990005330');
  stranger = await login(S, '+79990005331');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

test('фразы по наследству — только при цели «наследство»; дата и нотариус из заявки; документы — по услуге', () => {
  const reg = createRegistry([expertise]);
  const def = reg.service('expertise', 'realty');
  const now = new Date('2026-10-06T21:30:00Z');
  const all = messagePhrases({ def, fields: FIELDS, now });
  assert.deepEqual(all.map((p) => p.id), ['access', 'address', 'docs', ...H]);
  assert.deepEqual(all.slice(3).map((p) => p.title), ['Дата смерти', 'Справка нотариуса', 'Документы на объект', 'Кто покажет объект']);
  for (const p of all) assert.ok(!p.text.includes('{'), p.text);
  const by = (list, id) => list.find((x) => x.id === id).text;
  // Дата — день открытия наследства, «В заявке указано» — как написал заказчик; без «до …» и без «Приложить».
  assert.match(by(all, 'h_date'), /день открытия наследства[\s\S]*не на день осмотра[\s\S]*В заявке указано: «03\.06\.2026»\.$/);
  assert.ok(!/Приложить можно/.test(by(all, 'h_date')));
  assert.match(by(all, 'h_notary'), /до 12 октября справку нотариуса[\s\S]*запрос[\s\S]*Приложить можно в деле или ответом здесь\.$/);
  assert.match(by(all, 'h_deed'), /принадлежал наследодателю[\s\S]*Приложить можно в деле или ответом здесь\.$/);
  assert.match(by(all, 'h_show'), /кто из наследников или у кого ключи[\s\S]*опечатан/);
  // Нотариус указан — «В заявке указано»; дата не указана — фраза остаётся (просьба написать дату).
  const noDate = messagePhrases({ def, fields: { ...FIELDS, death_date: '', notary: 'нотариус Тестова Т. Т., дело № 7/2026' }, now });
  assert.match(by(noDate, 'h_date'), /Напишите или подтвердите[\s\S]*нотариуса\.$/);
  assert.match(by(noDate, 'h_notary'), /В заявке указано: «нотариус Тестова Т\. Т\., дело № 7\/2026»\. Приложить/);
  // Запрошено — к пункту; справка получена — фразы о ней нет.
  const open = messagePhrases({ def, fields: FIELDS, now, docItems: { heir_opening: 'open', title_deed: 'open' } });
  assert.match(by(open, 'h_notary'), /к пункту «Справка нотариуса об открытии наследственного дела или свидетельство о смерти» списка/);
  assert.match(by(open, 'h_deed'), /к пункту «Документ о праве собственности» списка/);
  const got = messagePhrases({ def, fields: FIELDS, now, docItems: { heir_opening: 'got', title_deed: 'got' } });
  assert.deepEqual(got.map((p) => p.id), ['access', 'address', 'docs', 'h_date', 'h_show']);
  // Другая цель или цель не указана — фраз по наследству нет.
  for (const purpose of ['deal', 'bank', '']) {
    assert.ok(!messagePhrases({ def, fields: { ...FIELDS, purpose }, now }).some((p) => p.id.startsWith('h_')), purpose);
  }
  // Машина и прочее имущество — «Документы на имущество» вместо «Документы на объект»; у ДТП и товара фраз нет.
  const car = messagePhrases({ def: reg.service('expertise', 'vehicle'), fields: { ...FIELDS, vehicle_type: 'car' }, now });
  assert.deepEqual(car.filter((p) => p.id.startsWith('h_')).map((p) => p.title), ['Дата смерти', 'Справка нотариуса', 'Документы на имущество', 'Кто покажет объект']);
  assert.match(by(car, 'h_papers'), /ПТС и СТС на его имя[\s\S]*Приложить можно в деле или ответом здесь\.$/);
  assert.ok(!/Приложить можно в деле или ответом здесь\. Приложить/.test(by(car, 'h_papers')));
  assert.deepEqual(messagePhrases({ def: reg.service('expertise', 'land'), fields: FIELDS, now }).filter((p) => p.id.startsWith('h_')).map((p) => p.id), H);
  for (const s of ['car_damage', 'goods']) {
    assert.ok(!messagePhrases({ def: reg.service('expertise', s), fields: FIELDS, now }).some((p) => p.id.startsWith('h_')), s);
  }
});

test('when у фразы проверяется при запуске (2.505)', () => {
  const bad = (phrases) => assert.throws(() => validateModule({ ...expertise, phrases }), undefined, JSON.stringify(phrases));
  const ok = { id: 'x', title: 'Т', services: ['realty', 'vehicle'], when: { field: 'purpose', in: ['inheritance'] }, text: 'Текст' };
  validateModule({ ...expertise, phrases: [ok] });
  bad([{ ...ok, when: { field: 'purpose', in: [] } }]);
  bad([{ ...ok, when: { field: 'purpose', in: ['nope'] } }]);
  bad([{ ...ok, when: { field: 'address', in: ['x'] } }]); // не поле-список
  bad([{ ...ok, when: { field: 'purpose', in: ['inheritance'], extra: 1 } }]);
  bad([{ ...ok, services: ['goods'], when: { field: 'bank', in: ['sber'] } }]); // у товароведческой нет поля «банк»
});

test('в деле по наследству: фразы у эксперта; справка получена — без фразы; заказчик и чужой не видят', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Квартира: фразы по наследству' })).body.order;
  const r = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: FIELDS });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);

  const msgs = (c) => c.req('GET', `/api/orders/${o.id}/messages`);
  let p = (await msgs(spec)).body.phrases;
  assert.deepEqual(p.filter((x) => x.id.startsWith('h_')).map((x) => x.id), H);
  assert.deepEqual((await msgs(owner)).body.phrases, []);
  assert.deepEqual((await msgs(dispatcher)).body.phrases, []);
  assert.equal((await msgs(stranger)).status, 404);

  assert.equal((await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['heir_opening'] })).status, 201);
  p = (await msgs(spec)).body.phrases;
  assert.match(p.find((x) => x.id === 'h_notary').text, /к пункту «Справка нотариуса об открытии наследственного дела/);
  const rq = (await owner.req('GET', `/api/orders/${o.id}/doc-requests`)).body.requests.find((x) => x.item_id === 'heir_opening');
  const d = (await owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from('справка'), {
    raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('справка.pdf') } })).body.document;
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/doc-requests/${rq.id}/attach`, { document_id: d.id })).status, 200);
  p = (await msgs(spec)).body.phrases;
  assert.deepEqual(p.filter((x) => x.id.startsWith('h_')).map((x) => x.id), ['h_date', 'h_deed', 'h_show']);
  assert.equal((await msgs(spec)).body.messages.length, 0);
});
