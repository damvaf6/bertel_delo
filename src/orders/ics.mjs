// «Мои сроки на две недели» файлом для календаря телефона (2.122): сроки своих дел — событием на весь день с напоминанием
// накануне в 9:00, выезды помощника и свои выезды помощником — на час с напоминанием за час. Как в нагрузке руководителя,
// без заказчика, названий заявок и адресов: услуга и номер дела (свой выезд по чужому делу — без номера). Просроченное,
// ссылки на осмотр, просьбы о переносе и заметки в файл не идут — они в кабинете. UID у события постоянный: календарь,
// который понимает обновление, при повторной загрузке файла заменит событие, а не добавит второе. Срок по заданию на оценку
// раньше срока дела (2.317) — своим событием на весь день с напоминанием накануне. Срок из письма о переносе (2.359) — своим
// названием «Срок по письму о переносе», в описании прежний срок, «сдайте к нему или попросите письмо с новым сроком» и
// попросили ли его (2.353); UID тот же, что у срока по заданию, — календарь передвинет событие на день из письма, а не
// оставит старое рядом. У срока дела в описании — к какому дню сдать по заданию или по письму о переносе. Срок в выходной или
// праздник (2.398) — в названии «нерабочий день, сдайте до …» (последний рабочий день перед ним), в описании — чем день
// нерабочий, а напоминание — накануне этого рабочего дня в 9:00, а не в выходной. Заседание суда (2.442) — занятые два часа
// с адресом суда в месте события (адрес суда открыт, это не адрес объекта), в описании — суд и номер дела; напоминания — накануне
// в 18:00 по Москве и за два часа до начала.
import { addDays } from './workflow.mjs';
import { offDayName, workdayBefore } from './holidays.mjs';
import { orderRef } from '../notify/registry.mjs';

const DOMAIN = 'bertel-delo';
const VISIT_MINUTES = 60;
const HEARING_MINUTES = 120;

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

function event(lines, { uid, now, start, end, summary, description, location, alarm, busy = false }) {
  lines.push('BEGIN:VEVENT', `UID:${uid}@${DOMAIN}`, `DTSTAMP:${stamp(now)}`, start, end, `SUMMARY:${icsText(summary)}`);
  if (description) lines.push(`DESCRIPTION:${icsText(description)}`);
  if (location) lines.push(`LOCATION:${icsText(location)}`);
  // Срок — пометка на весь день, время не занимает; выезд — занятый час.
  lines.push(`TRANSP:${busy ? 'OPAQUE' : 'TRANSPARENT'}`);
  for (const a of [alarm].flat().filter(Boolean)) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(summary)}`, `TRIGGER${a.startsWith(';') ? a : `:${a}`}`, 'END:VALARM');
  }
  lines.push('END:VEVENT');
}

const ru = (iso) => iso.split('-').reverse().join('.');
const mskDate = (t) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(t));

// Срок дела: срок по заданию или по письму о переносе раньше — к какому дню сдать; письмо перенесло срок не раньше срока дела —
// на какой день.
function deadlineNote(i) {
  if (i.task_due) return `${i.task_due_letter ? 'По письму о переносе' : 'По заданию на оценку'} отчёт нужен раньше — к ${ru(i.task_due)}. `;
  if (i.task_letter) return `Срок по заданию перенесён письмом о переносе на ${ru(i.task_letter.day)} (было ${ru(i.task_letter.was)}). `;
  return '';
}

function taskDueEvent(i) {
  const l = i.task_due.letter;
  if (!l) {
    return { summary: `Срок по заданию на оценку: дело ${orderRef(i.order_id)}, ${i.service}`,
      description: `Срок дела позже — ${ru(i.deadline)}, а по заданию на оценку отчёт нужен к этому дню. ` };
  }
  const ask = i.letter_ask?.asked_at ? ` Письмо с новым сроком попросили ${mskDate(i.letter_ask.asked_at)}, пока не пришло.` : '';
  return { summary: `Срок по письму о переносе: дело ${orderRef(i.order_id)}, ${i.service}`,
    description: `Срок дела позже — ${ru(i.deadline)}, а по письму о переносе${l.was ? ` (было ${ru(l.was)})` : ''} отчёт нужен к этому дню: `
      + `сдайте к нему или попросите у заказчика письмо с новым сроком.${ask} ` };
}

// Срок в нерабочий день: к названию — «сдайте до …», в начало описания — почему, напоминание — накануне рабочего дня перед ним.
function offDay(date, alarm) {
  const name = offDayName(date);
  if (!name) return { suffix: '', note: '', alarm };
  const before = workdayBefore(date);
  const days = Math.round((Date.parse(date) - Date.parse(before)) / 86_400_000);
  return {
    suffix: ` — нерабочий день, сдайте до ${ru(before)}`,
    note: `${ru(date)} — ${name}, нерабочий день: заказчик и банк в этот день не работают, сдайте лучше до него — к ${ru(before)}. `,
    alarm: alarm && `-P${days}DT15H`,
  };
}

// Заседание: накануне в 18:00 по Москве — точным моментом (15:00 UTC), чтобы не зависеть от времени начала.
// Прогон 2.450: эксперт подал «Не смогу прийти» — событие остаётся (суд может отказать), но свободным временем и без
// напоминаний «возьмите отчёт».
function hearingEvent(i) {
  const start = new Date(i.at);
  const eve = new Date(`${addDays(mskIso(start), -1)}T18:00:00+03:00`);
  if (i.absence) {
    return {
      uid: `court-${i.call_id}`,
      start: `DTSTART:${stamp(start)}`, end: `DTEND:${stamp(new Date(start.getTime() + HEARING_MINUTES * 60_000))}`,
      summary: `Заседание в суде (подано ходатайство): ${i.court}, дело № ${i.case_no}`,
      description: `Вы подали ходатайство «${i.absence}» по делу ${orderRef(i.order_id)}, ${i.service}. Узнайте в суде, удовлетворено ли оно; если нет — нужно прийти. `,
      location: i.address, busy: false,
    };
  }
  return {
    uid: `court-${i.call_id}`,
    start: `DTSTART:${stamp(start)}`, end: `DTEND:${stamp(new Date(start.getTime() + HEARING_MINUTES * 60_000))}`,
    summary: `Заседание в суде: ${i.court}, дело № ${i.case_no}`,
    description: `Вызывают как эксперта по делу ${orderRef(i.order_id)}, ${i.service}. Возьмите отчёт, аттестат и полис. `,
    location: i.address, busy: true,
    alarm: [`;VALUE=DATE-TIME:${stamp(eve)}`, '-PT2H'],
  };
}
const mskIso = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);

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
        // Накануне в 9:00 — от полуночи дня срока назад на 15 часов; дело уже на проверке — без напоминания.
        const off = offDay(d.date, i.status === 'review' ? null : '-PT15H');
        event(lines, {
          uid: `deadline-${i.order_id}`, now,
          start: `DTSTART;VALUE=DATE:${dateOnly(d.date)}`, end: `DTEND;VALUE=DATE:${dateOnly(addDays(d.date, 1))}`,
          summary: `${DEADLINE_NOTE[i.status] ?? 'Срок сдачи'}: дело ${orderRef(i.order_id)}, ${i.service}${off.suffix}`,
          description: `${off.note}${deadlineNote(i)}${about}`,
          alarm: off.alarm,
        });
      } else if (i.kind === 'task_due') {
        const e = taskDueEvent(i);
        const off = offDay(d.date, '-PT15H');
        event(lines, {
          uid: `taskdue-${i.order_id}`, now,
          start: `DTSTART;VALUE=DATE:${dateOnly(d.date)}`, end: `DTEND;VALUE=DATE:${dateOnly(addDays(d.date, 1))}`,
          summary: `${e.summary}${off.suffix}`, description: `${off.note}${e.description}${about}`,
          alarm: off.alarm,
        });
      } else if (i.kind === 'court') {
        const e = hearingEvent(i);
        event(lines, { ...e, now, description: `${e.description}${about}` });
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
