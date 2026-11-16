// Готовые фразы эксперта заказчику по доле (задача 2.515): доступ на осмотр с согласия других собственников, какая комната в
// пользовании, как оценивать долю — данными в описании модуля (phrases, when: «Доля в квартире или доме»). Отправляет
// эксперт сам. Номера +7 999 000-55-38…41 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';
import { messagePhrases } from '../../src/orders/phrases.mjs';

let S, owner, dispatcher, spec, stranger;
const FIELDS = { purpose: 'deal', region: 'moscow', object_type: 'share', address: 'г. Москва, Тестовая ул., д. 11, кв. 7', area: 58, share_size: '1/3' };
const SH = ['s_access', 's_room', 's_method'];

before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005538');
  dispatcher = await login(S, '+79990005539');
  spec = await login(S, '+79990005540');
  stranger = await login(S, '+79990005541');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

test('фразы по доле — только у доли; сведения из заявки; порядок пользования получен — без фразы о комнате', () => {
  const reg = createRegistry([expertise]);
  const def = reg.service('expertise', 'realty');
  const now = new Date('2026-10-06T21:30:00Z');
  const by = (list, id) => list.find((x) => x.id === id).text;
  const all = messagePhrases({ def, fields: FIELDS, now });
  assert.deepEqual(all.map((p) => p.id), ['access', 'address', 'docs', ...SH]);
  assert.deepEqual(all.slice(3).map((p) => p.title), ['Доступ при доле', 'Какая комната в пользовании', 'Как оценивать долю']);
  for (const p of all) assert.ok(!p.text.includes('{'), p.text);
  assert.match(by(all, 's_access'), /осматривается вся квартира[\s\S]*согласны ли они на осмотр[\s\S]*укажу это в отчёте\.$/);
  assert.match(by(all, 's_room'), /какой комнатой Вы пользуетесь[\s\S]*до 12 октября его копию[\s\S]*Приложить можно в деле или ответом здесь\.$/);
  assert.match(by(all, 's_method'), /двумя способами[\s\S]*определения о назначении экспертизы[\s\S]*подскажу способ\.$/);
  assert.ok(!/Приложить можно/.test(by(all, 's_method')));

  // Заполнено в заявке — «В заявке указано: …» (выбор — названием варианта).
  const filled = messagePhrases({ def, now, fields: { ...FIELDS, share_owners: 'брат — 1/2, живёт в квартире', share_use: 'court', share_method: 'pro_rata' } });
  assert.match(by(filled, 's_access'), /В заявке указано: «брат — 1\/2, живёт в квартире»\.$/);
  assert.match(by(filled, 's_room'), /В заявке указано: «Определён решением суда»\. Приложить можно/);
  assert.match(by(filled, 's_method'), /В заявке указано: «Часть стоимости всего объекта \(без скидки\)»\.$/);

  // Порядок пользования запрошен — к пункту; получен — фразы о комнате нет, остальные остаются.
  const open = messagePhrases({ def, fields: FIELDS, now, docItems: { share_use_doc: 'open' } });
  assert.match(by(open, 's_room'), /к пункту «Соглашение о порядке пользования или решение суда о нём» списка/);
  const got = messagePhrases({ def, fields: FIELDS, now, docItems: { share_use_doc: 'got' } });
  assert.deepEqual(got.slice(3).map((p) => p.id), ['s_access', 's_method']);

  // Квартира целиком, раздел квартиры целиком, вид не указан — фраз по доле нет; у других услуг — тоже.
  for (const f of [{ object_type: 'flat' }, { object_type: 'flat', purpose: 'division' }, { object_type: '' }]) {
    assert.ok(!messagePhrases({ def, fields: { ...FIELDS, ...f }, now }).some((p) => p.id.startsWith('s_')), JSON.stringify(f));
  }
  for (const s of ['land', 'vehicle', 'car_damage', 'goods']) {
    assert.ok(!messagePhrases({ def: reg.service('expertise', s), fields: FIELDS, now }).some((p) => p.id.startsWith('s_')), s);
  }
  // Доля для наследства — и фразы по наследству, и по доле.
  const heir = messagePhrases({ def, fields: { ...FIELDS, purpose: 'inheritance' }, now }).map((p) => p.id);
  assert.ok(heir.includes('h_show') && heir.includes('s_access'), heir.join());
});

test('в деле по доле: фразы у эксперта; порядок пользования получен — без фразы; заказчик и чужой не видят', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Доля: фразы' })).body.order;
  const r = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: { ...FIELDS, share_use: 'agreement' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);

  const msgs = (c) => c.req('GET', `/api/orders/${o.id}/messages`);
  let p = (await msgs(spec)).body.phrases;
  assert.deepEqual(p.filter((x) => x.id.startsWith('s_')).map((x) => x.id), SH);
  assert.deepEqual((await msgs(owner)).body.phrases, []);
  assert.deepEqual((await msgs(dispatcher)).body.phrases, []);
  assert.equal((await msgs(stranger)).status, 404);

  assert.equal((await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['share_use_doc'] })).status, 201);
  p = (await msgs(spec)).body.phrases;
  assert.match(p.find((x) => x.id === 's_room').text, /к пункту «Соглашение о порядке пользования/);
  const rq = (await owner.req('GET', `/api/orders/${o.id}/doc-requests`)).body.requests.find((x) => x.item_id === 'share_use_doc');
  const d = (await owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from('соглашение'), {
    raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('соглашение.pdf') } })).body.document;
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/doc-requests/${rq.id}/attach`, { document_id: d.id })).status, 200);
  p = (await msgs(spec)).body.phrases;
  assert.deepEqual(p.filter((x) => x.id.startsWith('s_')).map((x) => x.id), ['s_access', 's_method']);
  assert.equal((await msgs(spec)).body.messages.length, 0);
});
