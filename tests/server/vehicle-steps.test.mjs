// Несколько машин в одном деле (задача 2.496): шаги осмотра «VIN» и «Пробег» — на основную машину (её марка в названии) и
// на каждую строку поля «Если машин несколько»; прежние id у шагов основной машины, «не снято» — по каждой машине.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, client, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry, validateModule } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';

let S, owner, dispatcher, spec;
const FIELDS = { purpose: 'deal', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая Модель', year: 2021, vin: 'XTA00000000000001',
  more_vehicles: '2. Тестовый Фургон, 2019, XTA00000000000002\n- Тестовый Прицеп, 2015\n\nТестовый Фургон, 2019, XTA00000000000002' };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.from('JFIF-тест-машины')]);

before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990004961');
  dispatcher = await login(S, '+79990004962');
  spec = await login(S, '+79990004963');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'vehicle']] });
});
after(async () => { await S?.close(); });

async function step(c, o, to) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status });
}
const view = (token) => client(S).req('GET', '/api/inspect', undefined, { headers: { 'x-inspect-token': token } });
const shoot = (token, stepId) => client(S).req('POST', '/api/inspect/photos', JPEG, {
  raw: true, csrf: true, headers: { 'x-inspect-token': token, 'content-type': 'image/jpeg', 'x-step': stepId },
});

test('реестр: VIN и пробег — основная машина первой с маркой, затем каждая из «Если машин несколько»; одна машина — как было', () => {
  const reg = createRegistry();
  const steps = reg.inspectionSteps('expertise', 'vehicle', FIELDS);
  const pick = (p) => steps.filter((s) => s.id === p || s.id.startsWith(`${p}-`)).map((s) => [s.id, s.title, s.optional]);
  assert.deepEqual(pick('car_vin'), [
    ['car_vin', 'VIN: Тестовая Модель', false],
    ['car_vin-1', 'VIN: Тестовый Фургон, 2019, XTA00000000000002', false],
    ['car_vin-2', 'VIN: Тестовый Прицеп, 2015', false],
  ]);
  assert.deepEqual(pick('car_odometer'), [
    ['car_odometer', 'Пробег: Тестовая Модель', false],
    ['car_odometer-1', 'Пробег: Тестовый Фургон, 2019, XTA00000000000002', false],
    ['car_odometer-2', 'Пробег: Тестовый Прицеп, 2015', false],
  ]);
  const at = (id) => steps.findIndex((s) => s.id === id);
  assert.equal(at('car_vin-2') + 1, at('car_odometer'), 'пробег — после всех VIN');
  assert.match(steps[at('car_vin-1')].hint, /все знаки/);
  assert.match(steps[at('car_odometer-1')].hint, /зажигани/);
  // Одна машина (поле пустое или без полей) — прежние шаги «VIN» и «Пробег».
  for (const f of [null, { make_model: 'Тестовая Модель' }, { make_model: 'Тестовая Модель', more_vehicles: ' \n - ' }]) {
    const s1 = reg.inspectionSteps('expertise', 'vehicle', f).filter((s) => /^car_(vin|odometer)/.test(s.id));
    assert.deepEqual(s1.map((s) => [s.id, s.title]), [['car_vin', 'VIN'], ['car_odometer', 'Пробег']]);
  }
  // Без марки основной машины — у первого шага прежнее название.
  assert.equal(reg.inspectionSteps('expertise', 'vehicle', { more_vehicles: 'Тестовый Фургон' })[4].title, 'VIN');
  // У ДТП поля «Если машин несколько» нет — шаги не меняются.
  assert.deepEqual(reg.inspectionSteps('expertise', 'car_damage', { ...FIELDS, damage: '' }).filter((s) => /^car_(vin|odometer)/.test(s.id)).map((s) => s.title), ['VIN', 'Пробег']);
  // Помощник на выезде видит список остальных машин.
  assert.ok(expertise.express.show.includes('more_vehicles'));
});

test('описание модуля: keep без rest, main только при keep', () => {
  const vin = expertise.inspection.find((s) => s.id === 'car_vin');
  const withVin = (each) => ({ ...expertise, inspection: expertise.inspection.map((s) => (s.id === 'car_vin' ? { ...s, each } : s)) });
  assert.doesNotThrow(() => validateModule(expertise));
  assert.throws(() => validateModule(withVin({ ...vin.each, rest: 'Остальное' })), /each\.rest/);
  assert.throws(() => validateModule(withVin({ ...vin.each, keep: 'да' })), /each\.keep/);
  const { keep, ...noKeep } = vin.each;
  assert.throws(() => validateModule(withVin({ ...noKeep, rest: 'Остальное' })), /each\.main/);
});

test('владелец снимает VIN и пробег каждой машины; «Готово» без одной — эксперту «не снято» с её названием', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'vehicle', title: 'Оценка трёх машин' })).body.order;
  const p = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: FIELDS });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  const r = await spec.req('POST', `/api/orders/${o.id}/inspection`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const token = r.body.path.split('#')[1];
  const titles = (await view(token)).body.steps.map((s) => s.title);
  for (const t of ['VIN: Тестовая Модель', 'VIN: Тестовый Прицеп, 2015', 'Пробег: Тестовый Фургон, 2019, XTA00000000000002']) assert.ok(titles.includes(t), t);
  for (const st of ['car_front', 'car_rear', 'car_left', 'car_right', 'car_vin', 'car_vin-1', 'car_vin-2', 'car_odometer', 'car_odometer-1', 'car_interior']) {
    assert.equal((await shoot(token, st)).status, 201, st);
  }
  assert.equal((await shoot(token, 'car_vin-3')).status, 400, 'машины с таким номером нет');
  assert.equal((await client(S).req('POST', '/api/inspect/finish', {}, { headers: { 'x-inspect-token': token } })).status, 200);
  const ins = (await spec.req('GET', `/api/orders/${o.id}/inspection`)).body;
  assert.deepEqual(ins.incomplete.missing.map((s) => s.title), ['Пробег: Тестовый Прицеп, 2015']);
  const nos = Object.fromEntries(ins.steps.flatMap((s) => s.photos.map((ph) => [s.id, ph.no])));
  assert.equal(nos['car_vin-1'], nos.car_vin + 1, 'номера фото — по порядку машин');
  assert.equal(nos.car_odometer, nos['car_vin-2'] + 1);
});
