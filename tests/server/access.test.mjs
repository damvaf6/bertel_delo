// «Чужие дела не видны никому»: для КАЖДОЙ операции ядра — кто может, кто нет.
// Последняя проверка сверяет: в реестре нет операций, не покрытых этой таблицей.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, client, makeOrg, addMember, setPlatformRole } from '../helpers.mjs';

const covered = new Set();
const cover = (id) => covered.add(id);

let S;
const U = {};        // клиенты
let orgA, orgB;
let ownOrder, orgOrder, colleagueOrder;
let ownDoc, orgDoc;

before(async () => {
  S = await startApp();
  // Роли: владелец, посторонний, руководитель и два сотрудника организации A, руководитель чужой организации B, диспетчер.
  const phones = {
    owner: '+79990000001', stranger: '+79990000002',
    headA: '+79990000011', memberA: '+79990000012', memberA2: '+79990000013',
    headB: '+79990000021', dispatcher: '+79990000031',
  };
  for (const [k, p] of Object.entries(phones)) U[k] = await login(S, p);

  orgA = await makeOrg(S.sql, 'Тестовая экспертная организация А');
  orgB = await makeOrg(S.sql, 'Тестовая организация Б');
  await addMember(S.sql, orgA.id, U.headA.user.id, 'head');
  await addMember(S.sql, orgA.id, U.memberA.user.id, 'member');
  await addMember(S.sql, orgA.id, U.memberA2.user.id, 'member');
  await addMember(S.sql, orgB.id, U.headB.user.id, 'head');
  await setPlatformRole(S.sql, U.dispatcher.user.id, 'dispatcher');

  ownOrder = (await U.owner.req('POST', '/api/orders', { title: 'Личная заявка владельца' })).body.order;
  orgOrder = (await U.memberA.req('POST', '/api/orders', { title: 'Заявка сотрудника А', org_id: orgA.id })).body.order;
  colleagueOrder = (await U.memberA2.req('POST', '/api/orders', { title: 'Заявка коллеги', org_id: orgA.id })).body.order;
  ownDoc = await upload(U.owner, ownOrder.id, 'владелец.txt');
  orgDoc = await upload(U.memberA, orgOrder.id, 'сотрудник.txt');
});
after(async () => { await S?.close(); });

async function upload(c, orderId, name, body = 'тестовый файл') {
  const r = await c.req('POST', `/api/orders/${orderId}/documents`, Buffer.from(body), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) },
  });
  return r.status === 201 ? r.body.document : r;
}

// Кто получает 200 и кто 404 при чтении.
function expectRead(r, allowed, who) {
  if (allowed) assert.equal(r.status, 200, `${who}: должен видеть (${r.status} ${JSON.stringify(r.body)})`);
  else assert.equal(r.status, 404, `${who}: не должен видеть (${r.status})`);
}

test('без входа: все закрытые операции — 401', async () => {
  const anon = client(S);
  const calls = [
    ['auth.logout', 'POST', '/api/auth/logout'],
    ['me', 'GET', '/api/me'],
    ['orders.create', 'POST', '/api/orders', { title: 'x' }],
    ['orders.list', 'GET', '/api/orders'],
    ['orders.get', 'GET', `/api/orders/${ownOrder.id}`],
    ['documents.list', 'GET', `/api/orders/${ownOrder.id}/documents`],
    ['documents.upload', 'POST', `/api/orders/${ownOrder.id}/documents`, 'x'],
    ['documents.link', 'GET', `/api/documents/${ownDoc.id}/link`],
    ['documents.delete', 'DELETE', `/api/documents/${ownDoc.id}`],
  ];
  for (const [id, m, p, b] of calls) {
    const r = await anon.req(m, p, b);
    assert.equal(r.status, 401, `${id}: ${r.status}`);
  }
});

test('изменяющие запросы без признака нашей страницы отклоняются (подделка с чужого сайта)', async () => {
  const r = await U.owner.req('POST', '/api/orders', { title: 'x' }, { csrf: false });
  assert.equal(r.status, 403);
  const d = await U.owner.req('DELETE', `/api/documents/${ownDoc.id}`, undefined, { csrf: false });
  assert.equal(d.status, 403);
});

test('me: только о себе', async () => {
  cover('me');
  const r = await U.memberA.req('GET', '/api/me');
  assert.equal(r.status, 200);
  assert.equal(r.body.user.id, U.memberA.user.id);
  assert.deepEqual(r.body.orgs.map((o) => o.org_id), [orgA.id]);
});

test('orders.create: от имени чужой организации нельзя', async () => {
  cover('orders.create');
  assert.equal((await U.stranger.req('POST', '/api/orders', { org_id: orgA.id, title: 'Подлог' })).status, 404);
  assert.equal((await U.headB.req('POST', '/api/orders', { org_id: orgA.id, title: 'Подлог' })).status, 404);
  assert.equal((await U.owner.req('POST', '/api/orders', { org_id: 'не-uuid', title: 'x' })).status, 404);
  assert.equal((await U.owner.req('POST', '/api/orders', { title: '' })).status, 400);
  const own = await U.headA.req('POST', '/api/orders', { org_id: orgA.id, title: 'От руководителя' });
  assert.equal(own.status, 201);
  assert.equal(own.body.order.owner_user_id, U.headA.user.id);
});

test('orders.list: каждый видит только своё; руководитель — всю организацию; диспетчер — всё', async () => {
  cover('orders.list');
  const ids = async (c) => (await c.req('GET', '/api/orders')).body.orders.map((o) => o.id);
  const owner = await ids(U.owner);
  assert.ok(owner.includes(ownOrder.id));
  assert.ok(!owner.includes(orgOrder.id));

  assert.deepEqual(await ids(U.stranger), []);
  assert.deepEqual(await ids(U.headB), []);

  const member = await ids(U.memberA);
  assert.ok(member.includes(orgOrder.id));
  assert.ok(!member.includes(colleagueOrder.id), 'сотрудник не видит дела коллеги');

  const head = await ids(U.headA);
  for (const id of [orgOrder.id, colleagueOrder.id]) assert.ok(head.includes(id), 'руководитель видит дела сотрудников');
  assert.ok(!head.includes(ownOrder.id));

  const disp = await ids(U.dispatcher);
  for (const id of [ownOrder.id, orgOrder.id, colleagueOrder.id]) assert.ok(disp.includes(id));
});

test('orders.get: свой / руководитель / диспетчер — да; посторонний, коллега, чужая организация — нет', async () => {
  cover('orders.get');
  const get = (c, o) => c.req('GET', `/api/orders/${o.id}`);
  expectRead(await get(U.owner, ownOrder), true, 'владелец');
  expectRead(await get(U.stranger, ownOrder), false, 'посторонний');
  expectRead(await get(U.headA, ownOrder), false, 'руководитель другой организации');
  expectRead(await get(U.dispatcher, ownOrder), true, 'диспетчер');

  expectRead(await get(U.memberA, orgOrder), true, 'сотрудник-автор');
  expectRead(await get(U.memberA2, orgOrder), false, 'коллега');
  expectRead(await get(U.headA, orgOrder), true, 'руководитель');
  expectRead(await get(U.headB, orgOrder), false, 'руководитель чужой организации');
  expectRead(await get(U.stranger, orgOrder), false, 'посторонний');

  assert.equal((await U.owner.req('GET', '/api/orders/не-uuid')).status, 404);
  assert.equal((await U.owner.req('GET', '/api/orders/00000000-0000-0000-0000-000000000000')).status, 404);
});

test('documents.list: те же правила, что для заявки', async () => {
  cover('documents.list');
  const list = (c, o) => c.req('GET', `/api/orders/${o.id}/documents`);
  expectRead(await list(U.owner, ownOrder), true, 'владелец');
  expectRead(await list(U.stranger, ownOrder), false, 'посторонний');
  expectRead(await list(U.memberA2, orgOrder), false, 'коллега');
  expectRead(await list(U.headA, orgOrder), true, 'руководитель');
  expectRead(await list(U.headB, orgOrder), false, 'чужая организация');
  expectRead(await list(U.dispatcher, orgOrder), true, 'диспетчер');
  const names = (await list(U.headA, orgOrder)).body.documents.map((d) => d.filename);
  assert.deepEqual(names, ['сотрудник.txt']);
  assert.equal((await list(U.headA, orgOrder)).body.documents[0].storage_key, undefined, 'ключ хранилища наружу не отдаётся');
});

test('documents.upload: в чужую заявку — нельзя; диспетчер только читает', async () => {
  cover('documents.upload');
  assert.equal((await upload(U.stranger, ownOrder.id, 'x.txt')).status, 404);
  assert.equal((await upload(U.memberA2, orgOrder.id, 'x.txt')).status, 404);
  assert.equal((await upload(U.headB, orgOrder.id, 'x.txt')).status, 404);
  assert.equal((await upload(U.dispatcher, ownOrder.id, 'x.txt')).status, 403);
  const byHead = await upload(U.headA, orgOrder.id, 'от руководителя.txt');
  assert.ok(byHead.id, 'руководитель добавляет файл в заявку сотрудника');
  const docs = (await U.owner.req('GET', `/api/orders/${ownOrder.id}/documents`)).body.documents;
  assert.equal(docs.length, 1, 'в чужую заявку ничего не добавилось');
});

test('documents.link: временная ссылка только тем, кто видит заявку', async () => {
  cover('documents.link');
  const link = (c, d) => c.req('GET', `/api/documents/${d.id}/link`);
  expectRead(await link(U.stranger, ownDoc), false, 'посторонний');
  expectRead(await link(U.headA, ownDoc), false, 'руководитель другой организации');
  expectRead(await link(U.memberA2, orgDoc), false, 'коллега');
  expectRead(await link(U.headB, orgDoc), false, 'чужая организация');
  expectRead(await link(U.dispatcher, orgDoc), true, 'диспетчер');

  const r = await link(U.headA, orgDoc);
  expectRead(r, true, 'руководитель');
  const file = await fetch(new URL(r.body.url, S.base));
  assert.equal(file.status, 200);
  assert.equal(await file.text(), 'тестовый файл');
  assert.match(file.headers.get('content-disposition'), /attachment/);
});

test('documents.delete: чужой не удаляет; удалённый файл больше не выдаётся', async () => {
  cover('documents.delete');
  const del = (c, d) => c.req('DELETE', `/api/documents/${d.id}`);
  assert.equal((await del(U.stranger, ownDoc)).status, 404);
  assert.equal((await del(U.memberA2, orgDoc)).status, 404);
  assert.equal((await del(U.headB, orgDoc)).status, 404);
  assert.equal((await del(U.dispatcher, ownDoc)).status, 403);

  const oldLink = (await U.owner.req('GET', `/api/documents/${ownDoc.id}/link`)).body.url;
  assert.equal((await del(U.owner, ownDoc)).status, 204);
  assert.equal((await U.owner.req('GET', `/api/documents/${ownDoc.id}/link`)).status, 404);
  assert.equal((await fetch(new URL(oldLink, S.base))).status, 404, 'старая ссылка на удалённый файл не работает');
  assert.equal((await del(U.owner, ownDoc)).status, 404);
  const log = await S.sql`select action from audit_log where subject_id = ${ownDoc.id} order by id`;
  assert.deepEqual(log.map((x) => x.action), ['document.upload', 'document.link', 'document.delete']);
});

test('auth.logout: выход закрывает только свою сессию', async () => {
  cover('auth.logout');
  const second = await login(S, '+79990000099');
  const r = await second.req('POST', '/api/auth/logout');
  assert.equal(r.status, 204);
  assert.equal((await second.req('GET', '/api/me')).status, 401);
  assert.equal((await U.owner.req('GET', '/api/me')).status, 200, 'чужие сессии живы');
});

test('реестр: открытые операции — только из утверждённого списка, остальные покрыты этой таблицей', () => {
  const PUBLIC = ['health', 'auth.code', 'auth.verify', 'files.memory', 'test.calls', 'test.script', 'test.reset'];
  const ops = S.app.locals.ops;
  const extraPublic = ops.filter((o) => o.auth === 'public' && !PUBLIC.includes(o.id)).map((o) => o.id);
  assert.deepEqual(extraPublic, [], `новые открытые операции: ${extraPublic.join(', ')}`);
  const unchecked = ops.filter((o) => o.auth !== 'public' && !covered.has(o.id)).map((o) => o.id);
  assert.deepEqual(unchecked, [], `операции без проверки «свой/чужой» в этой таблице: ${unchecked.join(', ')}`);
});
