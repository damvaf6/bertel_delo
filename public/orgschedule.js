// Нагрузка экспертов на две недели (2.111): у руководителя по каждому эксперту — полоса из 14 дней (сколько дел сдавать
// и выездов в день; штриховкой — дни, когда эксперт не принимает новые дела, зелёной чертой — день, когда ему снова
// предлагают дела, красной цифрой — срок сдачи в день, когда эксперт не принимает дела (2.194)) и итог: сколько сдавать, выездов, свободных будней.
// Раскрыл эксперта — его дни подробно; нажатие на дело открывает его в «Делах экспертов». Заказчика и названий заявок
// руководитель не видит — услуга и номер дела. Срок по заданию на оценку раньше срока дела (2.318) — дело сдавать в его
// день: своя строка, у срока дела — «по заданию на оценку — к …»; в полосе и «сдать» дело считается в день срока по заданию.
// Срок из письма о переносе (2.354) — «Сдать по письму о переносе», прежний срок и просил ли эксперт письмо с новым сроком.
import { api, el, say } from '/common.js';
import { WORKING_DAY, awaySpan, dayRu, holidayText } from '/order.js';
import { focusOrgCase } from '/orgcases.js';

const $ = (id) => document.getElementById(id);
const short = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
};
const STATUS = { review: 'сдано, ждёт проверки', awaiting_executor: 'предложено, ещё не принял' };

function itemText(i) {
  const ref = i.order_ref ? `${i.service} · ${i.order_ref}` : i.service;
  if (i.kind === 'task_due') {
    // 2.354: срок из письма о переносе раньше срока дела — так и сказано, прежний срок и просил ли эксперт письмо с новым сроком.
    const l = i.task_due.letter;
    if (l) {
      return { title: `Сдать по письму о переносе: ${ref}`, what: [STATUS[i.status], l.was ? `было — ${short(l.was)}` : null,
        `срок в письме раньше срока дела (${short(i.deadline)})`,
        l.ask?.asked_on ? `эксперт попросил письмо с новым сроком ${short(l.ask.asked_on)} — пока его нет`
          : l.ask?.can_ask ? 'письмо с новым сроком эксперт ещё не просил' : null]
        .filter(Boolean).join(' · ') };
    }
    return { title: `Сдать ${i.task_due.by}: ${ref}`, what: [STATUS[i.status], `срок дела позже — ${short(i.deadline)}`].filter(Boolean).join(' · ') };
  }
  if (i.kind === 'deadline') {
    const letter = i.task_letter ? (i.task_letter.day === i.deadline ? 'срок по письму о переносе — тот же день' : `по письму о переносе — к ${short(i.task_letter.day)}`) : null;
    return { title: `Сдать: ${ref}`, what: [STATUS[i.status], i.task_due ? `${i.task_due_letter ? 'по письму о переносе' : 'по заданию на оценку'} — к ${short(i.task_due)}` : letter,
      i.extend_to ? `просит перенести на ${short(i.extend_to)}` : null].filter(Boolean).join(' · ') };
  }
  if (i.kind === 'visit') return { title: `${i.time} · Выезд помощника: ${ref}`, what: '' };
  return { title: `${i.time} · Едет помощником на объект`, what: i.order_ref ? ref : `${i.service} · дело другой организации` };
}

function item(i, cls = '') {
  const t = itemText(i);
  const body = [el('span', { text: t.title }), ...(t.what ? [el('span', { class: 'what', text: t.what })] : [])];
  // Дело своей организации — открыть в списке дел; чужое (эксперт едет помощником) — только строка.
  return el('li', { 'data-schedule-item': i.kind }, i.order_ref
    ? el('button', { type: 'button', class: `open ${cls}`.trim(), onclick: () => focusOrgCase({ ref: i.order_ref }) }, ...body)
    : el('div', { class: `open ${cls}`.trim() }, ...body));
}

// День «не принимает новые дела» и день возвращения (2.194) — как у эксперта в «Моих сроках» (2.189).
const kind = (x, d) => (d.away ? 'away' : d.date === x.away?.until ? 'back' : 'free');
const FREE = { away: 'новые дела не предлагают', back: 'снова предлагают дела' };
// Что сдавать в день (2.318): срок по заданию на оценку или срок дела без более раннего срока по заданию.
const isDue = (i) => i.kind === 'task_due' || (i.kind === 'deadline' && !i.task_due);
const dueOn = (d) => d.items.filter((i) => isDue(i) && i.status !== 'review').length;
// Срок в отпуске («не принимаю до …») — заметно; выключил приём — дела в работе ведёт как обычно, не отмечаем.
const vacation = (x, d) => !!x.away && d.date < x.away.until && (!x.away.from || d.date >= x.away.from);

function strip(x, days) {
  return el('div', { class: 'strip', 'aria-hidden': 'true' }, ...days.map((h, k) => {
    const d = x.days[k];
    const due = d.items.filter(isDue).length;
    const go = d.items.filter((i) => i.kind === 'visit' || i.kind === 'helper').length;
    const cls = ['cell', h.today ? 'today' : '', h.weekend ? 'weekend' : '', h.working ? 'working' : '', kind(x, d) !== 'free' ? kind(x, d) : '',
      vacation(x, d) && dueOn(d) ? 'clash' : '', due > 1 ? 'heavy' : due || go ? 'busy' : ''].filter(Boolean).join(' ');
    return el('span', { class: cls, 'data-day': h.date, title: [`${h.weekday}, ${short(h.date)}`, h.holiday ? `праздник: ${h.holiday}` : null, h.working ? WORKING_DAY.toLowerCase() : null, kind(x, d) !== 'free' ? FREE[kind(x, d)] : null].filter(Boolean).join(' — ') },
      el('span', { class: 'num', text: String(Number(h.date.slice(8))) }),
      el('span', { class: 'cnt', text: due ? String(due) : go ? '•' : '' }));
  }));
}

function expertItem(x, days, experts) {
  const total = [`сдать за две недели: ${x.due}`, x.visits ? `выездов: ${x.visits}` : null,
    `свободных будней: ${x.free_workdays}`].filter(Boolean).join(' · ');
  const busy = x.days.map((d, k) => ({ d, h: days[k] })).filter(({ d }) => d.items.length);
  // «По дням» (2.245): кроме дней со сроками и выездами — первый день «не принимает новые дела» и день возвращения.
  const marked = x.days.map((d, k) => ({ d, h: days[k], k }))
    .filter(({ d, k }) => d.items.length || kind(x, d) === 'back' || (vacation(x, d) && (k === 0 || !vacation(x, x.days[k - 1]))));
  // Срок сдачи в дни, когда эксперт не принимает дела (2.194): руководителю — заметно, кому передать — его решение.
  const clash = x.days.reduce((n, d) => n + (vacation(x, d) ? dueOn(d) : 0), 0);
  return el('li', { 'data-expert-schedule': x.user_id },
    el('div', { class: 'title', text: x.full_name }),
    el('div', { class: 'muted', 'data-role': 'total', text: total }),
    ...(x.overdue.length ? [el('div', { class: 'overdue', 'data-role': 'overdue', text: `Срок уже прошёл: ${x.overdue.length}` })] : []),
    ...(x.away ? [el('div', { class: 'muted', 'data-away': '', text: `Не принимает новые дела ${awaySpan(x.away)}${x.away.note ? ` (${x.away.note})` : ''}` })]
      : x.paused ? [el('div', { class: 'muted', 'data-away': '', text: 'Не принимает новые дела — выключил приём' })] : []),
    strip(x, days),
    ...(clash ? [el('div', { class: 'clash-note', 'data-role': 'clash', text: `Срок сдачи в дни, когда эксперт не принимает дела: ${clash} — ${
      // Прогон 2.200: другого эксперта, который принимает дела, нет — «передать коллеге» не подсказываем.
      experts.some((y) => y.user_id !== x.user_id && !y.away && !y.paused) ? 'можно передать коллеге' : 'передать некому: другие эксперты не принимают дела — попросите эксперта перенести срок'}` })] : []),
    ...(busy.length || x.overdue.length ? [] : [el('div', { class: 'muted', text: x.away || x.paused ? 'Сроков и выездов нет.' : 'Две недели свободны — сроков и выездов нет.' })]),
    ...(marked.length || x.overdue.length ? [daysDetails(x, marked)] : []));
}

// «По дням»: сначала то, у чего срок уже прошёл, потом дни, где есть сроки или выезды.
function daysDetails(x, busy) {
  const late = x.overdue.length ? [el('li', { class: 'overdue-day' }, el('div', { class: 'day' }, el('span', { text: 'Срок уже прошёл' })),
    el('ul', {}, ...x.overdue.map((i) => item(i, 'hot'))))] : [];
  const rows = busy.map(({ d, h }) => el('li', { 'data-day': d.date,
    class: [h.today ? 'today' : '', h.weekend ? 'weekend' : '', kind(x, d) !== 'free' ? kind(x, d) : ''].filter(Boolean).join(' ') },
    el('div', { class: 'day' }, el('span', { text: `${h.today ? 'Сегодня, ' : ''}${h.weekday}, ${short(h.date)}` })),
    ...(kind(x, d) !== 'free' ? [el('p', { class: 'away-mark', text: FREE[kind(x, d)] })] : []),
    ...(h.holiday ? [el('p', { class: 'holiday-mark', 'data-role': 'holiday', text: holidayText(h, d.items.some((i) => isDue(i) && i.status !== 'review')) })] : []),
    ...(h.working ? [el('p', { class: 'working-mark', 'data-role': 'working', text: WORKING_DAY })] : []),
    ...(d.items.length ? [el('ul', {}, ...d.items.map((i) => item(i, i.kind === 'task_due' || (vacation(x, d) && isDue(i) && i.status !== 'review') ? 'hot' : '')))] : [])));
  return el('details', { 'data-days': x.user_id }, el('summary', { text: 'По дням' }), el('ol', { class: 'schedule' }, ...late, ...rows));
}

// Сколько экспертов принимают новые дела по дням (2.245) — полоса над экспертами, на тех же днях. Никто не принимает —
// день красным и строкой «Никто не принимает новые дела: …», чтобы руководитель заранее знал, когда дело назначить некому.
function spans(dates) {
  const out = [];
  for (const d of dates) {
    const last = out.at(-1);
    if (last && addDay(last.to) === d) last.to = d; else out.push({ from: d, to: d });
  }
  return out.map((p) => (p.from === p.to ? short(p.from) : `${short(p.from)} — ${short(p.to)}`)).join(', ');
}
function addDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return t.toISOString().slice(0, 10);
}
function team(schedule) {
  const total = schedule.experts.length;
  const none = schedule.days.filter((h) => h.accepting === 0).map((h) => h.date);
  const fewer = schedule.days.some((h) => h.accepting < total);
  const note = none.length ? el('div', { class: 'clash-note', 'data-role': 'nobody', text: `Никто не принимает новые дела: ${spans(none)}` })
    : el('div', { class: 'muted', 'data-role': 'nobody', text: fewer ? 'Каждый день кто-то из экспертов принимает новые дела.'
      : 'Все эксперты принимают новые дела все две недели.' });
  // Дела со сроком в дни «никто не принимает» (2.255): передать в эти дни некому — нажатие ведёт к делу, сразу к «кому передать»
  // или «попросить перенос срока»; сдано и ждёт проверки — не в счёт.
  const due = schedule.days.flatMap((h, k) => (h.accepting === 0 ? schedule.experts.flatMap((x) => x.days[k].items
    .filter((i) => isDue(i) && i.status !== 'review').map((i) => ({ i, x, h }))) : []));
  const cases = due.length ? [el('div', { class: 'clash-note', 'data-role': 'nobody-due', text: `Срок сдачи в эти дни: ${due.length}` }),
    el('ul', { class: 'schedule nobody-due' }, ...due.map(({ i, x, h }) => {
      const t = itemText(i);
      return el('li', { 'data-day': h.date, 'data-schedule-item': i.kind },
        el('button', { type: 'button', class: 'open hot', onclick: () => focusOrgCase({ ref: i.order_ref, to: 'transfer' }) },
          el('span', { text: `${short(h.date)} · ${t.title.replace(/^Сдать: /, '')}` }),
          el('span', { class: 'what', text: [x.full_name, t.what].filter(Boolean).join(' · ') })));
    }))] : [];
  return [
    el('div', { class: 'title', text: `Принимают новые дела (из ${total})` }),
    el('div', { class: 'strip', 'aria-hidden': 'true' }, ...schedule.days.map((h) => el('span', {
      class: ['cell', h.today ? 'today' : '', h.weekend ? 'weekend' : '', h.working ? 'working' : '', h.accepting === 0 ? 'nobody' : h.accepting < total ? 'fewer' : ''].filter(Boolean).join(' '),
      'data-day': h.date, title: `${h.weekday}, ${short(h.date)}${h.holiday ? ` (праздник: ${h.holiday})` : h.working ? ` (${WORKING_DAY.toLowerCase()})` : ''} — принимают: ${h.accepting} из ${total}` },
    el('span', { class: 'num', text: String(Number(h.date.slice(8))) }),
    el('span', { class: 'cnt', text: String(h.accepting) })))),
    note,
    ...cases,
  ];
}

let seq = 0;
export async function loadOrgSchedule(org) {
  const my = ++seq;
  let schedule;
  try {
    ({ schedule } = await api('GET', `/api/orgs/${org.id}/schedule`));
  } catch (err) { say($('org-schedule-msg'), err.message); return; }
  if (my !== seq) return;
  say($('org-schedule-msg'), '');
  $('org-schedule-box').classList.toggle('hidden', schedule.experts.length === 0);
  $('org-schedule-range').textContent = `${short(schedule.from)} — ${short(schedule.to)}`;
  $('org-schedule-team').replaceChildren(...(schedule.experts.length ? team(schedule) : []));
  $('org-schedule').replaceChildren(...schedule.experts.map((x) => expertItem(x, schedule.days, schedule.experts)));
}
