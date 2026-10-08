// Нагрузка экспертов на две недели (2.111): у руководителя по каждому эксперту — полоса из 14 дней (сколько дел сдавать
// и выездов в день; серым — дни, когда эксперт не принимает новые дела) и итог: сколько сдавать, выездов, свободных будней.
// Раскрыл эксперта — его дни подробно; нажатие на дело открывает его в «Делах экспертов». Заказчика и названий заявок
// руководитель не видит — услуга и номер дела.
import { api, el, say } from '/common.js';
import { dayRu } from '/order.js';
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

function strip(x, days) {
  return el('div', { class: 'strip', 'aria-hidden': 'true' }, ...days.map((h, k) => {
    const d = x.days[k];
    const due = d.items.filter((i) => i.kind === 'deadline').length;
    const go = d.items.length - due;
    const cls = ['cell', h.today ? 'today' : '', h.weekend ? 'weekend' : '', d.away ? 'away' : '',
      due > 1 ? 'heavy' : due || go ? 'busy' : ''].filter(Boolean).join(' ');
    return el('span', { class: cls, 'data-day': h.date, title: `${h.weekday}, ${short(h.date)}` },
      el('span', { class: 'num', text: String(Number(h.date.slice(8))) }),
      el('span', { class: 'cnt', text: due ? String(due) : go ? '•' : '' }));
  }));
}

function expertItem(x, days) {
  const total = [`сдать за две недели: ${x.due}`, x.visits ? `выездов: ${x.visits}` : null,
    `свободных будней: ${x.free_workdays}`].filter(Boolean).join(' · ');
  const busy = x.days.map((d, k) => ({ d, h: days[k] })).filter(({ d }) => d.items.length);
  return el('li', { 'data-expert-schedule': x.user_id },
    el('div', { class: 'title', text: x.full_name }),
    el('div', { class: 'muted', 'data-role': 'total', text: total }),
    ...(x.overdue.length ? [el('div', { class: 'overdue', 'data-role': 'overdue', text: `Срок уже прошёл: ${x.overdue.length}` })] : []),
    ...(x.away ? [el('div', { class: 'muted', 'data-away': '', text: `Не принимает новые дела до ${dayRu(x.away.until)}${x.away.note ? ` (${x.away.note})` : ''}` })]
      : x.paused ? [el('div', { class: 'muted', 'data-away': '', text: 'Не принимает новые дела — выключил приём' })] : []),
    strip(x, days),
    ...(busy.length || x.overdue.length ? [daysDetails(x, busy)] : [el('div', { class: 'muted', text: 'Две недели свободны — сроков и выездов нет.' })]));
}

// «По дням»: сначала то, у чего срок уже прошёл, потом дни, где есть сроки или выезды.
function daysDetails(x, busy) {
  const late = x.overdue.length ? [el('li', { class: 'overdue-day' }, el('div', { class: 'day' }, el('span', { text: 'Срок уже прошёл' })),
    el('ul', {}, ...x.overdue.map((i) => item(i, 'hot'))))] : [];
  const rows = busy.map(({ d, h }) => el('li', { 'data-day': d.date, class: [h.today ? 'today' : '', h.weekend ? 'weekend' : ''].filter(Boolean).join(' ') },
    el('div', { class: 'day' }, el('span', { text: `${h.today ? 'Сегодня, ' : ''}${h.weekday}, ${short(h.date)}` }),
      el('span', { class: 'muted', text: d.away ? 'не принимает дела' : '' })),
    el('ul', {}, ...d.items.map((i) => item(i)))));
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
  $('org-schedule').replaceChildren(...schedule.experts.map((x) => expertItem(x, schedule.days)));
}
