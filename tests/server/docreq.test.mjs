// Запрос недостающих документов (задача 2.64): исполнитель одной кнопкой просит документы из списка услуги или своими
// словами; заказчик видит список с отметками и загружает файл к каждому; уведомления обеим сторонам; журнал дела.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid , docsAskedAgo } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry, validateModule } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';
import { assignmentDocs } from '../../src/ops/ai-ops.mjs';
import { docLong, docWait, docsWaiting } from '../../src/ops/docreq-ops.mjs';

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
  // 2.387: дата — по сроку этого дела (с запасом в рабочих днях), как считает сервер.
  const { docsDueIso, dayWords } = await import('../../src/orders/phrases.mjs');
  const near = addDays(todayMsk(), 3);
  await S.sql`update orders set deadline = ${near} where id = ${o.id}`;
  p = (await msgs(spec)).body.phrases;
  assert.ok(p[2].text.includes(`до ${dayWords(docsDueIso(new Date(), near))} —`), p[2].text);
});

test('готовые фразы (2.84): у товара и документа — свои слова', async () => {
  const { messagePhrases } = await import('../../src/orders/phrases.mjs');
  const reg = createRegistry([expertise]);
  const goods = messagePhrases({ def: reg.service('expertise', 'goods'), fields: { location: 'у истца, г. Москва' } });
  assert.match(goods[0].text, /осмотр товара/);
  assert.match(goods[0].text, /не ремонтируйте и не разбирайте/);
  assert.match(goods[1].text, /где сейчас находится товар \(в заявке указано: «у истца, г\. Москва»\)/);
  // Ущерб после ДТП (2.97): осмотр автомобиля, до осмотра не ремонтировать.
  const car = messagePhrases({ def: reg.service('expertise', 'car_damage'), fields: {} });
  assert.match(car[0].text, /осмотр автомобиля/);
  assert.match(car[0].text, /не ремонтируйте автомобиль/);
  const docSvc = expertise.services.find((s) => s.subject === 'document').id;
  const doc = messagePhrases({ def: reg.service('expertise', docSvc), fields: {} });
  assert.equal(doc[0].title, 'Передать оригинал');
  assert.match(doc[1].text, /где сейчас находится документ и у кого/);
  assert.ok(!doc.some((x) => /осмотр/.test(x.text)));
  const due = messagePhrases({ def: reg.service('expertise', 'realty'), now: new Date('2026-10-06T21:30:00Z') })[2].text;
  // 7 октября по Москве (ср) + 3 рабочих дня — пн 12 октября, а не суббота 10-го (2.387).
  assert.match(due, /до 12 октября/, 'через 3 рабочих дня по Москве');
});

test('2.387: «пришлите до …» — через 3 рабочих дня, не на выходной и праздник, с запасом 2 рабочих дня до срока дела', async () => {
  const { messagePhrases, docsDueIso } = await import('../../src/orders/phrases.mjs');
  const wed = new Date('2026-10-21T09:00:00Z');
  assert.equal(docsDueIso(wed), '2026-10-26', 'чт, пт, пн');
  // Пятница перед 4 ноября: пн 2, вт 3, праздник 4-го пропущен — чт 5 ноября.
  assert.equal(docsDueIso(new Date('2026-10-30T09:00:00Z')), '2026-11-05');
  // Новогодние каникулы — после них.
  assert.equal(docsDueIso(new Date('2026-12-29T09:00:00Z')), '2027-01-12');
  // Срок дела во вторник 27-го: за 2 рабочих дня — пт 23-го, раньше обычных трёх.
  assert.equal(docsDueIso(wed, '2026-10-27'), '2026-10-23');
  // Срок дела в понедельник 26-го: выходные не в счёт — пт 23 и чт 22: чт 22 октября.
  assert.equal(docsDueIso(wed, '2026-10-26'), '2026-10-22');
  // Срок далеко — обычные 3 рабочих дня; срок завтра или прошёл — не раньше следующего рабочего дня.
  assert.equal(docsDueIso(wed, '2026-12-01'), '2026-10-26');
  assert.equal(docsDueIso(wed, '2026-10-22'), '2026-10-22');
  assert.equal(docsDueIso(wed, '2026-10-01'), '2026-10-22');
  // Пятница вечером: следующий рабочий — понедельник, не суббота.
  assert.equal(docsDueIso(new Date('2026-10-23T18:00:00Z'), '2026-10-24'), '2026-10-26');
  const reg = createRegistry([expertise]);
  const docs = messagePhrases({ def: reg.service('expertise', 'realty'), openDocs: ['Выписка из ЕГРН'], deadline: '2026-10-27', now: wed })
    .find((x) => x.id === 'docs');
  assert.match(docs.text, /Пришлите их, пожалуйста, до 23 октября —/);
});

test('2.224: выписка ЕГРН старше 30 дней на дату оценки — подсказка в деле и в «Сегодня», свежая запрашивается одной кнопкой', async () => {
  const ru = (iso) => iso.split('-').reverse().join('.');
  const today = todayMsk();
  const putDoc = (o, body, name, kind) => owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from(body), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name), ...(kind ? { 'x-doc-kind': kind } : {}) } });
  const egrnText = (day) => `Выписка из Единого государственного реестра недвижимости об объекте недвижимости\n${ru(day)} № КУВИ-001/2026-12345678\nВид объекта недвижимости: Помещение\nКадастровая стоимость по состоянию на ${ru(addDays(today, -5))}`;
  const list = (o, c = spec) => c.req('GET', `/api/orders/${o.id}/doc-requests`);
  const todayRows = async () => (await spec.req('GET', '/api/today')).body.expert.egrn_old;

  // Без даты оценки — на сегодня; «по состоянию на» (дата кадастровой стоимости) — не дата выписки.
  const o = await inWork('Квартира: старая выписка ЕГРН');
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  assert.equal((await list(o)).body.egrn_old, null, 'выписки нет — подсказки нет');
  const old = addDays(today, -40);
  assert.equal((await putDoc(o, egrnText(old), 'Выписка ЕГРН.txt')).status, 201);
  let r = (await list(o)).body;
  assert.deepEqual({ ...r.egrn_old, id: undefined }, { id: undefined, name: 'Выписка ЕГРН.txt', page: 0, day: old, on: today, on_value: false, age: 40, asked: false });
  assert.ok((await todayRows()).some((x) => x.id === o.id && x.egrn.day === old));
  // Заказчик подсказки не видит.
  assert.equal((await list(o, owner)).body.egrn_old, null);

  // Дата оценки из задания (2.207) — через 20 дней после выписки: выписка годится.
  const o2 = await inWork('Квартира: выписка свежая на дату оценки');
  assert.equal((await spec.req('POST', `/api/orders/${o2.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  assert.equal((await putDoc(o2, egrnText(old), 'Выписка ЕГРН.txt')).status, 201);
  assert.equal((await putDoc(o2, `ЗАДАНИЕ НА ОЦЕНКУ\nДата оценки: ${ru(addDays(old, 20))}`, 'Задание на оценку.txt', 'basis')).status, 201);
  assert.equal((await list(o2)).body.egrn_old, null);
  assert.ok(!(await todayRows()).some((x) => x.id === o2.id));

  // Дата оценки — через 45 дней после выписки: устарела на дату оценки.
  const o3 = await inWork('Квартира: выписка старая на дату оценки');
  assert.equal((await spec.req('POST', `/api/orders/${o3.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  const early = addDays(today, -60);
  assert.equal((await putDoc(o3, egrnText(early), 'ЕГРН.txt')).status, 201);
  assert.equal((await putDoc(o3, `ЗАДАНИЕ НА ОЦЕНКУ\nДата оценки: ${ru(addDays(early, 45))}`, 'Задание на оценку.txt', 'basis')).status, 201);
  r = (await list(o3)).body;
  assert.equal(r.egrn_old.on, addDays(early, 45));
  assert.equal(r.egrn_old.on_value, true);
  assert.equal(r.egrn_old.age, 45);

  // «Запросить свежую выписку» — запрос документов с пояснением заказчику; подсказка остаётся «запрошена», из «Сегодня» уходит.
  const before = await events(owner, 'docs_requested');
  r = await spec.req('POST', `/api/orders/${o3.id}/doc-requests`, { items: ['egrn'], fresh_egrn: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const asked = r.body.requests.find((x) => x.item_id === 'egrn' && !x.done);
  assert.match(asked.note, new RegExp(`от ${ru(early).replace(/\./g, '\\.')} — старше 30 дней на дату оценки`));
  assert.equal(r.body.egrn_old.asked, true);
  assert.equal(await events(owner, 'docs_requested'), before + 1);
  assert.ok(!(await todayRows()).some((x) => x.id === o3.id));
  // Второй раз та же просьба не дублируется.
  assert.equal((await spec.req('POST', `/api/orders/${o3.id}/doc-requests`, { items: ['egrn'], fresh_egrn: true })).body.error, 'already_requested');

  // Заказчик прислал свежую — подсказки нет.
  const fresh = (await putDoc(o3, egrnText(addDays(early, 40)), 'Выписка ЕГРН новая.txt')).body.document;
  assert.equal((await owner.req('POST', `/api/orders/${o3.id}/doc-requests/${asked.id}/attach`, { document_id: fresh.id })).status, 200);
  assert.equal((await list(o3)).body.egrn_old, null);

  // Последняя выписка без распознанной даты — не судим (не держим подсказку вечно).
  assert.equal((await putDoc(o, 'Выписка из ЕГРН\nВид объекта недвижимости: Помещение', 'Выписка ЕГРН скан.txt')).status, 201);
  assert.equal((await list(o)).body.egrn_old, null);

  // 2.230: выписка на дом при оценке квартиры свежесть не решает — ни свежая, ни загруженная последней без даты.
  const o4 = await inWork('Квартира: старая выписка и выписка на дом');
  assert.equal((await spec.req('POST', `/api/orders/${o4.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  assert.equal((await putDoc(o4, egrnText(old), 'Выписка ЕГРН.txt')).status, 201);
  assert.equal((await putDoc(o4, 'Выписка из ЕГРН\nВид объекта недвижимости: Здание\nМатериал наружных стен: Панельные', 'Выписка ЕГРН дом.txt')).status, 201);
  assert.equal((await list(o4)).body.egrn_old?.day, old);
  assert.equal((await putDoc(o4, egrnText(addDays(today, -2)).replace('Помещение', 'Здание'), 'Выписка ЕГРН дом свежая.txt')).status, 201);
  assert.equal((await list(o4)).body.egrn_old?.name, 'Выписка ЕГРН.txt');
  // Свежая выписка на квартиру — подсказки нет.
  assert.equal((await putDoc(o4, egrnText(addDays(today, -1)), 'Выписка ЕГРН квартира.txt')).status, 201);
  assert.equal((await list(o4)).body.egrn_old, null);

  // Машина — выписки ЕГРН в списке услуги нет.
  const v = await inWork('Машина: выписка ни при чём', 'vehicle', { purpose: 'deal', region: 'moscow', vehicle_type: 'car', make_model: 'Лада Веста', year: 2020 });
  assert.equal((await spec.req('POST', `/api/orders/${v.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  assert.equal((await putDoc(v, egrnText(old), 'Выписка ЕГРН.txt')).status, 201);
  assert.equal((await list(v)).body.egrn_old, null);
});

test('2.224: дата выписки ЕГРН — «№ КУВИ», «Дата формирования», «Дата:»; дата кадастровой стоимости и регистрации — нет', async () => {
  const { egrnIssued } = await import('../../src/ai/report-checks.mjs');
  const day = (text) => egrnIssued([{ id: 'x', name: 'в', pages: [text] }])[0]?.day ?? null;
  assert.equal(day('Выписка\n02.09.2026 г. № КУВИ-001/2026-1'), '2026-09-02');
  assert.equal(day('Дата формирования выписки: 5 октября 2026 г.'), '2026-10-05');
  assert.equal(day('Выписка сформирована «12» мая 2026 г.'), '2026-05-12');
  assert.equal(day('Дата: 01.10.2026'), '2026-10-01');
  assert.equal(day('Кадастровая стоимость по состоянию на 01.01.2026'), null);
  assert.equal(day('Дата государственной регистрации: 01.01.2010\nДата присвоения кадастрового номера: 03.03.2003'), null);
  assert.equal(egrnIssued([{ id: 'x', name: 'в', pages: ['пусто', 'пусто', 'Дата: 01.10.2026'] }]).length, 0, 'только первые две страницы');
});

test('2.234: запрошенное не пришло 3 дня — «Напомнить заказчику» одной кнопкой, раз в сутки; строка в «Сегодня»', async () => {
  const o = await inWork('Квартира: документы не пришли');
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  const list = (c = spec) => c.req('GET', `/api/orders/${o.id}/doc-requests`);
  const remind = (c = spec) => c.req('POST', `/api/orders/${o.id}/doc-requests/remind`);
  const todayRow = async () => (await spec.req('GET', '/api/today')).body.expert.docs_wait.find((x) => x.id === o.id);
  const age = (days) => S.sql`update doc_requests set requested_at = now() - make_interval(days => ${days}) where order_id = ${o.id} and fulfilled_at is null`;
  // Ничего не запрошено — напоминать не о чем.
  assert.equal((await list()).body.wait, null);
  assert.equal((await remind()).body.error, 'not_waiting');
  const r = await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['egrn', 'tech_plan'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // Запросили два дня назад — ещё рано.
  await age(2);
  assert.equal((await list()).body.wait, null);
  assert.equal((await remind()).body.error, 'not_waiting');
  assert.equal(await todayRow(), undefined);
  // Три дня — строка в деле и в «Сегодня»: что ждём и сколько; заказчик её не видит, напомнить не может.
  const ago = docsAskedAgo();
  await S.sql`update doc_requests set requested_at = ${ago.at} where order_id = ${o.id} and fulfilled_at is null`;
  let w = (await list()).body.wait;
  assert.deepEqual({ ...w, since: undefined }, { titles: ['Выписка из ЕГРН', 'Технический паспорт БТИ или поэтажный план'],
    only_letter: false, since: undefined, days: ago.days, reminded_at: null, reminders: 0, can_remind: true, next_remind_at: null });
  assert.equal((await list(owner)).body.wait, null);
  assert.equal((await remind(owner)).status, 403);
  assert.equal((await remind(dispatcher)).status, 403);
  assert.equal((await remind(stranger)).status, 404);
  assert.deepEqual((await todayRow())?.wait.titles, w.titles);
  // Напомнили — уведомление заказчику (событие со ссылкой на заявку, без названий документов), журнал; второй раз — завтра.
  const before = await events(owner, 'docs_reminder');
  const ok = await remind();
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.wait.reminders, 1);
  assert.equal(ok.body.wait.can_remind, false);
  assert.ok(ok.body.wait.next_remind_at);
  assert.equal(await events(owner, 'docs_reminder'), before + 1);
  assert.equal(await events(spec, 'docs_reminder'), 0, 'себе не напоминаем');
  assert.equal((await S.sql`select count(*)::int as n from audit_log where action = 'doc_request.remind' and subject_id = ${o.id}`)[0].n, 1);
  assert.equal((await remind()).body.error, 'too_often');
  assert.equal(await events(owner, 'docs_reminder'), before + 1);
  assert.equal(await todayRow(), undefined, 'напомнили — до завтра строки нет');
  // Прошли сутки — снова можно; в «Сегодня» видно, когда напоминали.
  await S.sql`update doc_reminders set created_at = created_at - interval '25 hours' where order_id = ${o.id}`;
  w = (await list()).body.wait;
  assert.equal(w.can_remind, true);
  assert.ok((await todayRow())?.wait.reminded_at);
  // Заказчик прислал всё — напоминать не о чем, строки нет.
  for (const x of (await list(owner)).body.requests) {
    const doc = await upload(owner, o, `${x.title}.pdf`);
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/doc-requests/${x.id}/attach`, { document_id: doc.id })).status, 200);
  }
  assert.equal((await list()).body.wait, null);
  assert.equal(await todayRow(), undefined);
  assert.equal((await remind()).body.error, 'not_waiting');
  // Новый запрос — прежние напоминания не в счёт: через 3 дня можно напомнить сразу.
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { custom: ['Справка о зарегистрированных'] })).status, 201);
  const ago3 = docsAskedAgo(3);
  await S.sql`update doc_requests set requested_at = ${ago3.at} where order_id = ${o.id} and fulfilled_at is null`;
  await S.sql`update doc_reminders set created_at = ${new Date(ago3.at.getTime() - 2 * 3600_000)} where order_id = ${o.id}`;
  w = (await list()).body.wait;
  assert.deepEqual(w.titles, ['Справка о зарегистрированных']);
  assert.equal(w.can_remind, true);
});

test('2.248: после ИИ-проверки пришёл запрошенный документ — «проверьте заново» у ИИ-проверки и в «Сегодня»', async () => {
  const o = await inWork('Квартира: документ после ИИ-проверки');
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  const review = async (c = spec) => (await c.req('GET', `/api/orders/${o.id}/review`)).body.ai;
  const todayRow = async () => (await spec.req('GET', '/api/today')).body.expert.ai_recheck.find((x) => x.id === o.id);
  const asked = (await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['egrn', 'tech_plan'] })).body.requests;
  const rid = (item) => asked.find((r) => r.item_id === item).id;
  const attach = async (item, name) => {
    const doc = await upload(owner, o, name);
    assert.equal((await owner.req('POST', `/api/orders/${o.id}/doc-requests/${rid(item)}/attach`, { document_id: doc.id })).status, 200);
    return doc;
  };
  // Документ пришёл до ИИ-проверки — проверка его видела, подсказки нет.
  await attach('tech_plan', 'Техплан.pdf');
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/results`, Buffer.from('Отчёт об оценке квартиры'), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('Отчёт.txt') } })).status, 201);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/review/ai`)).status, 201);
  assert.equal((await review()).recheck, undefined);
  assert.equal(await todayRow(), undefined);
  // Выписка пришла после проверки — подсказка у ИИ-проверки (исполнителю и диспетчеру) и строка в «Сегодня».
  const egrn = await attach('egrn', 'Выписка.pdf');
  const r = (await review()).recheck;
  assert.equal(r.egrn, true);
  assert.deepEqual(r.docs.map((d) => [d.title, d.filename]), [['Выписка из ЕГРН', 'Выписка.pdf']]);
  assert.ok((await review(dispatcher)).recheck);
  assert.equal((await owner.req('GET', `/api/orders/${o.id}/review`)).body.ai, undefined, 'заказчику подсказки ИИ не видны');
  const row = await todayRow();
  assert.ok(row && row.recheck.egrn && row.recheck.review_at && row.recheck.docs.length === 1);
  // Новая ИИ-проверка — подсказка и строка уходят.
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/review/ai`)).status, 201);
  assert.equal((await review()).recheck, undefined);
  assert.equal(await todayRow(), undefined);
  // Заказчик удалил пришедший файл — не в счёт (просьба снова открыта); приложил заново — снова «проверьте заново».
  assert.equal((await owner.req('DELETE', `/api/documents/${egrn.id}`)).status, 204);
  assert.equal((await review()).recheck, undefined);
  await attach('egrn', 'Выписка свежая.pdf');
  assert.deepEqual((await review()).recheck.docs.map((d) => d.filename), ['Выписка свежая.pdf']);
  // Сдал на проверку (подпись здесь не проверяем — статус прямо в базе) — дело не в работе, строки в «Сегодня» нет.
  await S.sql`update orders set status = 'review', review_round = review_round + 1 where id = ${o.id}`;
  assert.equal(await todayRow(), undefined);
  assert.equal((await review(dispatcher)).recheck, undefined);
});

// 2.299: оценка для банка — в списке «задание на оценку от банка»; приложенный к просьбе файл — задание, как бы ни назывался.
test('2.299: задание на оценку от банка — только при цели «банк», уже приложенное не просится, файл к просьбе — задание', async () => {
  const reg = createRegistry([expertise]);
  const has = (service, fields) => reg.requestDocs('expertise', service, 'contract', fields).some((d) => d.id === 'bank_task');
  assert.ok(has('realty', { purpose: 'bank' }) && has('vehicle', { purpose: 'bank' }) && has('land', { purpose: 'bank' }));
  assert.ok(!has('realty', { purpose: 'deal' }) && !has('realty') && !has('handwriting', { purpose: 'bank' }));
  const bad = (when) => assert.throws(() => validateModule({ ...expertise, request_docs: [{ id: 'x', title: 'Документ', when }] }));
  bad({ field: 'нет-поля', in: ['bank'] });
  bad({ field: 'purpose', in: ['нет-значения'] });
  bad({ field: 'purpose', in: [] });
  bad({ field: 'address', in: ['x'] });
  bad({ field: 'purpose', in: ['bank'], extra: 1 });

  const o = await inWork('Квартира для банка: задание', 'realty', { ...FIELDS, purpose: 'bank' });
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  const ids = async () => (await spec.req('GET', `/api/orders/${o.id}/doc-requests`)).body.catalog.map((c) => c.id);
  assert.ok((await ids()).includes('bank_task'));
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['bank_task'] })).status, 201);
  const cat = (await spec.req('GET', `/api/orders/${o.id}/doc-requests`)).body.catalog.find((c) => c.id === 'bank_task');
  assert.equal(cat.open, true);
  const put = await owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from('ПАО Банк\nПросим провести оценку квартиры\nДата оценки: 01.10.2026'), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('скан.txt') } });
  assert.equal(put.status, 201, JSON.stringify(put.body));
  const order = await S.sql.one`select * from orders where id = ${o.id}`;
  assert.deepEqual(await assignmentDocs(S.sql, S.providers.storage, order), [], 'пока не приложен к просьбе — не задание');
  const [rq] = (await owner.req('GET', `/api/orders/${o.id}/doc-requests`)).body.requests;
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/doc-requests/${rq.id}/attach`, { document_id: put.body.document.id })).status, 200);
  assert.deepEqual((await assignmentDocs(S.sql, S.providers.storage, order)).map((d) => d.name), ['скан.txt']);
  const after = await ids();
  assert.ok(!after.includes('bank_task') && after.includes('egrn'), after.join());
});

// 2.306: оценка для банка, задания на оценку нет и не запрошено, а до срока 3 дня или меньше — в «Сегодня» «Запросите задание».
test('2.306: задания от банка нет и не запрошено, срок близко — строка в «Сегодня»; запросили или приложили — строки нет', async () => {
  const o = await inWork('Квартира для банка: срок близко', 'realty', { ...FIELDS, purpose: 'bank' });
  const deal = await inWork('Квартира для сделки: срок близко');
  for (const x of [o, deal]) assert.equal((await spec.req('POST', `/api/orders/${x.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  const rows = async () => (await spec.req('GET', '/api/today')).body.expert.bank_task;
  // Срок через 10 дней — рано.
  assert.ok(!(await rows()).some((x) => x.id === o.id));
  await S.sql`update orders set deadline = ${addDays(todayMsk(), 3)} where id = any(${[o.id, deal.id]}::uuid[])`;
  let r = await rows();
  const mine = r.find((x) => x.id === o.id);
  assert.ok(mine, JSON.stringify(r));
  assert.deepEqual(mine.bank_task, { item_id: 'bank_task', title: 'Задание на оценку от банка', days: 3 });
  assert.ok(!r.some((x) => x.id === deal.id), 'не для банка — строки нет');
  // Чужие не видят: заказчик и посторонний — без экспертной части.
  assert.equal((await owner.req('GET', '/api/today')).body.expert, null);
  assert.equal((await stranger.req('GET', '/api/today')).body.expert ?? null, null);
  // Просрочено — строка остаётся.
  await S.sql`update orders set deadline = ${addDays(todayMsk(), -1)} where id = ${o.id}`;
  assert.equal((await rows()).find((x) => x.id === o.id).bank_task.days, -1);
  // Запросили — строки нет; сняли просьбу — снова есть.
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['bank_task'] })).status, 201);
  assert.ok(!(await rows()).some((x) => x.id === o.id));
  const [rq] = (await spec.req('GET', `/api/orders/${o.id}/doc-requests`)).body.requests;
  assert.equal((await spec.req('DELETE', `/api/orders/${o.id}/doc-requests/${rq.id}`)).status, 200);
  assert.ok((await rows()).some((x) => x.id === o.id));
  // Задание уже в деле (письмо банка) — строки нет.
  const put = await owner.req('POST', `/api/orders/${o.id}/documents`, Buffer.from('ПАО Банк\nЗадание на оценку\nДата оценки: 01.10.2026'), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('Задание банка.txt') } });
  assert.equal(put.status, 201, JSON.stringify(put.body));
  assert.ok(!(await rows()).some((x) => x.id === o.id));
});

// 2.381: «не пришло 3 дня» — рабочих, по Москве: выходные и праздник 4 ноября не в счёт (как «Заказчик не отвечает», 2.380).
test('2.381: запрошенное не пришло 3 рабочих дня — выходные и праздник 4 ноября не в счёт', async () => {
  const msk = (s) => new Date(`${s}+03:00`);
  const asked = msk('2026-10-30T18:00:00'); // пятница, вечер
  // Понедельник: по календарю 3 дня, рабочих — меньше суток.
  assert.equal(docLong(asked, msk('2026-11-02T18:30:00')), false);
  // Четверг после праздника, полдень: по календарю почти 6 дней, рабочих — 2 дня и 18 часов.
  assert.equal(docLong(asked, msk('2026-11-05T12:00:00')), false);
  // Четверг вечером — 3 рабочих дня.
  assert.equal(docLong(asked, msk('2026-11-05T19:00:00')), true);
  // Будни подряд — как прежде, ровно 3 дня.
  assert.equal(docLong(msk('2026-10-19T10:00:00'), msk('2026-10-22T09:00:00')), false);
  assert.equal(docLong(msk('2026-10-19T10:00:00'), msk('2026-10-22T10:00:00')), true);
  // В деле, в «Сегодня» и у руководителя — та же мерка; «ждём N дн.» — по календарю.
  const o = await inWork('Квартира: запрос перед праздником');
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/doc-requests`, { items: ['egrn'] })).status, 201);
  await S.sql`update doc_requests set requested_at = ${asked} where order_id = ${o.id}`;
  const order = (await S.sql`select * from orders where id = ${o.id}`)[0];
  assert.equal(await docWait(S.sql, order, msk('2026-11-05T12:00:00')), null);
  const w = await docWait(S.sql, order, msk('2026-11-05T19:00:00'));
  assert.deepEqual([w.titles, w.days, w.can_remind], [['Выписка из ЕГРН'], 6, true]);
  assert.equal((await docsWaiting(S.sql, [order], msk('2026-11-05T12:00:00'))).get(o.id).long, false);
  assert.equal((await docsWaiting(S.sql, [order], msk('2026-11-05T19:00:00'))).get(o.id).long, true);
});
