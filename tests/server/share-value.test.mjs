// Задача 2.512 (оценка доли): ИИ-проверка «Стоимость доли» (share_value) — часть стоимости = целое × доля, стоимость доли =
// часть × (1 − скидка); по способу из заявки: «рыночная» — скидка с источником, «часть стоимости целого» — без скидки;
// пропуски «[заполнить]»; «Исправить в черновике» у неверной суммы. Таблица 2.511 из Word (ячейки — своими строками) и
// текстом PDF. Номера +7 999 000-54-21…23 — только здесь.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, login, setPlatformRole, makeSpecialist, ensurePaid } from '../helpers.mjs';
import { addDays, todayMsk } from '../../src/orders/workflow.mjs';
import { createRegistry } from '../../src/modules/index.mjs';
import { runAutoChecks, AUTO_CHECKS } from '../../src/ai/report-checks.mjs';
import { shareTable } from '../../src/orders/share.mjs';
import { extractPages } from '../../src/ai/extract.mjs';

const MARKET = { object_type: 'share', share_size: '1/3', share_method: 'market' };
const PRO = { object_type: 'share', share_size: '1/2', share_method: 'pro_rata' };
const doc = (lines, name = 'Отчёт.pdf') => ({ name, kind: 'pdf', pages: [['ОТЧЁТ ОБ ОЦЕНКЕ № 12', 'Объект оценки: доля 1/3 в праве на квартиру', ...lines].join('\n')] });
const run = (lines, fields = MARKET, ctx = {}) => runAutoChecks(['share_value'], [doc(lines)], { service: 'realty', fields, ...ctx }).share_value;
// Таблица 2.511, как её читает извлечение текста из Word: каждая ячейка — своей строкой.
const cells = (table) => table.flatMap((row) => row.split('|').map((c) => c.trim()).filter(Boolean));
const filled = (fields, vals) => { let i = 0; return shareTable('realty', fields).map((r) => r.replace(/\[заполнить\]/g, () => vals[i++] ?? '[заполнить]')); };

test('рыночная стоимость доли: таблица из Word сходится — молчим; суммы не сходятся — находки с исправлением', () => {
  assert.ok(AUTO_CHECKS.share_value, 'правило описано');
  const ok = cells(filled(MARKET, ['6 000 000', '2 000 000', '25', 'справочник Лейфера 2025, табл. 12', '1 500 000']));
  assert.deepEqual(run(ok), []);
  // Округление до тысяч — не находка.
  assert.deepEqual(run(cells(filled(MARKET, ['6 100 000', '2 033 333', '25', 'справочник Лейфера', '1 525 000']))), []);
  // Часть стоимости не та (и стоимость доли посчитана от неё — тоже находка, с верной суммой).
  let res = run(cells(filled(MARKET, ['6 000 000', '3 000 000', '25', 'справочник Лейфера', '2 250 000'])));
  assert.equal(res.length, 2, JSON.stringify(res));
  assert.equal(res[1].fix.right, '1 500 000');
  assert.equal(res[0].text, 'Часть стоимости объекта 3 000 000 руб. не равна стоимости целого × 1/3: 6 000 000 × 1/3 = 2 000 000 руб. — пересчитайте');
  assert.deepEqual(res[0].fix, { bad: '3 000 000', right: '2 000 000', from: 'по расчёту 6 000 000 × 1/3' });
  // Стоимость доли не та.
  res = run(cells(filled(MARKET, ['6 000 000', '2 000 000', '25', 'справочник Лейфера', '1 800 000'])));
  assert.equal(res.length, 1, JSON.stringify(res));
  assert.equal(res[0].text, 'Стоимость доли 1 800 000 руб. не сходится с расчётом: 2 000 000 × (1 − 25%) = 1 500 000 руб. — пересчитайте или исправьте скидку');
  assert.equal(res[0].fix.right, '1 500 000');
  assert.equal(res[0].fix.bad, '1 800 000');
});

test('рыночная: скидки нет, без источника; пропуски; текст PDF', () => {
  // Источник пустой.
  let res = run(cells(filled(MARKET, ['6 000 000', '2 000 000', '25', '[заполнить]', '1 500 000'])));
  assert.ok(res.some((f) => /пропуски «\[заполнить\]» \(1\)/.test(f.text)), JSON.stringify(res));
  assert.ok(res.some((f) => f.text === 'У скидки на долю 25% не назван источник — укажите справочник (с номером таблицы) или исследование рынка, откуда она взята'));
  // Таблица не заполнена вовсе — пропуски (по строкам таблицы) и «скидки нет», без арифметики.
  res = run(cells(shareTable('realty', MARKET)));
  assert.equal(res.length, 2, JSON.stringify(res));
  assert.match(res[0].text, /пропуски «\[заполнить\]» \(4\)/);
  assert.match(res[1].text, /скидки на долю в отчёте не найдено/);
  // Текстом (PDF): скидки нет вовсе.
  res = run(['Рыночная стоимость объекта в целом составляет 6 000 000 руб.', 'Рыночная стоимость доли 1/3 составляет 2 000 000 руб.']);
  assert.equal(res.length, 1, JSON.stringify(res));
  assert.match(res[0].text, /^По заявке оценивается рыночная стоимость доли 1\/3, а скидки на долю в отчёте не найдено/);
  // Текстом со скидкой и источником — молчим.
  assert.deepEqual(run(['Рыночная стоимость объекта в целом составляет 6 000 000 руб.',
    'Скидка на долю принята 25% по данным справочника оценщика недвижимости (Лейфер Л. А., 2025, табл. 12).',
    'Рыночная стоимость доли 1/3 составляет 1 500 000 руб.']), []);
  // Дата рядом с названием — не сумма.
  assert.deepEqual(run(['Рыночная стоимость объекта в целом по состоянию на 01.10.2025 составляет 6 000 000 руб.',
    'Скидка на долю — 25% (справочник Лейфера, табл. 12).',
    'Рыночная стоимость доли по состоянию на 01.10.2025 составляет 1 500 000 рублей.']), []);
  // Расчёта нет совсем.
  res = run(['Итоговая рыночная стоимость составляет 1 500 000 руб.'.replace('Итоговая рыночная стоимость', 'Итог')]);
  assert.equal(res.length, 1);
  assert.match(res[0].text, /^В отчёте не найден расчёт стоимости доли 1\/3/);
});

test('часть стоимости целого: скидки быть не должно; способ не указан; не доля — молчим', () => {
  assert.deepEqual(run(cells(filled(PRO, ['8 000 000', '4 000 000', '4 000 000'])), PRO), []);
  let res = run(['Стоимость объекта целиком: 8 000 000 руб.', 'Скидка на долю: 20%, справочник Лейфера', 'Стоимость доли: 3 200 000 руб.'], PRO);
  assert.equal(res.length, 2, JSON.stringify(res));
  assert.equal(res[0].text, 'По заявке оценивается часть стоимости всего объекта (целое × 1/2) без скидки, а в отчёте скидка на долю 20% — уберите скидку или сверьте способ с определением суда (заданием на оценку)');
  assert.match(res[1].text, /^Стоимость доли 3 200 000 руб\. не сходится с расчётом: 8 000 000 × 1\/2 = 4 000 000 руб\./);
  // Способ не указан: со скидкой или без — арифметика по тому, что в отчёте.
  const ask = { object_type: 'share', share_size: '1/2' };
  assert.deepEqual(run(['Стоимость объекта целиком: 8 000 000 руб.', 'Скидка на долю: 20%, справочник Лейфера', 'Стоимость доли: 3 200 000 руб.'], ask), []);
  assert.deepEqual(run(['Стоимость объекта целиком: 8 000 000 руб.', 'Стоимость доли: 4 000 000 руб.'], ask), []);
  assert.equal(run(['Стоимость объекта целиком: 8 000 000 руб.', 'Стоимость доли: 3 000 000 руб.'], ask).length, 1);
  // Не доля, размер не дробью, не оценка недвижимости — молчим.
  assert.deepEqual(run([], { ...MARKET, object_type: 'flat' }), []);
  assert.deepEqual(run([], { ...MARKET, share_size: 'половина' }), []);
  assert.deepEqual(run([], MARKET, { service: 'vehicle' }), []);
  // Пункт проверки — у оценки недвижимости и только для доли.
  const reg = createRegistry();
  assert.ok(reg.checks('expertise', 'realty', MARKET).some((c) => (c.auto ?? []).includes('share_value')));
  assert.equal(reg.checks('expertise', 'realty', { object_type: 'flat' }).some((c) => (c.auto ?? []).includes('share_value')), false);
  assert.equal((reg.checks('expertise', 'vehicle') ?? []).some((c) => (c.auto ?? []).includes('share_value')), false);
});

let S, owner, dispatcher, spec;
const BASE = { purpose: 'division', region: 'moscow', object_type: 'share', address: 'г. Москва, Тестовая ул., д. 1, кв. 3', area: 54, share_size: '1/3', share_method: 'market' };
before(async () => {
  S = await startApp({ AUTH_RATE_MAX: '60' });
  owner = await login(S, '+79990005421');
  dispatcher = await login(S, '+79990005422');
  spec = await login(S, '+79990005423');
  await setPlatformRole(S.sql, dispatcher.user.id, 'dispatcher');
  await makeSpecialist(S.sql, spec.user.id, { permits: [['expertise', 'realty']] });
});
after(async () => { await S?.close(); });

test('Word из черновика: неверная стоимость доли — находка в ИИ-проверке дела', async () => {
  const o = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Доля: проверка' })).body.order;
  assert.equal((await owner.req('PATCH', `/api/orders/${o.id}`, { deadline: addDays(todayMsk(), 10), fields: BASE })).status, 200);
  assert.equal((await owner.req('POST', `/api/orders/${o.id}/status`, { from: 'new', to: 'matching' })).status, 200);
  await ensurePaid(S.sql, o.id);
  assert.equal((await dispatcher.req('POST', `/api/orders/${o.id}/offer`, { specialist_id: spec.user.id, from: 'matching' })).status, 200);
  const [cur] = await S.sql`select status from orders where id = ${o.id}`;
  assert.equal((await spec.req('POST', `/api/orders/${o.id}/status`, { from: cur.status, to: 'in_work' })).status, 200);
  const d = (await spec.req('POST', `/api/orders/${o.id}/draft/ai`, {})).body.draft;
  const t = shareTable('realty', BASE);
  const vals = ['6 000 000', '2 000 000', '25', 'справочник Лейфера 2025, табл. 12', '1 700 000'];
  let i = 0;
  const mine = t.map((r) => r.replace(/\[заполнить\]/g, () => vals[i++]));
  const body = d.body.replace(t.join('\n'), mine.join('\n')).replace(/\[(?:заполнить|описать)[^\]]*\]/g, 'текст');
  assert.ok(body.includes('| Рыночная стоимость доли (часть × (1 − скидка)), руб. | 1 700 000 |'));
  assert.equal((await spec.req('PUT', `/api/orders/${o.id}/draft`, { body, from: d.id })).status, 200);
  const w = await fetch(`${S.base}/api/orders/${o.id}/draft/docx`, { headers: { cookie: spec.cookie } });
  assert.equal(w.status, 200);
  const buf = Buffer.from(await w.arrayBuffer());
  const pages = (await extractPages(buf, 'r.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).pages;
  const res = runAutoChecks(['share_value'], [{ name: 'Отчёт.docx', kind: 'docx', pages }], { service: 'realty', fields: BASE }).share_value;
  assert.equal(res.length, 1, JSON.stringify(res));
  assert.match(res[0].text, /^Стоимость доли 1 700 000 руб\. не сходится с расчётом: 2 000 000 × \(1 − 25%\) = 1 500 000 руб\./);
});
