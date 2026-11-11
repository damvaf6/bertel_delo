// Проверка организации эксперта перед выдачей (2.466, схема 5 экранов — решение Дамира 31.10/02.11.2026): у «Экспертизы»
// заключение проверяет и подписывает организация эксперта (ЦНЭР). При ORG_CHECK=1 (по умолчанию — боевой сайт) эксперт без
// организации не попадает в подбор и ленту, не сдаёт дело на проверку; без подписи организации диспетчер не выдаёт.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, makeOrg, addMember, signResults, testEnv } from '../helpers.mjs';
import { loadConfig } from '../../src/config.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';

let S, owner, dispatcher, solo, member, head, org;
const FIELDS = { purpose: 'court', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 46', area: '40' };

before(async () => {
  S = await startApp({ ORG_CHECK: '1', AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990004661');
  dispatcher = await login(S, '+79990004662');
  solo = await login(S, '+79990004663');
  member = await login(S, '+79990004664');
  head = await login(S, '+79990004665');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, solo.user.id);
  await makeSpecialist(S.sql, member.user.id);
  org = await makeOrg(S.sql, 'ООО «ЦНЭР-Пример»');
  await addMember(S.sql, org.id, head.user.id, 'head');
  await addMember(S.sql, org.id, member.user.id, 'member');
  assert.equal((await member.req('PATCH', '/api/specialist/me', { org_id: org.id })).status, 200);
  assert.equal((await head.req('PATCH', '/api/me', { full_name: 'Руководитель Примера' })).status, 200);
});
after(async () => { await S?.close(); });

async function step(c, o, to) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status });
}
const result = (o, who) => who.req('POST', `/api/orders/${o.id}/results`, Buffer.from('заключение'), {
  raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('Заключение.pdf') },
});
const docsOf = async (c, o) => (await c.req('GET', `/api/orders/${o.id}/documents`)).body;

async function paid(title) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: FIELDS })).status, 200);
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  return o;
}

test('настройка: проверка организации по умолчанию только на боевом сайте; ORG_CHECK — только 0 или 1', () => {
  assert.equal(loadConfig(testEnv()).orgCheck, false);
  assert.equal(loadConfig(testEnv({ ORG_CHECK: '1' })).orgCheck, true);
  const { TEST_CONTROL_TOKEN, ...dev } = testEnv();
  assert.equal(loadConfig({ ...dev, APP_ENV: 'dev' }).orgCheck, false);
  assert.throws(() => loadConfig(testEnv({ ORG_CHECK: 'да' })), /ORG_CHECK/);
});

test('описание модуля: у «Экспертизы» signature.org; действует только при включённой проверке; ошибка в описании — не стартует', () => {
  assert.equal(expertise.signature.org, true);
  assert.equal(createRegistry().orgCheckRequired('expertise', 'realty'), false, 'проверка выключена — не требуется');
  const on = createRegistry(undefined, { orgCheck: true });
  for (const s of expertise.services) assert.equal(on.orgCheckRequired('expertise', s.id), true, s.id);
  assert.equal(on.orgCheckRequired('expertise', 'nope'), false);
  assert.equal(on.orgCheckRequired('translation', 'simple'), false, 'у переводов не требуется');
  const { signature, ...rest } = structuredClone(expertise);
  assert.equal(createRegistry([{ ...rest, signature: {} }], { orgCheck: true }).orgCheckRequired('expertise', 'realty'), false);
  assert.throws(() => createRegistry([{ ...rest, signature: { org: 'да' } }]), /подпись/);
});

test('эксперт без организации — не в подборе и не в ленте; предложить ему нельзя; от организации — можно', async () => {
  const o = await paid('Квартира: кого подбирать');
  const c = (await dispatcher.req('GET', `/api/orders/${o.id}/candidates`)).body.candidates;
  assert.ok(c.some((x) => x.user_id === member.user.id), 'эксперт от организации — в подборе');
  assert.ok(!c.some((x) => x.user_id === solo.user.id), 'без организации — нет');
  assert.ok(!(await solo.req('GET', '/api/specialist/feed')).body.feed.some((x) => x.id === o.id), 'без организации — не в ленте');
  assert.ok((await member.req('GET', '/api/specialist/feed')).body.feed.some((x) => x.id === o.id), 'от организации — в ленте');
  assert.notEqual((await solo.req('POST', `/api/specialist/feed/${o.id}/take`)).status, 200, 'взять из ленты нельзя');
  assert.notEqual((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: solo.user.id, from: 'matching' })).status, 200);
  assert.equal((await member.req('POST', `/api/specialist/feed/${o.id}/take`)).status, 200);
});

test('дело уже у эксперта без организации — сдать нельзя, в деле сказано, что нужна организация', async () => {
  const o = await paid('Квартира: эксперт без организации');
  // Дело попало к нему до включения проверки — напрямую в базе.
  await S.sql`update orders set status = 'in_work', executor_user_id = ${solo.user.id} where id = ${o.id}`;
  assert.equal((await result(o, solo)).status, 201);
  await signResults(S, solo, o.id);
  const d = await docsOf(solo, o);
  assert.equal(d.org_check_missing, true);
  assert.equal(d.signature_org, null);
  const r = await step(solo, o, 'review');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'org_check');
  assert.match(r.body.message, /организация эксперта/);
  assert.equal((await docsOf(member, o)).org_check_missing, undefined, 'чужому — ничего');
});

test('от организации: без подписи руководителя не сдать; после неё — сдать; подпись организации пропала — не выдать', async () => {
  const o = await paid('Квартира: проверка ЦНЭР');
  assert.equal((await member.req('POST', `/api/specialist/feed/${o.id}/take`)).status, 200);
  const doc = (await result(o, member)).body.document;
  await signResults(S, member, o.id);
  assert.equal((await docsOf(member, o)).org_check_missing, undefined);
  assert.equal((await step(member, o, 'review')).body.error, 'not_signed_org');
  assert.equal((await head.req('POST', `/api/org-documents/${doc.id}/sign`, { confirm: true })).status, 201);
  assert.equal((await step(member, o, 'review')).status, 200);
  const rv = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  for (const c of rv.checks) await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict: 'ok', round: rv.round });
  const [sig] = await S.sql`delete from document_signatures where document_id = ${doc.id} and role = 'org' returning *`;
  const r = await step(dispatcher, o, 'done');
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'org_check_missing');
  assert.match(r.body.message, /Заключение\.pdf/);
  const cols = Object.keys(sig);
  await S.sql.pool.query(`insert into document_signatures (${cols.join(', ')}) overriding system value values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map((k) => sig[k]));
  assert.equal((await step(dispatcher, o, 'done')).status, 200);
});
