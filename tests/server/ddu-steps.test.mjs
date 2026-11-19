// Осмотр по ДДУ (задача 2.544): дом строится — у квартиры в новостройке шаги стройплощадки, щита застройщика и корпуса
// снаружи вместо подъезда, двери и комнат квартиры; осмотра в деле нет — своя фраза «осмотр квартиры не проводился».
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, client, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import { DDU_NO_INSPECT, dduNoInspect } from '../../src/orders/ddu.mjs';

let S, owner, dispatcher, spec;
const DDU = { purpose: 'bank', bank: 'sber', region: 'mo', object_type: 'ddu', address: 'Московская обл., г. Тестовск, ЖК «Тестовый», корп. 3',
  ddu_number: 'ЖК-12/3-145', ddu_date: '14.03.2025', ddu_developer: 'ООО «СЗ Пример»', ddu_complex: 'ЖК «Тестовый», корп. 3', ddu_area: 41.5,
  ddu_handover: '31.12.2027' };
const DDU_STEPS = ['ddu_site', 'ddu_board', 'ddu_building', 'ddu_section', 'surroundings'];
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.from('JFIF-тест-дду')]);

before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005441');
  dispatcher = await login(S, '+79990005442');
  spec = await login(S, '+79990005443');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

test('реестр: у ДДУ — стройплощадка, щит, корпус; шагов квартиры нет; у квартиры и дома — как было', () => {
  const reg = createRegistry();
  const d = reg.inspectionSteps('expertise', 'realty', DDU);
  assert.deepEqual(d.map((s) => s.id), DDU_STEPS);
  const by = Object.fromEntries(d.map((s) => [s.id, s]));
  assert.equal(by.ddu_site.title, 'Стройплощадка целиком');
  assert.equal(by.ddu_board.title, 'Щит застройщика (паспорт объекта)');
  assert.match(by.ddu_board.hint, /разрешения на строительство/);
  assert.equal(by.ddu_building.title, 'Корпус снаружи');
  assert.match(by.ddu_building.hint, /этаж/);
  assert.equal(by.ddu_section.optional, true, 'секция и этаж — если понятно');
  for (const id of ['facade', 'entrance', 'door', 'rooms', 'kitchen', 'bathroom', 'window_view', 'meters', 'defects']) assert.ok(!by[id], `${id} — не у ДДУ`);
  const flat = ['facade', 'entrance', 'door', 'rooms', 'kitchen', 'bathroom', 'window_view', 'meters', 'surroundings', 'defects'];
  assert.deepEqual(reg.inspectionSteps('expertise', 'realty', { object_type: 'flat' }).map((s) => s.id), flat);
  const house = reg.inspectionSteps('expertise', 'realty', { object_type: 'house' }).map((s) => s.id);
  assert.ok(house.includes('house_front') && house.includes('rooms') && !house.some((id) => id.startsWith('ddu_')));
});

test('фраза «осмотр квартиры не проводился» — только у ДДУ', () => {
  assert.equal(dduNoInspect('realty', DDU), DDU_NO_INSPECT);
  assert.match(DDU_NO_INSPECT, /^Осмотр квартиры не проводился: дом не введён в эксплуатацию/);
  assert.equal(dduNoInspect('realty', { object_type: 'flat' }), null);
  assert.equal(dduNoInspect('vehicle', DDU), null);
});

async function step(c, o, to) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, from: cur.status });
}
const shoot = (token, stepId) => client(S).req('POST', '/api/inspect/photos', JPEG, {
  raw: true, csrf: true, headers: { 'x-inspect-token': token, 'content-type': 'image/jpeg', 'x-step': stepId },
});

test('дело ДДУ: в черновике своя фраза, владелец снимает стройплощадку, комнаты — не шаг; ИИ-проверка принимает фразу', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'ДДУ: осмотр' })).body.order;
  const p = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: DDU });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec, o, 'in_work')).status, 200);

  const dr = (await spec.req('GET', `/api/orders/${o.id}/draft`)).body;
  assert.equal(dr.no_inspection, true);
  assert.equal(dr.no_inspection_text, DDU_NO_INSPECT);
  assert.equal((await dispatcher.req('GET', `/api/orders/${o.id}/draft`)).body.no_inspection, false);
  const stranger = await login(S, '+79990005444');
  assert.equal((await stranger.req('GET', `/api/orders/${o.id}/draft`)).status, 404);

  // ИИ-проверка: фраза ДДУ — это «осмотр не проводился», находки «в деле осмотра нет» нет.
  const ru = (d) => d.split('-').reverse().join('.');
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/results`, Buffer.from(`Отчёт об оценке права требования\n${DDU_NO_INSPECT}\nДата составления отчёта: ${ru(todayMsk())}`), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') },
  })).status, 201);
  const ai = await spec.req('POST', `/api/orders/${o.id}/review/ai`);
  assert.equal(ai.status, 201, JSON.stringify(ai.body));
  assert.ok(!ai.body.ai.items.flatMap((i) => i.found ?? []).some((f) => f.no_inspection || /в деле осмотра нет/.test(f.text)));

  const r = await spec.req('POST', `/api/orders/${o.id}/inspection`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const token = r.body.path.split('#')[1];
  const v = await client(S).req('GET', '/api/inspect', undefined, { headers: { 'x-inspect-token': token } });
  assert.deepEqual(v.body.steps.map((s) => s.id), DDU_STEPS);
  assert.equal((await shoot(token, 'rooms')).status, 400, 'комнат у ДДУ нет');
  for (const st of ['ddu_site', 'ddu_building', 'surroundings']) assert.equal((await shoot(token, st)).status, 201, st);
  assert.equal((await client(S).req('POST', '/api/inspect/finish', {}, { headers: { 'x-inspect-token': token } })).status, 200);
  const ins = (await spec.req('GET', `/api/orders/${o.id}/inspection`)).body;
  assert.deepEqual(ins.incomplete.missing.map((s) => s.title), ['Щит застройщика (паспорт объекта)']);
  // Осмотр стройплощадки есть — фраза больше не предлагается.
  assert.equal((await spec.req('GET', `/api/orders/${o.id}/draft`)).body.no_inspection, false);
});
