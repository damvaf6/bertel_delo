// «Пояснения эксперта к отчёту» для суда (2.444): Word из вопросов суда по вызову на заседание (2.441) — вопрос, пояснение
// эксперта и где в отчёте. Эксперт берёт его на заседание или отдаёт в суд письменно — без набора вручную.
import { orderRef } from '../notify/registry.mjs';
import { todayMsk } from '../orders/workflow.mjs';
import { buildSimpleDoc } from './docx.mjs';

const ru = (d) => String(d).slice(0, 10).split('-').reverse().join('.');
const whenMsk = (t) => new Date(t).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

// call — вызов (суд, номер дела, заседание); items — вопросы с пояснениями; number — номер отчёта дела (2.412) или null.
export function courtExplainData({ order, call, service, executor, items }) {
  return {
    ref: orderRef(order.id),
    number: order.report_number ?? null,
    service,
    court: call.court,
    case_no: call.case_no,
    hearing: whenMsk(call.hearing_at),
    executor: executor || null,
    rows: items.map((i, n) => ({ no: n + 1, text: i.text, answer: i.answer, place: i.place || '' })),
  };
}

export function courtExplainBlocks(a) {
  return [
    { type: 'para', text: `В ${a.court}` },
    { type: 'para', text: `по делу № ${a.case_no}` },
    { type: 'table', rows: [
      ['Отчёт об оценке', a.number ? `№ ${a.number}` : 'без номера'],
      ['Услуга', a.service],
      ['Заседание', a.hearing],
      ['Эксперт', a.executor ?? '—'],
      ['Вопросов', String(a.rows.length)],
    ] },
    { type: 'bold', text: 'Пояснения по вопросам суда' },
    { type: 'table', rows: [['№', 'Вопрос', 'Пояснение эксперта', 'Где в отчёте'],
      ...a.rows.map((r) => [String(r.no), r.text, r.answer, r.place || '—'])] },
    { type: 'para', text: `Пояснения составлены ${ru(todayMsk())}.` },
    { type: 'sign', text: `Эксперт ____________________ / ${a.executor ?? '____________________'} /` },
  ];
}

export function courtExplainDoc(a) {
  const to = a.number ? `к отчёту № ${a.number}` : 'к отчёту';
  const blocks = [{ type: 'title', text: `Пояснения эксперта ${to} · дело ${a.ref}` }, ...courtExplainBlocks(a)];
  const caseNo = a.case_no.replace(/[\\/:*?"<>|]+/g, '-');
  return { buf: buildSimpleDoc(blocks), filename: `Пояснения для суда ${caseNo}.docx` };
}
