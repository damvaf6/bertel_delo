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

test('me.hints: закрытая подсказка — только своя и только из списка', async () => {
  cover('me.hints');
  const r = await U.stranger.req('POST', '/api/me/hints', { hint: 'expert', user_id: U.owner.user.id });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.hints_seen, ['expert']);
  assert.deepEqual((await U.stranger.req('POST', '/api/me/hints', { hint: 'expert' })).body.hints_seen, ['expert'], 'повтор не дублирует');
  assert.equal((await U.stranger.req('POST', '/api/me/hints', { hint: 'чужое' })).status, 400);
  assert.deepEqual((await U.stranger.req('GET', '/api/me')).body.hints_seen, ['expert']);
  assert.deepEqual((await U.owner.req('GET', '/api/me')).body.hints_seen, [], 'у другого человека не изменилось');
});

test('problems.*: сообщить может каждый; журнал видят и разбирают только служебные', async () => {
  cover('problems.report'); cover('problems.list'); cover('problems.close');
  const r = await U.owner.req('POST', '/api/problems', { text: 'Не открывается заявка', place: `#order=${ownOrder.id}`, client: '412×915' });
  assert.equal(r.status, 201);
  // Подставить чужой адрес вместо раздела нельзя — место остаётся пустым.
  assert.equal((await U.stranger.req('POST', '/api/problems', { text: 'x', place: 'https://example.com' })).status, 201);
  assert.equal((await U.stranger.req('POST', '/api/problems', { text: '' })).status, 400);
  for (const c of [U.owner, U.stranger, U.headA, U.memberA, U.spec]) {
    assert.equal((await c.req('GET', '/api/problems')).status, 404);
    assert.equal((await c.req('POST', `/api/problems/${r.body.id}/close`, {})).status, 404);
  }
  for (const c of [U.dispatcher, U.admin]) {
    const list = (await c.req('GET', '/api/problems')).body;
    const mine = list.problems.find((p) => p.id === r.body.id);
    assert.equal(mine.text, 'Не открывается заявка');
    assert.equal(mine.place, `#order=${ownOrder.id}`);
    assert.ok(list.problems.some((p) => p.text === 'x' && p.place === ''));
  }
  assert.equal((await U.dispatcher.req('POST', `/api/problems/${r.body.id}/close`, { note: 'Исправлено' })).status, 200);
  assert.equal((await U.admin.req('POST', `/api/problems/${r.body.id}/close`, {})).status, 404, 'уже разобрано');
  assert.equal((await U.admin.req('POST', '/api/problems/не-число/close', {})).status, 404);
});

test('case.*: журнал — стороны и служебные; архив — заказчик и служебные; посторонним — «не найдено»', async () => {
  cover('case.journal'); cover('case.export');
  assert.equal((await U.owner.req('GET', `/api/orders/${ownOrder.id}/journal`)).status, 200);
  assert.equal((await U.dispatcher.req('GET', `/api/orders/${ownOrder.id}/journal`)).body.full, true);
  assert.equal((await U.headA.req('GET', `/api/orders/${orgOrder.id}/journal`)).status, 200);
  for (const c of [U.stranger, U.headB, U.memberA]) {
    assert.equal((await c.req('GET', `/api/orders/${ownOrder.id}/journal`)).status, 404);
    assert.equal((await c.req('GET', `/api/orders/${ownOrder.id}/export`)).status, 404);
  }
  assert.equal((await U.memberA2.req('GET', `/api/orders/${orgOrder.id}/export`)).status, 404, 'коллега — не его заявка');
  assert.equal((await U.owner.req('GET', `/api/orders/${ownOrder.id}/export`)).status, 200);
  assert.equal((await U.admin.req('GET', `/api/orders/${orgOrder.id}/export`)).status, 200);
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
  assert.deepEqual(exp.services.map((s) => s.id), ['realty', 'land', 'vehicle', 'car_damage', 'movable', 'goods', 'construction', 'handwriting']);
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
  for (const id of ['orders.money', 'orders.price', 'payments.create', 'payments.refresh', 'payouts.retry', 'refunds.retry', 'money.summary', 'payouts.mine', 'orders.invoice', 'orders.closing.docx']) cover(id);
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
  // Файлы Word (2.46): акт — заказчику и служебным, отчёт агента — исполнителю и служебным; счёт — стороне заказчика.
  const word = (c, path) => c.req('GET', `/api/orders/${o.id}/${path}`);
  const [act] = done.documents;
  const [report] = sp.documents;
  for (const [who, code] of [['owner', 200], ['admin', 200], ['dispatcher', 200], ['spec', 404], ['stranger', 404], ['headB', 404]]) {
    assert.equal((await word(U[who], `closing/${act.id}`)).status, code, `акт: ${who}`);
  }
  for (const [who, code] of [['spec', 200], ['dispatcher', 200], ['owner', 404], ['stranger', 404]]) {
    assert.equal((await word(U[who], `closing/${report.id}`)).status, code, `отчёт агента: ${who}`);
  }
  assert.equal((await word(U.owner, 'closing/не-номер')).status, 404);
  for (const [who, code] of [['owner', 200], ['dispatcher', 200], ['spec', 403], ['stranger', 404], ['headB', 404]]) {
    assert.equal((await word(U[who], 'invoice')).status, code, `счёт: ${who}`);
  }

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
  for (const id of ['draft.get', 'draft.ai', 'draft.save', 'draft.attach', 'draft.docx', 'draft.approaches', 'draft.past.list', 'draft.past', 'draft.sources']) cover(id);
  // Заявка без исполнителя: заказчик и его организация черновика не видят, посторонние — «не найдено».
  for (const k of ['owner']) assert.equal((await U[k].req('GET', `/api/orders/${ownOrder.id}/draft`)).status, 403, k);
  for (const k of ['memberA', 'headA']) assert.equal((await U[k].req('GET', `/api/orders/${orgOrder.id}/draft`)).status, 403, k);
  for (const k of ['stranger', 'headB', 'spec']) assert.equal((await U[k].req('GET', `/api/orders/${ownOrder.id}/draft`)).status, 404, k);
  for (const k of ['dispatcher', 'admin']) {
    const r = await U[k].req('GET', `/api/orders/${ownOrder.id}/draft`);
    assert.equal(r.status, 200, k);
    assert.equal(r.body.can_edit, false, k);
  }
  for (const [method, path, body] of [['POST', 'draft/ai', {}], ['PUT', 'draft', { body: 'x' }], ['POST', 'draft/result', { confirm: true }], ['PUT', 'approaches', { approaches: ['cost'] }], ['GET', 'draft/past'], ['POST', 'draft/past', { past_id: ownOrder.id }], ['POST', 'draft/sources', {}]]) {
    for (const k of ['owner', 'dispatcher', 'admin']) assert.equal((await U[k].req(method, `/api/orders/${ownOrder.id}/${path}`, body)).status, 403, `${k} ${path}`);
    for (const k of ['stranger', 'headB']) assert.equal((await U[k].req(method, `/api/orders/${ownOrder.id}/${path}`, body)).status, 404, `${k} ${path}`);
  }
  // Файл Word черновика (2.29) — только исполнитель: заказчику и служебным — «нельзя», посторонним — «не найдено».
  for (const k of ['owner', 'dispatcher', 'admin']) assert.equal((await U[k].req('GET', `/api/orders/${ownOrder.id}/draft/docx`)).status, 403, k);
  for (const k of ['stranger', 'headB', 'spec']) assert.equal((await U[k].req('GET', `/api/orders/${ownOrder.id}/draft/docx`)).status, 404, k);
});

test('шаблон отчёта организации (2.29): меняет руководитель, видят сотрудники; служебные, посторонние, чужая организация — «не найдено»', async () => {
  for (const id of ['orgs.template.get', 'orgs.template.put', 'orgs.template.delete', 'orgs.template.file']) cover(id);
  const { makeDocx } = await import('../tools/make-docs.mjs');
  const put = (c) => c.req('POST', `/api/orgs/${orgA.id}/template`, makeDocx(['Бланк А']), { raw: true, headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('Бланк.docx') } });
  for (const k of ['memberA', 'seniorA']) assert.equal((await put(U[k])).status, 403, k);
  for (const k of ['stranger', 'headB', 'dispatcher', 'admin', 'owner', 'invitee']) assert.equal((await put(U[k])).status, 404, k);
  assert.equal((await put(U.headA)).status, 201);
  for (const k of ['headA', 'seniorA', 'memberA', 'memberA2']) {
    assert.equal((await U[k].req('GET', `/api/orgs/${orgA.id}/template`)).body.template.filename, 'Бланк.docx', k);
    assert.equal((await U[k].req('GET', `/api/orgs/${orgA.id}/template/file`)).status, 200, k);
  }
  for (const k of ['stranger', 'headB', 'dispatcher', 'admin', 'owner']) {
    for (const path of ['template', 'template/file']) assert.equal((await U[k].req('GET', `/api/orgs/${orgA.id}/${path}`)).status, 404, `${k} ${path}`);
    assert.equal((await U[k].req('DELETE', `/api/orgs/${orgA.id}/template`)).status, 404, k);
  }
  assert.equal((await U.memberA.req('DELETE', `/api/orgs/${orgA.id}/template`)).status, 403);
  assert.equal((await U.headA.req('GET', '/api/orgs/not-a-uuid/template')).status, 404);
  assert.equal((await U.headA.req('DELETE', `/api/orgs/${orgA.id}/template`)).status, 204);
  assert.equal((await U.headA.req('DELETE', `/api/orgs/${orgA.id}/template`)).status, 404, 'уже убран');
});

test('дистанционный осмотр (2.3): в деле видят те, кто видит заявку; ссылку выдаёт и отзывает только исполнитель в работе', async () => {
  for (const id of ['inspection.get', 'inspection.issue', 'inspection.revoke', 'inspection.retake', 'inspection.retake_cancel', 'inspection.thumb']) cover(id);
  // Картинка снимка (2.71): документ не фото осмотра — «не найдено» даже тем, кто его видит; чужим — тоже «не найдено».
  for (const k of ['owner', 'spec', 'dispatcher']) assert.equal((await U[k].req('GET', `/api/documents/${ownDoc.id}/thumb`)).status, 404, k);
  for (const k of ['stranger', 'headB']) assert.equal((await U[k].req('GET', `/api/documents/${ownDoc.id}/thumb`)).status, 404, k);
  for (const k of ['owner', 'dispatcher', 'admin']) {
    const r = await U[k].req('GET', `/api/orders/${ownOrder.id}/inspection`);
    assert.equal(r.status, 200, k);
    assert.equal(r.body.can_issue, false, k);
  }
  for (const k of ['memberA', 'headA', 'seniorA']) assert.equal((await U[k].req('GET', `/api/orders/${orgOrder.id}/inspection`)).status, 200, k);
  for (const k of ['stranger', 'headB', 'spec']) assert.equal((await U[k].req('GET', `/api/orders/${ownOrder.id}/inspection`)).status, 404, k);
  assert.equal((await U.memberA2.req('GET', `/api/orders/${orgOrder.id}/inspection`)).status, 404, 'коллега-сотрудник');
  for (const [method, path, body] of [['POST', 'inspection', { days: 3, phone: '+79990009999' }], ['DELETE', 'inspection/1', undefined],
    ['POST', 'inspection/retakes', { step: 'facade', note: 'Тёмно' }], ['DELETE', 'inspection/retakes/1', undefined]]) {
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
  for (const id of ['signature.upload', 'orgsign.list', 'orgsign.link', 'orgsign.sign', 'orgsign.upload', 'orgsign.return', 'orgreturn.item', 'orgsign.remind']) cover(id);
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
  // Напомнить руководителю о подписи (2.99) — только сам эксперт-исполнитель; очередь подписи видит только он.
  const remind = (c) => c.req('POST', `/api/orders/${o.id}/sign-reminder`);
  for (const k of ['stranger', 'headA', 'spec']) assert.equal((await remind(U[k])).status, 404, k);
  for (const c of [U.headB, memberB]) assert.equal((await remind(c)).status, 404, 'руководитель и сотрудники заявку не видят');
  for (const k of ['owner', 'dispatcher', 'admin']) assert.equal((await remind(U[k])).status, 403, k);
  for (const k of ['owner', 'dispatcher', 'admin']) assert.equal((await U[k].req('GET', `/api/orders/${o.id}/documents`)).body.sign_wait, undefined, k);
  assert.equal((await spec2.req('GET', `/api/orders/${o.id}/documents`)).body.sign_wait.files, 1);
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
  // Пункт замечания (2.93) отмечает только сам эксперт-исполнитель.
  const rid = (await spec2.req('GET', `/api/orders/${o.id}/documents`)).body.org_returns[0].id;
  const mark = (c) => c.req('PUT', `/api/orders/${o.id}/org-returns/${rid}/items/1`, { fixed: true });
  for (const k of ['stranger', 'headA', 'spec']) assert.equal((await mark(U[k])).status, 404, k);
  for (const c of [U.headB, memberB]) assert.equal((await mark(c)).status, 404, 'руководитель и сотрудники заявку не видят');
  for (const k of ['owner', 'dispatcher', 'admin']) assert.equal((await mark(U[k])).status, 403, k);
  assert.equal((await mark(spec2)).body.return.left, 0);
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
  assert.deepEqual(Object.keys(c).sort(), ['active', 'chat', 'deadline', 'expert', 'extend', 'fee_kop', 'hot', 'id', 'offer_wait', 'offered_at', 'order_ref', 'overdue', 'payout', 'returned_open', 'service', 'sign_wait', 'status', 'status_name', 'transfer_to']);
  assert.deepEqual(Object.keys(c.chat).sort(), ['expert_last', 'messages']);   // переписка (2.67): только число и чьё последнее, без текста
  assert.equal(c.status, 'review');
  assert.equal(c.expert, 'Эксперт Б');
  assert.equal(c.fee_kop, 1_200_000, 'вознаграждение — 80% цены');
  const o = (await S.sql`select * from orders where executor_user_id = ${spec2.user.id}`)[0];
  const owner = (await S.sql`select phone from users where id = ${o.owner_user_id}`)[0];
  // Номер дела — для внутренней переписки с экспертом (2.28); саму заявку руководитель по нему не открывает.
  assert.equal(c.id, o.id);
  assert.equal((await U.headB.req('GET', `/api/orders/${o.id}`)).status, 404);
  const raw = JSON.stringify(r.body);
  for (const secret of [o.owner_user_id, owner.phone, o.title, 'Подписная', 'deal', 'z.pdf']) assert.ok(!raw.includes(secret), `не раскрывает: ${secret}`);
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
  assert.deepEqual(Object.keys(p).sort(), ['away', 'deadline', 'declined', 'experts', 'fee_kop', 'id', 'order_ref', 'overdue', 'service']);
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

test('внутренняя переписка организации (2.28): только эксперт и руководитель его организации; заказчик, диспетчер, бывший сотрудник — «не найдено»', async () => {
  for (const id of ['orgchat.list', 'orgchat.post']) cover(id);
  const spec2 = expertB;
  const events = async (userId, event) => (await S.sql`select count(*)::int as n from notifications where user_id = ${userId} and event = ${event}`)[0].n;
  const o = (await S.sql`select * from orders where executor_user_id = ${spec2.user.id} and status = 'in_work' order by created_at desc limit 1`)[0];
  assert.ok(o, 'дело эксперта Б в работе (из проверки 2.17)');
  const list = (c) => c.req('GET', `/api/orders/${o.id}/org-chat`);
  const post = (c, body = 'Проверьте аналоги, пожалуйста') => c.req('POST', `/api/orders/${o.id}/org-chat`, { body });
  // Эксперту в деле — с какой организацией переписка; заказчику и служебным — нет.
  assert.equal((await spec2.req('GET', `/api/orders/${o.id}`)).body.org_chat, orgB.name);
  for (const k of ['owner', 'dispatcher', 'admin']) assert.equal((await U[k].req('GET', `/api/orders/${o.id}`)).body.org_chat, null, k);
  // Руководитель пишет — эксперт видит и получает уведомление (вид «Мои дела как исполнителя»).
  const h = await post(U.headB);
  assert.equal(h.status, 201, JSON.stringify(h.body));
  assert.equal(h.body.message.side, 'head');
  assert.equal(await events(spec2.user.id, 'org_chat_expert'), 1);
  const e = await post(spec2, 'Исправил, посмотрите');
  assert.equal(e.status, 201);
  assert.equal(e.body.message.side, 'expert');
  assert.equal(await events(U.headB.user.id, 'org_chat_head'), 1);
  assert.equal((await S.sql`select type from notifications where event = 'org_chat_head' limit 1`)[0].type, 'executor_work');
  const seen = (await list(spec2)).body;
  assert.deepEqual(seen.messages.map((m) => [m.side, m.mine]), [['head', false], ['expert', true]]);
  assert.equal(seen.org, orgB.name);
  assert.equal(seen.can_write, true);
  assert.deepEqual((await list(U.headB)).body.messages.map((m) => m.body), ['Проверьте аналоги, пожалуйста', 'Исправил, посмотрите']);
  assert.equal((await post(U.headB, '   ')).status, 400, 'пустое не отправить');
  // Заказчик, диспетчер, администратор, посторонний, руководитель чужой организации, старший и другой специалист — «не найдено».
  for (const k of ['owner', 'dispatcher', 'admin', 'stranger', 'headA', 'spec']) {
    assert.equal((await list(U[k])).status, 404, k);
    assert.equal((await post(U[k])).status, 404, k);
  }
  for (const c of [seniorB]) {
    assert.equal((await list(c)).status, 404, 'старший — не руководитель');
    assert.equal((await post(c)).status, 404);
  }
  // В переписку по заявке и в письма по заявке (1.9) не попадает; заказчик и диспетчер текста не видят.
  for (const k of ['owner', 'dispatcher']) {
    const m = (await U[k].req('GET', `/api/orders/${o.id}/messages`)).body;
    assert.ok(!JSON.stringify(m).includes('Проверьте аналоги'), k);
  }
  assert.equal((await S.sql`select count(*)::int as n from order_messages where body like 'Проверьте аналоги%'`)[0].n, 0);
  assert.equal((await S.sql`select count(*)::int as n from mail_outbox where body like '%Проверьте аналоги%' or body like '%Исправил, посмотрите%'`)[0].n, 0);
  // Бывший сотрудник: эксперт ушёл из организации — переписки нет ни у него, ни у руководителя.
  await S.sql`delete from org_members where org_id = ${orgB.id} and user_id = ${spec2.user.id}`;
  for (const c of [spec2, U.headB]) {
    assert.equal((await list(c)).status, 404, 'бывший сотрудник');
    assert.equal((await post(c)).status, 404);
  }
  assert.equal((await spec2.req('GET', `/api/orders/${o.id}`)).body.org_chat, null);
  await addMember(S.sql, orgB.id, spec2.user.id, 'member');
  assert.equal((await list(spec2)).body.messages.length, 2, 'вернулся — лента та же');
  // Дело отменено — читать можно, писать нельзя.
  await S.sql`update orders set status = 'cancelled' where id = ${o.id}`;
  assert.equal((await list(U.headB)).body.can_write, false);
  assert.equal((await post(U.headB)).body.error, 'order_final');
  await S.sql`update orders set status = 'in_work' where id = ${o.id}`;
});

test('досье эксперта (2.14): только сам эксперт; копии в дело — только исполнитель своего дела в работе', async () => {
  for (const id of ['dossier.get', 'dossier.add', 'dossier.update', 'dossier.remove', 'dossier.file', 'dossier.file.link', 'dossier.attach']) cover(id);
  const exp = await login(S, '+79990001491');
  await makeSpecialist(S.sql, exp.user.id);
  const it = await exp.req('POST', '/api/specialist/me/dossier', { kind: 'sro', title: 'Тестовая СРО', number: '777' });
  assert.equal(it.status, 201);
  const upl = (c) => c.req('POST', `/api/specialist/me/dossier/${it.body.id}/file`, Buffer.from('копия'), { raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': 'sro.pdf' } });
  assert.equal((await upl(exp)).status, 200);
  // Не специалист — досье нет; другой специалист, диспетчер, администратор — чужую запись не видят и не трогают.
  assert.equal((await U.owner.req('GET', '/api/specialist/me/dossier')).status, 404);
  assert.equal((await U.owner.req('POST', '/api/specialist/me/dossier', { kind: 'sro', title: 'x', number: '1' })).status, 404);
  for (const k of ['spec', 'dispatcher', 'admin', 'headA', 'stranger']) {
    const c = U[k];
    assert.equal((await c.req('PUT', `/api/specialist/me/dossier/${it.body.id}`, { title: 'Подлог', number: '1' })).status, 404, k);
    assert.equal((await c.req('DELETE', `/api/specialist/me/dossier/${it.body.id}`)).status, 404, k);
    assert.equal((await c.req('GET', `/api/specialist/me/dossier/${it.body.id}/file`)).status, 404, k);
    assert.equal((await upl(c)).status, 404, k);
    const own = (await c.req('GET', '/api/specialist/me/dossier')).body;
    assert.ok(!JSON.stringify(own ?? {}).includes('Тестовая СРО'), k);
  }
  assert.equal((await exp.req('GET', `/api/specialist/me/dossier/${it.body.id}/file`)).status, 200);
  // Копии в дело: чужое дело — «не найдено»; заказчик и диспетчер — не исполнители.
  assert.equal((await exp.req('POST', `/api/orders/${ownOrder.id}/dossier`)).status, 404);
  assert.equal((await U.owner.req('POST', `/api/orders/${ownOrder.id}/dossier`)).status, 403);
  assert.equal((await U.dispatcher.req('POST', `/api/orders/${ownOrder.id}/dossier`)).status, 403);
  assert.equal((await U.stranger.req('POST', `/api/orders/${ownOrder.id}/dossier`)).status, 404);
  assert.equal((await exp.req('DELETE', `/api/specialist/me/dossier/${it.body.id}`)).status, 200);
});

test('аналоги в деле (2.32): видят исполнитель и служебные; меняет только исполнитель в работе; заказчику и посторонним — нет', async () => {
  for (const id of ['analogs.list', 'analogs.add', 'analogs.file', 'analogs.file.link', 'analogs.ai', 'analogs.update', 'analogs.remove']) cover(id);
  // Заявка без исполнителя: заказчик и его организация аналогов не видят, посторонние — «не найдено».
  assert.equal((await U.owner.req('GET', `/api/orders/${ownOrder.id}/analogs`)).status, 403);
  for (const k of ['memberA', 'headA']) assert.equal((await U[k].req('GET', `/api/orders/${orgOrder.id}/analogs`)).status, 403, k);
  for (const k of ['stranger', 'headB', 'spec']) assert.equal((await U[k].req('GET', `/api/orders/${ownOrder.id}/analogs`)).status, 404, k);
  for (const k of ['dispatcher', 'admin']) {
    const r = await U[k].req('GET', `/api/orders/${ownOrder.id}/analogs`);
    assert.equal(r.status, 200, k);
    assert.equal(r.body.can_edit, false, k);
  }
  for (const k of ['owner', 'dispatcher', 'admin']) assert.equal((await U[k].req('POST', `/api/orders/${ownOrder.id}/analogs`, { url: 'https://www.avito.ru/moskva/kvartiry/1' })).status, 403, k);
  for (const k of ['stranger', 'headB']) assert.equal((await U[k].req('POST', `/api/orders/${ownOrder.id}/analogs`, { url: 'https://www.avito.ru/moskva/kvartiry/1' })).status, 404, k);
  // Дело в работе у исполнителя: он добавляет; заказчик, диспетчер — не меняют; аналог чужого дела — «не найдено».
  const mk = async (title) => {
    const o = (await U.owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    await S.sql`update orders set executor_user_id = ${U.spec.user.id}, status = 'in_work', deadline = current_date + 10,
                 fields = ${JSON.stringify({ region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 1', area: 50 })} where id = ${o.id}`;
    return o;
  };
  const o1 = await mk('Аналоги: дело 1');
  const o2 = await mk('Аналоги: дело 2');
  const a1 = (await U.spec.req('POST', `/api/orders/${o1.id}/analogs`, { url: 'https://www.avito.ru/moskva/kvartiry/111' })).body.id;
  const a2 = (await U.spec.req('POST', `/api/orders/${o2.id}/analogs`, { url: 'https://www.cian.ru/sale/flat/222/' })).body.id;
  assert.ok(a1 && a2);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('OCR: Цена 9 000 000 ₽')]);
  const file = (c, o, a) => c.req('POST', `/api/orders/${o.id}/analogs/${a}/file`, png, { raw: true, headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent('s.png') } });
  for (const k of ['owner', 'dispatcher']) {
    const c = U[k];
    assert.equal((await c.req('PUT', `/api/orders/${o1.id}/analogs/${a1}`, { fields: { price_rub: 1 } })).status, 403, k);
    assert.equal((await c.req('DELETE', `/api/orders/${o1.id}/analogs/${a1}`)).status, 403, k);
    assert.equal((await c.req('POST', `/api/orders/${o1.id}/analogs/${a1}/ai`, {})).status, 403, k);
    assert.equal((await file(c, o1, a1)).status, 403, k);
  }
  for (const k of ['stranger', 'headB', 'memberA']) {
    const c = U[k];
    assert.equal((await c.req('GET', `/api/orders/${o1.id}/analogs`)).status, 404, k);
    assert.equal((await c.req('GET', `/api/orders/${o1.id}/analogs/${a1}/file`)).status, 404, k);
    assert.equal((await file(c, o1, a1)).status, 404, k);
  }
  // Аналог другого дела по адресу этого дела — «не найдено», даже у того же исполнителя.
  assert.equal((await U.spec.req('PUT', `/api/orders/${o1.id}/analogs/${a2}`, { fields: { price_rub: 1 } })).status, 404);
  assert.equal((await U.spec.req('DELETE', `/api/orders/${o1.id}/analogs/${a2}`)).status, 404);
  assert.equal((await file(U.spec, o1, a2)).status, 404);
  assert.equal((await U.spec.req('GET', `/api/orders/${o1.id}/analogs/${a2}/file`)).status, 404);
  assert.equal((await U.spec.req('POST', `/api/orders/${o1.id}/analogs/${a2}/ai`, {})).status, 404);
  assert.equal((await U.spec.req('PUT', `/api/orders/${o1.id}/analogs/abc`, { fields: {} })).status, 404);
  assert.equal((await file(U.spec, o1, a1)).status, 200);
  assert.equal((await U.dispatcher.req('GET', `/api/orders/${o1.id}/analogs/${a1}/file`)).status, 200, 'диспетчер смотрит скриншот');
  assert.equal((await U.owner.req('GET', `/api/orders/${o1.id}/analogs/${a1}/file`)).status, 403, 'заказчик — только в составе отчёта');
  // Дело сдано — исполнитель больше не меняет аналоги, но видит их.
  await S.sql`update orders set status = 'review' where id = ${o1.id}`;
  assert.equal((await U.spec.req('PUT', `/api/orders/${o1.id}/analogs/${a1}`, { fields: { price_rub: 1 } })).status, 403);
  assert.equal((await U.spec.req('GET', `/api/orders/${o1.id}/analogs`)).body.can_edit, false);
});

test('«Сегодня» (2.34): только свои дела и свои организации; посторонний — пусто', async () => {
  cover('today.get');
  for (const k of ['stranger', 'owner']) {
    const r = await U[k].req('GET', '/api/today');
    assert.equal(r.status, 200, k);
    assert.ok(!JSON.stringify(r.body).includes(ownOrder.id) || k === 'owner', k);
    assert.equal(r.body.expert, null, k);
  }
  // Руководитель чужой организации не видит организацию A.
  assert.ok(!JSON.stringify((await U.headB.req('GET', '/api/today')).body).includes(orgA.id));
});

test('карточка эксперта (2.35): диспетчер, администратор, сам эксперт; заказчик, посторонний, чужой руководитель — «не найдено»', async () => {
  cover('specialists.card');
  for (const k of ['dispatcher', 'admin', 'spec']) assert.equal((await U[k].req('GET', `/api/specialists/${U.spec.user.id}/card`)).status, 200, k);
  for (const k of ['owner', 'stranger', 'headA', 'headB', 'memberA']) assert.equal((await U[k].req('GET', `/api/specialists/${U.spec.user.id}/card`)).status, 404, k);
  // Не специалист — «не найдено» даже диспетчеру.
  assert.equal((await U.dispatcher.req('GET', `/api/specialists/${U.owner.user.id}/card`)).status, 404);
});

test('прямая загрузка (2.49): ссылку и «готово» — только тем, кто может положить файл; чужим — «не найдено»', async () => {
  for (const id of ['documents.upload_url', 'results.upload_url', 'uploads.complete']) cover(id);
  const meta = { filename: 'большой.pdf', mime: 'application/pdf', size: 4 * 1024 * 1024, kind: 'other' };
  const url = (c, o, what = 'documents') => c.req('POST', `/api/orders/${o.id}/${what}/upload-url`, meta);
  for (const [who, o, code] of [['owner', ownOrder, 201], ['memberA', orgOrder, 201], ['headA', orgOrder, 201], ['stranger', ownOrder, 404], ['headB', orgOrder, 404], ['memberA2', orgOrder, 404], ['spec', ownOrder, 404], ['dispatcher', ownOrder, 403]]) {
    assert.equal((await url(U[who], o)).status, code, `${who}`);
  }
  for (const who of ['owner', 'stranger', 'dispatcher']) assert.notEqual((await url(U[who], ownOrder, 'results')).status, 201, `${who}: результат`);
  const r = (await url(U.owner, ownOrder)).body;
  for (const who of ['stranger', 'headB', 'spec']) assert.equal((await U[who].req('POST', `/api/orders/${ownOrder.id}/uploads/complete`, { pass: r.pass })).status, 404, who);
  assert.equal((await U.dispatcher.req('POST', `/api/orders/${ownOrder.id}/uploads/complete`, { pass: r.pass })).status, 403, 'пропуск другого человека');
});

test('передача дела в работе (2.62): только руководитель организации эксперта; файлы и переписка остаются, прежний эксперт теряет доступ, заказчик имени не видит', async () => {
  cover('orgs.cases.transfer');
  const events = async (userId, event) => (await S.sql`select count(*)::int as n from notifications where user_id = ${userId} and event = ${event}`)[0].n;
  // Второй эксперт организации Б.
  const expertC = await login(S, '+79990000054');
  await addMember(S.sql, orgB.id, expertC.user.id, 'member');
  await makeSpecialist(S.sql, expertC.user.id);
  await S.sql`update users set full_name = 'Эксперт В' where id = ${expertC.user.id}`;
  assert.equal((await expertC.req('PATCH', '/api/specialist/me', { org_id: orgB.id })).status, 200);
  const o = (await U.owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Передача дела' })).body.order;
  const fields = { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, Передаточная ул., 3' };
  assert.equal((await U.owner.req('PATCH', `/api/orders/${o.id}`, { fields, deadline: new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10) })).status, 200);
  assert.equal((await U.owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await U.dispatcher.req('POST', `/api/orders/${o.id}/offer`, { org_id: orgB.id, from: 'matching' })).status, 200);
  assert.equal((await U.headB.req('POST', `/api/orgs/${orgB.id}/cases/${o.id}/assign`, { specialist_id: expertB.user.id })).status, 200);
  const transfer = (c, orgId, sid = expertC.user.id, reason = 'Эксперт заболел') => c.req('POST', `/api/orgs/${orgId}/cases/${o.id}/transfer`, { specialist_id: sid, reason });
  assert.equal((await transfer(U.headB, orgB.id)).body.error, 'status_changed', 'дело ещё не принято экспертом');
  assert.equal((await expertB.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  // Работа прежнего эксперта: файл, сообщение заказчику, внутренняя переписка, ссылка на осмотр.
  const result = (c, name) => c.req('POST', `/api/orders/${o.id}/results`, Buffer.from('отчёт'), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) } });
  const doc = (await result(expertB, 'расчёт.txt')).body.document;
  assert.ok(doc?.id);
  assert.equal((await expertB.req('POST', `/api/orders/${o.id}/messages`, { body: 'Начал работу' })).status, 201);
  assert.equal((await U.headB.req('POST', `/api/orders/${o.id}/org-chat`, { body: 'Как продвигается?' })).status, 201);
  assert.equal((await expertB.req('POST', `/api/orders/${o.id}/inspection`, {})).status, 201);
  // Руководитель видит, кому можно передать: эксперт В, без нынешнего.
  const view = (await U.headB.req('GET', `/api/orgs/${orgB.id}/cases`)).body.cases.find((c) => c.id === o.id);
  assert.deepEqual(view.transfer_to.map((x) => x.full_name), ['Эксперт В']);
  // Посторонние и чужой руководитель — «не найдено»; старший, сами эксперты и служебные — «недостаточно прав».
  for (const k of ['stranger', 'headA', 'owner', 'spec']) assert.equal((await transfer(U[k], orgB.id)).status, 404, k);
  for (const c of [seniorB, expertB, expertC, U.dispatcher, U.admin]) assert.equal((await transfer(c, orgB.id)).status, 403);
  assert.equal((await transfer(U.headA, orgA.id)).status, 404, 'своей организацией чужое дело не взять');
  assert.equal((await transfer(U.headB, orgB.id, expertC.user.id, ' ')).body.error, 'reason_required');
  assert.equal((await transfer(U.headB, orgB.id, U.spec.user.id)).body.error, 'not_eligible', 'эксперт не из организации');
  assert.equal((await transfer(U.headB, orgB.id, expertB.user.id)).body.error, 'same_expert');
  const r = await transfer(U.headB, orgB.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // Статус тот же, исполнитель — эксперт В; прежний эксперт дело не видит, ни в заявке, ни в переписке организации.
  assert.deepEqual((await S.sql`select status, executor_user_id from orders where id = ${o.id}`)[0], { status: 'in_work', executor_user_id: expertC.user.id });
  for (const path of ['', '/documents', '/messages', '/org-chat']) assert.equal((await expertB.req('GET', `/api/orders/${o.id}${path}`)).status, 404, `прежний эксперт: ${path}`);
  // Новый эксперт видит файл, переписку с заказчиком и внутреннюю переписку организации.
  assert.ok((await expertC.req('GET', `/api/orders/${o.id}/documents`)).body.documents.some((d) => d.id === doc.id));
  assert.ok((await expertC.req('GET', `/api/orders/${o.id}/messages`)).body.messages.some((m) => m.body === 'Начал работу'));
  assert.ok((await expertC.req('GET', `/api/orders/${o.id}/org-chat`)).body.messages.some((m) => m.body === 'Как продвигается?'));
  assert.equal((await expertC.req('GET', `/api/orders/${o.id}`)).body.executor.is_me, true);
  // Ссылка прежнего эксперта на осмотр закрыта; новый выдаёт свою.
  assert.equal((await S.sql`select count(*)::int as n from inspection_links where order_id = ${o.id} and revoked_at is null`)[0].n, 0);
  assert.equal((await expertC.req('POST', `/api/orders/${o.id}/inspection`, {})).status, 201);
  // Уведомления: новому — по делу, прежнему — без дела (дела он больше не видит).
  assert.equal(await events(expertC.user.id, 'org_case_given'), 1);
  assert.equal(await events(expertB.user.id, 'org_case_taken'), 1);
  assert.equal((await S.sql`select order_id from notifications where user_id = ${expertB.user.id} and event = 'org_case_taken'`)[0].order_id, null);
  // Заказчику — ни имени, ни передачи в журнале; служебным — с причиной.
  const own = (await U.owner.req('GET', `/api/orders/${o.id}`)).body;
  assert.equal(own.executor, null);
  const ownJournal = JSON.stringify((await U.owner.req('GET', `/api/orders/${o.id}/journal`)).body);
  assert.ok(!ownJournal.includes('передал дело') && !ownJournal.includes('заболел'), ownJournal);
  const dj = (await U.dispatcher.req('GET', `/api/orders/${o.id}/journal`)).body.journal;
  assert.ok(dj.some((j) => j.what === 'Руководитель организации передал дело другому эксперту: Эксперт заболел'), JSON.stringify(dj.map((j) => j.what)));
  // В «Делах экспертов» — дело у эксперта В; передать можно обратно эксперту Б.
  const after = (await U.headB.req('GET', `/api/orgs/${orgB.id}/cases`)).body.cases.find((c) => c.id === o.id);
  assert.equal(after.expert, 'Эксперт В');
  assert.deepEqual(after.transfer_to.map((x) => x.user_id), [expertB.user.id]);
  // Сдано на проверку — передавать нельзя.
  assert.equal((await result(expertC, 'отчёт.txt')).status, 201);
  await S.sql`update orders set status = 'review' where id = ${o.id}`;
  assert.equal((await transfer(U.headB, orgB.id, expertB.user.id)).body.error, 'status_changed');
});

test('запрос документов (2.64): видят те, кто видит заявку; просит только исполнитель, прикладывает заказчик', async () => {
  for (const id of ['doc_requests.list', 'doc_requests.create', 'doc_requests.attach', 'doc_requests.cancel']) cover(id);
  const base = `/api/orders/${ownOrder.id}/doc-requests`;
  for (const [who, ok] of [['owner', true], ['dispatcher', true], ['admin', true], ['stranger', false], ['headA', false], ['headB', false], ['spec', false]]) {
    expectRead(await U[who].req('GET', base), ok, who);
  }
  for (const who of ['stranger', 'headA', 'headB', 'spec']) {
    assert.equal((await U[who].req('POST', base, { items: ['egrn'] })).status, 404, `${who}: запрос`);
    assert.equal((await U[who].req('POST', `${base}/1/attach`, { document_id: ownDoc.id })).status, 404, `${who}: приложить`);
    assert.equal((await U[who].req('DELETE', `${base}/1`)).status, 404, `${who}: снять`);
  }
  // Заказчик и диспетчер — не исполнители: запросить и снять нельзя; приложить диспетчер не может (только чтение).
  for (const who of ['owner', 'dispatcher']) assert.equal((await U[who].req('POST', base, { items: ['egrn'] })).status, 403, who);
  assert.equal((await U.dispatcher.req('POST', `${base}/1/attach`, { document_id: ownDoc.id })).status, 403);
  assert.equal((await U.owner.req('DELETE', `${base}/1`)).status, 403);
});

test('перенос срока (2.91): видят те, кто видит заявку; просит только исполнитель, решает диспетчер', async () => {
  for (const id of ['deadline_requests.list', 'deadline_requests.create', 'deadline_requests.withdraw', 'deadline_requests.decide']) cover(id);
  const base = `/api/orders/${ownOrder.id}/deadline-requests`;
  for (const [who, ok] of [['owner', true], ['dispatcher', true], ['admin', true], ['stranger', false], ['headA', false], ['headB', false], ['spec', false]]) {
    expectRead(await U[who].req('GET', base), ok, who);
  }
  for (const who of ['stranger', 'headA', 'headB', 'spec']) {
    assert.equal((await U[who].req('POST', base, { new_deadline: '2030-01-01', reason: 'x' })).status, 404, `${who}: просьба`);
    assert.equal((await U[who].req('DELETE', `${base}/1`)).status, 404, `${who}: отзыв`);
    assert.equal((await U[who].req('POST', `${base}/1/decide`, { approve: true })).status, 404, `${who}: решение`);
  }
  // Заказчик и диспетчер — не исполнители: просить и отзывать нельзя; заказчик не решает.
  for (const who of ['owner', 'dispatcher']) {
    assert.equal((await U[who].req('POST', base, { new_deadline: '2030-01-01', reason: 'x' })).status, 403, who);
    assert.equal((await U[who].req('DELETE', `${base}/1`)).status, 403, who);
  }
  assert.equal((await U.owner.req('POST', `${base}/1/decide`, { approve: true })).status, 403);
});

test('переназначение до ответа эксперта (2.76): только руководитель организации; прежний эксперт теряет предложение, «уже изменилось» после ответа', async () => {
  cover('orgs.cases.reassign');
  const events = async (userId, event) => (await S.sql`select count(*)::int as n from notifications where user_id = ${userId} and event = ${event}`)[0].n;
  const expertD = await login(S, '+79990000055');
  await addMember(S.sql, orgB.id, expertD.user.id, 'member');
  await makeSpecialist(S.sql, expertD.user.id);
  await S.sql`update users set full_name = 'Эксперт Г' where id = ${expertD.user.id}`;
  assert.equal((await expertD.req('PATCH', '/api/specialist/me', { org_id: orgB.id })).status, 200);
  const o = (await U.owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Переназначение до ответа' })).body.order;
  const fields = { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, Ждущая ул., 5' };
  assert.equal((await U.owner.req('PATCH', `/api/orders/${o.id}`, { fields, deadline: new Date(Date.now() + 9 * 86400_000).toISOString().slice(0, 10) })).status, 200);
  assert.equal((await U.owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await U.dispatcher.req('POST', `/api/orders/${o.id}/offer`, { org_id: orgB.id, from: 'matching' })).status, 200);
  assert.equal((await U.headB.req('POST', `/api/orgs/${orgB.id}/cases/${o.id}/assign`, { specialist_id: expertB.user.id })).status, 200);
  // Руководитель видит: эксперт Б ещё не ответил, когда предложено, кому можно отдать (без Б).
  const view = (await U.headB.req('GET', `/api/orgs/${orgB.id}/cases`)).body.cases.find((c) => c.id === o.id);
  assert.equal(view.status, 'awaiting_executor');
  assert.equal(view.offer_wait.from, expertB.user.id);
  assert.ok(Date.now() - new Date(view.offer_wait.offered_at).getTime() < 60_000, 'когда предложено');
  assert.ok(view.offer_wait.reassign_to.some((x) => x.full_name === 'Эксперт Г'));
  assert.ok(!view.offer_wait.reassign_to.some((x) => x.user_id === expertB.user.id), 'без нынешнего');
  const reassign = (c, orgId, sid = expertD.user.id, from = expertB.user.id) => c.req('POST', `/api/orgs/${orgId}/cases/${o.id}/reassign`, { from, specialist_id: sid });
  for (const k of ['stranger', 'headA', 'owner', 'spec']) assert.equal((await reassign(U[k], orgB.id)).status, 404, k);
  for (const c of [seniorB, expertB, expertD, U.dispatcher, U.admin]) assert.equal((await reassign(c, orgB.id)).status, 403);
  assert.equal((await reassign(U.headA, orgA.id)).status, 404, 'своей организацией чужое дело не взять');
  assert.equal((await reassign(U.headB, orgB.id, U.spec.user.id)).body.error, 'not_eligible', 'эксперт не из организации');
  assert.equal((await reassign(U.headB, orgB.id, expertB.user.id)).body.error, 'same_expert');
  assert.equal((await reassign(U.headB, orgB.id, expertD.user.id, expertD.user.id)).body.error, 'status_changed', 'видел другого эксперта');
  // Отдал эксперту Г: Б дело больше не видит и принять не может; Г — предложение; Б — уведомление без номера дела.
  const r = await reassign(U.headB, orgB.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await S.sql`select status, executor_user_id, offer_org_id from orders where id = ${o.id}`)[0],
    { status: 'awaiting_executor', executor_user_id: expertD.user.id, offer_org_id: orgB.id });
  assert.equal((await expertB.req('GET', `/api/orders/${o.id}`)).status, 404);
  assert.notEqual((await expertB.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200, 'прежний не принимает');
  assert.equal(await events(expertD.user.id, 'offer'), 1);
  assert.equal(await events(expertB.user.id, 'org_offer_taken'), 1);
  assert.equal((await S.sql`select order_id from notifications where user_id = ${expertB.user.id} and event = 'org_offer_taken'`)[0].order_id, null);
  // Второй раз с тем же «from» — уже изменилось.
  assert.equal((await reassign(U.headB, orgB.id)).body.error, 'status_changed');
  // Забрал назад: дело снова в «Ждут назначения», эксперт Г — уведомление.
  const back = await reassign(U.headB, orgB.id, null, expertD.user.id);
  assert.equal(back.status, 200, JSON.stringify(back.body));
  const v2 = (await U.headB.req('GET', `/api/orgs/${orgB.id}/cases`)).body;
  assert.ok(v2.pending.some((p) => p.id === o.id), 'в «Ждут назначения»');
  assert.ok(!v2.cases.some((c) => c.id === o.id));
  assert.equal(await events(expertD.user.id, 'org_offer_taken'), 1);
  assert.equal((await expertD.req('GET', `/api/orders/${o.id}`)).status, 404);
  // Заказчику — ни имени, ни переназначения в журнале; служебным — видно.
  assert.ok(!JSON.stringify((await U.owner.req('GET', `/api/orders/${o.id}/journal`)).body).includes('Руководитель организации'));
  const dj = (await U.dispatcher.req('GET', `/api/orders/${o.id}/journal`)).body.journal.map((j) => j.what);
  assert.ok(dj.includes('Руководитель организации предложил дело другому эксперту'), JSON.stringify(dj));
  assert.ok(dj.includes('Руководитель организации забрал дело у эксперта до ответа'), JSON.stringify(dj));
  // Эксперт принял — переназначать нельзя (только передача дела в работе).
  assert.equal((await U.headB.req('POST', `/api/orgs/${orgB.id}/cases/${o.id}/assign`, { specialist_id: expertD.user.id })).status, 200);
  assert.equal((await expertD.req('POST', `/api/orders/${o.id}/status`, { to: 'in_work', from: 'awaiting_executor' })).status, 200);
  assert.equal((await reassign(U.headB, orgB.id, expertB.user.id, expertD.user.id)).body.error, 'status_changed');
  assert.equal((await U.headB.req('GET', `/api/orgs/${orgB.id}/cases`)).body.cases.find((c) => c.id === o.id).offer_wait, null);
  const offers = await S.sql`select specialist_id, outcome from order_offers where order_id = ${o.id} order by id`;
  assert.deepEqual(offers.map((x) => [x.specialist_id === expertB.user.id ? 'Б' : x.specialist_id === expertD.user.id ? 'Г' : 'организация', x.outcome]), [
    ['организация', 'accepted'], ['Б', 'withdrawn'], ['Г', 'withdrawn'], ['организация', 'accepted'], ['Г', 'accepted']]);
});

test('«не принимаю новые дела до …» (2.77): подбор эксперта не предлагает, руководитель видит до какого дня; день наступил — снова в подборе', async () => {
  const day = (n) => new Date(Date.now() + 3 * 3_600_000 + n * 86400_000).toISOString().slice(0, 10);
  const away = (body) => expertB.req('PATCH', '/api/specialist/me', { away: body });
  for (const [body, why] of [[{ until: day(0) }, 'сегодня'], [{ until: day(-3) }, 'в прошлом'], [{ until: day(400) }, 'дальше года'],
    [{ until: '2026-02-30' }, 'нет такого дня'], [{}, 'без дня'], [{ until: day(5), note: 'я'.repeat(81) }, 'длинная причина']]) {
    assert.equal((await away(body)).status, 400, why);
  }
  assert.equal((await U.owner.req('PATCH', '/api/specialist/me', { away: { until: day(5) } })).status, 404, 'не специалист');
  const before = (await S.sql`select count(*)::int as n from notifications where user_id = ${U.headB.user.id} and event = 'expert_away_head'`)[0].n;
  const r = await away({ until: day(10), note: '  отпуск ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.specialist.away, { until: day(10), note: 'отпуск' });
  assert.equal(r.body.specialist.active, true, 'выключатель «принимаю дела» не трогается');
  const after = (await S.sql`select count(*)::int as n, bool_and(org_id = ${orgB.id}) as org from notifications where user_id = ${U.headB.user.id} and event = 'expert_away_head'`)[0];
  assert.equal(after.n, before + 1, 'руководителю — уведомление');
  assert.equal(after.org, true);
  // Новое дело организации Б: эксперта Б нет ни в подборе диспетчера, ни в назначении у руководителя; руководитель видит почему.
  const o = (await U.owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Эксперт в отпуске' })).body.order;
  assert.equal((await U.owner.req('PATCH', `/api/orders/${o.id}`, { fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, Отпускная ул., 1' }, deadline: day(12) })).status, 200);
  assert.equal((await U.owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  const cands = async () => (await U.dispatcher.req('GET', `/api/orders/${o.id}/candidates`)).body.candidates.map((c) => c.user_id);
  assert.ok(!(await cands()).includes(expertB.user.id), 'подбор не предлагает');
  assert.equal((await U.dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: expertB.user.id, from: 'matching' })).body.error, 'not_eligible');
  const list = (await U.dispatcher.req('GET', '/api/specialists')).body.specialists.find((s) => s.user_id === expertB.user.id);
  assert.deepEqual(list.away, { until: day(10), note: 'отпуск' }, 'диспетчер видит в списке специалистов');
  assert.equal((await U.dispatcher.req('POST', `/api/orders/${o.id}/offer`, { org_id: orgB.id, from: 'matching' })).status, 200);
  const v = (await U.headB.req('GET', `/api/orgs/${orgB.id}/cases`)).body;
  const p = v.pending.find((x) => x.id === o.id);
  assert.ok(!p.experts.some((x) => x.user_id === expertB.user.id), 'назначить нельзя');
  assert.ok(p.away.some((a) => a.until === day(10) && a.note === 'отпуск'), JSON.stringify(p.away));
  assert.deepEqual(v.load.find((l) => l.user_id === expertB.user.id).away, { until: day(10), note: 'отпуск' });
  assert.equal((await U.headB.req('POST', `/api/orgs/${orgB.id}/cases/${o.id}/assign`, { specialist_id: expertB.user.id })).status, 409);
  // День возвращения наступил — отметка перестала действовать сама.
  await S.sql`update specialists set away_until = ${day(0)} where user_id = ${expertB.user.id}`;
  assert.equal((await expertB.req('GET', '/api/specialist/me')).body.specialist.away, null);
  assert.equal((await U.headB.req('GET', `/api/orgs/${orgB.id}/cases`)).body.load.find((l) => l.user_id === expertB.user.id).away, null);
  assert.ok((await U.headB.req('GET', `/api/orgs/${orgB.id}/cases`)).body.pending.find((x) => x.id === o.id).experts.some((x) => x.user_id === expertB.user.id));
  // Снять отметку раньше — снова принимает дела; руководителю при снятии не пишем.
  assert.equal((await away({ until: day(3) })).status, 200);
  const cleared = await away(null);
  assert.equal(cleared.body.specialist.away, null);
  assert.equal((await S.sql`select count(*)::int as n from notifications where user_id = ${U.headB.user.id} and event = 'expert_away_head'`)[0].n, before + 2);
  assert.equal((await U.headB.req('POST', `/api/orgs/${orgB.id}/cases/${o.id}/decline`, { reason: 'проверка 2.77' })).status, 200);
});

test('сводка за месяц по экспертам (2.78): только руководитель; считает с вступления в организацию; таблица для Excel', async () => {
  cover('orgs.report');
  const orgC = await makeOrg(S.sql, 'Тестовая организация В');
  const headC = await login(S, '+79990000061');
  await addMember(S.sql, orgC.id, headC.user.id, 'head');
  const ex = {};
  for (const [k, phone, name] of [['e1', '+79990000062', '=Сидоров «Эксперт»'], ['e2', '+79990000063', 'Петрова; Эксперт']]) {
    ex[k] = await login(S, phone);
    await addMember(S.sql, orgC.id, ex[k].user.id, 'member');
    await makeSpecialist(S.sql, ex[k].user.id);
    await S.sql`update users set full_name = ${name} where id = ${ex[k].user.id}`;
    assert.equal((await ex[k].req('PATCH', '/api/specialist/me', { org_id: orgC.id })).status, 200);
  }
  const report = (c, q = '', orgId = orgC.id) => c.req('GET', `/api/orgs/${orgId}/report${q}`);
  for (const c of [ex.e1, U.dispatcher, U.admin]) assert.equal((await report(c)).status, 403);
  for (const k of ['stranger', 'headA', 'headB', 'owner']) assert.equal((await report(U[k])).status, 404, k);
  // Пустая организация — нули; месяц — текущий по Москве.
  const empty = (await report(headC)).body.report;
  const month = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 7);
  assert.equal(empty.month, month);
  assert.equal(empty.current, true);
  // Только что созданная организация (2.90): в выборе месяца только текущий; с давней — текущий и 12 прошлых.
  assert.deepEqual(empty.months, [month]);
  await S.sql`update organizations set created_at = now() - interval '2 years' where id = ${orgC.id}`;
  assert.equal((await report(headC)).body.report.months.length, 13);
  assert.deepEqual(empty.total, { accepted: 0, done: 0, done_late: 0, overdue_now: 0, returned_head: 0, returned_dispatcher: 0, fee_kop: 0, paid_kop: 0 });
  for (const q of ['?month=2020-01', '?month=2099-01', '?month=13', '?month=2026-13']) assert.equal((await report(headC, q)).body.error, 'bad_month', q);
  // Дела: e1 принял 2 дела, одно сдал вовремя, другое позже срока; одно в работе просрочено; руководитель вернул раз,
  // диспетчер — раз; выплачено за одно. До вступления (прошлое частное дело) — не считается.
  await S.sql`update org_members set created_at = now() - interval '1 minute' where org_id = ${orgC.id}`;
  const order = async (title, status, deadline, priceKop, executor = ex.e1.user.id) => {
    const o = (await U.owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    await S.sql`update orders set status = ${status}, deadline = ${deadline}, price_kop = ${priceKop}, executor_user_id = ${executor} where id = ${o.id}`;
    return o;
  };
  const day = (n) => new Date(Date.now() + 3 * 3_600_000 + n * 86400_000).toISOString().slice(0, 10);
  const onTime = await order('Сводка: вовремя', 'done', day(5), 1_000_000);
  const late = await order('Сводка: позже срока', 'closed', day(-1), 2_000_000);
  const overdue = await order('Сводка: просрочено', 'in_work', day(-2), 500_000);
  const before = await order('Сводка: до вступления', 'done', day(5), 3_000_000);
  const accept = (o, minsAgo = 0) => S.sql`insert into order_offers (order_id, specialist_id, score, outcome, outcome_at)
    values (${o.id}, ${ex.e1.user.id}, '{}', 'accepted', now() - make_interval(mins => ${minsAgo}::int))`;
  await accept(onTime); await accept(late); await accept(before, 2);
  const hist = (o, from, to, minsAgo = 0) => S.sql`insert into order_status_history (order_id, from_status, to_status, side, at)
    values (${o.id}, ${from}, ${to}, 'dispatcher', now() - make_interval(mins => ${minsAgo}::int))`;
  await hist(onTime, 'review', 'done');
  await hist(late, 'review', 'in_work'); await hist(late, 'review', 'done'); await hist(late, 'done', 'closed');
  await hist(before, 'review', 'done', 2);
  await S.sql`insert into payouts (order_id, executor_user_id, amount_kop, commission_kop, status, paid_at)
              values (${onTime.id}, ${ex.e1.user.id}, 800000, 200000, 'succeeded', now()),
                     (${before.id}, ${ex.e1.user.id}, 2400000, 600000, 'succeeded', now() - interval '2 minutes')`;
  const doc = await upload(U.owner, overdue.id, 'отчёт.pdf');
  await S.sql`insert into org_returns (order_id, document_id, org_id, executor_user_id, returned_by, filename, comment)
              values (${overdue.id}, ${doc.id}, ${orgC.id}, ${ex.e1.user.id}, ${headC.user.id}, 'отчёт.pdf', 'Поправьте')`;
  const r = (await report(headC)).body.report;
  const e1 = r.experts.find((e) => e.user_id === ex.e1.user.id);
  assert.deepEqual({ ...e1, user_id: undefined, full_name: undefined }, { user_id: undefined, full_name: undefined,
    accepted: 2, done: 2, done_late: 1, overdue_now: 1, returned_head: 1, returned_dispatcher: 1, fee_kop: 800_000 + 1_600_000, paid_kop: 800_000 });
  assert.equal(r.experts.find((e) => e.user_id === ex.e2.user.id).done, 0);
  assert.equal(r.total.done, 2);
  assert.equal(r.total.fee_kop, 2_400_000);
  // Без заказчика и названий заявок.
  for (const secret of ['Сводка:', U.owner.user.id]) assert.ok(!JSON.stringify(r).includes(secret), secret);
  // Прошлый месяц — пусто, «просрочено сейчас» не считается.
  const prev = (await report(headC, `?month=${r.months[1]}`)).body.report;
  assert.equal(prev.current, false);
  assert.equal(prev.total.done, 0);
  assert.equal(prev.total.overdue_now, null);
  // Таблица для Excel: BOM, точка с запятой, суммы с запятой, имя с «=» — не формула, «;» — в кавычках.
  const csv = await headC.req('GET', `/api/orgs/${orgC.id}/report?format=csv`, undefined, { binary: true });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment/);
  assert.deepEqual([...csv.body.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM');
  const text = csv.body.toString('utf8');
  assert.ok(text.includes('Тестовая организация В'));
  assert.ok(text.includes("'=Сидоров «Эксперт»;2;2;1;1;1;1;24000,00;8000,00"), text);
  assert.ok(text.includes('"Петрова; Эксперт";0;0;0;0;0;0;0,00;0,00'), text);
  assert.ok(text.includes('Итого;2;2;1;1;1;1;24000,00;8000,00'), text);
  assert.equal((await report(ex.e1, '?format=csv')).status, 403);

  // Архив сданных за месяц заключений (2.89): только руководитель; без сданных дел — «нечего выгружать».
  cover('orgs.report.archive');
  const archive = (c, q = '', orgId = orgC.id) => c.req('GET', `/api/orgs/${orgId}/report/archive${q}`, undefined, { binary: true });
  for (const c of [ex.e1, U.dispatcher, U.admin]) assert.equal((await archive(c)).status, 403);
  for (const k of ['stranger', 'headA', 'headB', 'owner']) assert.equal((await archive(U[k])).status, 404, k);
  const zipped = await archive(headC);
  assert.equal(zipped.status, 200);
  assert.equal(zipped.headers.get('content-type'), 'application/zip');
  assert.match(decodeURIComponent(zipped.headers.get('content-disposition')), /Заключения за .+ \d{4}\.zip/);
  assert.equal((await archive(headC, `?month=${r.months[1]}`)).status, 409);
  assert.equal((await archive(headC, '?month=2020-01')).status, 400);
});

test('свои заготовки абзацев (2.87): видит и меняет только сам эксперт; не специалист — «не найдено»', async () => {
  for (const id of ['snippets.list', 'snippets.add', 'snippets.update', 'snippets.remove']) cover(id);
  const exp = await login(S, '+79990001492');
  await makeSpecialist(S.sql, exp.user.id);
  const add = await exp.req('POST', '/api/specialist/me/snippets', { kind: 'assumption', title: 'Скрытые дефекты', body: 'Тестовая заготовка: скрытые дефекты не учитывались.' });
  assert.equal(add.status, 201);
  assert.equal(add.body.snippets.length, 1);
  assert.equal(add.body.snippets[0].kind_name, 'Допущения');
  // Неверный вид и пустой текст — отказ.
  assert.equal((await exp.req('POST', '/api/specialist/me/snippets', { kind: 'x', title: 'a', body: 'b' })).status, 400);
  assert.equal((await exp.req('POST', '/api/specialist/me/snippets', { kind: 'other', title: 'a', body: '  ' })).status, 400);
  assert.equal((await U.owner.req('GET', '/api/specialist/me/snippets')).status, 404, 'не специалист');
  assert.equal((await U.owner.req('POST', '/api/specialist/me/snippets', { kind: 'other', title: 'a', body: 'b' })).status, 404);
  for (const k of ['spec', 'dispatcher', 'admin', 'headA', 'stranger']) {
    const c = U[k];
    assert.equal((await c.req('PUT', `/api/specialist/me/snippets/${add.body.id}`, { kind: 'other', title: 'Подлог', body: 'x' })).status, 404, k);
    assert.equal((await c.req('DELETE', `/api/specialist/me/snippets/${add.body.id}`)).status, 404, k);
    const own = (await c.req('GET', '/api/specialist/me/snippets')).body;
    assert.ok(!JSON.stringify(own ?? {}).includes('Тестовая заготовка'), k);
  }
  const upd = await exp.req('PUT', `/api/specialist/me/snippets/${add.body.id}`, { kind: 'reservation', title: 'Оговорка', body: 'Тестовая заготовка: новая редакция.' });
  assert.equal(upd.status, 200);
  assert.deepEqual(upd.body.snippets.map((s) => [s.kind, s.title, s.body]), [['reservation', 'Оговорка', 'Тестовая заготовка: новая редакция.']]);
  const del = await exp.req('DELETE', `/api/specialist/me/snippets/${add.body.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.snippets.length, 0);
  assert.equal((await exp.req('DELETE', `/api/specialist/me/snippets/${add.body.id}`)).status, 404, 'убранная — больше не найти');
});

test('мои итоги за месяц (2.92): только свои дела — частные и от организации; в срок, возвраты, деньги; не специалист — 404', async () => {
  cover('specialist.me.report');
  const exp = await login(S, '+79990001493');
  const other = await login(S, '+79990001494');
  await makeSpecialist(S.sql, exp.user.id);
  await makeSpecialist(S.sql, other.user.id);
  const report = (c, q = '') => c.req('GET', `/api/specialist/me/report${q}`);
  assert.equal((await report(U.owner)).status, 404, 'не специалист');
  const empty = (await report(exp)).body.report;
  const month = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 7);
  assert.equal(empty.month, month);
  assert.deepEqual(empty.months, [month], 'только что стал специалистом — только текущий месяц');
  assert.deepEqual(empty.total, { accepted: 0, done: 0, done_on_time: 0, done_late: 0, overdue_now: 0, returned_head: 0, returned_dispatcher: 0, fee_kop: 0, paid_kop: 0 });
  assert.deepEqual(empty.cases, []);
  for (const q of ['?month=2020-01', '?month=2099-01', '?month=13']) assert.equal((await report(exp, q)).body.error, 'bad_month', q);
  await S.sql`update specialists set created_at = now() - interval '2 years' where user_id = ${exp.user.id}`;
  // Частное дело сдано в срок и выплачено; дело от организации — позже срока, руководитель и диспетчер возвращали;
  // одно в работе просрочено; дело другого эксперта — не считается.
  const order = async (title, status, days, priceKop, executor = exp.user.id) => {
    const o = (await U.owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
    await S.sql`update orders set status = ${status}, deadline = current_date + ${days}::int, price_kop = ${priceKop}, executor_user_id = ${executor} where id = ${o.id}`;
    return o;
  };
  const onTime = await order('Итоги: частное в срок', 'done', 5, 1_000_000);
  const late = await order('Итоги: от организации позже срока', 'closed', -1, 2_000_000);
  const overdue = await order('Итоги: просрочено', 'in_work', -2, 500_000);
  const foreign = await order('Итоги: чужое', 'done', 5, 3_000_000, other.user.id);
  for (const o of [onTime, late]) {
    await S.sql`insert into order_offers (order_id, specialist_id, score, outcome, outcome_at) values (${o.id}, ${exp.user.id}, '{}', 'accepted', now())`;
  }
  const hist = (o, from, to) => S.sql`insert into order_status_history (order_id, from_status, to_status, side) values (${o.id}, ${from}, ${to}, 'dispatcher')`;
  await hist(onTime, 'review', 'done');
  // Сдано на секунду раньше: в одну миллисекунду порядок дел в списке был бы случайным.
  await S.sql`update order_status_history set at = at - interval '1 second' where order_id = ${onTime.id}`;
  await hist(late, 'review', 'in_work'); await hist(late, 'review', 'done'); await hist(late, 'done', 'closed');
  await hist(foreign, 'review', 'done');
  await S.sql`insert into payouts (order_id, executor_user_id, amount_kop, commission_kop, status, paid_at)
              values (${onTime.id}, ${exp.user.id}, 800000, 200000, 'succeeded', now()),
                     (${foreign.id}, ${other.user.id}, 2400000, 600000, 'succeeded', now())`;
  const doc = await upload(U.owner, overdue.id, 'отчёт.pdf');
  await S.sql`insert into org_returns (order_id, document_id, org_id, executor_user_id, returned_by, filename, comment)
              values (${overdue.id}, ${doc.id}, ${orgA.id}, ${exp.user.id}, ${U.headA.user.id}, 'отчёт.pdf', 'Поправьте')`;
  const r = (await report(exp)).body.report;
  assert.equal(r.months.length, 13);
  assert.deepEqual(r.total, { accepted: 2, done: 2, done_on_time: 1, done_late: 1, overdue_now: 1, returned_head: 1, returned_dispatcher: 1,
    fee_kop: 800_000 + 1_600_000, paid_kop: 800_000 });
  assert.deepEqual(r.cases.map((c) => [c.id, c.late, c.fee_kop, c.paid]), [[onTime.id, false, 800_000, true], [late.id, true, 1_600_000, false]]);
  assert.ok(!JSON.stringify(r).includes('Итоги: чужое'));
  assert.ok(!JSON.stringify(r).includes('Итоги: просрочено'), 'в списке — только сданные');
  // Другой эксперт видит только своё; прошлый месяц — пусто, «просрочено сейчас» не считается.
  const o2 = (await report(other)).body.report;
  assert.deepEqual(o2.cases.map((c) => c.id), [foreign.id]);
  assert.equal(o2.total.paid_kop, 2_400_000);
  const prev = (await report(exp, `?month=${r.months[1]}`)).body.report;
  assert.equal(prev.current, false);
  assert.equal(prev.total.done, 0);
  assert.equal(prev.total.overdue_now, null);
});

test('реестр: открытые операции — только из утверждённого списка, остальные покрыты этой таблицей', () => {
  const PUBLIC = ['health', 'auth.code', 'auth.verify', 'files.memory', 'files.memory.upload', 'test.calls', 'test.script', 'test.reset', 'test.mail.inbound', 'stage.login', 'payments.notify',
    'inspect.view', 'inspect.photo', 'inspect.finish'];
  const ops = S.app.locals.ops;
  const extraPublic = ops.filter((o) => o.auth === 'public' && !PUBLIC.includes(o.id)).map((o) => o.id);
  assert.deepEqual(extraPublic, [], `новые открытые операции: ${extraPublic.join(', ')}`);
  // Без защиты от подделки запроса — только уведомление ЮKassa (оно содержимому не верит) и загрузка «в память» по
  // подписанной ссылке (тесты; как PUT в хранилище, 2.49).
  assert.deepEqual(ops.filter((o) => o.csrf === false).map((o) => o.id).sort(), ['files.memory.upload', 'payments.notify']);
  // Операции моста — только три, все под /api/bridge/ (подпись ключом моста).
  assert.deepEqual(ops.filter((o) => o.auth === 'bridge').map((o) => o.id), ['bridge.crm.profiles', 'bridge.crm.load', 'bridge.crm.offers']);
  const unchecked = ops.filter((o) => o.auth !== 'public' && !covered.has(o.id)).map((o) => o.id);
  assert.deepEqual(unchecked, [], `операции без проверки «свой/чужой» в этой таблице: ${unchecked.join(', ')}`);
});
