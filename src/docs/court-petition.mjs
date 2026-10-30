// Ходатайство эксперта к заседанию (2.445): эксперт не сможет прийти — просит рассмотреть дело без его участия или отложить
// заседание; причина — его словами. Эксперт подписывает и отдаёт в суд сам; платформа ничего в суд не отправляет.
import { orderRef } from '../notify/registry.mjs';
import { todayMsk } from '../orders/workflow.mjs';
import { buildSimpleDoc } from './docx.mjs';

const ru = (d) => String(d).slice(0, 10).split('-').reverse().join('.');
const whenMsk = (t) => new Date(t).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export const ABSENCE = {
  without: { name: 'рассмотреть без участия эксперта', title: 'Ходатайство о рассмотрении дела без участия эксперта' },
  postpone: { name: 'отложить заседание', title: 'Ходатайство об отложении судебного заседания' },
};

// call — вызов с ходатайством (absence_kind, absence_reason); explained — готовы ли письменные пояснения (2.444).
export function courtPetitionData({ order, call, executor, explained }) {
  return {
    ref: orderRef(order.id),
    number: order.report_number ?? null,
    court: call.court,
    case_no: call.case_no,
    hearing: whenMsk(call.hearing_at),
    kind: call.absence_kind,
    reason: /[.!?…]$/.test(call.absence_reason) ? call.absence_reason : `${call.absence_reason}.`,
    executor: executor || null,
    explained: !!explained,
  };
}

export function courtPetitionBlocks(a) {
  const no = a.number ? ` № ${a.number}` : '';
  const report = `отчёта об оценке${no}`;
  const toReport = `отчёту об оценке${no}`;
  const ask = a.kind === 'without'
    ? [`Прошу рассмотреть дело № ${a.case_no} в заседании ${a.hearing} без моего участия.`,
       a.explained ? `Письменные пояснения к ${toReport} по вопросам суда прилагаю.`
         : `Выводы ${report} поддерживаю; ответы на вопросы суда могу дать письменно.`]
    : [`Прошу отложить судебное заседание по делу № ${a.case_no}, назначенное на ${a.hearing}, и известить меня о новой дате.`];
  return [
    { type: 'para', text: `В ${a.court}` },
    { type: 'para', text: `по делу № ${a.case_no}` },
    { type: 'para', text: `от эксперта ${a.executor ?? '____________________'}, составившего ${report}` },
    { type: 'bold', text: ABSENCE[a.kind].title },
    { type: 'para', text: `Мне направлен вызов в судебное заседание ${a.hearing} для пояснений к ${toReport}. Явиться не смогу: ${a.reason}` },
    ...ask.map((text) => ({ type: 'para', text })),
    { type: 'para', text: `Дата: ${ru(todayMsk())}` },
    { type: 'sign', text: `Эксперт ____________________ / ${a.executor ?? '____________________'} /` },
  ];
}

export function courtPetitionDoc(a) {
  const blocks = [{ type: 'title', text: `${ABSENCE[a.kind].title} · дело ${a.ref}` }, ...courtPetitionBlocks(a)];
  const caseNo = a.case_no.replace(/[\\/:*?"<>|]+/g, '-');
  return { buf: buildSimpleDoc(blocks), filename: `Ходатайство ${caseNo}.docx` };
}
