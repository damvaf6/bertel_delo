// Мои похожие дела (2.129): эксперт в деле видит свои сданные дела той же услуги и того же вида объекта за год и открывает
// своё прошлое заключение как образец. Чужие дела, другой вид объекта, старше года, не сданные и без файла — не видны;
// в списке нет названия, адреса, имён и имени файла прошлого заказчика.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { kindField } from '../../src/ops/similar-ops.mjs';
import { createRegistry } from '../../src/modules/index.mjs';

let S, owner1, owner2, dispatcher, spec, other;
const today = todayMsk();
const FLAT = { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, ул. Садовая, д. 1, кв. 7', area: '50' };

before(async () => {
  S = await startApp();
  owner1 = await login(S, '+79990003801');
  owner2 = await login(S, '+79990003802');
  dispatcher = await login(S, '+79990003803');
  spec = await login(S, '+79990003804');
  other = await login(S, '+79990003805');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await owner1.req('PATCH', '/api/me', { full_name: 'Петров Пётр Сидорович' });
  for (const c of [spec, other]) await makeSpecialist(S.sql, c.user.id, { permits: [['expertise', 'realty'], ['expertise', 'vehicle']] });
});
after(async () => { await S?.close(); });

async function inWork(owner, fields, { who = spec, service = 'realty', title = 'Оценка квартиры' } = {}) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service, title })).body.order;
  const r = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(today, 9), fields });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: who.user.id, from: 'matching' })).status, 200);
  assert.equal((await who.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  return o;
}

// Сданное дело: файл заключения от исполнителя, статус «Готово» daysAgo дней назад.
async function done(owner, fields, { who = spec, daysAgo = 10, file = 'Отчёт Петров Садовая.pdf', title = 'Квартира Петрова на Садовой', service } = {}) {
  const o = await inWork(owner, fields, { who, title, service });
  if (file) {
    const r = await who.req('POST', `/api/orders/${o.id}/results`, Buffer.from('%PDF-1.4 отчёт'), { raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(file) } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  await S.sql`update orders set status = 'done' where id = ${o.id}`;
  await S.sql`insert into order_status_history (order_id, from_status, to_status, side, at)
              values (${o.id}, 'review', 'done', 'dispatcher', now() - make_interval(days => ${daysAgo}))`;
  return o;
}

test('вид объекта — первое поле выбора самой услуги; у услуги без такого поля — вся услуга', () => {
  const reg = createRegistry();
  assert.equal(kindField(reg.service('expertise', 'realty')).id, 'object_type');
  assert.equal(kindField(reg.service('expertise', 'vehicle')).id, 'vehicle_type');
  assert.equal(kindField(reg.service('expertise', 'goods')), null);
});

test('эксперт видит свои сданные дела того же вида объекта за год и открывает заключение; данных прошлого заказчика в списке нет', async () => {
  const flat = await done(owner1, FLAT, { daysAgo: 20 });
  const flatBank = await done(owner2, { ...FLAT, purpose: 'bank', address: 'Москва, Тверская 3' }, { daysAgo: 5, title: 'Заём Сидорова' });
  await done(owner1, { ...FLAT, address: 'Москва, Арбат 2' }, { daysAgo: 400 });                       // старше года
  await done(owner1, { ...FLAT, object_type: 'house', address: 'Московская обл., Истра' }, { daysAgo: 3 }); // другой вид
  await done(owner1, { ...FLAT, address: 'Москва, Пресня 4' }, { daysAgo: 3, who: other });           // чужое
  await done(owner1, { ...FLAT, address: 'Москва, Мира 9' }, { daysAgo: 3, file: null });             // без заключения
  await inWork(owner1, { ...FLAT, address: 'Москва, Цветной 5' });                                     // не сдано
  await done(owner1, { purpose: 'court', region: 'moscow', vehicle_type: 'car', make_model: 'Лада Веста' }, { service: 'vehicle', daysAgo: 3 }); // другая услуга

  const cur = await inWork(owner2, { ...FLAT, address: 'Москва, Новый Арбат 10' }, { title: 'Новая квартира' });
  const r = await spec.req('GET', `/api/orders/${cur.id}/similar`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.kind, 'Квартира');
  assert.deepEqual(r.body.cases.map((c) => c.id), [flat.id, flatBank.id], 'сначала та же цель (суд), потом остальные');
  const [c] = r.body.cases;
  assert.equal(c.same_purpose, true);
  assert.equal(c.kind, 'Квартира');
  assert.equal(c.purpose, 'Для суда');
  assert.equal(c.region, 'Москва');
  assert.equal(c.files.length, 1);
  assert.equal(c.files[0].type, 'PDF');
  const text = JSON.stringify(r.body);
  for (const bad of ['Петров', 'Садовая', 'Тверская', 'Сидоров', 'Квартира Петрова', '.pdf']) assert.ok(!text.includes(bad), `в списке нет «${bad}»`);

  // Открыть своё заключение — обычной ссылкой на документ своего дела; чужому эксперту — «не найдено».
  const link = await spec.req('GET', `/api/documents/${c.files[0].id}/link`);
  assert.equal(link.status, 200);
  assert.ok(link.body.url);
  assert.equal((await other.req('GET', `/api/documents/${c.files[0].id}/link`)).status, 404);

  // В новом деле ничего не появилось: документов нет, черновика нет.
  assert.equal((await spec.req('GET', `/api/orders/${cur.id}/documents`)).body.documents.length, 0);

  // Заказчик, диспетчер и другой эксперт — пусто или «не найдено».
  assert.deepEqual((await owner2.req('GET', `/api/orders/${cur.id}/similar`)).body, { kind: null, cases: [] });
  assert.deepEqual((await dispatcher.req('GET', `/api/orders/${cur.id}/similar`)).body, { kind: null, cases: [] });
  assert.equal((await other.req('GET', `/api/orders/${cur.id}/similar`)).status, 404);

  // Дело сдано — список больше не нужен.
  await S.sql`update orders set status = 'review' where id = ${cur.id}`;
  assert.deepEqual((await spec.req('GET', `/api/orders/${cur.id}/similar`)).body, { kind: null, cases: [] });
});

test('у другого эксперта своих похожих дел нет — пустой список', async () => {
  const cur = await inWork(owner1, { ...FLAT, address: 'Москва, Ленинский 30' }, { who: other });
  const r = await other.req('GET', `/api/orders/${cur.id}/similar`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.cases.map((c) => c.ref).length, 1, 'только своё сданное (Пресня)');
});
