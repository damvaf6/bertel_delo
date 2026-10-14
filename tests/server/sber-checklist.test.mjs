// Чек-лист Сбербанка к отчёту об оценке (задача штаба 3f917197): заявка «для Сбербанка» — при проверке перед сдачей
// заказчику к правилам модуля добавляются пункты «Сбер: …»; у других заявок их нет. Отметки ставит человек.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid, signResults } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry, validateModule } from '../../src/modules/index.mjs';
import expertise from '../../src/modules/expertise.mjs';

const SBER_REALTY = ['sber_task', 'sber_docs', 'sber_rights', 'sber_object', 'sber_layout', 'sber_photos', 'sber_market', 'sber_analogs', 'sber_value', 'sber_form'];

test('описание модуля: пункты Сбера — только при «Сбербанк» в заявке и только у услуг оценки', () => {
  const reg = createRegistry();
  const ids = (service, fields) => reg.checks('expertise', service, fields).map((c) => c.id);
  assert.ok(!ids('realty').some((id) => id.startsWith('sber_')), 'без полей заявки — без чек-листа банка');
  assert.ok(!ids('realty', { bank: 'other' }).some((id) => id.startsWith('sber_')));
  assert.deepEqual(ids('realty', { bank: 'sber' }).filter((id) => id.startsWith('sber_')), SBER_REALTY);
  assert.ok(ids('realty', { bank: 'sber' }).includes('analogs'), 'правила модуля остаются');
  const vehicle = ids('vehicle', { bank: 'sber' });
  assert.ok(vehicle.includes('sber_photos') && !vehicle.includes('sber_layout') && !vehicle.includes('sber_object'), 'у машины — без планировки и дома');
  assert.ok(!ids('goods', { bank: 'sber' }).some((id) => id.startsWith('sber_')), 'у экспертиз чек-листа оценки нет');
  for (const s of ['realty', 'land', 'vehicle', 'movable']) {
    assert.ok(reg.service('expertise', s).fields.some((f) => f.id === 'bank'), `поле «для какого банка» у услуги ${s}`);
  }
  assert.ok(reg.catalog()[0].checks.find((c) => c.id === 'sber_task').when, 'в каталоге видно, когда пункт действует');
});

test('описание модуля: when проверяется — поле-список у всех услуг пункта, значения из списка', () => {
  const withCheck = (c) => ({ ...structuredClone(expertise), checks: [...structuredClone(expertise.checks), { id: 'x_bank', title: 'Банк', ...c }] });
  validateModule(withCheck({ services: ['realty'], when: { field: 'bank', in: ['sber', 'other'] } }));
  validateModule(withCheck({ when: { field: 'purpose', in: ['bank'] } }));
  assert.throws(() => validateModule(withCheck({ services: ['realty'], when: { field: 'nope', in: ['sber'] } })), /when\.field/);
  assert.throws(() => validateModule(withCheck({ services: ['realty'], when: { field: 'address', in: ['sber'] } })), /when\.field/, 'не список');
  assert.throws(() => validateModule(withCheck({ services: ['realty', 'goods'], when: { field: 'bank', in: ['sber'] } })), /when\.field/, 'у товароведческой поля нет');
  assert.throws(() => validateModule(withCheck({ services: ['realty'], when: { field: 'bank', in: ['vtb'] } })), /when\.in/);
  assert.throws(() => validateModule(withCheck({ services: ['realty'], when: { field: 'bank', in: [] } })), /when\.in/);
  assert.throws(() => validateModule(withCheck({ services: ['realty'], when: { field: 'bank', in: ['sber'], x: 1 } })), /when/);
});

let S, owner, dispatcher, spec;
before(async () => {
  S = await startApp();
  owner = await login(S, '+79990000561');
  dispatcher = await login(S, '+79990000562');
  spec = await login(S, '+79990000563');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

async function step(c, o, to, reason) {
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  return c.req('POST', `/api/orders/${o.id}/status`, { to, reason, from: cur.status });
}

async function inWork(bank) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty' })).body.order;
  const fields = { purpose: 'bank', region: 'moscow', object_type: 'flat', address: 'г. Москва, тестовая ул., 7', ...(bank ? { bank } : {}) };
  const r = await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 15), fields });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await step(owner, o, 'matching')).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  assert.equal((await step(spec, o, 'in_work')).status, 200);
  return o;
}

test('заявка для Сбербанка: пункты банка в проверке, ИИ-подсказки по ним, без отметки «готово» не ставится', async () => {
  const other = await inWork('other');
  assert.ok(!(await spec.req('GET', `/api/orders/${other.id}/review`)).body.checks.some((c) => c.id.startsWith('sber_')), 'другой банк — без пунктов Сбера');
  const draft = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty' })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${draft.id}`, { fields: { bank: 'x' } })).status, 400, 'только из списка');

  const o = await inWork('sber');
  const view = (await spec.req('GET', `/api/orders/${o.id}/review`)).body;
  const sber = view.checks.filter((c) => c.id.startsWith('sber_'));
  assert.deepEqual(sber.map((c) => c.id), SBER_REALTY, 'исполнитель видит чек-лист банка до сдачи');
  assert.match(sber[0].title, /^Сбер: /);

  // ИИ-проверка перед сдачей — подсказка по каждому пункту, вопрос о пунктах Сбера ушёл в модель.
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/results`, Buffer.from('Отчёт об оценке квартиры для ПАО Сбербанк. Итог 9 000 000 руб.'), {
    raw: true, headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('отчёт.txt') },
  })).status, 201);
  S.providers.ai.reset();
  const ai = await spec.req('POST', `/api/orders/${o.id}/review/ai`);
  assert.equal(ai.status, 201, JSON.stringify(ai.body));
  assert.deepEqual(ai.body.ai.items.map((i) => i.id), view.checks.map((c) => c.id));
  const prompt = S.providers.ai.calls.at(-1).args.messages.map((m) => m.content).join('\n');
  assert.match(prompt, /- sber_analogs: /);

  // На проверке: диспетчер отмечает и пункты Сбера; замечание по пункту банка держит «готово».
  await signResults(S, spec, o.id);
  assert.equal((await step(spec, o, 'review')).status, 200);
  const r = (await dispatcher.req('GET', `/api/orders/${o.id}/review`)).body;
  for (const c of r.checks) {
    const verdict = c.id === 'sber_photos' ? 'issue' : 'ok';
    const note = verdict === 'issue' ? 'Нет фото санузла и вида из окна' : undefined;
    assert.equal((await dispatcher.req('PUT', `/api/orders/${o.id}/review/${c.id}`, { verdict, round: r.round, note })).status, 200);
  }
  const done = await step(dispatcher, o, 'done');
  assert.equal(done.status, 409);
  assert.match(done.body.message, /Сбер: фото/);
  assert.equal((await dispatcher.req('PUT', `/api/orders/${o.id}/review/sber_photos`, { verdict: 'ok', round: r.round })).status, 200);
  assert.equal((await step(dispatcher, o, 'done')).status, 200);
});
