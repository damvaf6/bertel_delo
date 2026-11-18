// Задача 2.534 (аналоги для дома): у жилого дома признаки аналога — площадь участка, материал стен, газ; «Этаж» и «Тип дома»
// у дома не спрашиваются. Площадь участка дальше 30% от заявки, материал стен или газ не как у объекта — «нужна корректировка»
// у аналога и строкой над списком; корректировки «Площадь участка», «Газ, коммуникации», «Тип дома, материал стен» снимают их.
// У квартиры и участка признаков нет. Номера +7 999 000-59-41…43 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry, DEFAULT_MODULES } from '../../src/modules/index.mjs';
import { analogWarnings, analogTable } from '../../src/analogs/analogs.mjs';

const reg = createRegistry();
const HOUSE = { region: 'mo', object_type: 'house', area: 120, house_walls: 'brick', house_land: 'own', land_area: 10, house_gas: 'main' };
const spec = reg.analogs('expertise', 'realty', HOUSE);
const an = (id, f = {}, adjustments = []) => ({
  id, file_key: 'k', confirmed_at: new Date(),
  fields: { price_rub: 12_000_000, listed_on: todayMsk(), region: 'mo', address: 'МО, Тестовый пос.', area: 120, land_area: 10, walls: 'brick', gas: 'main', ...f },
  adjustments,
});
const adj = (kind) => ({ kind, pct: -10, book: 'Справочник оценщика', year: 2026, table: '7' });
const ids = (s) => s.fields.map((f) => f.id);

test('признаки дома — только у заявки на жилой дом; этажа и типа дома у дома нет', () => {
  assert.deepEqual(ids(spec).filter((x) => ['land_area', 'walls', 'gas', 'floor', 'house_type'].includes(x)), ['land_area', 'walls', 'gas']);
  for (const k of ['land_area', 'gas']) assert.ok(spec.adjustments.some((x) => x.id === k));
  assert.ok(spec.adjustments.find((x) => x.id === 'house_type').covers.includes('walls'));
  for (const fields of [{ object_type: 'flat' }, { object_type: 'commercial' }, null]) {
    const s = reg.analogs('expertise', 'realty', fields);
    assert.ok(ids(s).includes('floor') && ids(s).includes('house_type'));
    assert.ok(!ids(s).some((x) => ['land_area', 'walls', 'gas'].includes(x)));
    assert.ok(!s.adjustments.some((x) => ['land_area', 'gas'].includes(x.id)));
  }
  assert.ok(!ids(reg.analogs('expertise', 'land', HOUSE)).includes('walls'));
  // Описание модуля: near.same — у признака-списка и с вариантами поля заявки; skip — поле-список заявки.
  const bad = (fn) => () => { const m = structuredClone(DEFAULT_MODULES.find((x) => x.id === 'expertise')); fn(m.analogs); createRegistry([m]); };
  assert.throws(bad((a) => { a.fields.find((f) => f.id === 'walls').near = { field: 'house_gas', same: true }; }), /near\.same/);
  assert.throws(bad((a) => { a.fields.find((f) => f.id === 'walls').near = { field: 'address', same: true }; }), /near\.field/);
  assert.throws(bad((a) => { a.fields.find((f) => f.id === 'address').near = { field: 'house_walls', same: true }; }), /near\.same/);
  assert.throws(bad((a) => { a.fields.find((f) => f.id === 'floor').skip = { field: 'address', in: ['x'] }; }), /skip/);
});

test('участок, стены, газ не как у объекта — «нужна корректировка», корректировка снимает', () => {
  const list = [
    an(1),
    an(2, { land_area: 25, walls: 'wood' }),
    an(3, { gas: 'none', land_area: 12 }),
    an(4, { land_area: 25, walls: 'wood', gas: 'tank' }, [adj('land_area'), adj('house_type'), adj('gas')]),
  ];
  const { per, hints } = analogWarnings(spec, { fields: HOUSE }, list);
  const mine = (n) => per.get(n).filter((w) => /участка|стен|Газ/.test(w));
  assert.deepEqual(mine(1), []);
  assert.deepEqual(mine(2), [
    'Материал стен: Дерево, брус, бревно у аналога, Кирпич, блоки у объекта — нужна корректировка «Тип дома, материал стен»',
    'Площадь участка, сот.: 25 у аналога, 10 у объекта — нужна корректировка «Площадь участка»',
  ]);
  assert.deepEqual(mine(3), ['Газ: Нет у аналога, Магистральный у объекта — нужна корректировка «Газ, коммуникации»'], '12 соток от 10 — в пределах 30%');
  assert.deepEqual(mine(4), [], 'корректировки есть');
  assert.ok(hints.includes('Площадь участка далеко от объекта у аналога 2 — нет корректировки «Площадь участка»'));
  assert.ok(hints.includes('Материал стен не как у объекта (Кирпич, блоки) у аналога 2 — нет корректировки «Тип дома, материал стен»'));
  assert.ok(hints.includes('Газ не как у объекта (Магистральный) у аналога 3 — нет корректировки «Газ, коммуникации»'));
  // В заявке не указано — сверять не с чем, тихо.
  const blank = analogWarnings(spec, { fields: { object_type: 'house', region: 'mo' } }, list);
  assert.ok(![...blank.per.values()].flat().some((w) => /участка|стен|Газ/.test(w)));
  // В таблице Word — столбцы дома, без этажа и типа дома.
  const t = JSON.stringify(analogTable(spec, list, { fields: HOUSE }));
  assert.match(t, /Площадь участка, сот\./);
  assert.match(t, /Материал стен/);
  assert.match(t, /Газгольдер или баллоны/);
  assert.doesNotMatch(t, /Этаж \/ этажей|Тип дома \|/);
});

let S, owner, dispatcher, expert;
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005941');
  dispatcher = await login(S, '+79990005942');
  expert = await login(S, '+79990005943');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, expert.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

async function caseInWork(fields) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Дом: аналоги' })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: expert.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await expert.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);
  return o;
}

async function addAnalog(o, n, fields, adjustments) {
  const r = await expert.req('POST', `/api/orders/${o.id}/analogs`, { url: `https://www.cian.ru/sale/suburban/5941${n}/` });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const u = await expert.req('PUT', `/api/orders/${o.id}/analogs/${r.body.id}`, { fields: { price_rub: 12_000_000 + n, listed_on: todayMsk(), region: 'mo', address: `МО, Тестовый пос., ${n}`, area: 120, ...fields }, ...(adjustments ? { adjustments } : {}) });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  return u.body;
}

test('в деле о доме: признаки в форме, предупреждение и корректировка; у квартиры признаков дома нет', async () => {
  const o = await caseInWork({ ...HOUSE, purpose: 'deal', address: 'Московская обл., Тестовый пос., ул. Садовая, д. 41' });
  await addAnalog(o, 1, { land_area: 10, walls: 'brick', gas: 'main' });
  const v = await addAnalog(o, 2, { land_area: 10, walls: 'brick', gas: 'none' });
  assert.ok(['land_area', 'walls', 'gas'].every((x) => v.fields.some((f) => f.id === x)));
  assert.ok(!v.fields.some((f) => f.id === 'floor'));
  assert.ok(v.adjust_kinds.some((k) => k.id === 'gas' && k.name === 'Газ, коммуникации'));
  assert.ok(v.analogs[1].warnings.includes('Газ: Нет у аналога, Магистральный у объекта — нужна корректировка «Газ, коммуникации»'));
  assert.ok(v.hints.includes('Газ не как у объекта (Магистральный) у аналога 2 — нет корректировки «Газ, коммуникации»'));
  assert.deepEqual((await dispatcher.req('GET', `/api/orders/${o.id}/analogs`)).body.hints, v.hints);
  const id = v.analogs[1].id;
  const u = await expert.req('PUT', `/api/orders/${o.id}/analogs/${id}`, { fields: { price_rub: 12_000_002, listed_on: todayMsk(), region: 'mo', address: 'МО, 2', area: 120, land_area: 10, walls: 'brick', gas: 'none' }, adjustments: [adj('gas')] });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.ok(!u.body.analogs[1].warnings.some((w) => /Газ:/.test(w)));
  // Неверное значение признака — отказ.
  const bad = await expert.req('PUT', `/api/orders/${o.id}/analogs/${id}`, { fields: { price_rub: 1, listed_on: todayMsk(), region: 'mo', address: 'x', gas: 'coal' } });
  assert.equal(bad.status, 400);

  const flat = await caseInWork({ purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, Тестовая ул., д. 5, кв. 41', area: 60 });
  const f = await addAnalog(flat, 3, { floor: '3/9' });
  assert.ok(!f.fields.some((x) => ['land_area', 'walls', 'gas'].includes(x.id)));
  const no = await expert.req('PUT', `/api/orders/${flat.id}/analogs/${f.analogs[0].id}`, { fields: { price_rub: 1, listed_on: todayMsk(), region: 'moscow', address: 'x' }, adjustments: [adj('gas')] });
  assert.equal(no.status, 400);
});
