// Задача 2.510 (оценка доли): в заявке на оценку недвижимости — «Если доля — как оценивать», «порядок пользования», «другие
// собственники и кто живёт» (необязательные); подсказка в деле — размер доли, способ оценки (со скидкой или часть целого,
// при разделе — как решит суд); строкой «Из заявки: …» — в «7. Описание объекта оценки» черновика от ИИ.
// Номера +7 999 000-54-01…03 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { FACTS_HEAD, factsLine } from '../../src/orders/facts.mjs';
import { shareOf, shareNotices } from '../../src/orders/share.mjs';
import { createRegistry } from '../../src/modules/index.mjs';

const LINE = `${FACTS_HEAD} размер доли — 1/3; как оценивать — рыночная стоимость доли (со скидкой на долю); порядок пользования — не определён; другие собственники и кто живёт — брат — 2/3, живёт в квартире.`;

test('размер доли, подсказки и строка «Из заявки»', () => {
  assert.deepEqual(shareOf(' 1 / 3 '), { a: 1, b: 3 });
  for (const bad of ['', '1/1', '3/2', '0/3', 'половина', '1/0', '1,5/3']) assert.equal(shareOf(bad), null, bad);

  const ids = (f) => shareNotices('realty', f).map((n) => n.id);
  assert.deepEqual(ids({ object_type: 'flat' }), [], 'не доля и без размера — молчим');
  assert.deepEqual(ids({ object_type: 'flat', share_size: '1/2' }), ['share_type']);
  assert.deepEqual(ids({ object_type: 'share' }), ['share_size', 'share_ask']);
  assert.deepEqual(ids({ object_type: 'share', share_size: 'половина', share_method: 'market' }), ['share_size', 'share_market']);
  assert.deepEqual(ids({ object_type: 'share', share_size: '1/3', share_method: 'pro_rata' }), ['share_pro_rata']);
  assert.match(shareNotices('realty', { object_type: 'share', share_size: '1/3', share_method: 'market' })[0].text, /^Оценивается рыночная стоимость доли \(1\/3\): .*скидка на долю с источником/);
  assert.match(shareNotices('realty', { object_type: 'share', share_size: '1/3', purpose: 'division' })[0].text, /решает суд/);
  assert.match(shareNotices('realty', { object_type: 'share', share_size: '1/3', purpose: 'deal' })[0].text, /Уточните у заказчика/);
  assert.deepEqual(shareNotices('vehicle', { object_type: 'share', share_size: '1/3' }), []);

  const registry = createRegistry();
  const fields = registry.service('expertise', 'realty').fields;
  const sec = registry.draftSections('expertise', 'realty').find((s) => s.facts);
  assert.equal(sec.id, 'r_object');
  const values = { share_size: '1/3', share_method: 'market', share_use: 'none', share_owners: 'брат — 2/3, живёт в квартире' };
  assert.equal(factsLine(fields, sec.facts, values), LINE);
  assert.equal(factsLine(fields, sec.facts, { share_method: 'pro_rata' }), `${FACTS_HEAD} как оценивать — часть стоимости всего объекта (без скидки).`);
  assert.equal(factsLine(fields, sec.facts, {}), null);
});

let S, owner, dispatcher, spec;
const BASE = { purpose: 'division', region: 'moscow', object_type: 'share', address: 'г. Москва, Тестовая ул., д. 1, кв. 3', area: 54, share_size: '1/3' };
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005401');
  dispatcher = await login(S, '+79990005402');
  spec = await login(S, '+79990005403');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

test('поля необязательны и проверяются; подсказка в деле; строка — в черновике от ИИ', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Доля: раздел' })).body.order;
  const patch = (fields) => owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields });
  assert.equal((await patch(BASE)).status, 200, 'без новых полей — как раньше');
  assert.deepEqual((await owner.req('GET', `/api/orders/${o.id}`)).body.notices.map((n) => n.id), ['share_ask']);
  for (const wrong of [{ share_method: 'half' }, { share_use: 'yes' }, { share_owners: 'x'.repeat(301) }]) {
    assert.equal((await patch({ ...BASE, ...wrong })).status, 400, JSON.stringify(wrong));
  }
  const all = { ...BASE, share_method: 'market', share_use: 'none', share_owners: 'брат — 2/3, живёт в квартире' };
  assert.equal((await patch(all)).status, 200);
  const seen = (await owner.req('GET', `/api/orders/${o.id}`)).body.notices;
  assert.deepEqual(seen.map((n) => n.id), ['share_market']);

  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);
  assert.deepEqual((await spec.req('GET', `/api/orders/${o.id}`)).body.notices.map((n) => n.id), ['share_market'], 'эксперт видит ту же подсказку');

  const r = await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const lines = r.body.draft.body.split('\n');
  const h = lines.findIndex((l) => /^#{1,3}\s*7\. Описание объекта оценки/.test(l));
  assert.ok(h >= 0, r.body.draft.body.slice(0, 400));
  assert.equal(lines[h + 1], LINE.replace('брат — 2/3', 'брат — 2/3'));
  assert.equal(lines.filter((l) => l.startsWith(FACTS_HEAD)).length, 1);
});
