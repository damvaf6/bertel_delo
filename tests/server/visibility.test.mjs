// Автопроверка видимости (задача 2.48): чужие дела не видны никому. Для КАЖДОЙ операции ядра над заявкой и её
// документом — каждый посторонний (заказчик другой заявки, эксперт, которому дело не предлагали, бывший исполнитель,
// руководитель и сотрудник другой организации, сотрудник той же организации с чужим делом) получает «не найдено»,
// и ничего не меняется. Диспетчер видит всё. Списки заявок и «Сегодня» — только свои дела.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, makeOrg, addMember, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { listOps } from '../../src/app.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';

let S, U, orgA, orgB, personal, orgOrder, inWork, docId;
const READY = { deadline: addDays(todayMsk(), 10), fields: { purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, Видимая ул., 1' } };

before(async () => {
  S = await startApp();
  U = {};
  const phones = {
    owner: '+79990004901', other: '+79990004902', expert: '+79990004903', exExpert: '+79990004904', strangerExpert: '+79990004905',
    headA: '+79990004906', memberA: '+79990004907', memberA2: '+79990004908', headB: '+79990004909', dispatcher: '+79990004910',
  };
  for (const [k, p] of Object.entries(phones)) U[k] = await login(S, p);
  orgA = await makeOrg(S.sql, 'Тестовая фирма видимости А');
  orgB = await makeOrg(S.sql, 'Тестовая фирма видимости Б');
  await addMember(S.sql, orgA.id, U.headA.user.id, 'head');
  await addMember(S.sql, orgA.id, U.memberA.user.id, 'member');
  await addMember(S.sql, orgA.id, U.memberA2.user.id, 'member');
  await addMember(S.sql, orgB.id, U.headB.user.id, 'head');
  await setPlatformRole(S.sql, U.dispatcher.user.id, 'dispatcher');
  for (const k of ['expert', 'exExpert', 'strangerExpert']) await makeSpecialist(S.sql, U[k].user.id);

  const make = async (c, title, orgId) => {
    const o = (await c.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title, ...(orgId ? { org_id: orgId } : {}) })).body.order;
    assert.equal((await c.req('PATCH', `/api/orders/${o.id}`, READY)).status, 200);
    return o;
  };
  personal = await make(U.owner, 'Личная заявка');
  orgOrder = await make(U.memberA, 'Заявка сотрудника фирмы А', orgA.id);
  inWork = await make(U.owner, 'Заявка в работе');
  const up = await U.owner.req('POST', `/api/orders/${personal.id}/documents`, Buffer.from('%PDF-1.4 выписка'), { raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': 'v.pdf' } });
  docId = up.body.document.id;
  // Заявка в работе: сначала у одного эксперта, потом передана другому (бывший теряет доступ).
  assert.equal((await U.owner.req('POST', `/api/orders/${inWork.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, inWork.id);
  const offer = async (who, from) => assert.equal((await U.dispatcher.req('POST', `/api/orders/${inWork.id}/offer`, { specialist_id: U[who].user.id, from })).status, 200);
  await offer('exExpert', 'matching');
  assert.equal((await U.exExpert.req('POST', `/api/orders/${inWork.id}/status`, { from: 'awaiting_executor', to: 'in_work' })).status, 200);
  assert.equal((await U.dispatcher.req('POST', `/api/orders/${inWork.id}/status`, { from: 'in_work', to: 'matching', reason: 'Передать другому' })).status, 200);
  await offer('expert', 'matching');
  assert.equal((await U.expert.req('POST', `/api/orders/${inWork.id}/status`, { from: 'awaiting_executor', to: 'in_work' })).status, 200);
});
after(async () => { await S?.close(); });

// Кто — посторонний для каждой заявки.
const OUTSIDERS = {
  personal: ['other', 'expert', 'exExpert', 'strangerExpert', 'headA', 'memberA', 'headB'],
  orgOrder: ['owner', 'other', 'expert', 'strangerExpert', 'memberA2', 'headB'],
  inWork: ['other', 'exExpert', 'strangerExpert', 'headA', 'memberA', 'headB'],
};
const INSIDERS = { personal: ['owner', 'dispatcher'], orgOrder: ['memberA', 'headA', 'dispatcher'], inWork: ['owner', 'expert', 'dispatcher'] };

test('каждая операция над заявкой (2.48): посторонним — «не найдено», ничего не меняется', async () => {
  const orders = { personal, orgOrder, inWork };
  const ops = listOps(S.cfg, S.providers).filter((o) => o.access?.resource === 'order');
  assert.ok(ops.length >= 40, `операций над заявкой: ${ops.length}`);
  const snapshot = async () => JSON.stringify(await S.sql`select id, status, title, fields, price_kop, executor_user_id, deadline from orders order by id`)
    + JSON.stringify(await S.sql`select count(*)::int as n from documents`) + JSON.stringify(await S.sql`select count(*)::int as n from order_messages`);
  const before = await snapshot();
  for (const op of ops) {
    for (const [name, o] of Object.entries(orders)) {
      const path = op.path.replace(`:${op.access.param}`, o.id).replace(/:[a-z_]+/gi, '00000000-0000-0000-0000-000000000000');
      for (const who of OUTSIDERS[name]) {
        const r = await U[who].req(op.method, path, op.method === 'GET' ? undefined : { from: o.status, to: 'cancelled', body: 'x', text: 'x' });
        assert.equal(r.status, 404, `${op.id} ${op.method} ${name}: ${who} получил ${r.status}`);
      }
    }
  }
  // Операции над документом заявки — тоже «не найдено» для посторонних.
  const docOps = listOps(S.cfg, S.providers).filter((o) => o.access?.resource === 'document');
  assert.ok(docOps.length >= 5);
  for (const op of docOps) {
    const path = op.path.replace(`:${op.access.param}`, docId);
    for (const who of OUTSIDERS.personal) {
      const r = await U[who].req(op.method, path, op.method === 'GET' ? undefined : { confirm: true });
      assert.equal(r.status, 404, `${op.id}: ${who} получил ${r.status}`);
    }
  }
  assert.equal(await snapshot(), before, 'посторонние ничего не изменили');
});

test('видимость заявки и документа (2.48): свои — видят, диспетчер — всё; списки и «Сегодня» — только свои дела', async () => {
  const orders = { personal, orgOrder, inWork };
  for (const [name, o] of Object.entries(orders)) {
    for (const who of INSIDERS[name]) assert.equal((await U[who].req('GET', `/api/orders/${o.id}`)).status, 200, `${name}: ${who}`);
    for (const who of OUTSIDERS[name]) assert.equal((await U[who].req('GET', `/api/orders/${o.id}`)).status, 404, `${name}: ${who}`);
  }
  // Документ заявки: по своей ссылке — заказчику и диспетчеру; остальным — «не найдено».
  for (const who of ['owner', 'dispatcher']) assert.equal((await U[who].req('GET', `/api/documents/${docId}/link`)).status, 200, who);
  for (const who of OUTSIDERS.personal) assert.equal((await U[who].req('GET', `/api/documents/${docId}/link`)).status, 404, who);

  const titles = async (who) => (await U[who].req('GET', '/api/orders')).body.orders.map((x) => x.title).sort();
  assert.deepEqual(await titles('owner'), ['Заявка в работе', 'Личная заявка']);
  assert.deepEqual(await titles('memberA'), ['Заявка сотрудника фирмы А']);
  assert.deepEqual(await titles('memberA2'), []);
  assert.deepEqual(await titles('headA'), ['Заявка сотрудника фирмы А']);
  assert.deepEqual(await titles('headB'), []);
  assert.deepEqual(await titles('expert'), ['Заявка в работе']);
  assert.deepEqual(await titles('exExpert'), [], 'сняли с дела — дело из списка ушло');
  assert.deepEqual(await titles('strangerExpert'), []);
  assert.deepEqual(await titles('dispatcher'), ['Заявка в работе', 'Заявка сотрудника фирмы А', 'Личная заявка']);

  // «Сегодня» и уведомления постороннего не содержат чужих заявок.
  for (const who of ['other', 'strangerExpert', 'headB', 'exExpert', 'memberA2']) {
    const t = JSON.stringify((await U[who].req('GET', '/api/today')).body);
    const n = JSON.stringify((await U[who].req('GET', '/api/notifications')).body);
    for (const o of Object.values(orders)) {
      if (OUTSIDERS[Object.keys(orders).find((k) => orders[k] === o)].includes(who)) {
        assert.ok(!t.includes(o.id) && !t.includes(o.title), `«Сегодня» ${who}: ${o.title}`);
        assert.ok(!n.includes(o.title), `уведомления ${who}: ${o.title}`);
      }
    }
  }
});
