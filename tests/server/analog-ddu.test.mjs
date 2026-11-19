// Задача 2.543 (аналоги для ДДУ): у квартиры по ДДУ признаки аналога — стадия строительства, срок сдачи дома, кто продаёт
// (застройщик или переуступка), отделка. Срок сдачи дальше квартала от срока передачи по договору или аналог — готовая
// квартира — «нужна корректировка «Срок сдачи дома»» у аналога и строкой над списком; отделка не как у большинства —
// «Состояние и отделка»; застройщик и переуступка вместе — строкой. У квартиры и дома признаков ДДУ нет.
// Номера +7 999 000-59-71…73 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import { analogWarnings, analogTable, dduQuarter, searchHints } from '../../src/analogs/analogs.mjs';

const reg = createRegistry();
const DDU = { region: 'moscow', object_type: 'ddu', ddu_area: 54.3, ddu_handover: '31.12.2027', ddu_complex: 'ЖК «Тестовый», корп. 3' };
const spec = reg.analogs('expertise', 'realty', DDU);
const an = (id, f = {}, adjustments = []) => ({
  id, file_key: 'k', confirmed_at: new Date(),
  fields: { price_rub: 15_000_000, listed_on: todayMsk(), region: 'moscow', address: 'г. Москва, ЖК «Тестовый»', area: 54, ddu_stage: 'frame', ddu_due: 'IV кв. 2027', ddu_seller: 'developer', ddu_finish: 'none', ...f },
  adjustments,
});
const adj = (kind) => ({ kind, pct: -5, book: 'Справочник оценщика', year: 2026, table: '12' });
const ids = (s) => s.fields.map((f) => f.id);
const DDU_IDS = ['ddu_stage', 'ddu_due', 'ddu_seller', 'ddu_finish'];

test('срок сдачи — квартал из даты или «IV кв. 2027»; год без квартала — не сравниваем', () => {
  assert.equal(dduQuarter('31.12.2027'), dduQuarter('IV кв. 2027'));
  assert.equal(dduQuarter('4 квартал 2027 г.'), dduQuarter('01.10.2027'));
  assert.equal(dduQuarter('2 кв 2028') - dduQuarter('IV кв. 2027'), 2);
  for (const v of ['2027', 'скоро', '', null, '31.13.2027']) assert.equal(dduQuarter(v), null);
});

test('признаки ДДУ — только у заявки на права по ДДУ', () => {
  assert.deepEqual(ids(spec).filter((x) => DDU_IDS.includes(x)), DDU_IDS);
  assert.ok(ids(spec).includes('floor'), 'этаж у квартиры в новостройке остаётся');
  assert.deepEqual(spec.adjustments.find((x) => x.id === 'ddu_due').covers, ['ddu_stage']);
  assert.ok(spec.adjustments.find((x) => x.id === 'finish').covers.includes('ddu_finish'));
  for (const fields of [{ object_type: 'flat' }, { object_type: 'house' }, null]) {
    const s = reg.analogs('expertise', 'realty', fields);
    assert.ok(!ids(s).some((x) => DDU_IDS.includes(x)));
    assert.ok(!s.adjustments.some((x) => x.id === 'ddu_due'));
  }
});

test('срок сдачи далеко, готовая квартира, отделка — «нужна корректировка», корректировка снимает', () => {
  const list = [
    an(1),
    an(2, { ddu_due: 'II кв. 2029', ddu_seller: 'assignment' }),
    an(3, { ddu_stage: 'ready', ddu_due: '' }),
    an(4, { ddu_due: '31.03.2028' }),
    an(5, { ddu_due: '', ddu_finish: 'full' }),
    an(6, { ddu_due: 'I кв. 2030', ddu_finish: 'full' }, [adj('ddu_due'), adj('finish')]),
  ];
  const { per, hints } = analogWarnings(spec, { fields: DDU }, list);
  const mine = (n) => per.get(n).filter((w) => /Срок сдачи|срок сдачи|готовая|Отделка/.test(w));
  assert.deepEqual(mine(1), []);
  assert.deepEqual(mine(2), ['Срок сдачи: II кв. 2029 у аналога, IV кв. 2027 по договору — позже на 6 кварталов, нужна корректировка «Срок сдачи дома»']);
  assert.deepEqual(mine(3), ['Аналог — готовая квартира в сданном доме, а оценивается право требования по ДДУ — нужна корректировка «Срок сдачи дома» или аналог-новостройка']);
  assert.deepEqual(mine(4), [], 'I кв. 2028 — в пределах квартала');
  assert.deepEqual(mine(5), [
    'Укажите срок сдачи дома — цена права требования зависит от срока',
    'Отделка: чистовая у аналога, у аналогов 1, 2, 3, 4 — без отделки: нужна корректировка «Состояние и отделка»',
  ]);
  assert.deepEqual(mine(6), [], 'корректировки есть');
  assert.ok(hints.includes('Аналог 3 — готовая квартира, а оценивается право требования: без корректировки «Срок сдачи дома»'));
  assert.ok(hints.includes('Срок сдачи далеко от срока передачи по договору (IV кв. 2027) у аналога 2 — нет корректировки «Срок сдачи дома»'));
  assert.ok(hints.includes('Отделка у аналогов разная: без отделки — 1, 2, 3, 4; чистовая — 5, 6; без корректировки «Состояние и отделка» — аналог 5'));
  assert.ok(hints.includes('Продают: застройщик — аналоги 1, 3, 4, 5, 6, переуступка — аналог 2; цены застройщика и переуступки могут различаться — поясните в отчёте'));
  // Срок в заявке кварталом не указан — сверять не с чем; поровну по отделке — только строка над списком.
  const blank = analogWarnings(spec, { fields: { ...DDU, ddu_handover: '2027 год' } }, [an(1), an(2, { ddu_due: 'II кв. 2029', ddu_finish: 'full' })]);
  assert.ok(![...blank.per.values()].flat().some((w) => /Срок сдачи:|Отделка:/.test(w)));
  assert.ok(blank.hints.includes('Отделка у аналогов разная: без отделки — 1; чистовая — 2 — сделайте корректировку «Состояние и отделка» к отделке объекта'));
  // В таблице Word — столбцы ДДУ.
  const t = JSON.stringify(analogTable(spec, list, { fields: DDU }));
  for (const x of ['Стадия строительства', 'Срок сдачи дома', 'Кто продаёт', 'Переуступка', 'Предчистовая|Без отделки']) assert.match(t, new RegExp(x));
});

test('где искать: новостройки, площадь от проектной, тот же ЖК, срок сдачи', () => {
  const h = searchHints(reg, { module: 'expertise', service: 'realty', fields: DDU });
  assert.match(h.criteria, /^Квартиры в новостройках \(права по ДДУ\), 38–71 кв\. м; тот же ЖК или рядом \(ЖК «Тестовый», корп\. 3\); срок сдачи около IV кв\. 2027;/);
  assert.ok(h.links.some((l) => /новостройки/.test(l.name)));
  assert.doesNotMatch(searchHints(reg, { module: 'expertise', service: 'realty', fields: { object_type: 'flat', area: 50 } }).criteria, /ДДУ/);
});

let S, owner, dispatcher, expert;
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005971');
  dispatcher = await login(S, '+79990005972');
  expert = await login(S, '+79990005973');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, expert.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

async function caseInWork(fields) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'ДДУ: аналоги' })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: expert.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await expert.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);
  return o;
}

async function addAnalog(o, n, fields, adjustments) {
  const r = await expert.req('POST', `/api/orders/${o.id}/analogs`, { url: `https://www.cian.ru/sale/flat/5971${n}/` });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const u = await expert.req('PUT', `/api/orders/${o.id}/analogs/${r.body.id}`, { fields: { price_rub: 15_000_000 + n, listed_on: todayMsk(), region: 'moscow', address: `г. Москва, ЖК «Тестовый», ${n}`, area: 54, ...fields }, ...(adjustments ? { adjustments } : {}) });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  return u.body;
}

test('в деле по ДДУ: признаки в форме, предупреждение и корректировка; у квартиры признаков ДДУ нет', async () => {
  const o = await caseInWork({ ...DDU, purpose: 'bank', address: 'г. Москва, ЖК «Тестовый», корп. 3, кв. 51 (усл.)' });
  await addAnalog(o, 1, { ddu_stage: 'frame', ddu_due: 'IV кв. 2027', ddu_seller: 'developer', ddu_finish: 'none' });
  const v = await addAnalog(o, 2, { ddu_stage: 'pit', ddu_due: 'IV кв. 2028', ddu_seller: 'developer', ddu_finish: 'none' });
  assert.ok(DDU_IDS.every((x) => v.fields.some((f) => f.id === x)));
  assert.ok(v.adjust_kinds.some((k) => k.id === 'ddu_due' && k.name === 'Срок сдачи дома'));
  const w = 'Срок сдачи: IV кв. 2028 у аналога, IV кв. 2027 по договору — позже на 4 квартала, нужна корректировка «Срок сдачи дома»';
  assert.ok(v.analogs[1].warnings.includes(w));
  assert.ok(v.hints.includes('Срок сдачи далеко от срока передачи по договору (IV кв. 2027) у аналога 2 — нет корректировки «Срок сдачи дома»'));
  assert.deepEqual((await dispatcher.req('GET', `/api/orders/${o.id}/analogs`)).body.hints, v.hints);
  const id = v.analogs[1].id;
  const u = await expert.req('PUT', `/api/orders/${o.id}/analogs/${id}`, { fields: { price_rub: 15_000_002, listed_on: todayMsk(), region: 'moscow', address: 'г. Москва, 2', area: 54, ddu_stage: 'pit', ddu_due: 'IV кв. 2028' }, adjustments: [adj('ddu_due')] });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.ok(!u.body.analogs[1].warnings.some((x) => /Срок сдачи:/.test(x)));
  const bad = await expert.req('PUT', `/api/orders/${o.id}/analogs/${id}`, { fields: { price_rub: 1, listed_on: todayMsk(), region: 'moscow', address: 'x', ddu_seller: 'bank' } });
  assert.equal(bad.status, 400);

  const flat = await caseInWork({ purpose: 'deal', region: 'moscow', object_type: 'flat', address: 'г. Москва, Тестовая ул., д. 5, кв. 51', area: 60 });
  const f = await addAnalog(flat, 3, { floor: '3/9' });
  assert.ok(!f.fields.some((x) => DDU_IDS.includes(x.id)));
  const no = await expert.req('PUT', `/api/orders/${flat.id}/analogs/${f.analogs[0].id}`, { fields: { price_rub: 1, listed_on: todayMsk(), region: 'moscow', address: 'x' }, adjustments: [adj('ddu_due')] });
  assert.equal(no.status, 400);
});
