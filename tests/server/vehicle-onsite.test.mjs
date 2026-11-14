// Задача 2.490 (оценка транспорта): пробег в отчёте — как по прибору при осмотре (данные с объекта, которые помощник записал
// на выезде), а не как в заявке; по прибору намного меньше заявки — «уточните у заказчика»; помощник отметил «VIN на кузове не
// совпадает с документами» — в отчёте это должно быть сказано. Номера +7 999 000-49-21…23 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { runAutoChecks } from '../../src/ai/report-checks.mjs';

const doc = (pages) => [{ name: 'отчёт.txt', pages }];
const texts = (res, name) => res[name].map((f) => f.text);

test('2.490: пробег сверяется с прибором при осмотре, а не с заявкой', () => {
  const fields = { vin: 'XTA00000000000001', mileage: 120000 };
  const page = ['Объект оценки: легковой автомобиль, VIN XTA00000000000001.', 'Пробег по показаниям одометра: 120 000 км.'].join('\n');
  // Без выезда — как раньше: с заявкой, запас 10%.
  assert.deepEqual(runAutoChecks(['mileage_match'], doc([page]), { fields }).mileage_match, []);
  // По прибору — 131 512 км: отчёт с пробегом из заявки — находка с «Исправить в черновике».
  const onsite = { mileage: 131512, vin_match: 'yes' };
  const bad = runAutoChecks(['mileage_match'], doc([page]), { fields, onsite }).mileage_match;
  assert.deepEqual(bad.map((f) => f.text), ['Пробег 120 000 км не совпадает с пробегом по прибору при осмотре (131 512 км) — в отчёте пробег пишется по прибору, как его снял помощник на выезде']);
  assert.deepEqual(bad[0].fix, { bad: '120 000 км', right: '131 512 км', from: 'по прибору при осмотре' });
  // «132 тыс. км» — округление до тысяч, не находка; аналоги и среднегодовой пробег не в счёт.
  const ok = ['Пробег объекта — 132 тыс. км.', 'Аналог №1: пробег 90 000 км.', 'Среднегодовой пробег — 20 000 км в год.'].join('\n');
  assert.deepEqual(runAutoChecks(['mileage_match'], doc([ok]), { fields, onsite }).mileage_match, []);
  // Несколько машин в деле — не сверяем.
  assert.deepEqual(runAutoChecks(['mileage_match'], doc([page]), { fields: { ...fields, more_vehicles: 'вторая' }, onsite }).mileage_match, []);
});

test('2.490: по прибору намного меньше, чем в заявке, — «уточните у заказчика», один раз', () => {
  const fields = { mileage: 180000 };
  const onsite = { mileage: 95000 };
  const page = ['Пробег по одометру: 95 000 км.', 'Пробег, км: 95 000 км'].join('\n');
  const res = texts(runAutoChecks(['mileage_match'], doc([page]), { fields, onsite }), 'mileage_match');
  assert.deepEqual(res, ['Пробег по прибору при осмотре (95 000 км) намного меньше, чем в заявке (180 000 км) — уточните у заказчика; если пробег скручен, скажите об этом в описании объекта и учтите в расчёте']);
  // Больше заявки (машина ездила) или почти так же — молчим.
  assert.deepEqual(runAutoChecks(['mileage_match'], doc([page]), { fields: { mileage: 90000 }, onsite }).mileage_match, []);
  assert.deepEqual(runAutoChecks(['mileage_match'], doc([page]), { fields: {}, onsite }).mileage_match, [], 'в заявке пробега нет');
  assert.deepEqual(runAutoChecks(['mileage_match'], doc(['Выводы']), { fields, onsite }).mileage_match, [], 'пробега в отчёте нет — молчим');
});

test('2.490: помощник отметил «VIN не совпадает» — в отчёте должно быть сказано', () => {
  const fields = { vin: 'XTA00000000000001' };
  const plain = 'Объект оценки: легковой автомобиль, VIN XTA00000000000001, госномер А001АА777.';
  const res = runAutoChecks(['vin_match'], doc([plain]), { fields, onsite: { vin_match: 'no' } }).vin_match;
  assert.deepEqual(res.map((f) => f.text), ['Помощник на выезде отметил: VIN на кузове не совпадает с документами, а в отчёте об этом ни слова — опишите расхождение в описании объекта или проверьте отметку с выезда']);
  assert.match(res[0].quote, /VIN XTA/);
  const told = `${plain}\nПри осмотре установлено: VIN на кузове не совпадает с ПТС (последний знак «7» вместо «1»).`;
  assert.deepEqual(runAutoChecks(['vin_match'], doc([told]), { fields, onsite: { vin_match: 'no' } }).vin_match, []);
  assert.deepEqual(runAutoChecks(['vin_match'], doc([plain]), { fields, onsite: { vin_match: 'yes' } }).vin_match, []);
  assert.deepEqual(runAutoChecks(['vin_match'], doc([plain]), { fields, onsite: { vin_match: 'no_docs' } }).vin_match, []);
  // VIN в заявке нет — отметка с выезда всё равно сверяется; файл без VIN (приложение) — молчим.
  assert.equal(runAutoChecks(['vin_match'], doc([plain]), { fields: {}, onsite: { vin_match: 'no' } }).vin_match.length, 1);
  assert.deepEqual(runAutoChecks(['vin_match'], doc(['Приложение: фото']), { fields, onsite: { vin_match: 'no' } }).vin_match, []);
});

let S, owner, dispatcher, spec;
const FIELDS = { purpose: 'deal', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая Модель', year: 2020,
  vin: 'XTA00000000000001', reg_number: 'А001АА777', mileage: 120000 };
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990004921');
  dispatcher = await login(S, '+79990004922');
  spec = await login(S, '+79990004923');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'vehicle']] });
});
after(async () => { await S?.close(); });

test('2.490: ИИ-проверка транспорта берёт пробег и VIN с завершённого выезда помощника', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'vehicle', title: 'Машина: пробег по прибору' })).body.order;
  { const p = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: FIELDS }); assert.equal(p.status, 200, JSON.stringify(p.body)); }
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);
  const r = await spec.req('POST', `/api/orders/${o.id}/results`, Buffer.from('ОТЧЁТ ОБ ОЦЕНКЕ\nVIN XTA00000000000001.\nПробег по одометру: 120 000 км.\n'), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const found = async () => {
    S.providers.ai.reset();
    const ai = await spec.req('POST', `/api/orders/${o.id}/review/ai`);
    assert.equal(ai.status, 201, JSON.stringify(ai.body));
    return ai.body.ai.items.flatMap((i) => i.found ?? []).map((f) => f.text).filter((t) => /пробег|VIN на кузове/i.test(t));
  };
  assert.deepEqual(await found(), [], 'выезда нет — пробег как в заявке');
  // Выезд не завершён — его данные ещё не в счёт; завершён — сверяем с прибором.
  const [v] = await S.sql`insert into onsite_visits (order_id, helper_id, assigned_by, planned_at, data)
                          values (${o.id}, ${owner.user.id}, ${spec.user.id}, now(), ${JSON.stringify({ mileage: 131512, vin_match: 'no' })}) returning id`;
  assert.deepEqual(await found(), []);
  await S.sql`update onsite_visits set finished_at = now() where id = ${v.id}`;
  const t = await found();
  assert.equal(t.length, 2, JSON.stringify(t));
  assert.ok(t.some((x) => x.startsWith('Пробег 120 000 км не совпадает с пробегом по прибору при осмотре (131 512 км)')));
  assert.ok(t.some((x) => x.startsWith('Помощник на выезде отметил: VIN на кузове не совпадает')));
});
