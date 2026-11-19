// Задача 2.542 (квартира в новостройке, права по ДДУ): ИИ-проверка ddu_right — объект в отчёте — право требования, а не
// собственность; номер и дата ДДУ, проектная площадь — как в договоре из дела (без него — как в заявке); площадь названа
// проектной; срок передачи указан и тот же; кадастрового номера квартиры нет. Без сервера — правило и описание модуля.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../../src/modules/index.mjs';
import { runAutoChecks, AUTO_CHECKS, dduContractFacts } from '../../src/ai/report-checks.mjs';
import { dduTaskLine, dduAssumption } from '../../src/orders/ddu.mjs';

const DDU = {
  object_type: 'ddu', ddu_number: 'ЖК-12/3-145', ddu_date: '14.03.2025', ddu_developer: 'ООО «СЗ Тестовый»',
  ddu_complex: 'ЖК «Тестовый», корп. 3', ddu_unit: '145', ddu_area: 41.5, ddu_handover: '31.12.2027',
};
const doc = (lines) => ({ name: 'Отчёт.pdf', kind: 'pdf', pages: [['ОТЧЁТ ОБ ОЦЕНКЕ № 77', ...lines].join('\n')] });
const run = (lines, fields = DDU, ddu = []) => runAutoChecks(['ddu_right'], [doc(lines)], { service: 'realty', fields, ddu }).ddu_right;
const OK = [dduTaskLine('realty', DDU), dduAssumption('realty', DDU), 'Итоговая рыночная стоимость права требования: 9 800 000 руб.'];
const CONTRACT = { id: 'c1', name: 'ДДУ.pdf', pages: [[
  'ДОГОВОР УЧАСТИЯ В ДОЛЕВОМ СТРОИТЕЛЬСТВЕ № ЖК-12/3-146 от «15» марта 2025 г.',
  'Объект долевого строительства — квартира, условный номер 145, проектная общая площадь 42,3 кв. м.',
].join('\n')] };

test('строки из черновика (2.541) — молчим; правило описано и только у ДДУ', () => {
  assert.ok(AUTO_CHECKS.ddu_right, 'правило описано');
  assert.deepEqual(run(OK), []);
  for (const object_type of ['flat', 'house', undefined]) assert.deepEqual(run(['Объект оценки: квартира'], { ...DDU, object_type }), []);
  assert.deepEqual(runAutoChecks(['ddu_right'], [doc(['Объект оценки: квартира'])], { service: 'vehicle', fields: DDU }).ddu_right, []);
  const reg = createRegistry();
  assert.ok(reg.checks('expertise', 'realty', DDU).some((c) => (c.auto ?? []).includes('ddu_right')));
  assert.equal(reg.checks('expertise', 'realty', { object_type: 'flat' }).some((c) => (c.auto ?? []).includes('ddu_right')), false);
});

test('объект — квартира или собственность вместо права требования — находка', () => {
  const lines = ['Объект оценки: квартира, ДДУ № ЖК-12/3-145 от 14.03.2025, проектная площадь 41,5 кв. м, срок передачи — 31.12.2027'];
  let res = run(lines);
  assert.equal(res.length, 1, JSON.stringify(res));
  assert.match(res[0].text, /^Квартира в новостройке, а в отчёте не сказано «право требования»/);
  res = run([...OK, 'Оцениваемые права: право собственности']);
  assert.equal(res.length, 1, JSON.stringify(res));
  assert.match(res[0].text, /^В отчёте оцениваемое право — собственность/);
  assert.equal(res[0].quote, 'Оцениваемые права: право собственности');
});

test('номер, дата и проектная площадь — как в заявке; пропуски «[заполнить]» — находка', () => {
  const bad = OK.map((l) => l.replace('ЖК-12/3-145', 'ЖК-12/3-999').replace('14.03.2025', '15.03.2025').replace('41,5 кв. м', '45 кв. м'));
  const res = run(bad);
  assert.equal(res.length, 3, JSON.stringify(res));
  assert.equal(res[0].text, 'Номер ДДУ в отчёте ЖК-12/3-999, а в заявке — ЖК-12/3-145: проверьте, не номер ли это другого договора');
  assert.deepEqual(res[0].fix, { bad: 'ЖК-12/3-999', right: 'ЖК-12/3-145', from: 'в заявке' });
  assert.equal(res[1].text, 'Дата ДДУ в отчёте 15.03.2025, а в заявке — 14.03.2025');
  assert.equal(res[2].text, 'Проектная площадь в отчёте 45 кв. м, а в заявке — 41,5 кв. м');
  assert.deepEqual(res[2].fix, { bad: '45', right: '41,5', from: 'в заявке' });
  // Заготовка черновика без номера и даты.
  const gap = run([dduTaskLine('realty', { ...DDU, ddu_number: '', ddu_date: '' }), dduAssumption('realty', DDU)]);
  assert.equal(gap.length, 1, JSON.stringify(gap));
  assert.match(gap[0].text, /остались пропуски «\[заполнить\]»/);
  // Номера ДДУ нет вовсе.
  const none = run(['Объект оценки — право требования на квартиру в ЖК «Тестовый», проектная площадь 41,5 кв. м, срок передачи — 31.12.2027']);
  assert.equal(none.length, 1, JSON.stringify(none));
  assert.equal(none[0].text, 'В отчёте не указаны номер и дата договора участия в долевом строительстве — в заявке: № ЖК-12/3-145 от 14.03.2025; объект по ДДУ описывается по договору');
});

test('договор из дела важнее заявки: номер, дата словами и площадь', () => {
  assert.deepEqual(dduContractFacts([CONTRACT]), { name: 'ДДУ.pdf', num: 'ЖК-12/3-146', date: '15.03.2025', area: 42.3 });
  const res = run(OK, DDU, [CONTRACT]);
  assert.equal(res.length, 3, JSON.stringify(res));
  assert.equal(res[0].text, 'Номер ДДУ в отчёте ЖК-12/3-145, а в договоре из дела — ЖК-12/3-146: проверьте, не номер ли это другого договора');
  assert.deepEqual(res[0].fix, { bad: 'ЖК-12/3-145', right: 'ЖК-12/3-146', from: 'по договору из дела «ДДУ.pdf»' });
  assert.equal(res[1].text, 'Дата ДДУ в отчёте 14.03.2025, а в договоре из дела — 15.03.2025');
  assert.equal(res[2].text, 'Проектная площадь в отчёте 41,5 кв. м, а в договоре из дела — 42,3 кв. м');
  const fixed = OK.map((l) => l.replace('ЖК-12/3-145', 'ЖК-12/3-146').replace('14.03.2025', '«15» марта 2025').replace('41,5 кв. м', '42,3 кв. м'));
  assert.deepEqual(run(fixed, DDU, [CONTRACT]), []);
});

test('площадь не названа проектной, срок передачи не указан или другой, кадастровый номер квартиры — находки', () => {
  let res = run(['Объект оценки — право требования по ДДУ № ЖК-12/3-145 от 14.03.2025, срок передачи по договору — 31.12.2027', 'Общая площадь квартиры: 41,5 кв. м']);
  assert.equal(res.length, 1, JSON.stringify(res));
  assert.match(res[0].text, /^В отчёте площадь квартиры не названа проектной: у квартиры по ДДУ площадь — по договору \(41,5 кв\. м\)/);
  res = run(['Объект оценки — право требования по ДДУ № ЖК-12/3-145 от 14.03.2025, проектная площадь 41,5 кв. м']);
  assert.equal(res.length, 1, JSON.stringify(res));
  assert.equal(res[0].text, 'В отчёте не указан срок передачи квартиры по договору (в заявке — 31.12.2027): от него зависит стоимость права требования — впишите его в описание объекта');
  res = run(OK.map((l) => l.replace('31.12.2027', '30.06.2027')));
  assert.equal(res.length, 1, JSON.stringify(res));
  assert.equal(res[0].text, 'Срок передачи квартиры в отчёте 30.06.2027, а в заявке — 31.12.2027: проверьте по договору');
  assert.deepEqual(res[0].fix, { bad: '30.06.2027', right: '31.12.2027', from: 'в заявке' });
  // Срок кварталом в заявке — сам срок не сравниваем, лишь бы был.
  assert.deepEqual(run(OK.map((l) => l.replace('31.12.2027', 'IV квартал 2027')), { ...DDU, ddu_handover: 'IV квартал 2027' }), []);
  res = run([...OK, 'Кадастровый номер квартиры: 77:01:0001001:1234']);
  assert.equal(res.length, 1, JSON.stringify(res));
  assert.match(res[0].text, /^В отчёте у квартиры кадастровый номер 77:01:0001001:1234, а у квартиры по ДДУ его ещё нет/);
  // Номер участка под строительство и аналогов — не трогаем.
  assert.deepEqual(run([...OK, 'Дом строится на земельном участке с кадастровым номером 77:01:0001001:50', 'Аналог 2: квартира, кадастровый номер 77:01:0001001:777']), []);
});
