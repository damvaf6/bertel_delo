// 2.473: ИИ-проверка заключения по ДТП — дата ДТП и цены на дату ДТП из заявки; методика по цели из заявки
// (ОСАГО — Единая методика 755-П, суд и к виновнику — рекомендации РФЦСЭ 2018). Находки — в пункте «Стоимость ремонта».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAutoChecks } from '../../src/ai/report-checks.mjs';
import { DEFAULT_MODULES } from '../../src/modules/index.mjs';

const REPORT = [
  'ЗАКЛЮЧЕНИЕ ЭКСПЕРТА № 12',
  '3. Объект и обстоятельства ДТП',
  'Дата ДТП: 14.09.2026, г. Москва, ул. Тверская.',
  '6. Методика расчёта',
  'Расчёт выполнен по Методическим рекомендациям по проведению судебных автотехнических экспертиз ФБУ РФЦСЭ при Минюсте России, 2018 г.',
  'Цены на запасные части, работы и материалы приняты на дату ДТП 14.09.2026.',
  '7. Расчёт стоимости восстановительного ремонта',
  'Облицовка заднего бампера 18 500 руб.',
].join('\n');
const run = (text, fields) => runAutoChecks(['repair_basis'], [{ name: 'Заключение.docx', pages: [text] }],
  { service: 'car_damage', fields: { accident_date: '14.09.2026', method: 'market', ...fields } }).repair_basis;

test('всё сходится — без находок; правило стоит в пункте «Стоимость ремонта»', () => {
  assert.deepEqual(run(REPORT), []);
  const item = DEFAULT_MODULES.find((m) => m.id === 'expertise').checks.find((c) => c.id === 'cd_cost');
  assert.ok(item.auto.includes('repair_basis'));
  // Не ДТП — молчим.
  assert.deepEqual(runAutoChecks(['repair_basis'], [{ name: 'a', pages: ['x'] }], { service: 'vehicle', fields: {} }).repair_basis, []);
});

test('дата ДТП и цены не на дату ДТП из заявки — находки с заменой', () => {
  const f = run(REPORT.replace('Дата ДТП: 14.09.2026', 'Дата ДТП: 15.09.2026').replace('на дату ДТП 14.09.2026', 'по состоянию на 01.11.2026'));
  assert.deepEqual(f.map((x) => x.text), [
    'Дата ДТП в отчёте 15.09.2026, а в заявке — 14.09.2026: исправьте отчёт или попросите заказчика уточнить дату по документам ГИБДД',
    'Цены в расчёте взяты на 01.11.2026, а ДТП было 14.09.2026 (дата из заявки) — по обеим методикам стоимость ремонта считается в ценах на дату ДТП',
  ]);
  assert.equal(f[0].quote, 'Дата ДТП: 15.09.2026, г. Москва, ул. Тверская.');
  assert.deepEqual(f[1].fix, { bad: '01.11.2026', right: '14.09.2026', from: 'в заявке' });
  // Дата оценки и слова «оценки на …» — не цены.
  assert.deepEqual(run(`${REPORT}\nДата оценки на 01.11.2026.`), []);
  // Словами — тоже дата ДТП.
  assert.deepEqual(run(REPORT.replace('Дата ДТП: 14.09.2026', 'ДТП, произошедшего 14 сентября 2026 г.')), []);
});

test('даты ДТП нет совсем; не сказано, на какую дату цены — по одной находке', () => {
  const noDate = REPORT.replace('Дата ДТП: 14.09.2026, г. Москва, ул. Тверская.', 'г. Москва.').replace(' на дату ДТП 14.09.2026', '');
  const f = run(noDate);
  assert.equal(f.length, 1);
  assert.match(f[0].text, /^Дата ДТП из заявки \(14\.09\.2026\) в отчёте не найдена/);
  const noPrice = REPORT.replace(' на дату ДТП 14.09.2026', '');
  const g = run(noPrice);
  assert.equal(g.length, 1);
  assert.match(g[0].text, /^В отчёте не сказано, на какую дату взяты цены/);
  assert.equal(g[0].quote, '6. Методика расчёта');
  // «на дату ДТП» без числа — достаточно, если дата ДТП в отчёте есть.
  assert.deepEqual(run(REPORT.replace('на дату ДТП 14.09.2026', 'на дату ДТП')), []);
});

test('методика по цели: ОСАГО — Единая методика, суд — РФЦСЭ; 432-П для ДТП после 20.09.2021; «не знаю» — только «не названа»', () => {
  const osago = run(REPORT, { method: 'osago' });
  assert.equal(osago.length, 1);
  assert.match(osago[0].text, /^В заявке — спор со страховой по ОСАГО, а Единая методика в отчёте не названа \(названы рекомендации РФЦСЭ 2018/);
  assert.match(osago[0].quote, /РФЦСЭ/);
  const unified = REPORT.replace(/Расчёт выполнен по [^\n]+/, 'Расчёт выполнен по Единой методике (Положение Банка России от 04.03.2021 № 755-П).');
  assert.deepEqual(run(unified, { method: 'osago' }), []);
  const old = run(unified.replace('755-П', '432-П'), { method: 'osago' });
  assert.equal(old.length, 1);
  assert.match(old[0].text, /^В отчёте — Положение № 432-П, а ДТП было 14\.09\.2026/);
  assert.deepEqual(run(unified.replace('755-П', '432-П'), { method: 'osago', accident_date: '01.06.2021' })
    .filter((x) => /432-П/.test(x.text)), []);
  const market = run(unified);
  assert.equal(market.length, 1);
  assert.match(market[0].text, /^В заявке — расчёт по рыночным ценам \(для суда или к виновнику\), а в отчёте названа Единая методика ОСАГО/);
  const none = REPORT.replace(/Расчёт выполнен по [^\n]+\n/, '');
  assert.match(run(none)[0].text, /^Методика расчёта в отчёте не названа: для суда и к виновнику расчёт — по Методическим рекомендациям/);
  assert.match(run(none, { method: 'unknown' })[0].text, /для спора по ОСАГО: Единая методика/);
  assert.deepEqual(run(unified, { method: 'unknown' }), []);
  assert.deepEqual(run(REPORT, { method: 'unknown' }), []);
});
