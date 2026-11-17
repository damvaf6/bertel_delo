// Задача 2.524 (нежилое помещение): ИИ-проверка premises_basis — у итоговой стоимости сказано, с НДС или без; аренда — как в
// заявке (сдаётся — названа, не сдаётся — нет «сдано в аренду» и договора аренды). Назначение — `use_match` (уже было).
// Без сервера — только правило и описание модуля.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../../src/modules/index.mjs';
import { runAutoChecks, AUTO_CHECKS } from '../../src/ai/report-checks.mjs';

const COM = { object_type: 'commercial', area: 120, premises_use: 'office' };
const doc = (lines) => ({ name: 'Отчёт.pdf', kind: 'pdf', pages: [['ОТЧЁТ ОБ ОЦЕНКЕ № 32', 'Объект оценки: нежилое помещение, назначение: нежилое', ...lines].join('\n')] });
const run = (lines, fields = COM) => runAutoChecks(['premises_basis'], [doc(lines)], { service: 'realty', fields }).premises_basis;
const VAT = 'Итоговая рыночная стоимость объекта оценки: 16 000 000 руб. (без учёта НДС)';
const NO_VAT = 'Итоговая рыночная стоимость объекта оценки: 16 000 000 руб.';

test('НДС: сказано у стоимости — молчим; не сказано или только у ставки аренды и аналогов — находка', () => {
  assert.ok(AUTO_CHECKS.premises_basis, 'правило описано');
  assert.deepEqual(run([VAT]), []);
  assert.deepEqual(run([NO_VAT, 'Стоимость включает НДС 20%.']), []);
  assert.deepEqual(run([NO_VAT, 'Выводы: операция не облагается НДС.']), []);
  let res = run([NO_VAT]);
  assert.equal(res.length, 1, JSON.stringify(res));
  assert.match(res[0].text, /^Не сказано, с НДС или без НДС итоговая стоимость нежилого помещения/);
  assert.equal(res[0].quote, NO_VAT);
  res = run([NO_VAT, 'Ставка аренды аналогов — без НДС, 18 000 руб. за кв. м в год', 'Цена аналога 2 включает НДС']);
  assert.equal(res.length, 1, 'НДС у ставки и аналогов — не в счёт');
  // Не нежилое и не оценка недвижимости — молчим.
  assert.deepEqual(run([NO_VAT], { object_type: 'flat' }), []);
  assert.deepEqual(runAutoChecks(['premises_basis'], [doc([NO_VAT])], { service: 'vehicle', fields: COM }).premises_basis, []);
});

test('аренда как в заявке: сдаётся — названа; сказано «не сдаётся» или ни слова — находка', () => {
  const lease = { ...COM, lease: 'full', lease_rent: 300000 };
  assert.deepEqual(run([VAT, 'Помещение сдано в аренду по договору аренды № 7 от 01.02.2026, арендатор — ООО «Пример»'], lease), []);
  assert.deepEqual(run([VAT, 'Обременения: аренда в пользу ООО «Пример» до 2028 г.'], lease), []);
  assert.deepEqual(run([VAT, 'Арендная плата по договору: 300 000 руб. в месяц'], lease), []);
  let res = run([VAT, 'Обременения: не зарегистрированы'], lease);
  assert.equal(res.length, 1, JSON.stringify(res));
  assert.equal(res[0].text, 'В заявке помещение сдаётся целиком, арендная плата 300 000 руб. в месяц, а в отчёте об аренде ни слова — назовите аренду в описании объекта и обременениях (арендатор, срок, плата по договору)');
  assert.equal(res[0].quote, 'Обременения: не зарегистрированы');
  assert.equal(run([VAT, 'Помещение в аренду не сдаётся.'], lease).length, 1);
  res = run([VAT, 'На дату оценки помещение не сдаётся в аренду.'], { ...COM, lease: 'part' });
  assert.equal(res.length, 1, JSON.stringify(res));
  assert.match(res[0].text, /^В заявке помещение сдаётся частично, а в отчёте сказано, что аренды нет/);
  // Рыночная ставка аренды и «может быть сдано» — не про сам договор.
  res = run([VAT, 'Рыночная ставка аренды: 18 000 руб. за кв. м в год', 'Помещение может быть сдано в аренду'], lease);
  assert.equal(res.length, 1, 'не названа');
});

test('не сдаётся по заявке: договор аренды в отчёте — находка; «не сдаётся» и ставка по аналогам — молчим; пункт только у нежилого', () => {
  const free = { ...COM, lease: 'no' };
  assert.deepEqual(run([VAT, 'Помещение в аренду не сдаётся.', 'Рыночная ставка аренды по аналогам: 18 000 руб.', 'Помещение может быть сдано в аренду'], free), []);
  const res = run([VAT, 'Помещение передано в аренду по договору аренды № 12 от 01.03.2025'], free);
  assert.equal(res.length, 1, JSON.stringify(res));
  assert.match(res[0].text, /^В заявке помещение не сдаётся, а в отчёте — аренда/);
  // Не указано в заявке — про аренду молчим.
  assert.deepEqual(run([VAT, 'Помещение передано в аренду по договору аренды № 12 от 01.03.2025']), []);
  const reg = createRegistry();
  assert.ok(reg.checks('expertise', 'realty', COM).some((c) => (c.auto ?? []).includes('premises_basis')));
  assert.equal(reg.checks('expertise', 'realty', { object_type: 'flat' }).some((c) => (c.auto ?? []).includes('premises_basis')), false);
});
