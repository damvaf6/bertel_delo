// Запрос недостающих документов (задача 2.64): исполнитель одной кнопкой просит документы из списка услуги или своими
// словами; заказчик видит список с отметками и загружает файл к каждому; уведомления обеим сторонам; журнал дела.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry, validateModule } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';

let S, owner, dispatcher, spec, stranger;
const FIELDS = { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, Документная ул., 7' };

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990002601');
  dispatcher = await login(S, '+79990002602');
  spec = await login(S, '+79990002603');
  stranger = await login(S, '+79990002604');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty'], ['expertise', 'vehicle']] });
});
after(async () => { await S?.close(); });

async function inWork(title, service = 'realty', fields = FIELDS) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service, title })).body.order;
  const r = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  return o;
}
const upload = async (c, o, name) => (await c.req('POST', `/api/orders/${o.id}/documents`, Buffer.from('скан'), {
  raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name) } })).body.document;
const events = async (u, event) => (await S.sql`select count(*)::int as n from notifications where user_id = ${u.user.id} and event = ${event}`)[0].n;

test('список документов — в описании модуля, по виду услуги; ошибки описания не принимаются', () => {
  const reg = createRegistry([expertise]);
  const realty = reg.requestDocs('expertise', 'realty').map((d) => d.id);
  assert.ok(realty.includes('egrn') && realty.includes('tech_plan') && !realty.includes('pts'), realty.join());
  const vehicle = reg.requestDocs('expertise', 'vehicle').map((d) => d.id);
  assert.ok(vehicle.includes('pts') && vehicle.includes('sts') && !vehicle.includes('egrn'), vehicle.join());
  // Без services — для всех услуг; определение суда (2.66) — только когда экспертизу назначил суд.
  for (const s of expertise.services) assert.ok(reg.requestDocs('expertise', s.id, 'court').some((d) => d.id === 'court_order'), s.id);
  assert.ok(!reg.requestDocs('expertise', 'realty', 'contract').some((d) => d.id === 'court_order'));
  assert.deepEqual(reg.requestDocs('expertise', 'нет'), []);
  const bad = (request_docs) => assert.throws(() => validateModule({ ...expertise, request_docs }));
  bad([{ id: 'x', title: '' }]);
  bad([{ id: 'x', title: 'Документ', services: ['нет-такой'] }]);
  bad([{ id: 'x', title: 'Документ', extra: 1 }]);
  bad([{ id: 'x', title: 'Документ', basis: ['нет-такого'] }]);
  bad([{ id: 'x', title: 'Документ', basis: [] }]);
  bad([{ id: 'x', title: 'А' }, { id: 'x', title: 'Б' }]);
});

test('исполнитель запрашивает документы, заказчик загружает к каждому — отметки, уведомления, журнал', async () => {
  const o = await inWork('Квартира: запрос документов');
  const list = (c) => c.req('GET', `/api/orders/${o.id}/doc-requests`);
  const ask = (body, c = spec) => c.req('POST', `/api/orders/${o.id}/doc-requests`, body);
  // Пока исполнитель не принял дело — запросить нельзя.
  assert.equal((await ask({ items: ['egrn'] })).body.error, 'not_in_work');
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  const before = (await list(spec)).body;
  assert.equal(before.can_request, true);
  assert.ok(before.catalog.some((c) => c.id === 'egrn' && c.hint && !c.open));
  // Заказчик и диспетчер не запрашивают; посторонний не видит.
  assert.equal((await ask({ items: ['egrn'] }, owner)).status, 403);
  assert.equal((await ask({ items: ['egrn'] }, dispatcher)).status, 403);
  assert.equal((await list(stranger)).status, 404);
  assert.equal((await ask({})).body.error, 'nothing_selected');
  assert.equal((await ask({ items: ['pts'] })).status, 400, 'ПТС не из списка оценки квартиры');
  const r = await ask({ items: ['egrn', 'tech_plan'], custom: ['Справка об отсутствии долгов по коммунальным платежам'], note: 'Выписку — свежую' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.requested, 3);
  assert.equal(r.body.catalog.find((c) => c.id === 'egrn').open, true);
  assert.equal((await ask({ items: ['egrn'] })).body.error, 'already_requested', 'не дублируется');
  assert.equal(await events(owner, 'docs_requested'), 1);
  // Заказчик видит список: что нужно, подсказка, пояснение исполнителя, ничего не получено.
  const seen = (await list(owner)).body;
  assert.equal(seen.can_request, false);
  assert.equal(seen.can_upload, true);
  assert.deepEqual(seen.catalog, []);
  assert.deepEqual(seen.requests.map((x) => [x.title, x.done]), [['Выписка из ЕГРН', false], ['Технический паспорт БТИ или поэтажный план', false], ['Справка об отсутствии долгов по коммунальным платежам', false]]);
  assert.equal(seen.requests[0].note, 'Выписку — свежую');
  assert.ok(seen.requests[0].hint);
  // Заказчик прикладывает файл к выписке.
  const egrn = seen.requests[0];
  const doc = await upload(owner, o, 'Выписка ЕГРН.pdf');
  const attach = (c, rid, documentId) => c.req('POST', `/api/orders/${o.id}/doc-requests/${rid}/attach`, { document_id: documentId });
  assert.equal((await attach(spec, egrn.id, doc.id)).status, 403, 'исполнитель не прикладывает за заказчика');
  assert.equal((await attach(stranger, egrn.id, doc.id)).status, 404);
  assert.equal((await attach(owner, '999999', doc.id)).status, 404);
  const done = await attach(owner, egrn.id, doc.id);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body.requests[0].document, { id: doc.id, filename: 'Выписка ЕГРН.pdf' });
  assert.equal(done.body.requests[0].done, true);
  assert.equal(await events(spec, 'docs_received'), 1);
  // Исполнитель видит отметку и файл в документах дела.
  assert.equal((await list(spec)).body.requests[0].done, true);
  assert.ok((await spec.req('GET', `/api/orders/${o.id}/documents`)).body.documents.some((d) => d.id === doc.id));
  // Чужой файл (другой заявки) приложить нельзя.
  const other = await inWork('Другая заявка');
  const otherDoc = await upload(owner, other, 'чужой.pdf');
  assert.equal((await attach(owner, seen.requests[1].id, otherDoc.id)).status, 404);
  // Полученный документ не снимается; неполученный — снимает исполнитель.
  assert.equal((await spec.req('DELETE', `/api/orders/${o.id}/doc-requests/${egrn.id}`)).body.error, 'already_done');
  assert.equal((await owner.req('DELETE', `/api/orders/${o.id}/doc-requests/${seen.requests[1].id}`)).status, 403);
  const cancelled = await spec.req('DELETE', `/api/orders/${o.id}/doc-requests/${seen.requests[1].id}`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.requests.length, 2);
  // Заказчик удалил файл — просьба снова открыта; выписку можно запросить заново после получения.
  assert.equal((await owner.req('DELETE', `/api/documents/${doc.id}`)).status, 204);
  const reopened = (await list(owner)).body.requests[0];
  assert.deepEqual([reopened.done, reopened.document], [false, null]);
  // Журнал дела: заказчику — что просили и что приложено.
  const journal = (await owner.req('GET', `/api/orders/${o.id}/journal`)).body.journal.map((j) => j.what);
  assert.ok(journal.some((w) => w.startsWith('Исполнитель запросил документы: Выписка из ЕГРН')), journal.join('\n'));
  assert.ok(journal.includes('Заказчик приложил запрошенный документ: Выписка из ЕГРН'));
  assert.ok(journal.includes('Исполнитель снял просьбу о документе: Технический паспорт БТИ или поэтажный план'));
});

test('транспорт — свой список; завершённая заявка — без запросов и загрузки', async () => {
  const o = await inWork('Машина: документы', 'vehicle', { purpose: 'deal', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая Модель' });
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  const cat = (await spec.req('GET', `/api/orders/${o.id}/doc-requests`)).body.catalog.map((c) => c.id);
  assert.ok(cat.includes('pts') && !cat.includes('egrn'));
  const r = (await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['pts'] })).body;
  await S.sql`update orders set status = 'cancelled' where id = ${o.id}`;
  const v = (await owner.req('GET', `/api/orders/${o.id}/doc-requests`)).body;
  assert.equal(v.can_upload, false);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['sts'] })).body.error, 'not_in_work');
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/doc-requests/${r.requests[0].id}/attach`, { document_id: crypto.randomUUID() })).body.error, 'order_final');
});

test('определение суда уже приложено заказчиком — в списке для запроса его нет (2.79)', async () => {
  const o = await inWork('Квартира для суда: документы');
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  await S.sql`update orders set basis_kind = 'court' where id = ${o.id}`;
  const ids = async () => (await spec.req('GET', `/api/orders/${o.id}/doc-requests`)).body.catalog.map((c) => c.id);
  const before = await ids();
  assert.ok(before.includes('court_order') && before.includes('egrn'), before.join());
  const r = await owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from('скан'), {
    raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('Определение.pdf'), 'x-doc-kind': 'basis' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const after = await ids();
  assert.ok(!after.includes('court_order') && after.includes('egrn'), after.join());
  assert.ok((await spec.req('GET', `/api/orders/${o.id}/doc-requests`)).body.catalog.every((c) => !('basis' in c)));
});

test('готовые фразы заказчику (2.84): только исполнителю, адрес и запрошенные документы из дела, по виду услуги', async () => {
  const o = await inWork('Квартира: готовые фразы');
  const msgs = (c) => c.req('GET', `/api/orders/${o.id}/messages`);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  let p = (await msgs(spec)).body.phrases;
  assert.deepEqual(p.map((x) => x.id), ['access', 'address', 'docs']);
  assert.equal(p[0].title, 'Доступ на осмотр');
  assert.match(p[1].text, /в заявке указано: «г\. Москва, Документная ул\., 7»/);
  assert.match(p[2].text, /\[какие\]/, 'пока ничего не запрошено — исполнитель пишет сам');
  // Заказчик, диспетчер и посторонний фраз не получают.
  assert.deepEqual((await msgs(owner)).body.phrases, []);
  assert.deepEqual((await msgs(dispatcher)).body.phrases, []);
  assert.equal((await msgs(stranger)).status, 404);
  // Запрошенные и ещё не присланные документы — в тексте по названию; присланный — уходит из фразы.
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['egrn', 'tech_plan'] })).status, 201);
  const reqs = (await owner.req('GET', `/api/orders/${o.id}/doc-requests`)).body.requests;
  const egrn = reqs.find((x) => x.item_id === 'egrn');
  const tech = reqs.find((x) => x.item_id === 'tech_plan');
  p = (await msgs(spec)).body.phrases;
  assert.ok(p[2].text.includes(egrn.title) && p[2].text.includes(tech.title), p[2].text);
  const d = await upload(owner, o, 'egrn.pdf');
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/doc-requests/${egrn.id}/attach`, { document_id: d.id })).status, 200);
  p = (await msgs(spec)).body.phrases;
  assert.ok(!p[2].text.includes(egrn.title) && p[2].text.includes(tech.title), p[2].text);
  // Фраза — только текст в поле: в переписке ничего не появилось, пока исполнитель не отправил сам.
  assert.equal((await msgs(spec)).body.messages.length, 0);
});

test('готовые фразы (2.84): у товара и документа — свои слова', async () => {
  const { messagePhrases } = await import('../../src/orders/phrases.mjs');
  const reg = createRegistry([expertise]);
  const goods = messagePhrases({ def: reg.service('expertise', 'goods'), fields: { location: 'у истца, г. Москва' } });
  assert.match(goods[0].text, /осмотр товара/);
  assert.match(goods[0].text, /не ремонтируйте и не разбирайте/);
  assert.match(goods[1].text, /где сейчас находится товар \(в заявке указано: «у истца, г\. Москва»\)/);
  const docSvc = expertise.services.find((s) => s.subject === 'document').id;
  const doc = messagePhrases({ def: reg.service('expertise', docSvc), fields: {} });
  assert.equal(doc[0].title, 'Передать оригинал');
  assert.match(doc[1].text, /где сейчас находится документ и у кого/);
  assert.ok(!doc.some((x) => /осмотр/.test(x.text)));
  const due = messagePhrases({ def: reg.service('expertise', 'realty'), now: new Date('2026-10-06T21:30:00Z') })[2].text;
  assert.match(due, /до 10 октября/, 'через 3 дня по Москве');
});
