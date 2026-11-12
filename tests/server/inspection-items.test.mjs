// Осмотр ДТП по деталям (задача 2.476): на каждую деталь из «Что повреждено» заявки — свой шаг «Крупно с линейкой: …»;
// владелец видит детали списком по ссылке, эксперт — в деле; номера фото и «не снято» — по этим шагам.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, client, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry, validateModule } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';

let S, owner, dispatcher, spec;
const FIELDS = { purpose: 'damage', region: 'moscow', vehicle_type: 'car', make_model: 'Тестовая Модель', year: 2021, vin: 'XTA00000000000001',
  reg_number: 'А001АА777', accident_date: '14.09.2026', accident_place: 'г. Москва, Тестовый пр-т',
  damage: 'Помят задний бампер, разбита левая фара и крышка багажника', method: 'osago' };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.from('JFIF-тест-детали')]);
const BASE = ['car_front', 'car_rear', 'car_left', 'car_right', 'car_vin', 'car_odometer', 'car_interior', 'car_damage_whole'];

before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990004761');
  dispatcher = await login(S, '+79990004762');
  spec = await login(S, '+79990004763');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'car_damage']] });
});
after(async () => { await S?.close(); });

async function step(c, o, to) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status });
}
async function inWork(fields = FIELDS) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'car_damage', title: 'ДТП: осмотр по деталям' })).body.order;
  const r = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  return o;
}
const view = (token) => client(S).req('GET', '/api/inspect', undefined, { headers: { 'x-inspect-token': token } });
const shoot = (token, stepId) => client(S).req('POST', '/api/inspect/photos', JPEG, {
  raw: true, csrf: true, headers: { 'x-inspect-token': token, 'content-type': 'image/jpeg', 'x-step': stepId },
});
const finish = (token) => client(S).req('POST', '/api/inspect/finish', {}, { headers: { 'x-inspect-token': token } });

test('реестр: по шагу на каждую деталь из заявки, «остальное» — необязательным после них; без деталей — шаг как был', () => {
  const reg = createRegistry();
  const steps = reg.inspectionSteps('expertise', 'car_damage', FIELDS);
  const close = steps.filter((s) => s.id.startsWith('car_damage_close'));
  assert.deepEqual(close.map((s) => [s.id, s.title, s.optional]), [
    ['car_damage_close-1', 'Крупно с линейкой: задний бампер', false],
    ['car_damage_close-2', 'Крупно с линейкой: левая фара', false],
    ['car_damage_close-3', 'Крупно с линейкой: крышка багажника', false],
    ['car_damage_close', 'Другие повреждения крупно', true],
  ]);
  assert.match(close[0].hint, /линейку или рулетку/);
  assert.equal(close[1].item, 'левая фара');
  assert.equal(steps.findIndex((s) => s.id === 'car_damage_close-1'), steps.findIndex((s) => s.id === 'car_damage_whole') + 1, 'на месте прежнего шага');
  // Без полей заявки или без знакомых деталей — прежний обязательный шаг.
  for (const f of [null, { damage: 'Всё побито, сами посмотрите' }]) {
    const one = reg.inspectionSteps('expertise', 'car_damage', f).filter((s) => s.id.startsWith('car_damage_close'));
    assert.deepEqual(one.map((s) => [s.id, s.title, s.optional]), [['car_damage_close', 'Каждое повреждение крупно', false]]);
  }
  // У других услуг each нет — шаги не зависят от полей.
  assert.deepEqual(reg.inspectionSteps('expertise', 'vehicle', FIELDS), reg.inspectionSteps('expertise', 'vehicle'));
  // Не больше 12 деталей.
  const many = ['передний бампер', 'задний бампер', 'левая фара', 'правая фара', 'капот', 'крышка багажника', 'левое переднее крыло',
    'правое переднее крыло', 'левая передняя дверь', 'правая передняя дверь', 'левая задняя дверь', 'правая задняя дверь',
    'лобовое стекло', 'решетка радиатора', 'левый фонарь'].join(', ');
  assert.equal(reg.inspectionSteps('expertise', 'car_damage', { damage: many }).filter((s) => s.item).length, 12);
});

test('описание модуля: ошибки в each ловятся при старте', () => {
  const withEach = (each) => ({ ...expertise, inspection: expertise.inspection.map((s) => (s.each ? { ...s, each } : s)) });
  const each = expertise.inspection.find((s) => s.each).each;
  assert.throws(() => validateModule(withEach({ ...each, title: 'Крупно' })), /\{item\}/);
  assert.throws(() => validateModule(withEach({ ...each, rest: '' })), /each\.rest/);
  assert.throws(() => validateModule(withEach({ ...each, field: '' })), /each\.field/);
  assert.throws(() => validateModule(withEach({ ...each, extra: 1 })), /extra/);
});

test('владелец видит детали списком и снимает каждую; «Готово» без детали — эксперту «не снято»', async () => {
  const o = await inWork();
  const r = await spec.req('POST', `/api/orders/${o.id}/inspection`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const token = r.body.path.split('#')[1];
  const v = await view(token);
  assert.equal(v.status, 200);
  const titles = v.body.steps.map((s) => s.title);
  for (const t of ['Крупно с линейкой: задний бампер', 'Крупно с линейкой: левая фара', 'Крупно с линейкой: крышка багажника', 'Другие повреждения крупно']) {
    assert.ok(titles.includes(t), t);
  }
  for (const st of [...BASE, 'car_damage_close-1', 'car_damage_close-2']) assert.equal((await shoot(token, st)).status, 201, st);
  assert.equal((await shoot(token, 'car_damage_close-9')).status, 400, 'детали с таким номером нет');
  assert.equal((await finish(token)).status, 200);
  const ins = (await spec.req('GET', `/api/orders/${o.id}/inspection`)).body;
  const by = Object.fromEntries(ins.steps.map((s) => [s.id, s]));
  assert.equal(by['car_damage_close-1'].photos.length, 1);
  assert.equal(by['car_damage_close-3'].photos.length, 0);
  assert.deepEqual(ins.incomplete.missing.map((s) => s.title), ['Крупно с линейкой: крышка багажника'], 'необязательное «Другие повреждения» не требуется');
  // Номера фото: деталь левая фара — сразу после заднего бампера (по порядку шагов).
  const nos = Object.fromEntries(ins.steps.flatMap((s) => s.photos.map((p) => [s.id, p.no])));
  assert.equal(nos['car_damage_close-2'], nos['car_damage_close-1'] + 1);
});
