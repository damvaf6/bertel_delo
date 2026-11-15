// Задача 2.502 (оценка задним числом): дата оценки раньше осмотра — в отчёте допущение «состояние на дату оценки принято
// таким же, как на дату осмотра»; ИИ-проверка (retro_basis) — допущения нет; цены и курс — на дату оценки, а не позже.
// В черновике от ИИ допущение встаёт строкой в раздел «Допущения и ограничительные условия». Номера +7 999 000-53-11…13 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import { runAutoChecks, AUTO_CHECKS } from '../../src/ai/report-checks.mjs';
import { RETRO_HEAD, placeRetro, retroInspection, retroLine } from '../../src/orders/retro.mjs';

const doc = (pages, name = 'Отчёт.pdf') => ({ name, kind: 'pdf', pages });
const report = (lines) => doc([['ОТЧЁТ ОБ ОЦЕНКЕ № 12', 'Дата оценки: 03.06.2026', 'Дата составления отчёта: 12.11.2026', ...lines].join('\n')]);
const run = (rep, ctx = {}) => runAutoChecks(['retro_basis'], [rep], { service: 'realty', inspectionDays: ['2026-11-10'], ...ctx }).retro_basis;

test('допущение: первый день осмотра позже даты оценки, строка и место в черновике', () => {
  assert.equal(retroInspection('2026-06-03', ['2026-11-12', '2026-11-10', '2026-05-01']), '2026-11-10');
  assert.equal(retroInspection('2026-06-03', ['2026-05-01']), null);
  assert.equal(retroInspection(null, ['2026-11-10']), null);
  assert.equal(retroInspection('03.06.2026', ['2026-11-10']), '2026-11-10', 'дата из черновика');
  const line = retroLine('2026-06-03', '2026-11-10');
  assert.ok(line.startsWith(RETRO_HEAD));
  assert.match(line, /дата оценки \(03\.06\.2026\) раньше даты осмотра \(10\.11\.2026\); состояние объекта на дату оценки принято таким же, как на дату осмотра/);
  assert.equal(retroLine('03.06.2026', '10.11.2026'), line, 'даты из отчёта — так же');
  const sections = [{ title: '4. Стандарты' }, { title: '5. Допущения и ограничительные условия' }];
  const body = '## 4. Стандарты\nФСО.\n\n## 5. Допущения и ограничительные условия\nОценщик не проверяет права.\n';
  const placed = placeRetro(body, sections, line);
  assert.ok(placed.includes(`## 5. Допущения и ограничительные условия\n${line}\nОценщик не проверяет права.`), placed);
  // Повторно — строка заменяется, а не дублируется.
  const again = placeRetro(placed, sections, retroLine('2026-06-03', '2026-11-12'));
  assert.equal(again.split(RETRO_HEAD).length, 2);
  assert.match(again, /12\.11\.2026/);
  assert.equal(placeRetro(body, [{ title: '4. Стандарты' }], line), body, 'раздела допущений нет — без вставки');
  assert.equal(placeRetro(body, sections, null), body);
});

test('ИИ-проверка: дата оценки раньше осмотра в деле, а допущения нет', () => {
  assert.ok(AUTO_CHECKS.retro_basis, 'правило описано');
  const res = run(report(['Цель оценки: для нотариуса']));
  assert.equal(res.length, 1);
  assert.equal(res[0].text, 'Дата оценки в отчёте 03.06.2026, а осмотр в деле — 10.11.2026: оценка задним числом, а допущения нет — напишите, что оценка ретроспективная и состояние объекта на дату оценки принято таким же, как на дату осмотра (ФСО); цены и аналоги — на дату оценки');
  assert.equal(res[0].quote, 'Дата оценки: 03.06.2026');
  assert.equal(res[0].retro, retroLine('2026-06-03', '2026-11-10'));
  // Допущение есть (своими словами или вставленное кнопкой) — молчим.
  assert.deepEqual(run(report(['Оценка проводится ретроспективно.'])), []);
  assert.deepEqual(run(report(['Состояние объекта на дату оценки принято аналогичным состоянию на дату осмотра'])), []);
  assert.deepEqual(run(report([retroLine('2026-06-03', '2026-11-10')])), []);
  // Осмотр в деле не позже даты оценки, осмотра нет, «без осмотра» — молчим.
  assert.deepEqual(run(report([]), { inspectionDays: ['2026-06-03'] }), []);
  assert.deepEqual(run(report([]), { inspectionDays: [] }), []);
  assert.deepEqual(run(report(['Оценка проведена без осмотра объекта.'])), []);
  // Дата осмотра в самом отчёте позже даты оценки — находка report_dates (с той же кнопкой), здесь не повторяется.
  const both = report(['Дата осмотра: 10.11.2026']);
  assert.deepEqual(run(both), []);
  const rd = runAutoChecks(['report_dates'], [both], { service: 'realty', inspectionDays: ['2026-11-10'] }).report_dates;
  const f = rd.find((x) => /раньше даты осмотра/.test(x.text));
  assert.equal(f?.retro, retroLine('2026-06-03', '2026-11-10'));
  // Не оценка — молчим.
  assert.deepEqual(run(report([]), { service: 'goods' }), []);
  // Пункт «Допущения и погрешности указаны» у всех услуг оценки.
  const reg = createRegistry();
  for (const id of ['realty', 'land', 'vehicle', 'movable']) {
    assert.ok((reg.checks('expertise', id) ?? []).some((c) => (c.auto ?? []).includes('retro_basis')), id);
  }
});

test('ИИ-проверка: цены, курс и индексы — на дату оценки', () => {
  const ok = [retroLine('2026-06-03', '2026-11-10')];
  const res = run(report([...ok, 'Курс доллара США, установленный ЦБ РФ на 12.11.2026, — 92,10 руб.', 'Цены на материалы приняты по состоянию на «10» ноября 2026 г.']));
  assert.deepEqual(res.map((x) => x.text), [
    'Курс валют в отчёте — на 12.11.2026, позже даты оценки 03.06.2026: стоимость определяется на дату оценки — цены, курсы валют, индексы и ставки берутся на неё, а не на дату осмотра или составления отчёта',
    'Цены в отчёте — на 10.11.2026, позже даты оценки 03.06.2026: стоимость определяется на дату оценки — цены, курсы валют, индексы и ставки берутся на неё, а не на дату осмотра или составления отчёта',
  ]);
  assert.equal(res[0].retro, undefined);
  assert.equal(res[0].quote, 'Курс доллара США, установленный ЦБ РФ на 12.11.2026, — 92,10 руб.');
  // На дату оценки или раньше — молчим; аналоги, справочники, законы, выписки, дата составления — не в счёт.
  assert.deepEqual(run(report([...ok,
    'Курс доллара США на 03.06.2026 — 79,50 руб.',
    'Индекс потребительских цен за май 2026 г. по данным Росстата на 01.06.2026',
    'Аналог 1: цена предложения 9 500 000 руб., объявление от 01.06.2026',
    'Справочник оценщика недвижимости, цены и корректировки, изд. 10.09.2026',
    'Приказ Минэкономразвития от 14.04.2022 № 200, цены по ФСО',
    'Выписка ЕГРН от 05.11.2026, кадастровая цена не указана',
  ])), []);
  // Дата оценки в отчёте не одна — молчим (это находка value_date).
  assert.deepEqual(run(doc(['Дата оценки: 03.06.2026\nДата оценки: 10.06.2026\nКурс доллара на 12.11.2026'])), []);
});

let S, owner, dispatcher, spec;
const BASE = { purpose: 'inheritance', region: 'moscow', object_type: 'flat', address: 'г. Москва, Тестовая ул., д. 2, кв. 3', area: 45 };
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005311');
  dispatcher = await login(S, '+79990005312');
  spec = await login(S, '+79990005313');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

async function caseInWork(fields) {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Квартира: задним числом' })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);
  return o;
}

test('черновик от ИИ: дата оценки раньше осмотра в деле — допущение в разделе допущений', async () => {
  const death = addDays(todayMsk(), -120);
  const o = await caseInWork({ ...BASE, death_date: death.split('-').reverse().join('.') });
  // Без осмотра в деле — допущения нет.
  let r = await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(!r.body.draft.body.includes(RETRO_HEAD));
  assert.equal(r.body.draft.inputs.retro, null);
  // Выезд помощника сегодня — осмотр позже даты оценки.
  await S.sql`insert into onsite_visits (order_id, helper_id, assigned_by, planned_at, finished_at)
              values (${o.id}, ${spec.user.id}, ${spec.user.id}, now(), now())`;
  const [{ v: from }] = await S.sql`select max(id)::text as v from result_drafts where order_id = ${o.id}`;
  r = await spec.req('POST', `/api/orders/${o.id}/draft/ai`, { from });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const line = retroLine(death, todayMsk());
  assert.ok(r.body.draft.body.includes(`5. Допущения и ограничительные условия\n${line}`), r.body.draft.body.slice(0, 3000));
  assert.equal(r.body.draft.inputs.retro, todayMsk());
});
