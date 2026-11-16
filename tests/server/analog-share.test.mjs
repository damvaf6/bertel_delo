// Задача 2.513 (аналоги для доли): при оценке доли у аналога признак «Продаётся доля или целый объект»; доли и целые объекты
// смешаны без корректировки «Доля / целый объект» — предупреждение у аналога и строка над списком; оценивается часть стоимости
// целого — аналоги-доли не годятся. У других заявок признака и корректировки нет.
// Номера +7 999 000-55-31…33 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import { analogWarnings, analogTable } from '../../src/analogs/analogs.mjs';
import { DEFAULT_MODULES } from '../../src/modules/index.mjs';

const reg = createRegistry();
const SHARE = { region: 'moscow', object_type: 'share', share_size: '1/3' };
const spec = reg.analogs('expertise', 'realty', SHARE);
const an = (id, kind, adjustments = []) => ({ id, file_key: 'k', confirmed_at: new Date(), fields: { price_rub: 9_000_000, listed_on: todayMsk(), region: 'moscow', address: 'Москва', ...(kind ? { share_kind: kind } : {}) }, adjustments });
const ADJ = [{ kind: 'share_kind', pct: 35, book: 'Справочник оценщика', year: 2026, table: '12' }];
const mixOf = (w) => w.find((x) => /доля|целый объект|целые объекты/i.test(x));

test('признак и корректировка «доля или целый объект» — только у заявки на долю', () => {
  assert.ok(spec.fields.some((f) => f.id === 'share_kind' && f.type === 'select'));
  assert.ok(spec.adjustments.some((k) => k.id === 'share_kind' && k.covers.includes('share_kind')));
  for (const fields of [{ object_type: 'flat' }, null]) {
    const s = reg.analogs('expertise', 'realty', fields);
    assert.ok(!s.fields.some((f) => f.id === 'share_kind'));
    assert.ok(!s.adjustments.some((k) => k.id === 'share_kind'));
  }
  assert.ok(!reg.analogs('expertise', 'land', SHARE).fields.some((f) => f.id === 'share_kind'));
  // Описание модуля: when — поле-список заявки.
  const bad = (fn) => () => { const m = structuredClone(DEFAULT_MODULES.find((x) => x.id === 'expertise')); fn(m.analogs); createRegistry([m]); };
  assert.throws(bad((a) => { a.fields.find((f) => f.id === 'share_kind').when = { field: 'address', in: ['x'] }; }), /when\.field/);
  assert.throws(bad((a) => { a.fields.find((f) => f.id === 'share_kind').when = { field: 'object_type', in: ['nope'] }; }), /when\.in/);
});

test('смешаны без корректировки — у меньшинства предупреждение и строка над списком', () => {
  const list = [an(1, 'whole'), an(2, 'share'), an(3, 'whole'), an(4, 'share', ADJ), an(5, null)];
  const { per, hints } = analogWarnings(spec, { fields: SHARE }, list);
  assert.equal(mixOf(per.get(1)), undefined);
  assert.equal(mixOf(per.get(3)), undefined);
  assert.equal(mixOf(per.get(2)), 'Аналог — доля, а аналоги 1, 3 — целые объекты: цены несравнимы, нужна корректировка «Доля / целый объект»');
  assert.equal(mixOf(per.get(4)), undefined, 'корректировка есть');
  assert.equal(per.get(5).find((w) => w.startsWith('Отметьте')), 'Отметьте, что продаётся — доля или целый объект: оценивается доля, цены долей и целых объектов несравнимы');
  assert.equal(hints[0], 'Аналоги смешаны: доли — 2, 4, целые объекты — 1, 3; без корректировки «Доля / целый объект» — аналог 2');
  // Большинство — доли: предупреждение у целого объекта.
  const w = analogWarnings(spec, { fields: SHARE }, [an(1, 'share'), an(2, 'share'), an(3, 'whole')]);
  assert.equal(mixOf(w.per.get(3)), 'Аналог — целый объект, а аналоги 1, 2 — доли: цены несравнимы, нужна корректировка «Доля / целый объект»');
  // Все одного вида — тихо.
  assert.ok(!analogWarnings(spec, { fields: SHARE }, [an(1, 'whole'), an(2, 'whole'), an(3, 'whole')]).hints.some((h) => /смешаны/.test(h)));
  assert.ok(!analogWarnings(spec, { fields: { ...SHARE, share_method: 'market' } }, [an(1, 'share'), an(2, 'share')]).hints.some((h) => /смешаны|часть стоимости/.test(h)));
});

test('часть стоимости целого — аналоги-доли не годятся', () => {
  const order = { fields: { ...SHARE, share_method: 'pro_rata' } };
  const { per, hints } = analogWarnings(spec, order, [an(1, 'whole'), an(2, 'share'), an(3, 'share', ADJ)]);
  assert.equal(mixOf(per.get(1)), undefined);
  assert.equal(mixOf(per.get(2)), 'Аналог — доля, а оценивается часть стоимости всего объекта (без скидки): возьмите аналог — целый объект или сделайте корректировку «Доля / целый объект»');
  assert.equal(mixOf(per.get(3)), undefined);
  assert.equal(hints[0], 'Оценивается часть стоимости всего объекта: аналог 2 — доля, нужны целые объекты или корректировка «Доля / целый объект»');
});

test('у квартиры целиком — ни признака, ни предупреждений; в таблице Word у доли — столбец', () => {
  const flat = reg.analogs('expertise', 'realty', { object_type: 'flat' });
  const { per, hints } = analogWarnings(flat, { fields: { object_type: 'flat' } }, [an(1, null), an(2, null), an(3, null)]);
  assert.ok(![...per.values()].flat().some((w) => /доля/i.test(w)));
  assert.ok(!hints.some((h) => /доли/.test(h)));
  const t = JSON.stringify(analogTable(spec, [an(1, 'share')], { fields: SHARE }));
  assert.match(t, /Продаётся доля или целый объект/);
  assert.match(t, /Доля в праве/);
});

let S, owner, dispatcher, expert;
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005531');
  dispatcher = await login(S, '+79990005532');
  expert = await login(S, '+79990005533');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, expert.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

async function caseInWork(fields) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Доля: аналоги' })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: expert.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await expert.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);
  return o;
}

async function addAnalog(o, n, fields, adjustments) {
  const r = await expert.req('POST', `/api/orders/${o.id}/analogs`, { url: `https://www.cian.ru/sale/flat/5531${n}/` });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const u = await expert.req('PUT', `/api/orders/${o.id}/analogs/${r.body.id}`, { fields: { price_rub: 3_000_000 + n, listed_on: todayMsk(), region: 'moscow', address: `Москва, ${n}`, ...fields }, ...(adjustments ? { adjustments } : {}) });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  return u.body;
}

test('в деле об оценке доли: признак в списке, корректировка снимает предупреждение; у квартиры признака нет', async () => {
  const o = await caseInWork({ ...SHARE, purpose: 'division', address: 'г. Москва, Тестовая ул., д. 5, кв. 31', area: 60 });
  await addAnalog(o, 1, { share_kind: 'whole' });
  await addAnalog(o, 2, { share_kind: 'whole' });
  let v = await addAnalog(o, 3, { share_kind: 'share' });
  assert.ok(v.fields.some((f) => f.id === 'share_kind'));
  assert.ok(v.adjust_kinds.some((k) => k.id === 'share_kind' && k.name === 'Доля / целый объект'));
  assert.equal(v.hints[0], 'Аналоги смешаны: доли — 3, целые объекты — 1, 2; без корректировки «Доля / целый объект» — аналог 3');
  assert.ok(v.analogs[2].warnings.includes('Аналог — доля, а аналоги 1, 2 — целые объекты: цены несравнимы, нужна корректировка «Доля / целый объект»'));
  // Диспетчер видит то же.
  assert.equal((await dispatcher.req('GET', `/api/orders/${o.id}/analogs`)).body.hints[0], v.hints[0]);
  // Корректировка — предупреждение ушло.
  const id = v.analogs[2].id;
  const u = await expert.req('PUT', `/api/orders/${o.id}/analogs/${id}`, { fields: { price_rub: 3_000_003, listed_on: todayMsk(), region: 'moscow', address: 'Москва, 3', share_kind: 'share' }, adjustments: ADJ });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.ok(!u.body.hints.some((h) => /смешаны/.test(h)));
  assert.ok(!u.body.analogs[2].warnings.some((w) => /целые объекты/.test(w)));
  // Неверное значение признака — отказ.
  const bad = await expert.req('PUT', `/api/orders/${o.id}/analogs/${id}`, { fields: { price_rub: 1, listed_on: todayMsk(), region: 'moscow', address: 'x', share_kind: 'half' } });
  assert.equal(bad.status, 400);

  const flat = await caseInWork({ purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, Тестовая ул., д. 5, кв. 32', area: 60 });
  const f = await addAnalog(flat, 4, {});
  assert.ok(!f.fields.some((x) => x.id === 'share_kind'));
  assert.ok(!f.adjust_kinds.some((k) => k.id === 'share_kind'));
  // Корректировка «на долю» у квартиры целиком — нельзя.
  const no = await expert.req('PUT', `/api/orders/${flat.id}/analogs/${f.analogs[0].id}`, { fields: { price_rub: 1, listed_on: todayMsk(), region: 'moscow', address: 'x' }, adjustments: ADJ });
  assert.equal(no.status, 400);
});
