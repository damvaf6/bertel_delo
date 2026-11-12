// Дело для банка без аккредитации (2.453): эксперту, у которого ни своей аккредитации в банке заявки, ни через организацию,
// — пометка у предложения (список дел, «Сегодня», «Что дальше» в деле) и строка в «Сегодня», пока дело в работе.
// Аккредитация есть — пометки нет; «Другой банк» и заявка не для банка — без пометок.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, makeOrg, addMember, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';

let S, owner, dispatcher, plain, self, org;
const today = todayMsk();

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990004541');
  dispatcher = await login(S, '+79990004542');
  plain = await login(S, '+79990004543'); // без аккредитации
  self = await login(S, '+79990004544'); // аккредитован в Сбербанке сам
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  for (const u of [plain, self]) await makeSpecialist(S.sql, u.user.id);
  await S.sql`insert into dossier_items (user_id, kind, title, bank, valid_until)
              values (${self.user.id}, 'bank', 'Сбербанк', 'sber', ${addDays(today, 100)})`;
  org = await makeOrg(S.sql, 'Тестовая организация 2.453');
  await addMember(S.sql, org.id, plain.user.id, 'member');
  await S.sql`update specialists set org_id = ${org.id} where user_id = ${plain.user.id}`;
});
after(async () => { await S?.close(); });

async function offered(to, fields) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty' })).body.order;
  const r = await owner.req('PATCH', `/api/orders/${o.id}`, { title: `Тест 2.453 ${Object.values(fields).join(' ')}`, deadline: addDays(today, 20),
    fields: { region: 'mo', object_type: 'flat', address: 'тестовый адрес, 1', ...fields } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  await ensurePaid(S.sql, o.id);
  const f = await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: to.user.id, from: 'matching' });
  assert.equal(f.status, 200, JSON.stringify(f.body));
  return o;
}
const listed = async (u, o) => (await u.req('GET', '/api/orders')).body.orders.find((x) => x.id === o.id);
const card = async (u, o) => (await u.req('GET', `/api/orders/${o.id}`)).body;
const today_ = async (u) => (await u.req('GET', '/api/today')).body.expert;

test('предложение для Сбербанка без аккредитации — пометка в списке, в деле и в «Сегодня»; принял — строка в «Сегодня»', async () => {
  const o = await offered(plain, { purpose: 'bank', bank: 'sber' });
  const sber = { id: 'sber', name: 'Сбербанк' };
  assert.deepEqual((await listed(plain, o)).bank_gap, sber);
  assert.deepEqual((await card(plain, o)).bank_gap, sber);
  let t = await today_(plain);
  assert.deepEqual(t.offers.find((x) => x.id === o.id).bank_gap, sber);
  assert.ok(!t.bank_gap.some((x) => x.id === o.id), 'предложение — пометкой, не строкой «в работе»');
  // Другим пометка не видна: заказчику и диспетчеру в карточке — null.
  assert.equal((await card(owner, o)).bank_gap, null);
  assert.equal((await card(dispatcher, o)).bank_gap, null);
  // Принять всё равно можно — решает эксперт.
  assert.equal((await plain.req('POST', `/api/orders/${o.id}/status`, { from: 'awaiting_executor', to: 'in_work' })).status, 200);
  t = await today_(plain);
  const row = t.bank_gap.find((x) => x.id === o.id);
  assert.deepEqual(row?.bank, sber);
  assert.equal(row.deadline, addDays(today, 20));
  // Организация эксперта получила аккредитацию в Сбербанке — пометки нет.
  await S.sql`insert into org_accreditations (org_id, bank, title, valid_until, created_by)
              values (${org.id}, 'sber', 'Сбербанк', ${addDays(today, 30)}, ${plain.user.id})`;
  assert.ok(!(await today_(plain)).bank_gap.some((x) => x.id === o.id));
  assert.equal((await card(plain, o)).bank_gap, null);
  assert.equal('bank_gap' in (await listed(plain, o)), false);
  // Аккредитация организации истекла — пометка снова.
  await S.sql`update org_accreditations set valid_until = ${addDays(today, -1)} where org_id = ${org.id}`;
  assert.deepEqual((await card(plain, o)).bank_gap, sber);
});

test('аккредитован сам — без пометки; «Другой банк» и заявка не для банка — без пометок', async () => {
  const a = await offered(self, { purpose: 'bank', bank: 'sber' });
  assert.equal((await card(self, a)).bank_gap, null);
  assert.equal((await today_(self)).offers.find((x) => x.id === a.id).bank_gap, null);
  for (const fields of [{ purpose: 'bank', bank: 'other' }, { purpose: 'deal' }]) {
    const o = await offered(plain, fields);
    assert.equal((await card(plain, o)).bank_gap, null);
    assert.equal('bank_gap' in (await listed(plain, o)), false);
    assert.equal((await today_(plain)).offers.find((x) => x.id === o.id).bank_gap, null);
  }
});

// Прогон 2.460: аккредитация в банке дела сегодня действует, но кончается раньше срока дела — в деле, рядом с «Аттестат или
// полис кончаются раньше срока дела» (2.365): отчёт после её конца банк может не принять (ИИ-проверка 2.458). Сама решает
// своя или организации — у той, что действует дольше; у организации — «продлевает руководитель».
test('прогон 2.460: аккредитация кончается раньше срока дела — предупреждение в деле', async () => {
  const late = await login(S, '+79990004545');
  await makeSpecialist(S.sql, late.user.id);
  await S.sql`insert into dossier_items (user_id, kind, title, bank, valid_until)
              values (${late.user.id}, 'bank', 'Сбербанк', 'sber', ${addDays(today, 10)})`;
  const o = await offered(late, { purpose: 'bank', bank: 'sber' });
  assert.equal((await late.req('POST', `/api/orders/${o.id}/status`, { from: 'awaiting_executor', to: 'in_work' })).status, 200);
  const term = async (u = late) => (await u.req('GET', `/api/orders/${o.id}/documents`)).body.dossier_term;
  assert.equal((await card(late, o)).bank_gap, null, 'сегодня действует — это не «аккредитации нет»');
  let t = await term();
  assert.equal(t.deadline, addDays(today, 20));
  assert.deepEqual(t.items, [{ kind: 'bank', kind_name: 'Аккредитация в банке «Сбербанк»', valid_until: addDays(today, 10), expired: false }]);
  assert.equal((await term(owner)) ?? null, null, 'заказчику — нет');
  // Организация эксперта аккредитована дольше срока дела — предупреждения нет.
  const o2 = await makeOrg(S.sql, 'Тестовая организация 2.460');
  await addMember(S.sql, o2.id, late.user.id, 'member');
  await S.sql`update specialists set org_id = ${o2.id} where user_id = ${late.user.id}`;
  await S.sql`insert into org_accreditations (org_id, bank, title, valid_until, created_by)
              values (${o2.id}, 'sber', 'Сбербанк', ${addDays(today, 40)}, ${late.user.id})`;
  assert.equal(await term(), null);
  // У организации тоже раньше срока, но позже своей — предупреждение по организации.
  await S.sql`update org_accreditations set valid_until = ${addDays(today, 15)} where org_id = ${o2.id}`;
  t = await term();
  assert.deepEqual(t.items, [{ kind: 'bank', kind_name: 'Аккредитация в банке «Сбербанк»', valid_until: addDays(today, 15), expired: false,
    org_name: 'Тестовая организация 2.460' }]);
  // Срок не указан — действует.
  await S.sql`update dossier_items set valid_until = null where user_id = ${late.user.id} and kind = 'bank'`;
  assert.equal(await term(), null);
  // «Другой банк» и заявка не для банка — без предупреждения.
  await S.sql`update dossier_items set valid_until = ${addDays(today, 10)} where user_id = ${late.user.id} and kind = 'bank'`;
  await S.sql`update org_accreditations set valid_until = ${addDays(today, 10)} where org_id = ${o2.id}`;
  for (const fields of [{ purpose: 'bank', bank: 'other' }, { purpose: 'deal' }]) {
    const x = await offered(late, fields);
    assert.equal((await late.req('POST', `/api/orders/${x.id}/status`, { from: 'awaiting_executor', to: 'in_work' })).status, 200);
    assert.equal((await late.req('GET', `/api/orders/${x.id}/documents`)).body.dossier_term, null);
  }
});
