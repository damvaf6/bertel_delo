// Задача 2.493 (оценка транспорта): пробег аналога отличается от объекта больше чем на 30% (по прибору при осмотре — данные
// с выезда помощника, иначе по заявке), а корректировки «Пробег» нет — предупреждение у аналога и строкой в подсказках раздела
// «Аналоги». Номера +7 999 000-49-35…37 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry, validateModule } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';
import { analogWarnings } from '../../src/analogs/analogs.mjs';

const reg = createRegistry();
const car = reg.analogs('expertise', 'vehicle');
const analog = (id, fields, adjustments = []) => ({ id, url: `https://auto.ru/cars/${id}`, file_key: 'k', confirmed_at: new Date(),
  fields: { make_model: 'Toyota Camry', price_rub: 2000000, region: 'moscow', listed_on: todayMsk(), ...fields }, adjustments });
const order = (fields) => ({ fields: { region: 'moscow', year: 2019, ...fields } });
const mileageOf = (r, id) => r.per.get(id).filter((w) => /Пробег/.test(w));

test('2.493: пробег аналога дальше 30% от заявки — нужна корректировка «Пробег»', () => {
  const list = [analog(1, { mileage_km: 100000 }), analog(2, { mileage_km: 140000 }), analog(3, { mileage_km: 60000 })];
  const r = analogWarnings(car, order({ mileage: 100000 }), list);
  assert.deepEqual(mileageOf(r, 1), []);
  assert.deepEqual(mileageOf(r, 2), ['Пробег, км: 140 000 у аналога, 100 000 у объекта (по заявке) — нужна корректировка «Пробег»']);
  assert.deepEqual(mileageOf(r, 3), ['Пробег, км: 60 000 у аналога, 100 000 у объекта (по заявке) — нужна корректировка «Пробег»']);
  assert.ok(r.hints.includes('Пробег далеко от объекта (по заявке) у аналогов 2, 3 — нет корректировки «Пробег»'), JSON.stringify(r.hints));
  // Ровно 30% — не далеко.
  assert.deepEqual(mileageOf(analogWarnings(car, order({ mileage: 100000 }), [analog(4, { mileage_km: 130000 })]), 4), []);
});

test('2.493: по прибору при осмотре важнее заявки; корректировка «Пробег» снимает предупреждение', () => {
  const list = [analog(1, { mileage_km: 100000 }), analog(2, { mileage_km: 160000 })];
  // В заявке 100 000, а по прибору 150 000: далёк уже первый аналог, второй — нет.
  const r = analogWarnings(car, order({ mileage: 100000 }), list, { mileage: 150000 });
  assert.deepEqual(mileageOf(r, 1), ['Пробег, км: 100 000 у аналога, 150 000 у объекта (по прибору при осмотре) — нужна корректировка «Пробег»']);
  assert.deepEqual(mileageOf(r, 2), []);
  assert.ok(r.hints.includes('Пробег далеко от объекта (по прибору при осмотре) у аналога 1 — нет корректировки «Пробег»'));
  // Пробега нет ни в заявке, ни с выезда — не сверяем; у аналога пробега нет — тоже.
  assert.deepEqual(mileageOf(analogWarnings(car, order({}), list, { vin_match: 'yes' }), 1), []);
  assert.deepEqual(mileageOf(analogWarnings(car, order({ mileage: 100000 }), [analog(5, {})]), 5), []);
  // С выезда пробег пустой — по заявке.
  assert.deepEqual(mileageOf(analogWarnings(car, order({ mileage: 100000 }), list, { mileage: null }), 2).length, 1);
  // Корректировка «Пробег» — предупреждения и строки в подсказках нет; другая корректировка не снимает.
  const adj = [analog(1, { mileage_km: 100000 }, [{ kind: 'mileage', pct: 8, book: 'Справочник', year: 2026, table: '5' }])];
  const ok = analogWarnings(car, order({}), adj, { mileage: 150000 });
  assert.deepEqual(mileageOf(ok, 1), []);
  assert.ok(!ok.hints.some((h) => /Пробег/.test(h)));
  const other = [analog(1, { mileage_km: 100000 }, [{ kind: 'condition', pct: -5, book: 'Справочник', year: 2026, table: '6' }])];
  assert.equal(mileageOf(analogWarnings(car, order({}), other, { mileage: 150000 }), 1).length, 1);
  // Год выпуска — как раньше, теперь с названием корректировки.
  const y = analogWarnings(car, order({}), [analog(6, { year: 2014 })]);
  assert.ok(y.per.get(6).includes('Год выпуска: 2014 у аналога, 2019 у объекта — нужна корректировка «Год выпуска (возраст)»'));
});

test('2.493: описание модуля — near.onsite только числовое поле данных с объекта', () => {
  const bad = (fn) => () => { const m = structuredClone(expertise); fn(m.analogs.fields.find((f) => f.id === 'mileage_km')); validateModule(m); };
  assert.doesNotThrow(bad(() => {}));
  assert.throws(bad((f) => { f.near.onsite = 'nope'; }), /near\.onsite/);
  assert.throws(bad((f) => { f.near.onsite = 'vin_match'; }), /near\.onsite/);
});

let S, owner, dispatcher, spec;
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990004935');
  dispatcher = await login(S, '+79990004936');
  spec = await login(S, '+79990004937');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'vehicle']] });
});
after(async () => { await S?.close(); });

test('2.493: раздел «Аналоги» в деле берёт пробег с завершённого выезда помощника', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'vehicle', title: 'Машина: пробег аналогов' })).body.order;
  const fields = { purpose: 'court', region: 'moscow', vehicle_type: 'car', make_model: 'Toyota Camry', year: 2019, mileage: 100000 };
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);
  const id = (await spec.req('POST', `/api/orders/${o.id}/analogs`, { url: 'https://auto.ru/cars/used/sale/toyota/camry/9/' })).body.id;
  const put = await spec.req('PUT', `/api/orders/${o.id}/analogs/${id}`, { fields: { make_model: 'Toyota Camry', price_rub: 2000000, year: 2019, region: 'moscow', listed_on: todayMsk(), mileage_km: 110000 } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const mileage = async () => (await spec.req('GET', `/api/orders/${o.id}/analogs`)).body.analogs[0].warnings.filter((w) => /Пробег/.test(w));
  assert.deepEqual(await mileage(), [], 'по заявке 100 000 — близко');
  const [v] = await S.sql`insert into onsite_visits (order_id, helper_id, assigned_by, planned_at, data)
                          values (${o.id}, ${owner.user.id}, ${spec.user.id}, now(), ${JSON.stringify({ mileage: 190000 })}) returning id`;
  assert.deepEqual(await mileage(), [], 'выезд не завершён');
  await S.sql`update onsite_visits set finished_at = now() where id = ${v.id}`;
  assert.deepEqual(await mileage(), ['Пробег, км: 110 000 у аналога, 190 000 у объекта (по прибору при осмотре) — нужна корректировка «Пробег»']);
  const r = await spec.req('GET', `/api/orders/${o.id}/analogs`);
  assert.ok(r.body.hints.some((h) => h === 'Пробег далеко от объекта (по прибору при осмотре) у аналога 1 — нет корректировки «Пробег»'));
});
