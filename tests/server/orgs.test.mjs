// Слой «организация» (задача 1.2): создание, приглашения по номеру, роли, уход сотрудника, последний руководитель.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login } from '../helpers.mjs';
import { LIMITS } from '../../src/ops/org-ops.mjs';

let S;
before(async () => { S = await startApp(); });
after(async () => { await S?.close(); });

async function newOrg(head, name = 'Тестовая организация') {
  const r = await head.req('POST', '/api/orgs', { name });
  assert.equal(r.status, 201);
  return r.body.org;
}

async function invite(head, org, phone, role = 'member') {
  const r = await head.req('POST', `/api/orgs/${org.id}/invites`, { phone, role });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.invite;
}

async function join(head, org, phone, role = 'member') {
  const inv = await invite(head, org, phone, role);
  const c = await login(S, phone);
  const r = await c.req('POST', `/api/invites/${inv.id}/accept`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}

const ids = async (c) => (await c.req('GET', '/api/orders')).body.orders.map((o) => o.id);

test('приглашение на номер, с которого ещё не входили: после первого входа человек видит его и принимает', async () => {
  const head = await login(S, '+79990001001');
  const org = await newOrg(head, 'Тестовое бюро переводов');
  const inv = await invite(head, org, '8 (999) 000-10-02', 'senior');
  assert.equal(inv.phone, '+79990001002', 'номер приводится к единому виду');

  const newbie = await login(S, '+79990001002');
  const mine = (await newbie.req('GET', '/api/invites')).body.invites;
  assert.deepEqual(mine.map((i) => [i.org_name, i.role, i.role_ru]), [['Тестовое бюро переводов', 'senior', 'старший']]);

  const r = await newbie.req('POST', `/api/invites/${inv.id}/accept`);
  assert.deepEqual(r.body, { org_id: org.id, role: 'senior' });
  // Роль действует сразу, без повторного входа.
  assert.deepEqual((await newbie.req('GET', '/api/me')).body.orgs.map((o) => [o.name, o.role]), [['Тестовое бюро переводов', 'senior']]);
  assert.equal((await newbie.req('GET', '/api/invites')).body.invites.length, 0);
  assert.equal((await newbie.req('POST', `/api/invites/${inv.id}/accept`)).status, 404, 'принять второй раз нельзя');
  assert.equal((await head.req('GET', `/api/orgs/${org.id}/invites`)).body.invites.length, 0);
  const log = await S.sql`select action from audit_log where subject_type = 'org' and subject_id = ${org.id} order by id`;
  assert.deepEqual(log.map((x) => x.action), ['org.create', 'org.invite.create', 'org.invite.accept']);
});

test('отклонённое приглашение больше не действует; руководитель может пригласить снова', async () => {
  const head = await login(S, '+79990001011');
  const org = await newOrg(head);
  const inv = await invite(head, org, '+79990001012');
  const c = await login(S, '+79990001012');
  assert.equal((await c.req('POST', `/api/invites/${inv.id}/decline`)).status, 204);
  assert.equal((await c.req('POST', `/api/invites/${inv.id}/accept`)).status, 404);
  assert.deepEqual((await c.req('GET', '/api/orgs')).body.orgs, []);
  await invite(head, org, '+79990001012');
});

test('повторное приглашение и приглашение участника — отказ; просроченное — не видно и не принимается', async () => {
  const head = await login(S, '+79990001021');
  const org = await newOrg(head);
  const inv = await invite(head, org, '+79990001022');
  const dup = await head.req('POST', `/api/orgs/${org.id}/invites`, { phone: '+7 999 000 10 22' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, 'invite_exists');
  const self = await head.req('POST', `/api/orgs/${org.id}/invites`, { phone: '+79990001021' });
  assert.equal(self.status, 409);
  assert.equal(self.body.error, 'already_member');
  assert.equal((await head.req('POST', `/api/orgs/${org.id}/invites`, { phone: '123' })).status, 400);
  assert.equal((await head.req('POST', `/api/orgs/${org.id}/invites`, { phone: '+79990001023', role: 'boss' })).status, 400);

  await S.sql`update org_invites set expires_at = now() - interval '1 minute' where id = ${inv.id}`;
  const c = await login(S, '+79990001022');
  assert.deepEqual((await c.req('GET', '/api/invites')).body.invites, []);
  assert.equal((await c.req('POST', `/api/invites/${inv.id}/accept`)).status, 404);
  assert.equal((await head.req('GET', `/api/orgs/${org.id}/invites`)).body.invites.length, 0);
  const again = await invite(head, org, '+79990001022');
  assert.notEqual(again.id, inv.id, 'просроченное закрыто, выдано новое');
  assert.equal((await c.req('POST', `/api/invites/${again.id}/accept`)).status, 200);
});

test('ушедший сотрудник теряет доступ к делам организации, личные дела остаются; дела видит и передаёт руководитель', async () => {
  const head = await login(S, '+79990001031');
  const org = await newOrg(head);
  const worker = await join(head, org, '+79990001032');
  const other = await join(head, org, '+79990001033');

  const orgOrder = (await worker.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Дело организации', org_id: org.id })).body.order;
  const personal = (await worker.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Личное дело' })).body.order;
  const doc = (await worker.req('POST', `/api/orders/${orgOrder.id}/documents`, Buffer.from('отчёт'), {
    raw: true, headers: { 'x-file-name': 'otchet.txt' },
  })).body.document;
  assert.equal(orgOrder.org_name, 'Тестовая организация');

  assert.equal((await head.req('DELETE', `/api/orgs/${org.id}/members/${worker.user.id}`)).status, 204);

  assert.deepEqual(await ids(worker), [personal.id], 'осталось только личное');
  assert.equal((await worker.req('GET', `/api/orders/${orgOrder.id}`)).status, 404);
  assert.equal((await worker.req('GET', `/api/documents/${doc.id}/link`)).status, 404);
  assert.equal((await worker.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'x', org_id: org.id })).status, 404, 'от имени организации больше нельзя');
  assert.equal((await worker.req('GET', `/api/orgs/${org.id}`)).status, 404);

  assert.ok((await ids(head)).includes(orgOrder.id), 'дело осталось у организации');
  assert.ok(!(await ids(head)).includes(personal.id), 'личное дело сотрудника руководитель не видит');
  assert.equal((await head.req('PATCH', `/api/orders/${orgOrder.id}/responsible`, { user_id: worker.user.id })).status, 404,
    'бывшему сотруднику дело не передать');
  const t = await head.req('PATCH', `/api/orders/${orgOrder.id}/responsible`, { user_id: other.user.id });
  assert.equal(t.status, 200);
  assert.equal(t.body.order.owner_user_id, other.user.id);
  assert.ok((await ids(other)).includes(orgOrder.id));
});

test('сотрудник уходит сам — то же самое; вернувшись по приглашению, снова видит свои дела организации', async () => {
  const head = await login(S, '+79990001041');
  const org = await newOrg(head);
  const worker = await join(head, org, '+79990001042');
  const order = (await worker.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Дело до ухода', org_id: org.id })).body.order;
  assert.equal((await worker.req('POST', `/api/orgs/${org.id}/leave`)).status, 204);
  assert.deepEqual(await ids(worker), []);
  const inv = await invite(head, org, '+79990001042');
  assert.equal((await worker.req('POST', `/api/invites/${inv.id}/accept`)).status, 200);
  assert.deepEqual(await ids(worker), [order.id]);
});

test('в организации всегда есть руководитель: единственный не уходит, не понижается и не удаляется', async () => {
  const head = await login(S, '+79990001051');
  const org = await newOrg(head);
  const r1 = await head.req('PATCH', `/api/orgs/${org.id}/members/${head.user.id}`, { role: 'member' });
  assert.equal(r1.status, 409);
  assert.equal(r1.body.error, 'last_head');
  assert.equal((await head.req('DELETE', `/api/orgs/${org.id}/members/${head.user.id}`)).status, 409);
  assert.equal((await head.req('POST', `/api/orgs/${org.id}/leave`)).status, 409);

  const second = await join(head, org, '+79990001052', 'head');
  assert.equal((await head.req('PATCH', `/api/orgs/${org.id}/members/${head.user.id}`, { role: 'senior' })).status, 200,
    'при втором руководителе можно понизить себя');
  assert.equal((await head.req('GET', `/api/orgs/${org.id}/invites`)).status, 403, 'бывший руководитель больше не управляет');
  assert.equal((await second.req('POST', `/api/orgs/${org.id}/leave`)).status, 409);
});

test('два руководителя одновременно снимают друг друга — остаётся хотя бы один', async () => {
  const a = await login(S, '+79990001061');
  const org = await newOrg(a);
  const b = await join(a, org, '+79990001062', 'head');
  const [ra, rb] = await Promise.all([
    a.req('PATCH', `/api/orgs/${org.id}/members/${b.user.id}`, { role: 'member' }),
    b.req('PATCH', `/api/orgs/${org.id}/members/${a.user.id}`, { role: 'member' }),
  ]);
  // Второй получает отказ: либо уже не руководитель (403), либо упирается в «последнего руководителя» (409).
  const codes = [ra.status, rb.status].sort();
  assert.equal(codes[0], 200);
  assert.ok([403, 409].includes(codes[1]), String(codes));
  const [{ n }] = await S.sql`select count(*)::int as n from org_members where org_id = ${org.id} and role = 'head'`;
  assert.equal(n, 1);
});

test('старший распределяет дела и видит нагрузку, но состав и приглашения не трогает', async () => {
  const head = await login(S, '+79990001071');
  const org = await newOrg(head);
  const senior = await join(head, org, '+79990001072', 'senior');
  const w1 = await join(head, org, '+79990001073');
  const w2 = await join(head, org, '+79990001074');
  const order = (await w1.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Оценка автомобиля', org_id: org.id })).body.order;

  const members = (await senior.req('GET', `/api/orgs/${org.id}/members`)).body.members;
  assert.equal(members.find((m) => m.user_id === w1.user.id).orders, 1);
  assert.equal((await senior.req('PATCH', `/api/orders/${order.id}/responsible`, { user_id: w2.user.id })).status, 200);
  assert.equal((await senior.req('POST', `/api/orgs/${org.id}/invites`, { phone: '+79990001075' })).status, 403);
  assert.equal((await senior.req('DELETE', `/api/orgs/${org.id}/members/${w1.user.id}`)).status, 403);
  // Дело видно в списке с именем того, кто его ведёт.
  await w2.req('PATCH', '/api/me', { full_name: 'Тестовый Эксперт' });
  const row = (await head.req('GET', '/api/orders')).body.orders.find((o) => o.id === order.id);
  assert.equal(row.responsible_name, 'Тестовый Эксперт');
  assert.equal(row.org_name, 'Тестовая организация');
});

test('ИНН и название: проверка и правка руководителем', async () => {
  const head = await login(S, '+79990001081');
  const r = await head.req('POST', '/api/orgs', { name: '  АНО «Тестовый центр экспертиз»  ', inn: '7707 083 893' });
  assert.equal(r.status, 201);
  assert.equal(r.body.org.name, 'АНО «Тестовый центр экспертиз»');
  assert.equal(r.body.org.inn, '7707083893');
  const ip = await head.req('PATCH', `/api/orgs/${r.body.org.id}`, { inn: '500100732259' });
  assert.equal(ip.body.org.inn, '500100732259');
  assert.equal(ip.body.org.name, 'АНО «Тестовый центр экспертиз»', 'не переданное поле не меняется');
  assert.equal((await head.req('PATCH', `/api/orgs/${r.body.org.id}`, { inn: '12345' })).status, 400);
  assert.equal((await head.req('PATCH', `/api/orgs/${r.body.org.id}`, { inn: null })).body.org.inn, null);
});

test('ограничение на число созданных организаций', async () => {
  const c = await login(S, '+79990001091');
  for (let i = 0; i < LIMITS.orgsCreatedPerUser; i++) await newOrg(c, `Тестовая ${i}`);
  const r = await c.req('POST', '/api/orgs', { name: 'Лишняя' });
  assert.equal(r.status, 429);
});
