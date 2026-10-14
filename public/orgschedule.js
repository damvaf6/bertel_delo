// Нагрузка экспертов на две недели (2.111): у руководителя по каждому эксперту — полоса из 14 дней (сколько дел сдавать
// и выездов в день; штриховкой — дни, когда эксперт не принимает новые дела, зелёной чертой — день, когда ему снова
// предлагают дела, красной цифрой — срок сдачи в день, когда эксперт не принимает дела (2.194)) и итог: сколько сдавать, выездов, свободных будней.
// Раскрыл эксперта — его дни подробно; нажатие на дело открывает его в «Делах экспертов». Заказчика и названий заявок
// руководитель не видит — услуга и номер дела.
import { api, el, say } from '/common.js';
import { awaySpan, dayRu } from '/order.js';
import { focusOrgCase } from '/orgcases.js';

const $ = (id) => document.getElementById(id);
const short = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
};
const STATUS = { review: 'сдано, ждёт проверки', awaiting_executor: 'предложено, ещё не принял' };

function itemText(i) {
  const ref = i.order_ref ? `${i.service} · ${i.order_ref}` : i.service;
  if (i.kind === 'deadline') {
    return { title: `Сдать: ${ref}`, what: [STATUS[i.status], i.extend_to ? `просит перенести на ${short(i.extend_to)}` : null].filter(Boolean).join(' · ') };
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
const dueOn = (d) => d.items.filter((i) => i.kind === 'deadline' && i.status !== 'review').length;
// Срок в отпуске («не принимаю до …») — заметно; выключил приём — дела в работе ведёт как обычно, не отмечаем.
const vacation = (x, d) => !!x.away && d.date < x.away.until && (!x.away.from || d.date >= x.away.from);

function strip(x, days) {
  return el('div', { class: 'strip', 'aria-hidden': 'true' }, ...days.map((h, k) => {
    const d = x.days[k];
    const due = d.items.filter((i) => i.kind === 'deadline').length;
    const go = d.items.length - due;
    const cls = ['cell', h.today ? 'today' : '', h.weekend ? 'weekend' : '', kind(x, d) !== 'free' ? kind(x, d) : '',
      vacation(x, d) && dueOn(d) ? 'clash' : '', due > 1 ? 'heavy' : due || go ? 'busy' : ''].filter(Boolean).join(' ');
    return el('span', { class: cls, 'data-day': h.date, title: `${h.weekday}, ${short(h.date)}` },
      el('span', { class: 'num', text: String(Number(h.date.slice(8))) }),
      el('span', { class: 'cnt', text: due ? String(due) : go ? '•' : '' }));
  }));
}

function expertItem(x, days, experts) {
  const total = [`сдать за две недели: ${x.due}`, x.visits ? `выездов: ${x.visits}` : null,
    `свободных будней: ${x.free_workdays}`].filter(Boolean).join(' · ');
  const busy = x.days.map((d, k) => ({ d, h: days[k] })).filter(({ d }) => d.items.length);
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
    ...(busy.length || x.overdue.length ? [daysDetails(x, busy)]
      : [el('div', { class: 'muted', text: x.away || x.paused ? 'Сроков и выездов нет.' : 'Две недели свободны — сроков и выездов нет.' })]));
}

// «По дням»: сначала то, у чего срок уже прошёл, потом дни, где есть сроки или выезды.
function daysDetails(x, busy) {
  const late = x.overdue.length ? [el('li', { class: 'overdue-day' }, el('div', { class: 'day' }, el('span', { text: 'Срок уже прошёл' })),
    el('ul', {}, ...x.overdue.map((i) => item(i, 'hot'))))] : [];
  const rows = busy.map(({ d, h }) => el('li', { 'data-day': d.date,
    class: [h.today ? 'today' : '', h.weekend ? 'weekend' : '', kind(x, d) !== 'free' ? kind(x, d) : ''].filter(Boolean).join(' ') },
    el('div', { class: 'day' }, el('span', { text: `${h.today ? 'Сегодня, ' : ''}${h.weekday}, ${short(h.date)}` })),
    ...(kind(x, d) !== 'free' ? [el('p', { class: 'away-mark', text: FREE[kind(x, d)] })] : []),
    el('ul', {}, ...d.items.map((i) => item(i, vacation(x, d) && i.kind === 'deadline' && i.status !== 'review' ? 'hot' : '')))));
  return el('details', { 'data-days': x.user_id }, el('summary', { text: 'По дням' }), el('ol', { class: 'schedule' }, ...late, ...rows));
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
  $('org-schedule').replaceChildren(...schedule.experts.map((x) => expertItem(x, schedule.days, schedule.experts)));
}
