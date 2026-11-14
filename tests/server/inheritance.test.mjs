// Задача 2.500 (оценка для наследства): в заявке оценки — «Если наследство — дата открытия наследства (день смерти)» и
// «нотариус или номер наследственного дела», оба необязательны. Подсказка в деле всем, кто видит заявку; в таблице задания
// черновика от ИИ дата оценки — эта дата (задание на оценку с датой важнее). Номера +7 999 000-53-01…04 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import { inheritanceOf, inheritanceNotices, inheritanceValueDay } from '../../src/orders/inheritance.mjs';

const today = '2026-11-14';

test('дата открытия наследства: разбор, подсказка и дата оценки', () => {
  const f = { purpose: 'inheritance', death_date: '03.06.2026' };
  assert.deepEqual(inheritanceOf(f, today), { day: '2026-06-03', state: 'ok' });
  assert.equal(inheritanceValueDay('realty', f, today), '03.06.2026');
  assert.equal(inheritanceValueDay('vehicle', f, today), '03.06.2026');
  assert.equal(inheritanceValueDay('goods', f, today), null, 'не оценка — нет');
  assert.deepEqual(inheritanceNotices('realty', f, today), [{ id: 'inheritance_ok',
    text: 'Оценка для наследства: дата оценки — день открытия наследства 03.06.2026, а не день осмотра. Цены и аналоги — на эту дату.' }]);
  assert.equal(inheritanceNotices('realty', { purpose: 'inheritance' }, today)[0].id, 'inheritance_missing');
  assert.equal(inheritanceValueDay('realty', { purpose: 'inheritance' }, today), null);
  assert.equal(inheritanceNotices('realty', { ...f, death_date: '31.02.2026' }, today)[0].id, 'inheritance_bad');
  assert.equal(inheritanceNotices('realty', { ...f, death_date: '01.12.2026' }, today)[0].id, 'inheritance_future');
  assert.equal(inheritanceValueDay('realty', { ...f, death_date: '01.12.2026' }, today), null, 'будущая дата — не дата оценки');
  const other = inheritanceNotices('vehicle', { purpose: 'bank', death_date: '03.06.2026' }, today);
  assert.equal(other[0].id, 'inheritance_purpose');
  assert.match(other[0].text, /цель оценки — не «Наследство, нотариус»/);
  assert.equal(inheritanceValueDay('vehicle', { purpose: 'bank', death_date: '03.06.2026' }, today), null);
  assert.deepEqual(inheritanceNotices('realty', { purpose: 'bank' }, today), [], 'не наследство и без даты — молчим');
  assert.deepEqual(inheritanceNotices('goods', f, today), []);
  // О праве на наследство и долях — ни слова.
  for (const s of ['ok', 'missing']) {
    const t = inheritanceNotices('realty', s === 'ok' ? f : { purpose: 'inheritance' }, today)[0].text;
    assert.ok(!/наследник|дол[яи]|прав[оа]/i.test(t), t);
  }
});

test('поля — у всех услуг оценки и необязательны', () => {
  const reg = createRegistry();
  for (const s of ['realty', 'land', 'vehicle', 'movable']) {
    const fields = reg.service('expertise', s).fields;
    const d = fields.find((x) => x.id === 'death_date');
    const n = fields.find((x) => x.id === 'notary');
    assert.ok(d && n, s);
    assert.equal(!!d.required || !!n.required, false, s);
  }
  assert.equal(reg.service('expertise', 'goods').fields.some((x) => x.id === 'death_date'), false);
});

let S, owner, dispatcher, spec, stranger;
const BASE = { purpose: 'inheritance', region: 'moscow', object_type: 'flat', address: 'г. Москва, Тестовая ул., д. 1, кв. 1', area: 45 };
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005301');
  dispatcher = await login(S, '+79990005302');
  spec = await login(S, '+79990005303');
  stranger = await login(S, '+79990005304');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

test('заявка: поля сохраняются и проверяются, подсказка в деле, дата — в таблице задания черновика', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Квартира: наследство' })).body.order;
  const patch = (fields) => owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields });
  assert.equal((await patch(BASE)).status, 200, 'без новых полей — как раньше');
  assert.deepEqual((await owner.req('GET', `/api/orders/${o.id}`)).body.notices.map((n) => n.id), ['inheritance_missing']);
  for (const wrong of [{ death_date: '2026-06-03' }, { death_date: '3.6.2026' }, { notary: 'x'.repeat(201) }]) {
    assert.equal((await patch({ ...BASE, ...wrong })).status, 400, JSON.stringify(wrong));
  }
  const day = addDays(todayMsk(), -120).split('-').reverse().join('.');
  const r0 = await patch({ ...BASE, death_date: day, notary: 'Нотариус г. Москвы Тестова Т. Т., дело № 1/2026' });
  assert.equal(r0.status, 200, JSON.stringify(r0.body));
  const view = (await owner.req('GET', `/api/orders/${o.id}`)).body;
  assert.equal(view.order.fields.death_date, day);
  assert.deepEqual(view.notices.map((n) => n.id), ['inheritance_ok']);
  assert.match(view.notices[0].text, new RegExp(`день открытия наследства ${day.replace(/\./g, '\\.')}`));
  assert.equal((await stranger.req('GET', `/api/orders/${o.id}`)).status, 404, 'чужой не видит');

  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);
  // Подсказку видит и эксперт.
  assert.deepEqual((await spec.req('GET', `/api/orders/${o.id}`)).body.notices.map((n) => n.id), ['inheritance_ok']);

  const r = await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const body = r.body.draft.body;
  assert.ok(body.includes(`| Дата оценки | ${day} (день открытия наследства, по заявке) |`), body.slice(0, 1500));
  assert.equal(r.body.draft.inputs.value_date.inherit, true);
  assert.equal(r.body.draft.inputs.value_date.day, day);
});

test('цель не «наследство» — дата открытия наследства не идёт в дату оценки', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Квартира: банк' })).body.order;
  const day = addDays(todayMsk(), -30).split('-').reverse().join('.');
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: { ...BASE, purpose: 'deal', death_date: day } })).status, 200);
  assert.deepEqual((await owner.req('GET', `/api/orders/${o.id}`)).body.notices.map((n) => n.id), ['inheritance_purpose']);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);
  const r = await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {});
  assert.equal(r.status, 201);
  assert.ok(!r.body.draft.body.includes('день открытия наследства'));
  assert.ok(!r.body.draft.inputs?.value_date);
});
