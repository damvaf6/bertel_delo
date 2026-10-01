// «Чужие дела не видны никому»: для КАЖДОЙ операции ядра — кто может, кто нет.
// Последняя проверка сверяет: в реестре нет операций, не покрытых этой таблицей.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, client, makeOrg, addMember, setPlatformRole } from '../helpers.mjs';

const covered = new Set();
const cover = (id) => covered.add(id);

let S;
const U = {};        // клиенты
let orgA, orgB, inviteA;
let ownOrder, orgOrder, colleagueOrder;
let ownDoc, orgDoc;

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
  assert.deepEqual(exp.services.map((s) => s.id), ['realty', 'land', 'vehicle', 'movable', 'goods']);
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
  assert.equal((await offer(U.dispatcher)).status, 200);
  assert.equal((await U.spec.req('GET', `/api/orders/${o.id}`)).status, 200);
  assert.equal((await U.spec.req('GET', `/api/orders/${ownOrder.id}`)).status, 404);
  assert.ok((await U.spec.req('GET', '/api/orders')).body.orders.some((x) => x.id === o.id));
  // Исполнитель читает, но не правит и не загружает; документы заявки ему доступны только на чтение.
  assert.equal((await U.spec.req('PATCH', `/api/orders/${o.id}`, { title: 'моё' })).status, 403);
  assert.equal((await U.spec.req('PATCH', `/api/orders/${o.id}/responsible`, { user_id: U.spec.user.id })).status, 403);
  assert.equal((await U.spec.req('GET', `/api/orders/${o.id}/candidates`)).status, 403);
});

test('реестр: открытые операции — только из утверждённого списка, остальные покрыты этой таблицей', () => {
  const PUBLIC = ['health', 'auth.code', 'auth.verify', 'files.memory', 'test.calls', 'test.script', 'test.reset'];
  const ops = S.app.locals.ops;
  const extraPublic = ops.filter((o) => o.auth === 'public' && !PUBLIC.includes(o.id)).map((o) => o.id);
  assert.deepEqual(extraPublic, [], `новые открытые операции: ${extraPublic.join(', ')}`);
  const unchecked = ops.filter((o) => o.auth !== 'public' && !covered.has(o.id)).map((o) => o.id);
  assert.deepEqual(unchecked, [], `операции без проверки «свой/чужой» в этой таблице: ${unchecked.join(', ')}`);
});
