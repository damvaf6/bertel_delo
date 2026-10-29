// «Ответ на замечания» (2.433): Word из пунктов замечаний (2.432) — пункт замечания банка или суда, что сделано («исправлено
// в отчёте» или «пояснение без правки» и пояснение эксперта) и где в отчёте. Эксперт прикладывает его к исправленному отчёту
// файлом результата — банку и суду больше не нужно отдельное письмо, набранное вручную.
import { orderRef } from '../notify/registry.mjs';
import { todayMsk } from '../orders/workflow.mjs';
import { buildSimpleDoc } from './docx.mjs';

const ru = (d) => String(d).slice(0, 10).split('-').reverse().join('.');
const dayMsk = (t) => new Date(t).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric' });
const DONE = { fixed: 'Исправлено в отчёте', explained: 'Пояснение без правки' };

// Сведения ответа. items — пункты круга замечаний (все с отметкой); number — номер отчёта дела (2.412) или null.
export function remarksAnswerData({ order, service, executor, items }) {
  return {
    ref: orderRef(order.id),
    number: order.report_number ?? null,
    service,
    round: order.remarks_round,
    at: dayMsk(order.remarks_at),
    executor: executor || null,
    fixed: items.filter((i) => i.resolution === 'fixed').length,
    rows: items.map((i, n) => ({ no: n + 1, text: i.text, done: DONE[i.resolution], note: i.note || '', place: i.place || '' })),
  };
}

export function remarksAnswerBlocks(a) {
  return [
    { type: 'table', rows: [
      ['Отчёт', a.number ? `№ ${a.number}` : 'без номера'],
      ['Услуга', a.service],
      ['Замечания получены', a.round > 1 ? `${a.at} (${a.round}-й раз)` : a.at],
      ['Эксперт', a.executor ?? '—'],
      ['Пунктов замечаний', `${a.rows.length}, исправлено в отчёте — ${a.fixed}, пояснений без правки — ${a.rows.length - a.fixed}`],
    ] },
    { type: 'bold', text: 'Ответ по пунктам' },
    { type: 'table', rows: [['№', 'Замечание', 'Что сделано', 'Где в отчёте'],
      ...a.rows.map((r) => [String(r.no), r.text, r.note ? `${r.done}. ${r.note}` : r.done, r.place || '—'])] },
    { type: 'para', text: a.fixed ? 'Исправленный отчёт прилагается.' : 'Отчёт не изменялся — даны пояснения по пунктам замечаний.' },
    { type: 'para', text: `Ответ составлен ${ru(todayMsk())}.` },
    { type: 'sign', text: `Эксперт ____________________ / ${a.executor ?? '____________________'} /` },
  ];
}

export function remarksAnswerDoc(a) {
  const to = a.number ? `к отчёту № ${a.number}` : 'к отчёту';
  const blocks = [{ type: 'title', text: `Ответ на замечания ${to} · дело ${a.ref}` }, ...remarksAnswerBlocks(a)];
  const ref = a.ref.replace(/^№\s*/, '');
  return { buf: buildSimpleDoc(blocks), filename: `Ответ на замечания ${ref}${a.round > 1 ? ` (${a.round})` : ''}.docx` };
}
