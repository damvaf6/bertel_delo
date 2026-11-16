// Прогон 2.518 (пачка «Оценка доли и раздел имущества»): в отчёте об оценке доли есть и стоимость всей квартиры («стоимость
// объекта целиком»), и стоимость доли. В «Перечень отчётов для СРО» и «Справку для нотариуса» идёт стоимость доли — объект
// оценки; ИИ-проверка «несколько объектов наследства» сверяет общую сумму со стоимостью доли, а не всей квартиры.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heirValues, reportFacts, runAutoChecks, shareCase } from '../../src/ai/report-checks.mjs';

const today = '2026-11-16';
const SHARE = { object_type: 'share', share_size: '1/3', share_method: 'market' };
const head = ['ОТЧЁТ ОБ ОЦЕНКЕ № 12/2026 от 10.11.2026', 'Объект оценки: 1/3 доли в праве на квартиру',
  'Итоговая величина рыночной стоимости квартиры в целом составляет 9 000 000 руб.'];
const calc = ['14. Согласование результатов', '| Расчёт стоимости доли | Значение |', '| Стоимость объекта целиком, руб. | 9 000 000 |',
  '| Размер доли | 1/3 |', '| Часть стоимости объекта (целое × 1/3), руб. | 3 000 000 |',
  '| Скидка на долю, % | 15 (источник — справочник Лейфера) |',
  '| Рыночная стоимость доли (часть × (1 − скидка)), руб. | 2 550 000 |',
  'Выводы: рыночная стоимость 1/3 доли в праве на квартиру составляет 2 550 000 руб.'];
const doc = (more = []) => ({ name: 'Отчёт.docx', kind: 'docx', pages: [head.join('\n'), [...calc, ...more].join('\n')] });

test('прогон 2.518: оценка доли — в перечень и справку стоимость доли, а не всей квартиры', () => {
  assert.equal(shareCase('realty', SHARE), true);
  assert.equal(shareCase('realty', { object_type: 'flat' }), false);
  assert.equal(shareCase('vehicle', SHARE), false);
  const share = reportFacts([doc()], { share: true });
  assert.equal(share.value_rub, 2550000);
  assert.equal(share.value_name, 'Стоимость доли');
  assert.equal(share.number, '12/2026');
  // Не доля — как раньше: итоговая рыночная стоимость.
  assert.equal(reportFacts([doc()]).value_rub, 9000000);
  // Доля, а стоимости доли в отчёте не нашлось — итоговая, как раньше.
  const whole = { name: 'Отчёт.docx', kind: 'docx', pages: [head.join('\n')] };
  assert.equal(reportFacts([whole], { share: true }).value_rub, 9000000);
});

test('прогон 2.518: наследство с долей и гаражом — стоимость доли в справке и сверка общей суммы', () => {
  const fields = { ...SHARE, purpose: 'inheritance', death_date: '03.06.2026', heir_objects: 'Гараж № 5 в ГСК «Восход»', heir_total: 'total' };
  const garage = 'Рыночная стоимость гаража № 5 в ГСК «Восход» — 400 000 руб.';
  const ok = doc([garage, 'Общая рыночная стоимость наследственного имущества — 2 950 000 руб.']);
  const v = heirValues([ok], 'realty', fields);
  assert.deepEqual(v.rows.map((r) => r.value_rub), [2550000, 400000]);
  assert.equal(v.total, 2950000);
  const run = (d) => runAutoChecks(['heir_objects'], [d], { service: 'realty', fields, today }).heir_objects;
  assert.deepEqual(run(ok), [], 'доля + гараж = общая — без находок');
  const bad = run(doc([garage, 'Общая рыночная стоимость наследственного имущества — 9 400 000 руб.']));
  assert.equal(bad.length, 1, 'общая посчитана от всей квартиры — находка');
  assert.match(bad[0].text, /не равна сумме по объектам 2 950 000 руб\./);
});
