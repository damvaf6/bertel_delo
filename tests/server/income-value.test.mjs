// Задача 2.522 (нежилое помещение): ИИ-проверка «Доходный подход» (income_value) — ПВД = площадь × ставка, ДВД = ПВД × (1 −
// недозагрузка), ЧОД = ДВД − расходы, стоимость = ЧОД / ставка капитализации; источник у ставки капитализации и недозагрузки;
// пропуски «[заполнить]»; «Исправить в черновике» у неверной суммы. Таблица 2.521 из Word (ячейки — своими строками) и
// текстом PDF. Номера +7 999 000-54-31…33 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import { runAutoChecks, AUTO_CHECKS } from '../../src/ai/report-checks.mjs';
import { incomeTable } from '../../src/orders/income.mjs';
import { extractPages } from '../../src/ai/extract.mjs';

const COM = { object_type: 'commercial', area: 120, lease: 'no' };
const doc = (lines, name = 'Отчёт.pdf') => ({ name, kind: 'pdf', pages: [['ОТЧЁТ ОБ ОЦЕНКЕ № 31', 'Объект оценки: нежилое помещение', '13. Доходный подход', 'Расчёт выполнен методом прямой капитализации.', ...lines, '14. Согласование результатов', 'Итоговая стоимость 1 000 руб.'].join('\n')] });
const run = (lines, fields = COM) => runAutoChecks(['income_value'], [doc(lines)], { service: 'realty', fields }).income_value;
const cells = (table) => table.flatMap((row) => row.split('|').map((c) => c.trim()).filter(Boolean));
// Ставка, ПВД, недозагрузка, источник, ДВД, расходы, состав, ЧОД, ставка кап., источник, стоимость.
const filled = (vals, fields = COM) => { let i = 0; return incomeTable('realty', fields).map((r) => r.replace(/\[заполнить\]/g, () => vals[i++] ?? '[заполнить]')); };
const OK = ['18 000', 'аналоги аренды 1–4', '2 160 000', '8', 'справочник Лейфера 2025, табл. 40', '1 987 200', '387 200', 'налог, управление, ремонт', '1 600 000', '10', 'метод рыночной экстракции по аналогам', '16 000 000'];

test('расчёт сходится — молчим; ошибка в шаге — находка с верной суммой и «Исправить в черновике»', () => {
  assert.ok(AUTO_CHECKS.income_value, 'правило описано');
  assert.deepEqual(run(cells(filled(OK))), []);
  assert.deepEqual(run(filled(OK)), [], 'строками таблицы — тоже');
  // Округление до 1% — не находка.
  assert.deepEqual(run(cells(filled(OK.map((v) => (v === '16 000 000' ? '16 100 000' : v))))), []);
  // ПВД не та.
  let res = run(cells(filled(OK.map((v) => (v === '2 160 000' ? '2 400 000' : v)))));
  assert.equal(res.length, 2, JSON.stringify(res)); // ПВД и ДВД (ДВД сверяется с ПВД отчёта)
  assert.equal(res[0].text, 'Потенциальный валовой доход 2 400 000 руб. не сходится с расчётом: 120 кв. м × 18 000 = 2 160 000 руб. — пересчитайте');
  assert.deepEqual(res[0].fix, { bad: '2 400 000', right: '2 160 000', from: 'по расчёту 120 кв. м × 18 000' });
  // ЧОД не та.
  res = run(cells(filled(OK.map((v) => (v === '1 600 000' ? '1 700 000' : v)))));
  assert.equal(res.length, 2, JSON.stringify(res));
  assert.equal(res[0].text, 'Чистый операционный доход 1 700 000 руб. не сходится с расчётом: 1 987 200 − 387 200 = 1 600 000 руб. — пересчитайте');
  assert.equal(res[1].fix.right, '17 000 000');
  // Стоимость не та: ЧОД / ставка.
  res = run(cells(filled(OK.map((v) => (v === '16 000 000' ? '12 000 000' : v)))));
  assert.equal(res.length, 1, JSON.stringify(res));
  assert.equal(res[0].text, 'Стоимость доходным подходом 12 000 000 руб. не сходится с расчётом: 1 600 000 / 10% = 16 000 000 руб. — пересчитайте');
  assert.deepEqual(res[0].fix, { bad: '12 000 000', right: '16 000 000', from: 'по расчёту 1 600 000 / 10%' });
  // ДВД не та.
  res = run(cells(filled(OK.map((v) => (v === '1 987 200' ? '2 160 000' : v)))));
  assert.equal(res[0].text, 'Действительный валовой доход 2 160 000 руб. не сходится с расчётом: 2 160 000 × (1 − 8%) = 1 987 200 руб. — пересчитайте');
});

test('источник у ставки капитализации и недозагрузки; пропуски «[заполнить]»', () => {
  const res = run(['Площадь: 120 кв. м', 'Рыночная ставка аренды: 18 000 руб. за кв. м в год', 'ПВД: 2 160 000 руб.',
    'Недозагрузка: 8 %, принята экспертом', 'ДВД: 1 987 200 руб.', 'Операционные расходы: 387 200 руб.', 'ЧОД: 1 600 000 руб.',
    'Ставка капитализации: 10 %', 'Стоимость доходным подходом: 16 000 000 руб.']);
  assert.equal(res.length, 2, JSON.stringify(res));
  assert.match(res[0].text, /^У ставки капитализации 10% не назван источник/);
  assert.match(res[1].text, /^У недозагрузки 8% не назван источник/);
  // Пустая таблица из черновика — одна находка о пропусках.
  const gaps = run(cells(incomeTable('realty', COM)));
  assert.equal(gaps.length, 1, JSON.stringify(gaps));
  assert.match(gaps[0].text, /^В расчёте доходным подходом остались пропуски «\[заполнить\]» \(\d+\)/);
});

test('текстом: ставка в месяц, сокращения; подхода нет — молчим; не нежилое — молчим; пункт только у нежилого', () => {
  const text = [
    'Площадь помещения: 100 кв. м',
    'Рыночная ставка аренды: 1 500 руб. за кв. м в месяц (по аналогам аренды)',
    'ПВД = 1 800 000 руб. в год',
    'Недозагрузка: 10 % (по данным рынка аренды)',
    'ДВД = 1 620 000 руб.',
    'Операционные расходы: 220 000 руб.',
    'ЧОД = 1 400 000 руб.',
    'Ставка капитализации: 11,5 % (кумулятивное построение)',
    'Стоимость доходным подходом: 12 173 913 руб.',
  ];
  assert.deepEqual(run(text), []);
  const bad = run(text.map((l) => l.replace('1 800 000', '150 000')));
  assert.equal(bad[0].text, 'Потенциальный валовой доход 150 000 руб. не сходится с расчётом: 100 кв. м × 1 500 × 12 мес. = 1 800 000 руб. — пересчитайте');
  assert.deepEqual(run(['Доходный подход не применялся: рынок аренды не развит.']), []);
  assert.deepEqual(run(text, { object_type: 'flat' }), []);
  const reg = createRegistry();
  assert.ok(reg.checks('expertise', 'realty', COM).some((c) => (c.auto ?? []).includes('income_value')));
  assert.equal(reg.checks('expertise', 'realty', { object_type: 'flat' }).some((c) => (c.auto ?? []).includes('income_value')), false);
});

let S, owner, dispatcher, spec;
const BASE = { purpose: 'bank', region: 'moscow', object_type: 'commercial', address: 'г. Москва, Тестовая ул., д. 5, пом. 1', area: 120, lease: 'no', premises_use: 'office' };
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005431');
  dispatcher = await login(S, '+79990005432');
  spec = await login(S, '+79990005433');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

test('Word из черновика: неверная стоимость доходным подходом — находка в ИИ-проверке', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Нежилое: доходный' })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: BASE })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);
  const d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).body.draft;
  const t = incomeTable('realty', BASE);
  assert.ok(d.body.includes(t.join('\n')), 'таблица 2.521 в черновике');
  const mine = filled(OK.map((v) => (v === '16 000 000' ? '15 000 000' : v)), BASE);
  const body = d.body.replace(t.join('\n'), mine.join('\n')).replace(/\[(?:заполнить|описать)[^\]]*\]/g, 'текст');
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/draft`, { body, from: d.id })).status, 200);
  const w = await fetch(`${S.base}/api/orders/${o.id}/draft/docx`, { headers: { cookie: spec.cookie } });
  assert.equal(w.status, 200);
  const pages = (await extractPages(Buffer.from(await w.arrayBuffer()), 'r.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).pages;
  const res = runAutoChecks(['income_value'], [{ name: 'Отчёт.docx', kind: 'docx', pages }], { service: 'realty', fields: BASE }).income_value;
  assert.equal(res.length, 1, JSON.stringify(res));
  assert.equal(res[0].text, 'Стоимость доходным подходом 15 000 000 руб. не сходится с расчётом: 1 600 000 / 10% = 16 000 000 руб. — пересчитайте');
});
