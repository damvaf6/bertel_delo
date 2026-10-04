// ИИ-ассистент по делам (задача 2.47): отвечает только по своим делам; память разных людей и организаций не
// смешивается. Сетка: каждый пишет в каждую свою память секретное слово — в подсказку модели попадают только слова
// этого человека и этой памяти; чужие заявки в разговор не взять; ушёл из организации или сняли с дела — память закрыта.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, makeOrg, addMember, setPlatformRole, makeSpecialist } from '../helpers.mjs';

let S, U, org1, org2;
const prompt = () => S.providers.ai.calls.at(-1).args.messages.map((m) => m.content).join('\n');
// Секретное слово человека в памяти: «ТАЙНА-<кто>-<память>».
const secret = (who, scope) => `ТАЙНА-${who}-${scope}`;
const ALL = [];

before(async () => {
  S = await startApp();
  U = {};
  const phones = { a: '+79990004801', b: '+79990004802', h1: '+79990004803', m1: '+79990004804', h2: '+79990004805', d: '+79990004806', e: '+79990004807' };
  for (const [k, p] of Object.entries(phones)) U[k] = await login(S, p);
  org1 = await makeOrg(S.sql, 'Тестовое бюро один');
  org2 = await makeOrg(S.sql, 'Тестовое бюро два');
  await addMember(S.sql, org1.id, U.h1.user.id, 'head');
  await addMember(S.sql, org1.id, U.m1.user.id, 'member');
  await addMember(S.sql, org2.id, U.h2.user.id, 'head');
  await addMember(S.sql, org2.id, U.h1.user.id, 'member'); // h1 — руководитель в одном бюро и сотрудник в другом
  await setPlatformRole(S.sql, U.d.user.id, 'dispatcher');
  await makeSpecialist(S.sql, U.e.user.id);
});
after(async () => { await S?.close(); });

// Памяти каждого: личная и по каждой своей организации.
const scopes = () => ({
  a: [null], b: [null], h1: [null, org1.id, org2.id], m1: [null, org1.id], h2: [null, org2.id], d: [null], e: [null],
});
const scopeName = (id) => (id === null ? 'личное' : id === org1.id ? 'бюро1' : 'бюро2');

test('память (2.47): в модель уходит только своя память — не чужого человека, не другой организации, не личная в рабочей', async () => {
  for (const [who, list] of Object.entries(scopes())) {
    for (const sc of list) {
      const r = await U[who].req('POST', '/api/assistant', { text: `${secret(who, scopeName(sc))}: вопрос`, org_id: sc });
      assert.equal(r.status, 201, `${who}/${scopeName(sc)}`);
      ALL.push(secret(who, scopeName(sc)));
    }
  }
  for (const [who, list] of Object.entries(scopes())) {
    for (const sc of list) {
      S.providers.ai.reset();
      assert.equal((await U[who].req('POST', '/api/assistant', { text: 'ещё вопрос', org_id: sc })).status, 201);
      const p = prompt();
      const mine = secret(who, scopeName(sc));
      assert.match(p, new RegExp(mine), `${who}/${scopeName(sc)}: своя память`);
      for (const s of ALL.filter((x) => x !== mine)) assert.doesNotMatch(p, new RegExp(s), `${who}/${scopeName(sc)}: чужое «${s}»`);
      // То же — в том, что человек видит на экране.
      const shown = (await U[who].req('GET', `/api/assistant${sc ? `?org=${sc}` : ''}`)).body.messages.map((m) => m.body).join('\n');
      for (const s of ALL.filter((x) => x !== mine)) assert.doesNotMatch(shown, new RegExp(s), `${who}/${scopeName(sc)}: на экране «${s}»`);
    }
  }
  // Чужая организация как раздел памяти — «не найдено»; подставить чужой org_id нельзя.
  for (const [who, org] of [['a', org1], ['m1', org2], ['h2', org1], ['d', org1], ['e', org2]]) {
    assert.equal((await U[who].req('POST', '/api/assistant', { text: 'x', org_id: org.id })).status, 404, `${who}`);
    assert.equal((await U[who].req('GET', `/api/assistant?org=${org.id}`)).status, 404, `${who}`);
  }
});

test('дела (2.47): в разговор берётся только своё дело и только в его память; чужие и дела другой организации — «не найдено»', async () => {
  const mk = async (c, title, orgId) => (await c.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title, ...(orgId ? { org_id: orgId } : {}) })).body.order;
  const oa = await mk(U.a, 'ДЕЛО-А личное');
  const om1 = await mk(U.m1, 'ДЕЛО-М1 бюро один', org1.id);
  const oh1 = await mk(U.h1, 'ДЕЛО-Р1 бюро один', org1.id);
  const oh2 = await mk(U.h2, 'ДЕЛО-Р2 бюро два', org2.id);
  const ask = (who, order, sc = null) => U[who].req('POST', '/api/assistant', { text: 'что дальше?', order_id: order.id, org_id: sc });
  const cases = [
    ['a', oa, null, 201], ['b', oa, null, 404], ['h1', oa, null, 404], ['e', oa, null, 404],
    ['m1', om1, org1.id, 201], ['m1', om1, null, 404], ['m1', oh1, org1.id, 404],     // сотрудник — только своё и в памяти бюро
    ['h1', om1, org1.id, 201], ['h1', om1, org2.id, 404], ['h1', om1, null, 404],      // руководитель — дела бюро в его памяти
    ['h1', oh2, org2.id, 404],                                                          // в другом бюро он сотрудник — чужое не видит
    ['h2', oh2, org2.id, 201], ['h2', om1, org2.id, 404], ['a', om1, null, 404],
  ];
  for (const [who, order, sc, code] of cases) {
    S.providers.ai.reset();
    const r = await ask(who, order, sc);
    assert.equal(r.status, code, `${who} → «${order.title}» в ${scopeName(sc)}`);
    if (code === 201) assert.match(prompt(), new RegExp(order.title));
  }
  // Список дел, которые можно взять в разговор, — только видимые в этой памяти.
  const list = async (who, sc) => (await U[who].req('GET', `/api/assistant${sc ? `?org=${sc}` : ''}`)).body.orders.map((o) => o.title).sort();
  assert.deepEqual(await list('a', null), ['ДЕЛО-А личное']);
  assert.deepEqual(await list('b', null), []);
  assert.deepEqual(await list('m1', org1.id), ['ДЕЛО-М1 бюро один']);
  assert.deepEqual(await list('m1', null), []);
  assert.deepEqual(await list('h1', org1.id), ['ДЕЛО-М1 бюро один', 'ДЕЛО-Р1 бюро один']);
  assert.deepEqual(await list('h1', org2.id), []);
  assert.deepEqual(await list('h2', org2.id), ['ДЕЛО-Р2 бюро два']);

  // Сотрудник ушёл из бюро — его рабочая память закрыта, и ни слова из неё не попадает в личную.
  await S.sql`delete from org_members where org_id = ${org1.id} and user_id = ${U.m1.user.id}`;
  assert.equal((await U.m1.req('GET', `/api/assistant?org=${org1.id}`)).status, 404);
  S.providers.ai.reset();
  await U.m1.req('POST', '/api/assistant', { text: 'личный вопрос после ухода' });
  assert.doesNotMatch(prompt(), /ДЕЛО-М1|ТАЙНА-m1-бюро1/);
});
