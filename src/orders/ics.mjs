// «Мои сроки на две недели» файлом для календаря телефона (2.122): сроки своих дел — событием на весь день с напоминанием
// накануне в 9:00, выезды помощника и свои выезды помощником — на час с напоминанием за час. Как в нагрузке руководителя,
// без заказчика, названий заявок и адресов: услуга и номер дела (свой выезд по чужому делу — без номера). Просроченное,
// ссылки на осмотр, просьбы о переносе и заметки в файл не идут — они в кабинете. UID у события постоянный: календарь,
// который понимает обновление, при повторной загрузке файла заменит событие, а не добавит второе.
import { addDays } from './workflow.mjs';
import { orderRef } from '../notify/registry.mjs';

const DOMAIN = 'bertel-delo';
const VISIT_MINUTES = 60;

// Текст по RFC 5545: обратная косая, точка с запятой, запятая и перевод строки — экранируются.
export const icsText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Строка длиннее 75 байт переносится: CRLF и пробел; по границе символа, не посреди буквы UTF-8.
export function icsFold(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dateOnly = (iso) => iso.replace(/-/g, '');

function event(lines, { uid, now, start, end, summary, description, alarm, busy = false }) {
  lines.push('BEGIN:VEVENT', `UID:${uid}@${DOMAIN}`, `DTSTAMP:${stamp(now)}`, start, end, `SUMMARY:${icsText(summary)}`);
  if (description) lines.push(`DESCRIPTION:${icsText(description)}`);
  // Срок — пометка на весь день, время не занимает; выезд — занятый час.
  lines.push(`TRANSP:${busy ? 'OPAQUE' : 'TRANSPARENT'}`);
  if (alarm) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(summary)}`, `TRIGGER:${alarm}`, 'END:VALARM');
  lines.push('END:VEVENT');
}

const DEADLINE_NOTE = {
  in_work: 'Срок сдачи',
  review: 'Срок сдачи (сдано, ждёт проверки)',
  awaiting_executor: 'Срок сдачи (дело предложено Вам, ещё не приняли)',
};

export function scheduleIcs(schedule, now = new Date()) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//БЕРТЕЛ Дело//Мои сроки//RU`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText('БЕРТЕЛ Дело — мои сроки')}`, 'X-WR-TIMEZONE:Europe/Moscow'];
  const about = 'Подробности — в кабинете БЕРТЕЛ Дело, раздел «Специалист» → «Мои сроки на две недели».';
  for (const d of schedule.days) {
    for (const i of d.items) {
      if (i.kind === 'deadline') {
        event(lines, {
          uid: `deadline-${i.order_id}`, now,
          start: `DTSTART;VALUE=DATE:${dateOnly(d.date)}`, end: `DTEND;VALUE=DATE:${dateOnly(addDays(d.date, 1))}`,
          summary: `${DEADLINE_NOTE[i.status] ?? 'Срок сдачи'}: дело ${orderRef(i.order_id)}, ${i.service}`,
          description: about,
          // Накануне в 9:00 — от полуночи дня срока назад на 15 часов; дело уже на проверке — без напоминания.
          alarm: i.status === 'review' ? null : '-PT15H',
        });
      } else if (i.kind === 'visit' || i.kind === 'my_visit') {
        const start = new Date(i.at);
        const end = new Date(start.getTime() + VISIT_MINUTES * 60_000);
        event(lines, {
          uid: `visit-${i.visit_id}`, now,
          start: `DTSTART:${stamp(start)}`, end: `DTEND:${stamp(end)}`,
          summary: i.kind === 'visit' ? `Выезд помощника на объект: дело ${orderRef(i.order_id)}, ${i.service}`
            : `Мой выезд на объект: ${i.service}`,
          description: about, busy: true,
          alarm: '-PT1H',
        });
      }
    }
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(icsFold).join('\r\n')}\r\n`;
}
