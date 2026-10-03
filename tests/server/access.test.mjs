// «Чужие дела не видны никому»: для КАЖДОЙ операции ядра — кто может, кто нет.
// Последняя проверка сверяет: в реестре нет операций, не покрытых этой таблицей.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, client, makeOrg, addMember, setPlatformRole, ensurePaid, bridge, TEST_TOKEN, signResults, makeSpecialist } from '../helpers.mjs';
import { testExternalSignature } from '../../src/providers/sign.mjs';
import crypto from 'node:crypto';

const covered = new Set();
const cover = (id) => covered.add(id);

let S;
const U = {};        // клиенты
let orgA, orgB, inviteA;
let ownOrder, orgOrder, colleagueOrder;
let ownDoc, orgDoc;
let expertB, seniorB; // эксперт и старший организации Б (подпись организации, дела экспертов)

before(async () => {
  S = await startApp();
  // Роли: владелец, посторонний, руководитель, старший и два сотрудника организации A, руководитель чужой организации B,
  // диспетчер, администратор, приглашённый в A.
  const phones = {
    owner: '+79990000001', stranger: '+79990000002',
    headA: '+79990000011', memberA: '+79990000012', memberA2: '+79990000013', seniorA: '+79990000014',
    headB: '+79990000021', spec: '+79990000051', dispatcher: '+79990000031', admin: '+79990000032', invitee: '+79990000041',
  };
  for (const [k, p] of Object.entries(phones)) U[k] = await login(S, p);

  orgA = await makeOrg(S.sql, 'Тестовая экспертная организация А');
  orgB = await makeOrg(S.sql, 'Тестовая организация Б');
  await addMember(S.sql, orgA.id, U.headA.user.id, 'head');
  await addMember(S.sql, orgA.id, U.memberA.user.id, 'member');
  await addMember(S.sql, orgA.id, U.memberA2.user.id, 'member');
  await addMember(S.sql, orgA.id, U.seniorA.user.id, 'senior');
  await addMember(S.sql, orgB.id, U.headB.user.id, 'head');
  await setPlatformRole(S.sql, U.dispatcher.user.id, 'dispatcher');
  await setPlatformRole(S.sql, U.admin.user.id, 'admin');
  inviteA = (await U.headA.req('POST', `/api/orgs/${orgA.id}/invites`, { phone: phones.invitee, role: 'member' })).body.invite;

  ownOrder = (await U.owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Личная заявка владельца' })).body.order;
  orgOrder = (await U.memberA.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Заявка сотрудника А', org_id: orgA.id })).body.order;
  colleagueOrder = (await U.memberA2.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Заявка коллеги', org_id: orgA.id })).body.order;
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

test('без входа: все закрытые операции реестра — 401', async () => {
  const anon = client(S);
  const closed = S.app.locals.ops.filter((o) => o.auth === 'user');
  assert.ok(closed.length > 20);
  for (const op of closed) {
    const p = op.path.replace(/:[a-zA-Z]+/g, ownOrder.id);
    const r = await anon.req(op.method, p, op.method === 'GET' || op.method === 'DELETE' ? undefined : {});
    assert.equal(r.status, 401, `${op.id}: ${r.status}`);
  }
});

test('изменяющие запросы без признака нашей страницы отклоняются (подделка с чужого сайта)', async () => {
  const r = await U.owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'x' }, { csrf: false });
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
  assert.equal(r.body.orgs[0].name, orgA.name);
  assert.equal((await U.invitee.req('GET', '/api/me')).body.pending_invites, 1);
  assert.equal((await U.stranger.req('GET', '/api/me')).body.pending_invites, 0);
});

test('me.update: меняется только своё имя', async () => {
  cover('me.update');
  const r = await U.stranger.req('PATCH', '/api/me', { full_name: 'Тестовый Посторонний', id: U.owner.user.id, platform_role: 'admin' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.id, U.stranger.user.id);
  assert.equal(r.body.user.platform_role, null, 'служебную роль себе не назначить');
  const [owner] = await S.sql`select full_name from users where id = ${U.owner.user.id}`;
  assert.equal(owner.full_name, '');
  assert.equal((await U.stranger.req('PATCH', '/api/me', { full_name: '' })).status, 400);
});

test('orders.create: от имени чужой организации нельзя', async () => {
  cover('orders.create');
  assert.equal((await U.stranger.req('POST', '/api/orders', { module: 'expertise', service: 'realty', org_id: orgA.id, title: 'Подлог' })).status, 404);
  assert.equal((await U.headB.req('POST', '/api/orders', { module: 'expertise', service: 'realty', org_id: orgA.id, title: 'Подлог' })).status, 404);
  assert.equal((await U.owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', org_id: 'не-uuid', title: 'x' })).status, 404);
  assert.equal((await U.owner.req('POST', '/api/orders', { module: 'expertise', service: 'нет-такой', title: 'x' })).status, 400);
  const own = await U.headA.req('POST', '/api/orders', { module: 'expertise', service: 'realty', org_id: orgA.id, title: 'От руководителя' });
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

  const senior = await ids(U.seniorA);
  for (const id of [orgOrder.id, colleagueOrder.id]) assert.ok(senior.includes(id), 'старший видит дела сотрудников');
  assert.ok(!senior.includes(ownOrder.id));

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
  expectRead(await get(U.seniorA, orgOrder), true, 'старший');
  expectRead(await get(U.headB, orgOrder), false, 'руководитель чужой организации');
  assert.equal((await get(U.memberA, orgOrder)).body.access, 'write');
  assert.equal((await get(U.seniorA, orgOrder)).body.access, 'manage');
  assert.equal((await get(U.dispatcher, orgOrder)).body.access, 'read');
  assert.equal((await get(U.owner, ownOrder)).body.access, 'write');
  assert.equal((await get(U.headA, orgOrder)).body.order.org_name, orgA.name);
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

test('orders.transfer: передать дело может только руководитель или старший его организации и только её участнику', async () => {
  cover('orders.transfer');
  const tr = (c, o, userId) => c.req('PATCH', `/api/orders/${o.id}/responsible`, { user_id: userId });
  assert.equal((await tr(U.stranger, orgOrder, U.stranger.user.id)).status, 404);
  assert.equal((await tr(U.memberA2, orgOrder, U.memberA2.user.id)).status, 404, 'коллега не видит');
  assert.equal((await tr(U.headB, orgOrder, U.headB.user.id)).status, 404);
  assert.equal((await tr(U.memberA, orgOrder, U.memberA2.user.id)).status, 403, 'сотрудник своё дело сам не передаёт');
  assert.equal((await tr(U.dispatcher, orgOrder, U.memberA2.user.id)).status, 403);
  assert.equal((await tr(U.owner, ownOrder, U.stranger.user.id)).status, 403, 'личное дело не передаётся');
  assert.equal((await tr(U.headA, orgOrder, U.headB.user.id)).status, 404, 'не участнику организации — нельзя');
  assert.equal((await tr(U.headA, orgOrder, 'не-uuid')).status, 404);

  const r = await tr(U.seniorA, orgOrder, U.memberA2.user.id);
  assert.equal(r.status, 200);
  assert.equal(r.body.order.owner_user_id, U.memberA2.user.id);
  expectRead(await U.memberA.req('GET', `/api/orders/${orgOrder.id}`), false, 'прежний ведущий больше не видит');
  expectRead(await U.memberA2.req('GET', `/api/orders/${orgOrder.id}`), true, 'новый ведущий видит');
  assert.equal((await tr(U.headA, orgOrder, U.memberA.user.id)).status, 200, 'вернули обратно');
});

test('orgs.create и orgs.list: создатель — руководитель; каждый видит только свои организации', async () => {
  cover('orgs.create'); cover('orgs.list');
  const r = await U.stranger.req('POST', '/api/orgs', { name: 'Тестовое бюро постороннего', inn: '7707083893' });
  assert.equal(r.status, 201);
  assert.equal(r.body.my_role, 'head');
  const mine = (await U.stranger.req('GET', '/api/orgs')).body.orgs;
  assert.deepEqual(mine.map((o) => o.id), [r.body.org.id]);
  assert.deepEqual((await U.owner.req('GET', '/api/orgs')).body.orgs, []);
  assert.deepEqual((await U.memberA.req('GET', '/api/orgs')).body.orgs.map((o) => [o.id, o.my_role]), [[orgA.id, 'member']]);
  assert.equal((await U.stranger.req('POST', '/api/orgs', { name: 'x', inn: '123' })).status, 400);
  assert.equal((await U.stranger.req('POST', '/api/orgs', { name: '' })).status, 400);
});

test('orgs.get: участники и диспетчер — да; посторонний и чужая организация — нет', async () => {
  cover('orgs.get');
  const get = (c) => c.req('GET', `/api/orgs/${orgA.id}`);
  expectRead(await get(U.memberA), true, 'сотрудник');
  expectRead(await get(U.dispatcher), true, 'диспетчер');
  expectRead(await get(U.stranger), false, 'посторонний');
  expectRead(await get(U.headB), false, 'руководитель чужой организации');
  expectRead(await get(U.invitee), false, 'приглашённый, ещё не принявший');
  assert.equal((await get(U.headA)).body.manage, true);
  assert.equal((await get(U.seniorA)).body.manage, false);
  assert.equal((await U.owner.req('GET', '/api/orgs/не-uuid')).status, 404);
});

test('orgs.update: только руководитель', async () => {
  cover('orgs.update');
  const upd = (c, name) => c.req('PATCH', `/api/orgs/${orgA.id}`, { name });
  assert.equal((await upd(U.stranger, 'Захват')).status, 404);
  assert.equal((await upd(U.headB, 'Захват')).status, 404);
  assert.equal((await upd(U.memberA, 'Захват')).status, 403);
  assert.equal((await upd(U.seniorA, 'Захват')).status, 403);
  assert.equal((await upd(U.dispatcher, 'Захват')).status, 403);
  const r = await upd(U.headA, orgA.name);
  assert.equal(r.status, 200);
  assert.equal(r.body.org.name, orgA.name);
});

test('orgs.members: состав видят участники; телефоны — руководитель; нагрузку — руководитель и старший', async () => {
  cover('orgs.members');
  const list = (c) => c.req('GET', `/api/orgs/${orgA.id}/members`);
  expectRead(await list(U.stranger), false, 'посторонний');
  expectRead(await list(U.headB), false, 'чужая организация');
  const asMember = (await list(U.memberA)).body.members;
  assert.equal(asMember.length, 4);
  assert.ok(asMember.every((m) => m.phone === undefined && m.orders === undefined), 'сотруднику — без телефонов и нагрузки');
  const asSenior = (await list(U.seniorA)).body.members;
  assert.ok(asSenior.every((m) => m.phone === undefined && typeof m.orders === 'number'));
  const asHead = (await list(U.headA)).body.members;
  assert.ok(asHead.every((m) => /^\+7\d{10}$/.test(m.phone)));
  assert.equal(asHead.find((m) => m.user_id === U.memberA.user.id).orders, 1);
  assert.equal(asHead[0].role, 'head');
});

test('orgs.members.update: роль меняет только руководитель и только участнику своей организации', async () => {
  cover('orgs.members.update');
  const upd = (c, userId, role) => c.req('PATCH', `/api/orgs/${orgA.id}/members/${userId}`, { role });
  assert.equal((await upd(U.stranger, U.memberA2.user.id, 'head')).status, 404);
  assert.equal((await upd(U.headB, U.memberA2.user.id, 'head')).status, 404);
  assert.equal((await upd(U.memberA, U.memberA.user.id, 'head')).status, 403, 'сотрудник не повышает себя');
  assert.equal((await upd(U.seniorA, U.seniorA.user.id, 'head')).status, 403, 'старший не повышает себя');
  assert.equal((await upd(U.dispatcher, U.memberA2.user.id, 'head')).status, 403);
  assert.equal((await upd(U.headA, U.headB.user.id, 'member')).status, 404, 'не участник этой организации');
  assert.equal((await upd(U.headA, U.memberA2.user.id, 'boss')).status, 400);
  assert.equal((await upd(U.headA, U.memberA2.user.id, 'senior')).status, 200);
  assert.equal((await upd(U.headA, U.memberA2.user.id, 'member')).status, 200);
});

test('orgs.members.remove: убрать может только руководитель', async () => {
  cover('orgs.members.remove');
  const rm = (c, userId) => c.req('DELETE', `/api/orgs/${orgA.id}/members/${userId}`);
  assert.equal((await rm(U.stranger, U.memberA2.user.id)).status, 404);
  assert.equal((await rm(U.headB, U.memberA2.user.id)).status, 404);
  assert.equal((await rm(U.memberA, U.memberA2.user.id)).status, 403);
  assert.equal((await rm(U.seniorA, U.memberA2.user.id)).status, 403);
  assert.equal((await rm(U.dispatcher, U.memberA2.user.id)).status, 403);
  assert.equal((await rm(U.headA, U.headB.user.id)).status, 404);
  // Сам удаляемый — в отдельном тесте orgs.test.mjs (после удаления меняется видимость).
});

test('orgs.leave: выйти может только участник', async () => {
  cover('orgs.leave');
  const leave = (c) => c.req('POST', `/api/orgs/${orgA.id}/leave`);
  assert.equal((await leave(U.stranger)).status, 404);
  assert.equal((await leave(U.headB)).status, 404);
  assert.equal((await leave(U.dispatcher)).status, 403, 'диспетчер не участник');
  assert.equal((await leave(U.headA)).status, 409, 'единственный руководитель не уходит');
});

test('orgs.invites.list и orgs.invites.create: только руководитель', async () => {
  cover('orgs.invites.list'); cover('orgs.invites.create');
  for (const [c, code] of [[U.stranger, 404], [U.headB, 404], [U.memberA, 403], [U.seniorA, 403], [U.dispatcher, 403]]) {
    assert.equal((await c.req('GET', `/api/orgs/${orgA.id}/invites`)).status, code);
    assert.equal((await c.req('POST', `/api/orgs/${orgA.id}/invites`, { phone: '+79990000049' })).status, code);
  }
  const list = (await U.headA.req('GET', `/api/orgs/${orgA.id}/invites`)).body.invites;
  assert.deepEqual(list.map((i) => i.id), [inviteA.id]);
  assert.equal((await U.headB.req('GET', `/api/orgs/${orgB.id}/invites`)).body.invites.length, 0, 'чужие приглашения не видны');
});

test('invites.mine: только приглашения на свой номер', async () => {
  cover('invites.mine');
  assert.deepEqual((await U.invitee.req('GET', '/api/invites')).body.invites.map((i) => [i.id, i.org_name]), [[inviteA.id, orgA.name]]);
  assert.deepEqual((await U.headA.req('GET', '/api/invites')).body.invites, []);
  assert.deepEqual((await U.stranger.req('GET', '/api/invites')).body.invites, []);
});

test('invites.accept, invites.decline: только адресат; руководитель чужое приглашение не принимает', async () => {
  cover('invites.accept'); cover('invites.decline');
  for (const c of [U.headA, U.stranger, U.memberA, U.headB, U.dispatcher]) {
    assert.equal((await c.req('POST', `/api/invites/${inviteA.id}/accept`)).status, 404);
    assert.equal((await c.req('POST', `/api/invites/${inviteA.id}/decline`)).status, 404);
  }
  const [{ n }] = await S.sql`select count(*)::int as n from org_members where org_id = ${orgA.id}`;
  assert.equal(n, 4, 'состав не изменился');
});

test('invites.revoke: только руководитель организации; адресат отозвать не может', async () => {
  cover('invites.revoke');
  const revoke = (c) => c.req('DELETE', `/api/invites/${inviteA.id}`);
  for (const c of [U.invitee, U.stranger, U.memberA, U.seniorA, U.headB, U.dispatcher]) assert.equal((await revoke(c)).status, 404);
  assert.equal((await revoke(U.headA)).status, 204);
  assert.equal((await U.invitee.req('POST', `/api/invites/${inviteA.id}/accept`)).status, 404, 'отозванное не принять');
});

test('admin.*: только администратор; остальным — «не найдено»', async () => {
  cover('admin.users.find'); cover('admin.staff'); cover('admin.users.update');
  for (const c of [U.owner, U.headA, U.dispatcher]) {
    assert.equal((await c.req('GET', `/api/admin/users?phone=${encodeURIComponent('+79990000001')}`)).status, 404);
    assert.equal((await c.req('GET', '/api/admin/staff')).status, 404);
    assert.equal((await c.req('PATCH', `/api/admin/users/${c.user.id}`, { platform_role: 'admin' })).status, 404);
  }
  const [me] = await S.sql`select platform_role from users where id = ${U.dispatcher.user.id}`;
  assert.equal(me.platform_role, 'dispatcher', 'диспетчер себя не повысил');
  const found = await U.admin.req('GET', `/api/admin/users?phone=${encodeURIComponent('8 999 000-00-12')}`);
  assert.equal(found.status, 200);
  assert.equal(found.body.user.id, U.memberA.user.id);
  const staff = (await U.admin.req('GET', '/api/admin/staff')).body.users.map((u) => u.id).sort();
  assert.deepEqual(staff, [U.dispatcher.user.id, U.admin.user.id].sort());
});

// Заполненная заявка, готовая к отправке (договор — файл основания не нужен).
const READY = { deadline: '2099-01-01', fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 1' } };
function soon() {
  const d = new Date(Date.now() + 10 * 86400_000);
  return d.toISOString().slice(0, 10);
}

test('catalog: перечень услуг и статусов — любому вошедшему, без данных заявок', async () => {
  cover('catalog');
  const r = await U.stranger.req('GET', '/api/catalog');
  assert.equal(r.status, 200);
  const exp = r.body.modules.find((m) => m.id === 'expertise');
  assert.deepEqual(exp.services.map((s) => s.id), ['realty', 'land', 'vehicle', 'movable', 'goods', 'construction', 'handwriting']);
  assert.ok(exp.checks.length > 0);
  assert.equal(r.body.statuses[0].id, 'new');
});

test('orders.update: заполнять заявку может тот, кто её меняет; диспетчер только читает', async () => {
  cover('orders.update');
  const upd = (c, o, body) => c.req('PATCH', `/api/orders/${o.id}`, body);
  const body = { ...READY, deadline: soon() };
  assert.equal((await upd(U.stranger, ownOrder, body)).status, 404);
  assert.equal((await upd(U.headA, ownOrder, body)).status, 404, 'руководитель чужой организации');
  assert.equal((await upd(U.memberA2, orgOrder, body)).status, 404, 'коллега');
  assert.equal((await upd(U.headB, orgOrder, body)).status, 404, 'чужая организация');
  assert.equal((await upd(U.dispatcher, ownOrder, body)).status, 403);
  assert.equal((await upd(U.admin, ownOrder, body)).status, 403);
  const [before] = await S.sql`select fields from orders where id = ${ownOrder.id}`;
  assert.deepEqual(before.fields, {}, 'чужие правки не сохранились');
  assert.equal((await upd(U.owner, ownOrder, body)).status, 200);
  assert.equal((await upd(U.memberA, orgOrder, body)).status, 200, 'сотрудник — своё дело');
  assert.equal((await upd(U.seniorA, orgOrder, { title: 'Заявка сотрудника А' })).status, 200, 'старший — дело организации');
});

test('orders.status: шаги заказчика — только его стороне; шаги диспетчера — только диспетчеру; администратор только читает', async () => {
  cover('orders.status');
  const mk = async (c, extra = {}) => {
    const o = (await c.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Статусы', ...extra })).body.order;
    assert.equal((await c.req('PATCH', `/api/orders/${o.id}`, { ...READY, deadline: soon() })).status, 200);
    return o;
  };
  const st = async (c, o, to, reason) => {
    const [cur] = await S.sql`select status from orders where id = ${o.id}`;
    return c.req('POST', `/api/orders/${o.id}/status`, { to, reason, from: cur.status });
  };

  const own = await mk(U.owner);
  assert.equal((await st(U.stranger, own, 'matching')).status, 404);
  assert.equal((await st(U.headA, own, 'matching')).status, 404);
  assert.equal((await st(U.dispatcher, own, 'matching')).status, 403, 'диспетчер не отправляет за заказчика');
  assert.equal((await st(U.admin, own, 'cancelled')).status, 403, 'администратор не отменяет');
  assert.equal((await st(U.owner, own, 'matching')).status, 200);
  assert.equal((await st(U.owner, own, 'review')).status, 409, 'такого шага нет');
  assert.equal((await st(U.owner, own, 'closed')).status, 409);
  assert.equal((await st(U.admin, own, 'awaiting_executor')).status, 409, 'предложение — отдельная операция подбора');
  assert.equal((await st(U.dispatcher, own, 'awaiting_executor')).status, 409);
  await S.sql`insert into specialists (user_id) values (${U.spec.user.id})`;
  await S.sql`insert into specialist_permits (user_id, module, service) values (${U.spec.user.id}, 'expertise', 'realty')`;
  await ensurePaid(S.sql, own.id);
  assert.equal((await U.dispatcher.req('POST', `/api/orders/${own.id}/offer`, { specialist_id: U.spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await st(U.owner, own, 'in_work')).status, 403, 'принять дело может только исполнитель');
  assert.equal((await st(U.dispatcher, own, 'in_work')).status, 403);
  assert.equal((await st(U.stranger, own, 'in_work')).status, 404);
  assert.equal((await st(U.spec, own, 'in_work')).status, 200);

  const org = await mk(U.memberA, { org_id: orgA.id });
  assert.equal((await st(U.memberA2, org, 'matching')).status, 404, 'коллега');
  assert.equal((await st(U.headB, org, 'matching')).status, 404, 'чужая организация');
  assert.equal((await st(U.headA, org, 'matching')).status, 200, 'руководитель отправляет дело сотрудника');
  assert.equal((await st(U.seniorA, org, 'cancelled')).status, 200, 'старший отменяет до начала работ');
  const log = await S.sql`select to_status, side, actor_id from order_status_history where order_id = ${org.id} order by id`;
  assert.deepEqual(log.map((x) => [x.to_status, x.side]), [['new', 'customer'], ['matching', 'customer'], ['cancelled', 'customer']]);
  assert.equal(log[2].actor_id, U.seniorA.user.id);
});

test('специалисты и подбор: допуски — только администратор; подбор — только диспетчер; чужое дело исполнитель не видит', async () => {
  for (const id of ['specialist.me', 'specialist.me.update', 'specialists.list', 'specialists.upsert',
    'specialists.permit.add', 'specialists.permit.remove', 'orders.candidates', 'orders.offer']) cover(id);
  const target = U.memberA2.user.id;
  // Профиль и допуски выдаёт только администратор; диспетчер и обычный человек получают «не найдено».
  for (const who of ['owner', 'dispatcher', 'spec']) {
    assert.equal((await U[who].req('PUT', `/api/admin/specialists/${target}`, {})).status, 404, `${who}: профиль`);
    assert.equal((await U[who].req('POST', `/api/admin/specialists/${target}/permits`, { module: 'expertise', service: 'land' })).status, 404, `${who}: допуск`);
    assert.equal((await U[who].req('DELETE', `/api/admin/specialists/${target}/permits/expertise/realty`)).status, 404);
  }
  assert.equal((await U.admin.req('PUT', `/api/admin/specialists/${target}`, { regions: ['moscow'], capacity: 3 })).status, 200);
  assert.equal((await U.admin.req('POST', `/api/admin/specialists/${target}/permits`, { module: 'expertise', service: 'land' })).status, 201);
  assert.equal((await U.admin.req('POST', `/api/admin/specialists/${target}/permits`, { module: 'expertise', service: 'nope' })).status, 400);
  assert.equal((await U.admin.req('DELETE', `/api/admin/specialists/${target}/permits/expertise/land`)).status, 200);
  assert.equal((await U.admin.req('DELETE', `/api/admin/specialists/${target}/permits/expertise/land`)).status, 404);

  // Список специалистов — служебным; остальным «не найдено».
  assert.equal((await U.owner.req('GET', '/api/specialists')).status, 404);
  assert.equal((await U.spec.req('GET', '/api/specialists')).status, 404);
  assert.equal((await U.dispatcher.req('GET', '/api/specialists')).status, 200);
  assert.equal((await U.admin.req('GET', '/api/specialists')).status, 200);

  // Свой профиль: у специалиста он есть, у остальных пусто; менять приём дел может только сам специалист.
  assert.equal((await U.spec.req('GET', '/api/specialist/me')).body.specialist.user_id, U.spec.user.id);
  assert.equal((await U.owner.req('GET', '/api/specialist/me')).body.specialist, null);
  assert.equal((await U.owner.req('PATCH', '/api/specialist/me', { active: false })).status, 404);
  assert.equal((await U.spec.req('PATCH', '/api/specialist/me', { active: 'нет' })).status, 400);
  assert.equal((await U.spec.req('PATCH', '/api/specialist/me', { active: false })).body.specialist.active, false);
  assert.equal((await U.spec.req('PATCH', '/api/specialist/me', { active: true })).body.specialist.active, true);

  // Подбор и предложение: только диспетчер; заказчик, администратор, исполнитель и посторонние — нет.
  const o = (await U.owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Подбор' })).body.order;
  assert.equal((await U.owner.req('PATCH', `/api/orders/${o.id}`, { ...READY, deadline: soon() })).status, 200);
  assert.equal((await U.owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  const offer = (c) => c.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: U.spec.user.id, from: 'matching' });
  for (const who of ['owner', 'admin']) {
    assert.equal((await U[who].req('GET', `/api/orders/${o.id}/candidates`)).status, 403, `${who}: список подбора`);
    assert.equal((await offer(U[who])).status, 403, `${who}: предложение`);
  }
  for (const who of ['stranger', 'headB', 'spec', 'memberA']) {
    assert.equal((await U[who].req('GET', `/api/orders/${o.id}/candidates`)).status, 404, `${who}: список подбора`);
    assert.equal((await offer(U[who])).status, 404, `${who}: предложение`);
  }
  const cands = (await U.dispatcher.req('GET', `/api/orders/${o.id}/candidates`)).body.candidates;
  assert.ok(cands.some((c) => c.user_id === U.spec.user.id));
  assert.ok(!cands.some((c) => c.user_id === U.owner.user.id), 'в подборе только допущенные');
  // Дело не видно исполнителю, пока ему не предложили; после предложения — видно только оно, но не чужие.
  assert.equal((await U.spec.req('GET', `/api/orders/${o.id}`)).status, 404);
  await ensurePaid(S.sql, o.id);
  assert.equal((await offer(U.dispatcher)).status, 200);
  assert.equal((await U.spec.req('GET', `/api/orders/${o.id}`)).status, 200);
  assert.equal((await U.spec.req('GET', `/api/orders/${ownOrder.id}`)).status, 404);
  assert.ok((await U.spec.req('GET', '/api/orders')).body.orders.some((x) => x.id === o.id));
  // Исполнитель читает, но не правит и не загружает; документы заявки ему доступны только на чтение.
  assert.equal((await U.spec.req('PATCH', `/api/orders/${o.id}`, { title: 'моё' })).status, 403);
  assert.equal((await U.spec.req('PATCH', `/api/orders/${o.id}/responsible`, { user_id: U.spec.user.id })).status, 403);
  assert.equal((await U.spec.req('GET', `/api/orders/${o.id}/candidates`)).status, 403);
});

test('работа по делу: результат — только исполнитель, заказчику — после проверки; переписка; отметки проверки — только диспетчер', async () => {
  for (const id of ['results.upload', 'messages.list', 'messages.post', 'review.get', 'review.mark']) cover(id);
  const o = (await U.owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Работа по делу' })).body.order;
  assert.equal((await U.owner.req('PATCH', `/api/orders/${o.id}`, { ...READY, deadline: soon() })).status, 200);
  assert.equal((await U.owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await U.dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: U.spec.user.id, from: 'matching' })).status, 200);
  const result = (c, name = 'отчёт.pdf') => c.req('POST', `/api/orders/${o.id}/results`, Buffer.from('тестовый отчёт'), {
    raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name) },
  });

  // Переписка: пишут заказчик, исполнитель, диспетчер; администратор только читает; посторонние не видят.
  const post = (c, body) => c.req('POST', `/api/orders/${o.id}/messages`, { body });
  for (const who of ['owner', 'spec', 'dispatcher']) assert.equal((await post(U[who], `Сообщение: ${who}`)).status, 201, who);
  assert.equal((await post(U.admin, 'администратор')).status, 403);
  for (const who of ['stranger', 'headB', 'memberA', 'headA']) {
    assert.equal((await post(U[who], 'чужой')).status, 404, `${who}: писать`);
    assert.equal((await U[who].req('GET', `/api/orders/${o.id}/messages`)).status, 404, `${who}: читать`);
  }
  assert.equal((await post(U.owner, '   ')).status, 400, 'пустое сообщение');
  const seen = (await U.owner.req('GET', `/api/orders/${o.id}/messages`)).body;
  assert.deepEqual(seen.messages.map((m) => [m.side, m.mine]), [['customer', true], ['executor', false], ['dispatcher', false]]);
  assert.ok(seen.messages.every((m) => m.author_name === null), 'заказчик не видит имён (исполнителя в том числе)');
  assert.equal(seen.can_write, true);
  const adminView = (await U.admin.req('GET', `/api/orders/${o.id}/messages`)).body;
  assert.equal(adminView.messages.length, 3);
  assert.equal(adminView.can_write, false);

  // Результат: пока дело не принято — нельзя; загружает только исполнитель.
  assert.equal((await result(U.spec)).status, 409, 'дело ещё не принято');
  assert.equal((await U.spec.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  for (const who of ['owner', 'dispatcher', 'admin']) assert.equal((await result(U[who])).status, 403, `${who}: результат`);
  for (const who of ['stranger', 'headB']) assert.equal((await result(U[who])).status, 404, `${who}: результат`);
  const up = await result(U.spec);
  assert.equal(up.status, 201);
  const doc = up.body.document;
  assert.equal(doc.kind, 'result');
  // Заказчик не видит результат до проверки: ни в списке, ни ссылкой, ни удалить.
  const ownerDocs = (await U.owner.req('GET', `/api/orders/${o.id}/documents`)).body;
  assert.ok(!ownerDocs.documents.some((d) => d.id === doc.id));
  assert.equal(ownerDocs.results_hidden, true);
  assert.equal((await U.owner.req('GET', `/api/documents/${doc.id}/link`)).status, 404);
  assert.equal((await U.owner.req('DELETE', `/api/documents/${doc.id}`)).status, 404);
  assert.ok((await U.dispatcher.req('GET', `/api/orders/${o.id}/documents`)).body.documents.some((d) => d.id === doc.id));
  assert.equal((await U.dispatcher.req('GET', `/api/documents/${doc.id}/link`)).status, 200);
  assert.equal((await U.dispatcher.req('DELETE', `/api/documents/${doc.id}`)).status, 403);
  assert.equal((await U.stranger.req('GET', `/api/documents/${doc.id}/link`)).status, 404);
  // Свой несданный результат исполнитель может убрать; документы заказчика — нет.
  const extra = (await result(U.spec, 'лишний.pdf')).body.document;
  assert.equal((await U.spec.req('DELETE', `/api/documents/${extra.id}`)).status, 204);
  const custDoc = await upload(U.owner, o.id, 'заказчик.txt');
  assert.equal((await U.spec.req('DELETE', `/api/documents/${custDoc.id}`)).status, 403);
  assert.equal((await U.spec.req('GET', `/api/documents/${custDoc.id}/link`)).status, 200, 'документы заказчика исполнителю нужны для работы');

  // Проверка: до сдачи отметки не ставятся; подробности — диспетчеру и исполнителю, заказчику — итог.
  const mark = (c, check, body) => c.req('PUT', `/api/orders/${o.id}/review/${check}`, body);
  assert.equal((await mark(U.dispatcher, 'calculation', { verdict: 'ok', round: 0 })).status, 409);
  // Подпись УКЭП (2.5): подписывает только исполнитель свой результат; до выдачи заказчик подписи не видит.
  for (const id of ['signature.sign', 'signature.verify', 'signature.link']) cover(id);
  const sign = (c, d = doc) => c.req('POST', `/api/documents/${d.id}/sign`, { confirm: true });
  const verify = (c) => c.req('POST', `/api/documents/${doc.id}/signature/verify`);
  const sigLink = (c) => c.req('GET', `/api/documents/${doc.id}/signature/link`);
  assert.equal((await U.spec.req('POST', `/api/orders/${o.id}/status`, { to: 'review', from: 'in_work' })).status, 400, 'без подписи не сдать');
  for (const k of ['owner', 'stranger', 'headB']) assert.equal((await sign(U[k])).status, 404, k);
  for (const k of ['dispatcher', 'admin']) assert.equal((await sign(U[k])).status, 403, k);
  assert.equal((await sign(U.spec, custDoc)).status, 403, 'документ заказчика исполнитель не подписывает');
  assert.equal((await verify(U.spec)).status, 404, 'ещё не подписан');
  await signResults(S, U.spec, o.id);
  assert.equal((await sign(U.spec)).status, 409, 'второй раз не подписать');
  for (const k of ['spec', 'dispatcher', 'admin']) {
    assert.equal((await verify(U[k])).body.valid, true, k);
    assert.equal((await sigLink(U[k])).status, 200, k);
  }
  for (const k of ['owner', 'stranger', 'headB']) {
    assert.equal((await verify(U[k])).status, 404, k);
    assert.equal((await sigLink(U[k])).status, 404, k);
  }
  assert.equal((await U.spec.req('POST', `/api/orders/${o.id}/status`, { to: 'review', from: 'in_work' })).status, 200);
  assert.equal((await U.spec.req('DELETE', `/api/documents/${doc.id}`)).status, 409, 'сданный результат не убрать');
  assert.equal((await result(U.spec)).status, 409, 'после сдачи — только через доработку');
  const rv = (await U.dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  assert.equal(rv.round, 1);
  assert.equal(rv.can_mark, true);
  assert.equal(rv.details, true);
  assert.equal((await U.spec.req('GET', `/api/orders/${o.id}/review`)).body.can_mark, false);
  const ov = (await U.owner.req('GET', `/api/orders/${o.id}/review`)).body;
  assert.equal(ov.details, false);
  assert.equal(ov.checks, undefined, 'заказчику — только итог');
  for (const who of ['owner', 'spec', 'admin']) assert.equal((await mark(U[who], 'calculation', { verdict: 'ok', round: 1 })).status, 403, who);
  for (const who of ['stranger', 'headB']) {
    assert.equal((await mark(U[who], 'calculation', { verdict: 'ok', round: 1 })).status, 404, who);
    assert.equal((await U[who].req('GET', `/api/orders/${o.id}/review`)).status, 404, who);
  }
  assert.equal((await mark(U.dispatcher, 'нет-такого', { verdict: 'ok', round: 1 })).status, 404);
  assert.equal((await mark(U.dispatcher, 'calculation', { verdict: 'issue', round: 1 })).status, 400, 'замечание — с пояснением');
  assert.equal((await mark(U.dispatcher, 'calculation', { verdict: 'ok', round: 2 })).status, 409, 'не тот круг');
  for (const c of rv.checks) assert.equal((await mark(U.dispatcher, c.id, { verdict: 'ok', round: 1 })).status, 200);
  assert.equal((await U.dispatcher.req('POST', `/api/orders/${o.id}/status`, { to: 'done', from: 'review' })).status, 200);
  // Оплачено при заказе (1.6а): после проверки заказчик видит результат и скачивает, но не удаляет; итог — «всё в порядке».
  const after = (await U.owner.req('GET', `/api/orders/${o.id}/documents`)).body;
  assert.ok(after.documents.some((d) => d.id === doc.id && d.kind === 'result'));
  assert.equal(after.results_hidden, false);
  assert.equal((await U.owner.req('GET', `/api/documents/${doc.id}/link`)).status, 200);
  assert.equal((await U.owner.req('DELETE', `/api/documents/${doc.id}`)).status, 403);
  // Выдано: заказчик видит подпись, скачивает её и проверяет сам; подписать или переподписать не может.
  assert.equal(after.documents.find((d) => d.id === doc.id).signatures.expert.checked_ok, true);
  assert.equal((await verify(U.owner)).body.valid, true);
  assert.equal((await sigLink(U.owner)).status, 200);
  assert.equal((await sign(U.owner)).status, 403);
  for (const k of ['stranger', 'headB']) assert.equal((await verify(U[k])).status, 404, k);
  const sum = (await U.owner.req('GET', `/api/orders/${o.id}/review`)).body.summary;
  assert.equal(sum.ok, sum.total);
  assert.equal((await U.headA.req('GET', `/api/documents/${doc.id}/link`)).status, 404, 'чужая организация');
  // Закрытая заявка: переписка закрыта.
  assert.equal((await U.owner.req('POST', `/api/orders/${o.id}/status`, { to: 'closed', from: 'done' })).status, 200);
  assert.equal((await post(U.owner, 'после закрытия')).status, 409);
  assert.equal((await U.owner.req('GET', `/api/orders/${o.id}/messages`)).body.can_write, false);
});

test('деньги: цену — диспетчер; платит заказчик при заказе; суммы и документы — каждому свои; возвраты; сводка — служебным', async () => {
  for (const id of ['orders.money', 'orders.price', 'payments.create', 'payments.refresh', 'payouts.retry', 'refunds.retry', 'money.summary', 'payouts.mine']) cover(id);
  const o = (await U.owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Деньги' })).body.order;
  assert.equal((await U.owner.req('PATCH', `/api/orders/${o.id}`, { ...READY, deadline: soon() })).status, 200);
  assert.equal((await U.owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  const money = async (c) => (await c.req('GET', `/api/orders/${o.id}/money`));
  const price = (c, p) => c.req('PUT', `/api/orders/${o.id}/price`, { price: p });
  const pay = (c) => c.req('POST', `/api/orders/${o.id}/payments`);
  const refresh = (c) => c.req('POST', `/api/orders/${o.id}/payments/refresh`);
  const retry = (c) => c.req('POST', `/api/orders/${o.id}/payout/retry`);
  const retryRefund = (c, id = o.id) => c.req('POST', `/api/orders/${id}/refund/retry`);

  // Цена: только диспетчер и только в подборе.
  for (const who of ['owner', 'admin']) assert.equal((await price(U[who], '15000')).status, 403, `${who}: цена`);
  for (const who of ['stranger', 'headB', 'spec', 'headA']) {
    assert.equal((await price(U[who], '15000')).status, 404, `${who}: цена`);
    assert.equal((await money(U[who])).status, 404, `${who}: деньги`);
  }
  assert.equal((await price(U.dispatcher, 'дорого')).status, 400);
  assert.equal((await price(U.dispatcher, '0')).status, 400);
  assert.equal((await price(U.dispatcher, '15000,555')).status, 400);
  const priced = await price(U.dispatcher, '15 000,50');
  assert.equal(priced.status, 200, JSON.stringify(priced.body));
  assert.equal(priced.body.money.price_kop, 1500050);
  assert.equal(priced.body.money.commission_kop, 300010, '20% платформе');
  assert.equal(priced.body.money.fee_kop, 1200040, '80% исполнителю');

  // Платит только сторона заказчика — при заказе, до предложения исполнителю.
  for (const who of ['dispatcher', 'admin']) assert.equal((await pay(U[who])).status, 403, `${who}: оплата`);
  for (const who of ['stranger', 'headB', 'headA', 'spec']) assert.equal((await pay(U[who])).status, 404, `${who}: оплата`);
  assert.equal((await money(U.owner)).body.money.can_pay, true);
  assert.equal((await money(U.dispatcher)).body.money.can_pay, false, 'кнопка оплаты — только заказчику');
  const p1 = await pay(U.owner);
  assert.equal(p1.status, 201);
  assert.ok(p1.body.confirmation_url.endsWith(`/kabinet.html#order=${o.id}`));
  const p2 = await pay(U.owner);
  assert.equal(p2.status, 200, 'незавершённый платёж не создаётся второй раз');
  assert.equal(p2.body.payment.id, p1.body.payment.id);
  // Состояние оплаты узнаёт заказчик (или служебные); посторонние — нет.
  for (const who of ['stranger', 'headB', 'spec']) assert.equal((await refresh(U[who])).status, 404, who);
  const paid = (await refresh(U.owner)).body.money;
  assert.equal(paid.paid, true);
  assert.equal(paid.payment.status, 'succeeded');
  assert.deepEqual(paid.documents, [], 'документы — при выдаче результата, не при оплате');
  assert.equal((await pay(U.owner)).status, 409, 'уже оплачено');

  assert.equal((await U.dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: U.spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await price(U.dispatcher, '1')).status, 409, 'после предложения цена не меняется');
  // Что видит каждый: заказчик — цену и оплату, исполнитель — своё вознаграждение, но не цену, не оплату и не вознаграждение платформы.
  const mo = (await money(U.owner)).body.money;
  assert.deepEqual([mo.price_kop, mo.fee_kop, mo.commission_kop, mo.payout], [1500050, null, null, null]);
  const ms = (await money(U.spec)).body.money;
  assert.deepEqual([ms.price_kop, ms.fee_kop, ms.commission_kop, ms.payment, ms.refund], [null, 1200040, null, null, null]);
  assert.equal((await refresh(U.spec)).status, 403);
  assert.equal((await money(U.admin)).body.money.commission_kop, 300010);

  assert.equal((await U.spec.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  assert.equal((await U.spec.req('POST', `/api/orders/${o.id}/results`, Buffer.from('отчёт'), { raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': 'r.pdf' } })).status, 201);
  await signResults(S, U.spec, o.id);
  assert.equal((await U.spec.req('POST', `/api/orders/${o.id}/status`, { to: 'review', from: 'in_work' })).status, 200);
  // Передать другому исполнителю — только диспетчер.
  for (const who of ['owner', 'spec', 'admin']) assert.equal((await U[who].req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'review', reason: 'x' })).status, 403, who);
  const rv = (await U.dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  for (const c of rv.checks) await U.dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
  assert.equal((await U.dispatcher.req('POST', `/api/orders/${o.id}/status`, { to: 'done', from: 'review' })).status, 200);

  // Выдача результата: заказчику — акт, исполнителю — отчёт агента (без имени заказчика) и выплата.
  const done = (await money(U.owner)).body.money;
  assert.deepEqual(done.documents.map((d) => d.kind), ['act'], 'заказчику — акт');
  assert.equal(done.documents[0].data.customer, (await S.sql`select full_name from users where id = ${U.owner.user.id}`)[0].full_name || 'Заказчик');
  const sp = (await money(U.spec)).body.money;
  assert.deepEqual(sp.documents.map((d) => d.kind), ['agent_report'], 'исполнителю — отчёт агента');
  assert.equal(sp.documents[0].data.customer, undefined, 'имени заказчика в отчёте исполнителю нет');
  assert.equal(sp.payout.status, 'succeeded');
  assert.equal(sp.payout.amount_kop, 1200040);
  assert.deepEqual((await money(U.admin)).body.money.documents.map((d) => d.kind), ['act', 'agent_report']);

  // Повтор выплаты и возврата — только диспетчер и только у неудавшихся.
  assert.equal((await retry(U.dispatcher)).status, 409);
  assert.equal((await retryRefund(U.dispatcher)).status, 409);
  for (const who of ['owner', 'spec', 'admin']) {
    assert.equal((await retry(U[who])).status, 403, who);
    assert.equal((await retryRefund(U[who])).status, 403, who);
  }
  for (const who of ['stranger', 'headB']) {
    assert.equal((await retry(U[who])).status, 404, who);
    assert.equal((await retryRefund(U[who])).status, 404, who);
  }

  // Возврат при отмене: документ о возврате — заказчику, не постороннему и не исполнителю.
  const c = (await U.owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Возврат' })).body.order;
  await U.owner.req('PATCH', `/api/orders/${c.id}`, { ...READY, deadline: soon() });
  await U.owner.req('POST', `/api/orders/${c.id}/status`, { to: 'matching', from: 'new' });
  await ensurePaid(S.sql, c.id);
  assert.equal((await U.owner.req('POST', `/api/orders/${c.id}/status`, { to: 'cancelled', from: 'matching' })).status, 200);
  const mc = (await U.owner.req('GET', `/api/orders/${c.id}/money`)).body.money;
  assert.deepEqual([mc.refund.status, mc.documents.map((d) => d.kind)], ['succeeded', ['refund']]);
  for (const who of ['stranger', 'headB', 'spec']) assert.equal((await U[who].req('GET', `/api/orders/${c.id}/money`)).status, 404, who);

  // Сводка — служебным; свои выплаты — каждому только свои.
  for (const who of ['owner', 'spec', 'headA']) assert.equal((await U[who].req('GET', '/api/money')).status, 404, who);
  const sum = (await U.dispatcher.req('GET', '/api/money')).body;
  assert.ok(sum.totals.received_kop >= 1500050);
  assert.ok(sum.totals.refunded_kop >= 1500000);
  assert.ok(sum.payouts.some((p) => p.order_id === o.id));
  assert.equal((await U.admin.req('GET', '/api/money')).status, 200);
  assert.ok((await U.spec.req('GET', '/api/payouts')).body.payouts.some((p) => p.order_id === o.id));
  assert.deepEqual((await U.owner.req('GET', '/api/payouts')).body.payouts, []);

  // Уведомление ЮKassa приходит без входа и без признака нашей страницы; неизвестный платёж — пропускается.
  const anon = client(S);
  assert.equal((await anon.req('POST', '/api/payments/notify', { event: 'payment.succeeded', object: { id: 'pay_нет' } }, { csrf: false })).status, 200);
  assert.equal((await U.owner.req('POST', `/api/orders/${o.id}/status`, { to: 'closed', from: 'done' })).status, 200);
});

test('уведомления: каждый видит и меняет только свои; название заявки — только пока заявка ему доступна', async () => {
  for (const id of ['notifications.list', 'notifications.read', 'notifications.settings', 'notifications.settings.update']) cover(id);
  // Приглашение в организацию A (в before) — уведомление приглашённому.
  const inv = (await U.invitee.req('GET', '/api/notifications')).body;
  assert.ok(inv.notifications.some((n) => n.title === 'Вас пригласили в организацию' && n.section === 'orgs'));
  const mine = inv.notifications[0].id;
  // Чужое уведомление не отметить: номер просто не находится; своё — отмечается.
  assert.equal((await U.stranger.req('POST', '/api/notifications/read', { ids: [mine] })).status, 200);
  assert.equal((await S.sql`select read_at from notifications where id = ${mine}`)[0].read_at, null, 'чужой не отметил');
  assert.equal((await U.stranger.req('GET', '/api/notifications')).body.notifications.length, 0);
  assert.equal((await U.invitee.req('POST', '/api/notifications/read', { ids: ['abc'] })).status, 400);
  assert.equal((await U.invitee.req('POST', '/api/notifications/read', { ids: [mine] })).body.unread, 0);
  // Настройки — свои; чужие не меняются.
  assert.equal((await U.stranger.req('PUT', '/api/notifications/settings', { type: 'order_progress', sms: false, user_id: U.owner.user.id })).status, 200);
  const ownerSet = (await U.owner.req('GET', '/api/notifications/settings')).body.settings;
  assert.equal(ownerSet.find((t) => t.type === 'order_progress').sms, true);
  assert.equal((await U.stranger.req('GET', '/api/notifications/settings')).body.settings.find((t) => t.type === 'order_progress').sms, false);
  assert.equal((await U.stranger.req('PUT', '/api/notifications/settings', { type: 'нет', sms: true })).status, 400);
  assert.equal((await U.stranger.req('PUT', '/api/notifications/settings', { type: 'money', sms: 'да' })).status, 400);
  // Виды в настройках: очередь диспетчера — только диспетчеру; дела исполнителя — специалисту.
  assert.ok(!ownerSet.some((t) => t.type === 'dispatch' || t.type === 'offers'));
  assert.ok((await U.dispatcher.req('GET', '/api/notifications/settings')).body.settings.some((t) => t.type === 'dispatch'));
  // Сотрудник ушёл из организации — в его старых уведомлениях по делам организации нет ни названия, ни ссылки.
  const o = (await U.memberA2.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Секретное дело организации', org_id: orgA.id })).body.order;
  assert.equal((await U.memberA2.req('PATCH', `/api/orders/${o.id}`, { ...READY, deadline: soon() })).status, 200);
  assert.equal((await U.memberA2.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  assert.equal((await U.dispatcher.req('POST', `/api/orders/${o.id}/messages`, { body: 'Уточните адрес' })).status, 201);
  const before = (await U.memberA2.req('GET', '/api/notifications')).body.notifications.find((n) => n.order_ref && n.title === 'Новое сообщение по заявке');
  assert.equal(before.order_title, 'Секретное дело организации');
  await S.sql`delete from org_members where org_id = ${orgA.id} and user_id = ${U.memberA2.user.id}`;
  const after = (await U.memberA2.req('GET', '/api/notifications')).body.notifications.find((n) => n.id === before.id);
  assert.equal(after.order_title, null);
  assert.equal(after.order_id, null);
  assert.equal(after.order_ref, before.order_ref);
  await S.sql`insert into org_members (org_id, user_id, role) values (${orgA.id}, ${U.memberA2.user.id}, 'member')`;
});

test('ИИ (1.8): разбор проблемы, ассистент, ИИ-проверка, модель — только свои и только тем, кому положено', async () => {
  for (const id of ['ai.problem', 'ai.consultation.order', 'assistant.get', 'assistant.ask', 'assistant.clear', 'review.ai', 'ai.status']) cover(id);
  // Разбор проблемы — только автору.
  const c = (await U.owner.req('POST', '/api/ai/problem', { text: 'Нужна оценка квартиры для нотариуса' })).body.consultation;
  for (const k of ['stranger', 'headA', 'dispatcher', 'admin']) {
    assert.equal((await U[k].req('POST', `/api/ai/consultations/${c.id}/order`, {})).status, 404, k);
  }
  assert.equal((await U.owner.req('POST', '/api/ai/consultations/not-a-uuid/order', {})).status, 404);
  assert.equal((await U.owner.req('POST', `/api/ai/consultations/${c.id}/order`, {})).status, 201);
  // Ассистент: память организации — только её участникам; заявку — только видимую и в «её» память.
  assert.equal((await U.headB.req('GET', `/api/assistant?org=${orgA.id}`)).status, 404);
  assert.equal((await U.dispatcher.req('GET', `/api/assistant?org=${orgA.id}`)).status, 404, 'служебные не читают чужую память');
  assert.equal((await U.stranger.req('POST', '/api/assistant', { text: 'x', order_id: ownOrder.id })).status, 404);
  assert.equal((await U.headB.req('POST', '/api/assistant', { text: 'x', order_id: orgOrder.id, org_id: orgB.id })).status, 404);
  assert.equal((await U.seniorA.req('POST', '/api/assistant', { text: 'x', order_id: colleagueOrder.id, org_id: orgA.id })).status, 201);
  assert.equal((await U.memberA.req('POST', '/api/assistant', { text: 'x', order_id: colleagueOrder.id, org_id: orgA.id })).status, 404, 'чужое дело коллеги');
  assert.equal((await U.headB.req('DELETE', `/api/assistant?org=${orgA.id}`)).status, 404);
  assert.equal((await U.seniorA.req('GET', `/api/assistant?org=${orgA.id}`)).body.messages.length, 2);
  // ИИ-проверка результата: заявка не в работе и не на проверке — никто; посторонний — «не найдено».
  for (const k of ['owner', 'dispatcher', 'admin']) assert.equal((await U[k].req('POST', `/api/orders/${ownOrder.id}/review/ai`)).status, 403, k);
  assert.equal((await U.stranger.req('POST', `/api/orders/${ownOrder.id}/review/ai`)).status, 404);
  // Сведения о модели — только администратору.
  assert.equal((await U.admin.req('GET', '/api/admin/ai')).status, 200);
  for (const k of ['owner', 'dispatcher', 'headA']) assert.equal((await U[k].req('GET', '/api/admin/ai')).status, 404, k);
});

test('черновик заключения (2.2): видят исполнитель и служебные; готовит и правит только исполнитель в работе; заказчику — нет', async () => {
  for (const id of ['draft.get', 'draft.ai', 'draft.save', 'draft.attach']) cover(id);
  // Заявка без исполнителя: заказчик и его организация черновика не видят, посторонние — «не найдено».
  for (const k of ['owner']) assert.equal((await U[k].req('GET', `/api/orders/${ownOrder.id}/draft`)).status, 403, k);
  for (const k of ['memberA', 'headA']) assert.equal((await U[k].req('GET', `/api/orders/${orgOrder.id}/draft`)).status, 403, k);
  for (const k of ['stranger', 'headB', 'spec']) assert.equal((await U[k].req('GET', `/api/orders/${ownOrder.id}/draft`)).status, 404, k);
  for (const k of ['dispatcher', 'admin']) {
    const r = await U[k].req('GET', `/api/orders/${ownOrder.id}/draft`);
    assert.equal(r.status, 200, k);
    assert.equal(r.body.can_edit, false, k);
  }
  for (const [method, path, body] of [['POST', 'draft/ai', {}], ['PUT', 'draft', { body: 'x' }], ['POST', 'draft/result', { confirm: true }]]) {
    for (const k of ['owner', 'dispatcher', 'admin']) assert.equal((await U[k].req(method, `/api/orders/${ownOrder.id}/${path}`, body)).status, 403, `${k} ${path}`);
    for (const k of ['stranger', 'headB']) assert.equal((await U[k].req(method, `/api/orders/${ownOrder.id}/${path}`, body)).status, 404, `${k} ${path}`);
  }
});

test('дистанционный осмотр (2.3): в деле видят те, кто видит заявку; ссылку выдаёт и отзывает только исполнитель в работе', async () => {
  for (const id of ['inspection.get', 'inspection.issue', 'inspection.revoke']) cover(id);
  for (const k of ['owner', 'dispatcher', 'admin']) {
    const r = await U[k].req('GET', `/api/orders/${ownOrder.id}/inspection`);
    assert.equal(r.status, 200, k);
    assert.equal(r.body.can_issue, false, k);
  }
  for (const k of ['memberA', 'headA', 'seniorA']) assert.equal((await U[k].req('GET', `/api/orders/${orgOrder.id}/inspection`)).status, 200, k);
  for (const k of ['stranger', 'headB', 'spec']) assert.equal((await U[k].req('GET', `/api/orders/${ownOrder.id}/inspection`)).status, 404, k);
  assert.equal((await U.memberA2.req('GET', `/api/orders/${orgOrder.id}/inspection`)).status, 404, 'коллега-сотрудник');
  for (const [method, path, body] of [['POST', 'inspection', { days: 3 }], ['DELETE', 'inspection/1', undefined]]) {
    for (const k of ['owner', 'dispatcher', 'admin']) assert.equal((await U[k].req(method, `/api/orders/${ownOrder.id}/${path}`, body)).status, 403, `${k} ${path}`);
    for (const k of ['stranger', 'headB']) assert.equal((await U[k].req(method, `/api/orders/${ownOrder.id}/${path}`, body)).status, 404, `${k} ${path}`);
  }
  // Страница владельца без секрета или с выдуманным — «не найдено», даже со входом.
  for (const token of [undefined, 'x', 'A'.repeat(43)]) {
    const headers = token ? { 'x-inspect-token': token } : {};
    assert.equal((await client(S).req('GET', '/api/inspect', undefined, { headers })).status, 404);
    assert.equal((await U.admin.req('POST', '/api/inspect/finish', {}, { headers })).status, 404);
    assert.equal((await client(S).req('POST', '/api/inspect/photos', Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]), {
      raw: true, headers: { ...headers, 'content-type': 'image/jpeg', 'x-step': 'facade' } })).status, 404);
  }
});

test('почта для заявок (1.9): адрес — только свой; организация — только своя; заявка по письму видна как обычная', async () => {
  for (const id of ['mail.get', 'mail.code', 'mail.confirm', 'mail.org', 'mail.delete']) cover(id);
  const sentTo = (to) => S.providers.mail.calls.filter((c) => c.method === 'send' && c.args.to === to).at(-1);
  assert.equal((await U.memberA.req('POST', '/api/me/mail', { email: 'member-a-test@example.ru' })).status, 200);
  const code = sentTo('member-a-test@example.ru').args.text.match(/\d{6}/)[0];
  // Чужой код к своей учётной записи не подходит: код привязан к человеку и адресу.
  assert.equal((await U.stranger.req('POST', '/api/me/mail/confirm', { code })).status, 400);
  assert.equal((await U.memberA.req('POST', '/api/me/mail/confirm', { code })).status, 200);
  assert.equal((await U.stranger.req('GET', '/api/me/mail')).body.address, null, 'чужой адрес не виден');
  // От имени организации — только участник; чужая организация — «не найдено».
  assert.equal((await U.memberA.req('PATCH', '/api/me/mail', { org_id: orgB.id })).status, 404);
  assert.equal((await U.memberA.req('PATCH', '/api/me/mail', { org_id: orgA.id })).status, 200);
  // Удаление — только своего: посторонний «удаляет» лишь своё (ничего), адрес сотрудника остаётся.
  assert.equal((await U.stranger.req('DELETE', '/api/me/mail')).status, 204);
  assert.equal((await U.memberA.req('GET', '/api/me/mail')).body.address.confirmed, true);
  // Заявка по письму — дело организации: видят сотрудник и руководитель; адрес — только стороне заказчика.
  const r = await fetch(`${S.base}/__test/mail/inbound`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-test-control': TEST_TOKEN, 'x-delo-request': '1' },
    body: JSON.stringify({ from: 'member-a-test@example.ru', subject: 'Квартира', text: 'Оценка квартиры в Москве' }),
  });
  const id = (await r.json()).inbound.order_id;
  expectRead(await U.headA.req('GET', `/api/orders/${id}`), true, 'руководитель');
  for (const k of ['stranger', 'headB', 'memberA2']) expectRead(await U[k].req('GET', `/api/orders/${id}`), false, k);
  assert.equal((await U.headA.req('GET', `/api/orders/${id}`)).body.mail.email, 'member-a-test@example.ru');
  assert.equal((await U.dispatcher.req('GET', `/api/orders/${id}`)).body.mail.email, null, 'служебным адрес заказчика не нужен');
  assert.equal((await U.memberA.req('DELETE', '/api/me/mail')).status, 204);
});

test('мост CRM (1.10): только по подписи моста; исполнитель видит только свои предложения из CRM', async () => {
  for (const id of ['specialist.crm', 'bridge.crm.profiles', 'bridge.crm.load', 'bridge.crm.offers']) cover(id);
  // Люди — даже администратор и диспетчер, с cookie и признаком страницы — мост не вызывают.
  for (const kind of ['profiles', 'load', 'offers']) {
    for (const k of ['admin', 'dispatcher', 'owner']) assert.equal((await U[k].req('POST', `/api/bridge/crm/${kind}`, {})).status, 404, `${k} ${kind}`);
    assert.equal((await client(S).req('POST', `/api/bridge/crm/${kind}`, {})).status, 404);
  }
  const consent = { platform: true, version: 'v1', given_at: '2026-09-01T00:00:00Z' };
  const r = await bridge(S, 'profiles', { profiles: [{ crm_id: 'acc-spec', phone: '+79990000051', email: 'spec-acc@example.test', consent }] });
  assert.equal(r.body.results[0].outcome, 'linked');
  await bridge(S, 'offers', { offers: [{ offer_id: 'acc-1', crm_id: 'acc-spec', customer: 'ГСУ СК России по г. Москве', language: 'английский',
    deadline: '2099-01-01', volume: { amount: 1, unit: 'pages' }, payment: 'pp1240', status: 'open' }] });
  assert.equal((await U.spec.req('GET', '/api/specialist/crm')).body.crm.offers.length, 1);
  for (const k of ['admin', 'dispatcher', 'owner', 'headA']) assert.deepEqual((await U[k].req('GET', '/api/specialist/crm')).body.crm, { linked: false, offers: [] }, k);
});

test('экспресс-выезд (2.4): ход выезда видят те, кто видит заявку; назначает исполнитель; помощник видит только свой выезд', async () => {
  for (const id of ['onsite.get', 'onsite.assign', 'onsite.cancel', 'visits.mine', 'visits.get', 'visits.photo', 'visits.data', 'visits.finish']) cover(id);
  const helper = await login(S, '+79990000052');
  await S.sql`insert into specialists (user_id, onsite) values (${helper.user.id}, true)`;
  const o = (await U.owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Экспресс владельца' })).body.order;
  const fields = { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, Выездная ул., 1' };
  assert.equal((await U.owner.req('PATCH', `/api/orders/${o.id}`, { fields, deadline: new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10), express: true })).status, 200);
  assert.equal((await U.owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await U.dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: U.spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await U.spec.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  const when = new Date(Date.now() + 86400_000).toISOString();
  const assign = (c) => c.req('POST', `/api/orders/${o.id}/onsite`, { helper_id: helper.user.id, planned_at: when });
  for (const k of ['owner', 'dispatcher', 'admin']) assert.equal((await assign(U[k])).status, 403, k);
  for (const k of ['stranger', 'headB', 'memberA']) assert.equal((await assign(U[k])).status, 404, k);
  assert.equal((await assign(helper)).status, 404, 'помощник заявку не видит');
  const a = await assign(U.spec);
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const vid = a.body.visit.id;
  for (const k of ['owner', 'dispatcher', 'admin', 'spec']) {
    const r = await U[k].req('GET', `/api/orders/${o.id}/onsite`);
    assert.equal(r.status, 200, k);
    assert.equal(r.body.visits[0].helper_name === null, k === 'owner', `${k}: имя помощника — только исполнителю и служебным`);
  }
  for (const k of ['stranger', 'headB']) assert.equal((await U[k].req('GET', `/api/orders/${o.id}/onsite`)).status, 404, k);
  assert.equal((await helper.req('GET', `/api/orders/${o.id}/onsite`)).status, 404, 'помощник — не через заявку');
  assert.equal((await helper.req('GET', `/api/orders/${o.id}`)).status, 404, 'помощник заявку не видит');
  // Выезд — только сам помощник: даже исполнитель и служебные идут через заявку.
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12)]);
  for (const k of ['owner', 'spec', 'dispatcher', 'admin', 'stranger']) {
    assert.equal((await U[k].req('GET', `/api/visits/${vid}`)).status, 404, k);
    assert.equal((await U[k].req('PUT', `/api/visits/${vid}/data`, { data: { notes: 'x' } })).status, 404, k);
    assert.equal((await U[k].req('POST', `/api/visits/${vid}/finish`, {})).status, 404, k);
    assert.equal((await U[k].req('POST', `/api/visits/${vid}/photos`, jpeg, { raw: true, headers: { 'content-type': 'image/jpeg', 'x-step': 'facade' } })).status, 404, k);
    assert.deepEqual((await U[k].req('GET', '/api/visits')).body.visits, [], `${k}: чужих выездов в списке нет`);
  }
  const hv = (await helper.req('GET', `/api/visits/${vid}`)).body.visit;
  assert.deepEqual(hv.object.map((f) => f.id), ['object_type', 'address'], 'помощник видит только поля для поиска объекта');
  assert.ok(!JSON.stringify(hv).includes('deal') && !JSON.stringify(hv).includes(U.owner.user.id), 'ни цели, ни заказчика');
  assert.equal((await helper.req('GET', '/api/visits')).body.visits.length, 1);
  // Отменить — только исполнитель.
  for (const k of ['owner', 'dispatcher']) assert.equal((await U[k].req('DELETE', `/api/orders/${o.id}/onsite/${vid}`)).status, 403, k);
  assert.equal((await U.stranger.req('DELETE', `/api/orders/${o.id}/onsite/${vid}`)).status, 404);
  assert.equal((await U.spec.req('DELETE', `/api/orders/${o.id}/onsite/${vid}`)).status, 204);
  assert.equal((await helper.req('PUT', `/api/visits/${vid}/data`, { data: { notes: 'x' } })).status, 410, 'отменённый выезд не правится');
});

test('подпись организации (2.5а): файлы видит и подписывает только руководитель организации исполнителя; загрузка — только своё', async () => {
  for (const id of ['signature.upload', 'orgsign.list', 'orgsign.link', 'orgsign.sign', 'orgsign.upload', 'orgsign.return']) cover(id);
  // Исполнитель работает от организации Б: подписывает он и руководитель Б (headB).
  const spec2 = expertB = await login(S, '+79990000053');
  const memberB = seniorB = await login(S, '+79990000022');
  await addMember(S.sql, orgB.id, spec2.user.id, 'member');
  await addMember(S.sql, orgB.id, memberB.user.id, 'senior');
  await makeSpecialist(S.sql, spec2.user.id);
  assert.equal((await U.spec.req('PATCH', '/api/specialist/me', { org_id: orgB.id })).status, 404, 'чужую организацию не выбрать');
  assert.equal((await spec2.req('PATCH', '/api/specialist/me', { org_id: orgB.id })).body.specialist.org.name, orgB.name);
  await S.sql`update users set full_name = 'Руководитель Б' where id = ${U.headB.user.id}`;
  const o = (await U.owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Подпись двоих' })).body.order;
  const fields = { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, Подписная ул., 2' };
  assert.equal((await U.owner.req('PATCH', `/api/orders/${o.id}`, { fields, deadline: new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10) })).status, 200);
  assert.equal((await U.owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await U.dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec2.user.id, from: 'matching' })).status, 200);
  assert.equal((await spec2.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  assert.equal((await spec2.req('PATCH', '/api/specialist/me', { org_id: null })).status, 409, 'организацию не сменить посреди дела');
  const body = Buffer.from('заключение двоих');
  const doc = (await spec2.req('POST', `/api/orders/${o.id}/results`, body, { raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': 'z.pdf' } })).body.document;
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  const up = (c, path, sig, confirm = '1') => c.req('POST', path, sig, { raw: true, headers: { 'content-type': 'application/octet-stream', 'x-confirm': confirm } });
  const expertSig = testExternalSignature({ digest, subject: 'Эксперт Внешний' });
  const orgSig = testExternalSignature({ digest, subject: 'Руководитель Б', org: orgB.name });
  // Загрузка подписи эксперта — только исполнитель свой файл.
  for (const k of ['owner', 'stranger', 'headB', 'headA']) assert.equal((await up(U[k], `/api/documents/${doc.id}/signature/upload`, expertSig)).status, 404, k);
  for (const k of ['dispatcher', 'admin']) assert.equal((await up(U[k], `/api/documents/${doc.id}/signature/upload`, expertSig)).status, 403, k);
  // Список и файлы на подпись организации — только руководитель Б; старший и сотрудник Б, чужие, служебные — нет.
  assert.equal((await U.headB.req('GET', `/api/orgs/${orgB.id}/signing`)).body.items[0].documents[0].id, doc.id);
  assert.equal((await memberB.req('GET', `/api/orgs/${orgB.id}/signing`)).status, 403, 'старший Б');
  for (const k of ['dispatcher', 'admin']) assert.equal((await U[k].req('GET', `/api/orgs/${orgB.id}/signing`)).status, 403, k);
  for (const k of ['stranger', 'headA', 'owner']) assert.equal((await U[k].req('GET', `/api/orgs/${orgB.id}/signing`)).status, 404, k);
  assert.deepEqual((await U.headA.req('GET', `/api/orgs/${orgA.id}/signing`)).body.items, [], 'у организации А нечего подписывать');
  for (const k of ['owner', 'stranger', 'headA', 'dispatcher', 'admin', 'spec']) {
    assert.equal((await U[k].req('GET', `/api/org-documents/${doc.id}/link`)).status, 404, k);
    assert.equal((await U[k].req('POST', `/api/org-documents/${doc.id}/sign`, { confirm: true })).status, 404, k);
    assert.equal((await up(U[k], `/api/org-documents/${doc.id}/signature/upload`, orgSig)).status, 404, k);
  }
  for (const c of [memberB, spec2]) assert.equal((await c.req('GET', `/api/org-documents/${doc.id}/link`)).status, 404, 'не руководитель');
  assert.equal((await U.headB.req('GET', `/api/org-documents/${doc.id}/link`)).status, 200);
  assert.equal((await U.headB.req('GET', `/api/orders/${o.id}`)).status, 404, 'саму заявку руководитель не видит');
  assert.equal((await U.headB.req('GET', `/api/documents/${doc.id}/link`)).status, 404, 'и файл — только через подпись');
  // Организация подписывает после эксперта.
  assert.equal((await U.headB.req('POST', `/api/org-documents/${doc.id}/sign`, { confirm: true })).body.error, 'expert_first');
  assert.equal((await up(spec2, `/api/documents/${doc.id}/signature/upload`, expertSig, '0')).status, 400, 'без подтверждения');
  assert.equal((await up(spec2, `/api/documents/${doc.id}/signature/upload`, testExternalSignature({ digest: 'ab'.repeat(32), subject: 'x' }))).body.error, 'bad_signature', 'чужой файл');
  const e = await up(spec2, `/api/documents/${doc.id}/signature/upload`, expertSig);
  assert.equal(e.status, 201, JSON.stringify(e.body));
  assert.equal(e.body.signature.method, 'upload');
  assert.equal(e.body.signature.signer, 'Эксперт Внешний');
  assert.equal((await spec2.req('POST', `/api/orders/${o.id}/status`, { to: 'review', from: 'in_work' })).body.error, 'not_signed_org', 'без подписи организации не сдать');
  assert.equal((await up(U.headB, `/api/org-documents/${doc.id}/signature/upload`, expertSig)).body.error, 'not_org_certificate');
  // Вернуть эксперту с замечанием (2.27) — только руководитель Б; возвраты видит только сам эксперт.
  const ret = (c, comment = 'Исправьте итог') => c.req('POST', `/api/org-documents/${doc.id}/return`, { comment });
  for (const k of ['owner', 'stranger', 'headA', 'dispatcher', 'admin', 'spec']) assert.equal((await ret(U[k])).status, 404, k);
  for (const c of [memberB, spec2]) assert.equal((await ret(c)).status, 404, 'не руководитель');
  assert.equal((await ret(U.headB, '  ')).status, 400, 'без замечания нельзя');
  assert.equal((await ret(U.headB)).status, 201);
  assert.equal((await ret(U.headB)).body.error, 'not_signed', 'подпись уже снята');
  for (const k of ['owner', 'dispatcher', 'admin']) {
    const b = (await U[k].req('GET', `/api/orders/${o.id}/documents`)).body;
    assert.equal(b.org_returns, undefined, `${k}: возвратов не видит`);
    assert.ok(!JSON.stringify(b).includes('Исправьте итог'), k);
  }
  assert.equal((await spec2.req('GET', `/api/orders/${o.id}/documents`)).body.org_returns[0].comment, 'Исправьте итог');
  assert.equal((await up(spec2, `/api/documents/${doc.id}/signature/upload`, expertSig)).status, 201, 'эксперт подписал заново');
  const g = await U.headB.req('POST', `/api/org-documents/${doc.id}/sign`, { confirm: true });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  assert.equal(g.body.signature.org, orgB.name);
  assert.equal((await up(U.headB, `/api/org-documents/${doc.id}/signature/upload`, orgSig)).status, 409, 'второй раз не подписать');
  assert.equal((await spec2.req('POST', `/api/orders/${o.id}/status`, { to: 'review', from: 'in_work' })).status, 200);
  assert.equal((await U.headB.req('POST', `/api/org-documents/${doc.id}/sign`, { confirm: true })).status, 409, 'после сдачи не подписать');
  assert.deepEqual((await U.headB.req('GET', `/api/orgs/${orgB.id}/signing`)).body.items, [], 'сданное ушло из списка');
  const d = (await U.dispatcher.req('GET', `/api/orders/${o.id}/documents`)).body;
  assert.equal(d.signature_org, orgB.name);
  const sigs = d.documents.find((x) => x.id === doc.id).signatures;
  assert.deepEqual([sigs.expert.method, sigs.org.method, sigs.org.title], ['upload', 'cabinet', 'Руководитель']);
  assert.equal((await U.dispatcher.req('POST', `/api/documents/${doc.id}/signature/verify`)).body.valid, true);
  assert.equal((await U.dispatcher.req('GET', `/api/documents/${doc.id}/signature/link?role=org`)).status, 200);
});

test('дела экспертов (2.16): видит только руководитель организации эксперта; без заказчика, полей, документов и переписки', async () => {
  cover('orgs.cases');
  // Продолжение проверки подписи организации: эксперт (+79990000053) работает от организации Б, его дело — на проверке.
  const spec2 = expertB;
  await S.sql`update users set full_name = 'Эксперт Б' where id = ${spec2.user.id}`;
  const r = await U.headB.req('GET', `/api/orgs/${orgB.id}/cases`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.cases.length, 1);
  const c = r.body.cases[0];
  assert.deepEqual(Object.keys(c).sort(), ['active', 'deadline', 'expert', 'fee_kop', 'order_ref', 'overdue', 'payout', 'service', 'status', 'status_name']);
  assert.equal(c.status, 'review');
  assert.equal(c.expert, 'Эксперт Б');
  assert.equal(c.fee_kop, 1_200_000, 'вознаграждение — 80% цены');
  const o = (await S.sql`select * from orders where executor_user_id = ${spec2.user.id}`)[0];
  const owner = (await S.sql`select phone from users where id = ${o.owner_user_id}`)[0];
  const raw = JSON.stringify(r.body);
  for (const secret of [o.id, o.owner_user_id, owner.phone, o.title, 'Подписная', 'deal', 'z.pdf']) assert.ok(!raw.includes(secret), `не раскрывает: ${secret}`);
  assert.deepEqual(r.body.load.map((l) => [l.full_name, l.in_work]), [['Эксперт Б', 1]]);
  assert.equal(r.body.money.waiting_kop, 1_200_000, 'ждёт выдачи — оплаченное дело на проверке');
  assert.equal(r.body.money.paid_kop, 0);
  // Нагрузка в составе: «дел» у эксперта — с делом в работе.
  assert.equal((await U.headB.req('GET', `/api/orgs/${orgB.id}/members`)).body.members.find((m) => m.user_id === spec2.user.id).orders, 1);
  // Старший и сотрудник (сам эксперт) — не руководитель; служебные — тоже нет.
  for (const c2 of [seniorB, spec2, U.dispatcher, U.admin]) assert.equal((await c2.req('GET', `/api/orgs/${orgB.id}/cases`)).status, 403);
  // Посторонний, руководитель чужой организации, заказчик — «не найдено».
  for (const k of ['stranger', 'headA', 'owner', 'spec']) assert.equal((await U[k].req('GET', `/api/orgs/${orgB.id}/cases`)).status, 404, k);
  // У организации А своих экспертов нет — пусто; дел Б там нет.
  const a = (await U.headA.req('GET', `/api/orgs/${orgA.id}/cases`)).body;
  assert.deepEqual([a.cases, a.load], [[], []]);
  // Эксперт ушёл из организации — его дела руководитель больше не видит.
  await S.sql`delete from org_members where org_id = ${orgB.id} and user_id = ${spec2.user.id}`;
  assert.deepEqual((await U.headB.req('GET', `/api/orgs/${orgB.id}/cases`)).body.cases, [], 'бывший сотрудник');
  await addMember(S.sql, orgB.id, spec2.user.id, 'member');
});

test('распределение в организации (2.17): дело организации; назначает и отказывается только её руководитель, заявку он не видит', async () => {
  for (const id of ['orgs.cases.assign', 'orgs.cases.decline']) cover(id);
  const spec2 = expertB;
  const events = async (userId, event) => (await S.sql`select count(*)::int as n from notifications where user_id = ${userId} and event = ${event}`)[0].n;
  const o = (await U.owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Дело организации Б' })).body.order;
  const fields = { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, Распределительная ул., 7' };
  assert.equal((await U.owner.req('PATCH', `/api/orders/${o.id}`, { fields, deadline: new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10) })).status, 200);
  assert.equal((await U.owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  // В подборе диспетчер видит организацию Б (в ней эксперт с допуском) и предлагает дело ей.
  const cands = (await U.dispatcher.req('GET', `/api/orders/${o.id}/candidates`)).body;
  const g = cands.orgs.find((x) => x.org_id === orgB.id);
  assert.ok(g, JSON.stringify(cands.orgs));
  assert.equal(g.experts, 1);
  assert.ok(!cands.orgs.some((x) => x.org_id === orgA.id), 'в организации А экспертов нет');
  assert.equal((await U.owner.req('POST', `/api/orders/${o.id}/offer`, { org_id: orgB.id, from: 'matching' })).status, 403, 'заказчик не предлагает');
  assert.equal((await U.stranger.req('POST', `/api/orders/${o.id}/offer`, { org_id: orgB.id, from: 'matching' })).status, 404);
  assert.equal((await U.dispatcher.req('POST', `/api/orders/${o.id}/offer`, { org_id: orgA.id, from: 'matching' })).body.error, 'not_eligible');
  const off = await U.dispatcher.req('POST', `/api/orders/${o.id}/offer`, { org_id: orgB.id, from: 'matching' });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.deepEqual([off.body.order.status, off.body.order.executor_user_id, off.body.order.offer_org_id], ['awaiting_executor', null, orgB.id]);
  assert.equal((await U.dispatcher.req('GET', `/api/orders/${o.id}`)).body.offer_org.name, orgB.name);
  assert.equal((await U.owner.req('GET', `/api/orders/${o.id}`)).body.offer_org, null, 'заказчику — не показываем');
  assert.equal(await events(U.headB.user.id, 'org_offer'), 1);
  assert.equal((await U.headB.req('GET', `/api/orders/${o.id}`)).status, 404, 'саму заявку руководитель не видит');
  // Руководитель Б видит дело в «Ждут назначения» — без заказчика и полей заявки — и своих экспертов с нагрузкой.
  const view = (await U.headB.req('GET', `/api/orgs/${orgB.id}/cases`)).body;
  assert.equal(view.pending.length, 1);
  const p = view.pending[0];
  assert.deepEqual(Object.keys(p).sort(), ['deadline', 'declined', 'experts', 'fee_kop', 'id', 'order_ref', 'overdue', 'service']);
  assert.equal(p.fee_kop, 1_200_000);
  assert.deepEqual(p.experts.map((x) => [x.user_id, x.in_work]), [[spec2.user.id, 1]]);
  const owner = (await S.sql`select phone from users where id = ${U.owner.user.id}`)[0];
  for (const secret of [U.owner.user.id, owner.phone, 'Дело организации Б', 'Распределительная', 'deal']) assert.ok(!JSON.stringify(view).includes(secret), `не раскрывает: ${secret}`);
  assert.deepEqual((await U.headA.req('GET', `/api/orgs/${orgA.id}/cases`)).body.pending, [], 'у организации А предложений нет');
  // Назначить и отказаться — только руководитель Б: чужие — «не найдено», старший, эксперт и служебные — «недостаточно прав».
  const assign = (c, orgId, sid = spec2.user.id) => c.req('POST', `/api/orgs/${orgId}/cases/${o.id}/assign`, { specialist_id: sid });
  const decline = (c, orgId, reason = 'Нет свободных экспертов') => c.req('POST', `/api/orgs/${orgId}/cases/${o.id}/decline`, { reason });
  for (const k of ['stranger', 'headA', 'owner', 'spec']) {
    assert.equal((await assign(U[k], orgB.id)).status, 404, k);
    assert.equal((await decline(U[k], orgB.id)).status, 404, k);
  }
  for (const c of [seniorB, spec2, U.dispatcher, U.admin]) {
    assert.equal((await assign(c, orgB.id)).status, 403);
    assert.equal((await decline(c, orgB.id)).status, 403);
  }
  assert.equal((await assign(U.headA, orgA.id)).status, 404, 'своей организацией чужое дело не взять');
  assert.equal((await decline(U.headA, orgA.id)).status, 404);
  assert.equal((await assign(U.headB, orgB.id, U.spec.user.id)).body.error, 'not_eligible', 'эксперт не из организации');
  assert.equal((await assign(U.headB, orgB.id)).status, 200);
  assert.equal((await assign(U.headB, orgB.id)).body.error, 'status_changed', 'дважды не назначить');
  assert.equal(await events(spec2.user.id, 'offer'), 2);
  assert.deepEqual((await U.headB.req('GET', `/api/orgs/${orgB.id}/cases`)).body.pending, [], 'назначенное ушло из «Ждут назначения»');
  // Эксперт отказывается — дело снова у руководителя, статус не меняется, эксперт дело больше не видит.
  const st = await spec2.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'awaiting_executor', reason: 'Занят' });
  assert.equal(st.status, 200, JSON.stringify(st.body));
  assert.equal(st.body.order.status, 'awaiting_executor');
  assert.equal((await spec2.req('GET', `/api/orders/${o.id}`)).status, 404);
  assert.equal(await events(U.headB.user.id, 'org_expert_declined'), 1);
  assert.equal(await events(U.dispatcher.user.id, 'declined'), 0, 'диспетчеру — нет: дело у организации');
  assert.equal((await U.headB.req('GET', `/api/orgs/${orgB.id}/cases`)).body.pending[0].declined, 'Занят', 'причина отказа эксперта');
  // Руководитель отказывается — дело диспетчеру в подбор; причина обязательна.
  assert.equal((await decline(U.headB, orgB.id, '')).body.error, 'reason_required');
  assert.equal((await decline(U.headB, orgB.id)).status, 200);
  assert.equal((await decline(U.headB, orgB.id)).status, 404, 'дело уже не у организации');
  const after1 = (await S.sql`select status, offer_org_id, executor_user_id from orders where id = ${o.id}`)[0];
  assert.deepEqual(after1, { status: 'matching', offer_org_id: null, executor_user_id: null });
  assert.equal(await events(U.dispatcher.user.id, 'org_declined'), 1);
  // Снова организации; диспетчер возвращает в подбор — руководителю сообщение, «Ждут назначения» пусто.
  assert.equal((await U.dispatcher.req('POST', `/api/orders/${o.id}/offer`, { org_id: orgB.id, from: 'matching' })).status, 200);
  assert.equal((await U.dispatcher.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'awaiting_executor', reason: 'Иначе' })).status, 200);
  assert.equal(await events(U.headB.user.id, 'org_offer_withdrawn'), 1);
  assert.deepEqual((await U.headB.req('GET', `/api/orgs/${orgB.id}/cases`)).body.pending, []);
  // Ещё раз: руководитель назначает, эксперт принимает — дело в «Делах экспертов» как обычное.
  assert.equal((await U.dispatcher.req('POST', `/api/orders/${o.id}/offer`, { org_id: orgB.id, from: 'matching' })).status, 200);
  assert.equal((await assign(U.headB, orgB.id)).status, 200);
  assert.equal((await spec2.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  const fin = (await U.headB.req('GET', `/api/orgs/${orgB.id}/cases`)).body;
  assert.equal(fin.cases.filter((c) => c.status === 'in_work').length, 1);
  const offers = await S.sql`select specialist_id, org_id, outcome from order_offers where order_id = ${o.id} order by id`;
  assert.deepEqual(offers.map((x) => [x.specialist_id ? 'эксперт' : 'организация', x.outcome]), [
    ['организация', 'accepted'], ['эксперт', 'declined'], ['организация', 'declined'], ['организация', 'withdrawn'],
    ['организация', 'accepted'], ['эксперт', 'accepted']]);
  // Дело в работе — назначить больше нельзя.
  assert.equal((await assign(U.headB, orgB.id)).body.error, 'status_changed');
});

test('реестр: открытые операции — только из утверждённого списка, остальные покрыты этой таблицей', () => {
  const PUBLIC = ['health', 'auth.code', 'auth.verify', 'files.memory', 'test.calls', 'test.script', 'test.reset', 'test.mail.inbound', 'stage.login', 'payments.notify',
    'inspect.view', 'inspect.photo', 'inspect.finish'];
  const ops = S.app.locals.ops;
  const extraPublic = ops.filter((o) => o.auth === 'public' && !PUBLIC.includes(o.id)).map((o) => o.id);
  assert.deepEqual(extraPublic, [], `новые открытые операции: ${extraPublic.join(', ')}`);
  // Без защиты от подделки запроса — только уведомление ЮKassa (оно содержимому не верит).
  assert.deepEqual(ops.filter((o) => o.csrf === false).map((o) => o.id), ['payments.notify']);
  // Операции моста — только три, все под /api/bridge/ (подпись ключом моста).
  assert.deepEqual(ops.filter((o) => o.auth === 'bridge').map((o) => o.id), ['bridge.crm.profiles', 'bridge.crm.load', 'bridge.crm.offers']);
  const unchecked = ops.filter((o) => o.auth !== 'public' && !covered.has(o.id)).map((o) => o.id);
  assert.deepEqual(unchecked, [], `операции без проверки «свой/чужой» в этой таблице: ${unchecked.join(', ')}`);
});
