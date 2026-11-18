// Осмотр жилого дома по шагам (задача 2.533): у дома — фасады со всех четырёх сторон, кровля, фундамент, котёл и счётчики,
// участок и подъезд к дому вместо подъезда, двери и счётчиков квартиры; владелец снимает по ссылке, эксперту — «не снято».
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, client, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry, validateModule } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';

let S, owner, dispatcher, spec;
const HOUSE = { purpose: 'deal', region: 'mo', object_type: 'house', address: 'Московская обл., д. Тестовая, ул. Луговая, д. 7', area: 110,
  house_land: 'own', land_area: 12, house_gas: 'main' };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.from('JFIF-тест-дом')]);
const HOUSE_STEPS = ['house_front', 'house_back', 'house_left', 'house_right', 'house_roof', 'house_foundation', 'rooms', 'kitchen', 'bathroom',
  'window_view', 'house_heating', 'house_land', 'house_access', 'house_buildings', 'surroundings', 'defects'];

before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005335');
  dispatcher = await login(S, '+79990005336');
  spec = await login(S, '+79990005337');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

test('реестр: у дома — свои шаги по порядку, у квартиры и без полей — как было', () => {
  const reg = createRegistry();
  const h = reg.inspectionSteps('expertise', 'realty', HOUSE);
  assert.deepEqual(h.map((s) => s.id), HOUSE_STEPS);
  const by = Object.fromEntries(h.map((s) => [s.id, s]));
  assert.equal(by.house_front.title, 'Дом спереди');
  assert.match(by.house_front.hint, /номер дома/);
  assert.equal(by.house_roof.title, 'Кровля');
  assert.equal(by.house_foundation.title, 'Фундамент и цоколь');
  assert.equal(by.house_heating.title, 'Котёл, отопление и счётчики');
  assert.equal(by.house_access.title, 'Подъезд к дому');
  assert.equal(by.house_buildings.optional, true, 'постройки — если есть');
  assert.equal(by.house_land.optional, false);
  for (const id of ['facade', 'entrance', 'door', 'meters']) assert.ok(!by[id], `${id} — не у дома`);
  const flat = ['facade', 'entrance', 'door', 'rooms', 'kitchen', 'bathroom', 'window_view', 'meters', 'surroundings', 'defects'];
  assert.deepEqual(reg.inspectionSteps('expertise', 'realty', { object_type: 'flat' }).map((s) => s.id), flat);
  assert.deepEqual(reg.inspectionSteps('expertise', 'realty', null).map((s) => s.id), flat);
  assert.deepEqual(reg.inspectionSteps('expertise', 'realty', { object_type: 'commercial' }).map((s) => s.id), flat);
  // У земли и транспорта шаги от поля «Вид объекта» не зависят.
  assert.deepEqual(reg.inspectionSteps('expertise', 'land', HOUSE), reg.inspectionSteps('expertise', 'land'));
});

test('описание модуля: when и skip у шага — только поле-список заявки и его значения', () => {
  const patch = (k, c) => ({ ...expertise, inspection: expertise.inspection.map((s) => (s.id === 'house_roof' ? { ...s, [k]: c } : s)) });
  assert.throws(() => validateModule(patch('when', { field: 'object_type', in: ['castle'] })), /when\.in/);
  assert.throws(() => validateModule(patch('when', { field: 'address', in: ['house'] })), /when\.field/);
  assert.throws(() => validateModule(patch('skip', { field: 'nope', in: ['x'] })), /skip\.field/);
  assert.throws(() => validateModule(patch('skip', { field: 'object_type', in: ['house'], extra: 1 })), /extra/);
  assert.doesNotThrow(() => validateModule(expertise));
});

async function step(c, o, to) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status });
}
const view = (token) => client(S).req('GET', '/api/inspect', undefined, { headers: { 'x-inspect-token': token } });
const shoot = (token, stepId) => client(S).req('POST', '/api/inspect/photos', JPEG, {
  raw: true, csrf: true, headers: { 'x-inspect-token': token, 'content-type': 'image/jpeg', 'x-step': stepId },
});

test('владелец дома снимает фасады, кровлю, фундамент; без кровли — эксперту «не снято: Кровля»; дверь квартиры — не шаг', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Дом: осмотр по шагам' })).body.order;
  const p = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: HOUSE });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  const r = await spec.req('POST', `/api/orders/${o.id}/inspection`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const token = r.body.path.split('#')[1];
  const v = await view(token);
  assert.equal(v.status, 200);
  assert.deepEqual(v.body.steps.map((s) => s.id), HOUSE_STEPS);
  assert.equal((await shoot(token, 'door')).status, 400, 'двери квартиры у дома нет');
  const need = HOUSE_STEPS.filter((id) => !['house_roof', 'house_buildings', 'defects'].includes(id));
  for (const st of need) assert.equal((await shoot(token, st)).status, 201, st);
  assert.equal((await client(S).req('POST', '/api/inspect/finish', {}, { headers: { 'x-inspect-token': token } })).status, 200);
  const ins = (await spec.req('GET', `/api/orders/${o.id}/inspection`)).body;
  assert.deepEqual(ins.incomplete.missing.map((s) => s.title), ['Кровля']);
  // Номера фото — по порядку шагов: фасад сзади сразу за фасадом спереди.
  const nos = Object.fromEntries(ins.steps.flatMap((s) => s.photos.map((ph) => [s.id, ph.no])));
  assert.equal(nos.house_back, nos.house_front + 1);
  assert.equal(nos.house_foundation, nos.house_right + 1);
  // Чужой не видит осмотр дома.
  const stranger = await login(S, '+79990005338');
  assert.equal((await stranger.req('GET', `/api/orders/${o.id}/inspection`)).status, 404);
});
