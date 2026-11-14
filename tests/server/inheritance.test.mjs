// Задача 2.500 (оценка для наследства): в заявке оценки — «Если наследство — дата открытия наследства (день смерти)» и
// «нотариус или номер наследственного дела», оба необязательны. Подсказка в деле всем, кто видит заявку; в таблице задания
// черновика от ИИ дата оценки — эта дата (задание на оценку с датой важнее). Номера +7 999 000-53-01…04 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import { inheritanceOf, inheritanceNotices, inheritanceValueDay } from '../../src/orders/inheritance.mjs';
import { runAutoChecks, AUTO_CHECKS } from '../../src/ai/report-checks.mjs';
import { assignmentSource, swapValue } from '../../public/draftfind.js';

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

// 2.501: ИИ-проверка — при оценке для наследства дата оценки как день открытия наследства из заявки, пользователь — нотариус.
test('2.501: ИИ-проверка — дата оценки и пользователь при оценке для наследства', () => {
  const doc = (pages, name = 'Отчёт.pdf') => ({ name, kind: 'pdf', pages });
  const report = (on, user = 'нотариус г. Москвы Петрова А. А.') => doc([`ОТЧЁТ ОБ ОЦЕНКЕ № 9\nЦель оценки: для нотариуса (наследство)\nДата оценки: ${on}\n${user === null ? '' : `Предполагаемый пользователь результатов оценки: ${user}`}\nВид стоимости: рыночная`]);
  const heir = { purpose: 'inheritance', death_date: '03.06.2026' };
  const run = (rep, fields = heir, ctx = {}) => runAutoChecks(['inherit_basis'], [rep], { service: 'realty', fields, today, ...ctx }).inherit_basis;
  assert.ok(AUTO_CHECKS.inherit_basis, 'правило описано');
  // Дата — день открытия наследства, пользователь — нотариус: без находок.
  assert.deepEqual(run(report('03.06.2026')), []);
  assert.deepEqual(run(report('«03» июня 2026 г.', 'наследники и нотариус')), []);
  // Дата оценки — день осмотра: находка с заменой на дату из заявки.
  const res = run(report('10.11.2026'));
  assert.equal(res.length, 1);
  assert.equal(res[0].text, 'Дата оценки в отчёте 10.11.2026, а день открытия наследства в заявке — 03.06.2026: для нотариуса стоимость определяется на день открытия наследства (ст. 1114 ГК РФ) — исправьте дату оценки, цены и аналоги возьмите на эту дату');
  assert.deepEqual(res[0].fix, { bad: '10.11.2026', right: '03.06.2026', from: 'в заявке', flip: 'date' });
  assert.equal(res[0].quote, 'Дата оценки: 10.11.2026');
  // Кнопка «Заменить на значение из заявки» — для этой даты есть, у других находок по заявке с датой — по-прежнему нет.
  assert.equal(assignmentSource(res[0].fix), 'из заявки');
  assert.equal(swapValue(res[0].fix, '«10» ноября 2026'), '«03» июня 2026');
  assert.equal(assignmentSource({ bad: '10.11.2026', right: '03.06.2026', from: 'в заявке' }), null);
  // Задание на оценку с датой важнее заявки: с заявкой не сверяем; его дата не день открытия наследства — «сверьте».
  const task = (on) => doc([`ЗАДАНИЕ НА ОЦЕНКУ\nДата оценки: ${on}`], 'Задание.pdf');
  assert.deepEqual(run(report('10.11.2026'), heir, { assignment: [task('03.06.2026')] }), [], 'расхождение с заданием — правило value_date');
  const odd = run(report('01.06.2026'), heir, { assignment: [task('01.06.2026')] });
  assert.equal(odd.length, 1);
  assert.equal(odd[0].text, 'Дата оценки 01.06.2026 — как в задании на оценку «Задание.pdf», а день открытия наследства в заявке — 03.06.2026: сверьте со справкой нотариуса, какая дата верная');
  assert.equal(odd[0].fix, undefined);
  // Пользователь: не указан — находка; банк — находка; суд — можно (наследство делят и через суд).
  assert.deepEqual(run(report('03.06.2026', null)).map((f) => f.text), ['В отчёте не указан предполагаемый пользователь результатов оценки — оценка для наследства: укажите пользователем нотариуса (наследников)']);
  assert.equal(run(report('03.06.2026', 'ПАО Сбербанк'))[0].text, 'Предполагаемый пользователь в отчёте — «ПАО Сбербанк», а оценка для наследства: пользователь результатов — нотариус (наследники); исправьте отчёт');
  assert.deepEqual(run(report('03.06.2026', 'Пресненский районный суд г. Москвы')), []);
  // Даты нет или она в будущем — дату не сверяем, пользователя — да.
  assert.deepEqual(run(report('10.11.2026'), { purpose: 'inheritance' }), []);
  assert.deepEqual(run(report('10.11.2026'), { ...heir, death_date: '01.12.2026' }), []);
  // Цель не «наследство», не оценка — молчим.
  assert.deepEqual(run(report('10.11.2026', 'ПАО Сбербанк'), { purpose: 'bank', death_date: '03.06.2026' }), []);
  assert.deepEqual(run(report('10.11.2026', null), heir, { service: 'goods' }), []);
  // Пункт проверки «Сведения по закону об оценке» у всех услуг оценки.
  const reg = createRegistry();
  for (const id of ['realty', 'land', 'vehicle', 'movable']) {
    const items = reg.checks('expertise', id) ?? [];
    assert.ok(items.some((c) => (c.auto ?? []).includes('inherit_basis')), id);
  }
});
