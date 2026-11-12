// Готовые фразы эксперта заказчику по ДТП (задача 2.477): документы ГИБДД, европротокол, акт и расчёт страховой,
// заказ-наряд — данными в описании модуля (phrases). Получен документ по запросу — фразы о нём нет; запрошен — «к пункту
// … в деле»; страховая из заявки — «В заявке указано: …». Фраза только подставляется в поле: отправляет эксперт сам.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry, validateModule } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';
import { messagePhrases } from '../../src/orders/phrases.mjs';

let S, owner, dispatcher, spec, stranger;
const FIELDS = { purpose: 'damage', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая Модель', year: 2021,
  accident_date: '14.09.2026', damage: 'Задний бампер', method: 'osago', insurer: 'Тестовая страховая, убыток 0001, выплатила 40 000 ₽' };
const CD = ['cd_police', 'cd_euro', 'cd_insurer', 'cd_repair'];

before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990004771');
  dispatcher = await login(S, '+79990004772');
  spec = await login(S, '+79990004773');
  stranger = await login(S, '+79990004774');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'car_damage']] });
});
after(async () => { await S?.close(); });

async function inWork(fields = FIELDS) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'car_damage', title: 'ДТП: фразы' })).body.order;
  const r = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  return o;
}

test('фразы по ДТП — только у услуги «Ущерб после ДТП», дата и страховая подставлены', () => {
  const reg = createRegistry([expertise]);
  const now = new Date('2026-10-06T21:30:00Z');
  const car = messagePhrases({ def: reg.service('expertise', 'car_damage'), fields: FIELDS, now });
  assert.deepEqual(car.map((p) => p.id), ['access', 'address', 'docs', ...CD]);
  assert.deepEqual(car.slice(3).map((p) => p.title), ['Документы ГИБДД', 'Европротокол', 'Акт и расчёт страховой', 'Заказ-наряд']);
  for (const p of car.slice(3)) {
    assert.match(p.text, /до 12 октября/, p.id);
    assert.ok(!p.text.includes('{'), p.text);
    assert.match(p.text, /Приложить можно в деле или ответом здесь\.$/);
  }
  assert.match(car[5].text, /В заявке указано: «Тестовая страховая, убыток 0001, выплатила 40 000 ₽»/);
  assert.match(car[4].text, /обе стороны бланка/);
  assert.match(car[6].text, /не ремонтируйте/);
  // Страховой в заявке нет — без «В заявке указано».
  const bare = messagePhrases({ def: reg.service('expertise', 'car_damage'), fields: { damage: 'фара' }, now });
  assert.ok(!bare.some((p) => /В заявке указано/.test(p.text)));
  // Запрошен — к пункту; получен — фразы нет (оба про документы ДТП).
  const asked = messagePhrases({ def: reg.service('expertise', 'car_damage'), fields: FIELDS, now,
    docItems: { insurer_docs: 'open', accident_docs: 'got' } });
  assert.deepEqual(asked.map((p) => p.id), ['access', 'address', 'docs', 'cd_insurer', 'cd_repair']);
  assert.match(asked[3].text, /к пункту «Акт осмотра и расчёт страховой» списка «Запрошенные документы»\.$/);
  // У других услуг этих фраз нет.
  for (const s of ['vehicle', 'realty', 'goods']) {
    assert.ok(!messagePhrases({ def: reg.service('expertise', s), fields: {} }).some((p) => p.id.startsWith('cd_')), s);
  }
});

test('описание фраз проверяется при запуске (2.477)', () => {
  const bad = (phrases) => assert.throws(() => validateModule({ ...expertise, phrases }), undefined, JSON.stringify(phrases));
  const ok = { id: 'x', title: 'Т', services: ['car_damage'], text: 'Текст' };
  validateModule({ ...expertise, phrases: [ok] });
  bad([]);
  bad([ok, ok]);
  bad([{ ...ok, services: ['nope'] }]);
  bad([{ ...ok, doc: 'nope' }]);
  bad([{ ...ok, field: 'nope' }]);
  bad([{ ...ok, extra: 1 }]);
  bad([{ ...ok, text: '' }]);
  bad([{ ...ok, title: 'x'.repeat(41) }]);
});

test('в деле по ДТП: фразы у эксперта; запрошенный документ — к пункту, полученный — фразы нет', async () => {
  const o = await inWork();
  const msgs = (c) => c.req('GET', `/api/orders/${o.id}/messages`);
  let p = (await msgs(spec)).body.phrases;
  assert.deepEqual(p.map((x) => x.id), ['access', 'address', 'docs', ...CD]);
  assert.match(p.find((x) => x.id === 'cd_insurer').text, /В заявке указано: «Тестовая страховая/);
  assert.deepEqual((await msgs(owner)).body.phrases, []);
  assert.deepEqual((await msgs(dispatcher)).body.phrases, []);
  assert.equal((await msgs(stranger)).status, 404);

  assert.equal((await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['insurer_docs', 'repair_docs'] })).status, 201);
  p = (await msgs(spec)).body.phrases;
  assert.match(p.find((x) => x.id === 'cd_insurer').text, /к пункту «Акт осмотра и расчёт страховой»/);
  const reqs = (await owner.req('GET', `/api/orders/${o.id}/doc-requests`)).body.requests;
  const ins = reqs.find((x) => x.item_id === 'insurer_docs');
  const d = (await owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from('скан'), {
    raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('акт.pdf') } })).body.document;
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/doc-requests/${ins.id}/attach`, { document_id: d.id })).status, 200);
  p = (await msgs(spec)).body.phrases;
  assert.deepEqual(p.map((x) => x.id), ['access', 'address', 'docs', 'cd_police', 'cd_euro', 'cd_repair']);
  // Файл удалили — документ снова не получен: фраза вернулась.
  await S.sql`update documents set deleted_at = now() where id = ${d.id}`;
  assert.ok((await msgs(spec)).body.phrases.some((x) => x.id === 'cd_insurer'));
  // Фразы только подставляются: переписка пуста.
  assert.equal((await msgs(spec)).body.messages.length, 0);
});
