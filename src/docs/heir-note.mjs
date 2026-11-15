// «Справка для нотариуса» (2.507): короткая выписка из отчёта об оценке для наследства — объект, дата открытия наследства и
// дата оценки, рыночная стоимость цифрами и прописью, номер и дата отчёта, оценщик. Заказчик скачивает её после выдачи вместе
// с отчётом и несёт нотариусу; стоимость и номер — из самого файла отчёта (reportFacts, heirValues), а не со слов заявки.
// Справка отчёт не заменяет: при расхождении верен отчёт.
import { orderRef } from '../notify/registry.mjs';
import { numberToWords } from '../ai/report-checks.mjs';
import { todayMsk } from '../orders/workflow.mjs';
import { buildSimpleDoc } from './docx.mjs';

const ru = (iso) => String(iso).slice(0, 10).split('-').reverse().join('.');
const fmt = (n) => Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ');
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const PLURAL = (n) => { const a = n % 100; const b = n % 10; return a >= 11 && a <= 14 ? 'рублей' : b === 1 ? 'рубль' : b >= 2 && b <= 4 ? 'рубля' : 'рублей'; };

// «1 234 567 (Один миллион двести тридцать четыре тысячи пятьсот шестьдесят семь) рублей»
export function rubText(value) {
  const r = Math.floor(value);
  const w = numberToWords(r);
  return `${fmt(r)} (${cap(w ?? '')}) ${PLURAL(r)}`.replace(' () ', ' ');
}

// facts — { number, made_on, value_rub, value_name } из файла отчёта; heir — heirValues или null; valueDay — ДД.ММ.ГГГГ.
export function heirNoteData({ order, service, object, facts, heir, valueDay, executor, org }) {
  return {
    ref: orderRef(order.id),
    service,
    object,
    number: facts.number ?? order.report_number ?? null,
    made_on: facts.made_on ?? null,
    value_rub: facts.value_rub,
    value_name: facts.value_name || 'Рыночная стоимость',
    death_day: String(order.fields?.death_date ?? '').trim() || null,
    value_day: valueDay ?? null,
    notary: String(order.fields?.notary ?? '').trim() || null,
    executor: executor || null,
    org: org || null,
    heir: heir ?? null,
  };
}

export function heirNoteBlocks(a) {
  const report = [a.number ? `№ ${a.number}` : 'без номера', a.made_on ? `от ${ru(a.made_on)}` : null].filter(Boolean).join(' ');
  const rows = [
    ['Отчёт об оценке', report],
    ['Вид оценки', a.service],
    ['Объект оценки', a.heir ? a.heir.rows.map((r, i) => `${i + 1}) ${r.name}`).join('; ') : a.object],
    ['Цель оценки', 'Для нотариуса — наследство'],
    ...(a.notary ? [['Нотариус, наследственное дело', a.notary]] : []),
    ...(a.death_day ? [['Дата открытия наследства', a.death_day]] : []),
    ['Дата оценки', a.value_day ?? 'указана в отчёте'],
    ['Вид стоимости', 'Рыночная'],
  ];
  const sum = a.heir
    ? [{ type: 'bold', text: 'Рыночная стоимость по объектам' },
      { type: 'table', rows: [['№', 'Объект', 'Рыночная стоимость'],
        ...a.heir.rows.map((r, i) => [String(i + 1), r.name, r.value_rub != null ? rubText(r.value_rub) : 'указана в отчёте']),
        ...(a.heir.total != null ? [['', 'Общая рыночная стоимость', rubText(a.heir.total)]] : [])] }]
    : [{ type: 'bold', text: `${a.value_name}: ${rubText(a.value_rub)}` }];
  return [
    { type: 'table', rows },
    ...sum,
    { type: 'para', text: 'Справка составлена по отчёту об оценке и не заменяет его. При расхождении верны сведения отчёта.' },
    { type: 'table', rows: [
      ['Оценщик', a.executor ?? '—'],
      ...(a.org ? [['Организация', a.org]] : []),
    ] },
    { type: 'para', text: `Справка составлена ${ru(todayMsk())}.` },
    { type: 'sign', text: `Оценщик ____________________ / ${a.executor ?? '____________________'} /` },
  ];
}

export function heirNoteDoc(a) {
  const blocks = [{ type: 'title', text: `Справка об оценке для нотариуса · дело ${a.ref}` }, ...heirNoteBlocks(a)];
  const no = a.number ? ` ${String(a.number).replace(/[\\/:*?"<>|]+/g, '-')}` : '';
  return { buf: buildSimpleDoc(blocks), filename: `Справка для нотариуса${no}.docx` };
}
