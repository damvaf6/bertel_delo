// Подбор для заявки для банка (2.452): аккредитованные в банке заявки (сами — в досье, или через организацию, от которой
// работают) — первыми и с пометкой; истёкшая аккредитация и аккредитация в другом банке не в счёт; никого — предупреждение.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, makeOrg, addMember, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';

let S, owner, dispatcher, plain, self, viaOrg, old, org, plainOrg;
const today = todayMsk();

before(async () => {
  S = await startApp();
  owner = await login(S, '+79990004531');
  dispatcher = await login(S, '+79990004532');
  plain = await login(S, '+79990004533'); // без аккредитации, но свободнее всех
  self = await login(S, '+79990004534'); // аккредитован в Сбербанке сам
  viaOrg = await login(S, '+79990004535'); // через организацию
  old = await login(S, '+79990004536'); // аккредитация истекла, другая — в своём банке
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  for (const u of [plain, self, viaOrg, old]) await makeSpecialist(S.sql, u.user.id);
  // Загрузка: у аккредитованных дел больше — по одной оценке они были бы ниже.
  await S.sql`update specialists set external_load = 3 where user_id = any(${[self.user.id, viaOrg.user.id, old.user.id]}::uuid[])`;
  await S.sql`insert into dossier_items (user_id, kind, title, bank, valid_until) values
    (${self.user.id}, 'bank', 'Сбербанк', 'sber', ${addDays(today, 200)}),
    (${old.user.id}, 'bank', 'Сбербанк', 'sber', ${addDays(today, -1)}),
    (${old.user.id}, 'bank', 'Тестовый банк', 'other', null)`;
  org = await makeOrg(S.sql, 'Тестовая организация 2.452');
  plainOrg = await makeOrg(S.sql, 'Тестовая организация без аккредитаций 2.452');
  await addMember(S.sql, org.id, viaOrg.user.id, 'member');
  await addMember(S.sql, plainOrg.id, plain.user.id, 'member');
  await S.sql`update specialists set org_id = ${org.id} where user_id = ${viaOrg.user.id}`;
  await S.sql`update specialists set org_id = ${plainOrg.id} where user_id = ${plain.user.id}`;
  await S.sql`insert into org_accreditations (org_id, bank, title, valid_until, created_by)
              values (${org.id}, 'sber', 'Сбербанк', null, ${viaOrg.user.id})`;
});
after(async () => { await S?.close(); });

async function submitted(fields) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty' })).body.order;
  const r = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(today, 20), fields: { region: 'mo', object_type: 'flat', address: 'тестовый адрес, 1', ...fields } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { to: 'matching', from: 'new' })).status, 200);
  return o;
}
const list = async (o) => (await dispatcher.req('GET', `/api/orders/${o.id}/candidates`)).body;

test('заявка для Сбербанка: аккредитованные сами и через организацию — первыми, с пометкой', async () => {
  const o = await submitted({ purpose: 'bank', bank: 'sber' });
  const body = await list(o);
  assert.deepEqual(body.bank, { id: 'sber', name: 'Сбербанк', accredited: 2 });
  const ids = body.candidates.map((c) => c.user_id);
  assert.deepEqual(new Set(ids.slice(0, 2)), new Set([self.user.id, viaOrg.user.id]), 'аккредитованные — первыми');
  const by = Object.fromEntries(body.candidates.map((c) => [c.user_id, c]));
  assert.deepEqual(by[self.user.id].bank, { via: 'self', valid_until: addDays(today, 200) });
  assert.deepEqual(by[viaOrg.user.id].bank, { via: 'org', org_name: 'Тестовая организация 2.452', valid_until: null });
  assert.equal(by[old.user.id].bank, null, 'истёкшая и в другом банке — не в счёт');
  assert.equal(by[plain.user.id].bank, null);
  assert.ok(by[plain.user.id].score.total > by[self.user.id].score.total, 'по оценке свободный выше — порядок задаёт аккредитация');
  // Организации: с аккредитованными экспертами — первыми.
  assert.equal(body.orgs[0].org_id, org.id);
  assert.equal(body.orgs[0].bank_experts, 1);
  assert.equal(body.orgs.find((g) => g.org_id === plainOrg.id).bank_experts, 0);
  // Предложить можно и неаккредитованному — решает диспетчер.
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: plain.user.id, from: 'matching' })).status, 200);
});

test('никто не аккредитован — предупреждение; «Другой банк» и заявка не для банка — без пометок', async () => {
  await S.sql`update dossier_items set deleted_at = now() where user_id = ${self.user.id} and kind = 'bank'`;
  await S.sql`update org_accreditations set valid_until = ${addDays(today, -3)} where org_id = ${org.id}`;
  const none = await list(await submitted({ purpose: 'bank', bank: 'sber' }));
  assert.equal(none.bank.accredited, 0);
  assert.ok(none.candidates.length >= 4 && none.candidates.every((c) => c.bank === null));
  for (const fields of [{ purpose: 'bank', bank: 'other' }, { purpose: 'deal' }]) {
    const body = await list(await submitted(fields));
    assert.equal(body.bank, null);
    assert.ok(body.candidates.every((c) => !('bank' in c)));
    assert.ok(body.orgs.every((g) => !('bank_experts' in g)));
  }
});
