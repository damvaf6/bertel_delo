// Извещение об осмотре (2.470): образец Word — кому, когда и где осмотр, автомобиль и ДТП из заявки (поля — notice.fields
// в модуле). Эксперт подписывает и отправляет сам (телеграммой, письмом, почтой); платформа ничего не отправляет.
import { orderRef } from '../notify/registry.mjs';
import { todayMsk } from '../orders/workflow.mjs';
import { whenRu } from '../orders/notices.mjs';
import { buildSimpleDoc } from './docx.mjs';

const ruDate = (d) => String(d).slice(0, 10).split('-').reverse().join('.');

// spec — registry.notice(…), def — registry.service(…), n — строка inspection_notices.
export function noticeData({ order, def, spec, n, executor }) {
  const rows = spec.fields.map((id) => def.fields.find((f) => f.id === id)).filter(Boolean)
    .filter((f) => order.fields?.[f.id] !== undefined && order.fields[f.id] !== '')
    .map((f) => {
      const v = order.fields[f.id];
      return [f.label, f.type === 'select' ? f.options.find((o) => o.id === v)?.name ?? String(v) : String(v)];
    });
  return {
    ref: orderRef(order.id),
    party: spec.parties.find((p) => p.id === n.party)?.name ?? n.party,
    name: n.name,
    when: whenRu(n.inspect_at),
    place: n.place,
    purpose: spec.purpose,
    rows,
    executor: executor || null,
  };
}

export function noticeBlocks(a) {
  return [
    { type: 'para', text: `Кому: ${a.name} (${a.party[0].toLowerCase()}${a.party.slice(1)})` },
    { type: 'para', text: `От эксперта ${a.executor ?? '____________________'}` },
    { type: 'bold', text: 'Извещение об осмотре' },
    { type: 'para', text: `Сообщаю, что ${a.when} по адресу: ${a.place.replace(/[.;]+$/, '')} — состоится ${a.purpose}.` },
    ...(a.rows.length ? [{ type: 'para', text: 'Сведения из заявки:' }, { type: 'table', rows: [['Что', 'Значение'], ...a.rows] }] : []),
    { type: 'para', text: 'Приглашаю Вас (Вашего представителя с доверенностью) принять участие в осмотре. При неявке осмотр будет проведён без Вашего участия.' },
    { type: 'para', text: 'Телефон для связи: ____________________' },
    { type: 'para', text: `Дата: ${ruDate(todayMsk())}` },
    { type: 'sign', text: `Эксперт ____________________ / ${a.executor ?? '____________________'} /` },
  ];
}

export function noticeDoc(a) {
  const blocks = [{ type: 'title', text: `Извещение об осмотре · дело ${a.ref}` }, ...noticeBlocks(a)];
  const who = a.name.replace(/[\\/:*?"<>|«»]+/g, '').trim().slice(0, 60) || a.party;
  return { buf: buildSimpleDoc(blocks), filename: `Извещение об осмотре — ${who}.docx` };
}
