// «Праздники и переносы» (2.399): администратору в «Управлении» — календарь, по которому «Дело» считает сроки, на этот и
// следующий год; в декабре без переносов на следующий год — предупреждение «дописать постановление».
import { api, el, say } from '/common.js';

const $ = (id) => document.getElementById(id);
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEK = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const dayText = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${WEEK[d.getUTCDay()]}`;
};
const span = (from, to) => (from === to ? dayText(from) : `${dayText(from)} — ${dayText(to)}`);
const daysWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'день' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'дня' : 'дней');
let years = [];

function render(i) {
  const c = years[i];
  if (!c) return;
  for (const b of $('hd-years').children) b.setAttribute('aria-pressed', String(b.dataset.year === String(c.year)));
  $('hd-source').textContent = c.decree
    ? `Переносы выходных записаны: ${c.source ?? 'постановление Правительства'}.`
    : `Переносы выходных на ${c.year} год ещё не записаны — показаны только праздники по Трудовому кодексу.`;
  $('hd-source').dataset.decree = String(c.decree);
  $('hd-runs').replaceChildren(...c.runs.map((r) => el('li', { 'data-hd-run': r.from },
    el('div', { class: 'title', text: `${span(r.from, r.to)} · ${r.days} ${daysWord(r.days)}` }),
    el('div', { class: 'muted', text: `${r.names.join(', ')}. Первый рабочий день — ${dayText(r.back)}` }))));
  const moves = [...c.moves.map((m) => ({ date: m.date, text: `выходной: ${m.name}` })),
    ...c.working.map((d) => ({ date: d, text: 'рабочая суббота (перенос)', working: true }))].sort((a, b) => a.date.localeCompare(b.date));
  $('hd-moves').replaceChildren(...moves.map((m) => el('li', { 'data-hd-move': m.date, ...(m.working ? { 'data-working': 'true' } : {}) },
    el('div', { class: 'title', text: dayText(m.date) }), el('div', { class: 'muted', text: m.text }))));
  $('hd-moves-empty').classList.toggle('hidden', moves.length > 0);
}

export async function loadHolidays() {
  let r;
  try { r = await api('GET', '/api/admin/holidays'); } catch (err) { say($('hd-msg'), err.message); return; }
  years = r.years;
  $('hd-warn').classList.toggle('hidden', !r.warning);
  $('hd-warn').textContent = r.warning?.text ?? '';
  $('hd-years').replaceChildren(...years.map((c, i) => {
    const b = el('button', { type: 'button', 'data-year': String(c.year), text: `${c.year}${c.decree ? '' : ' · не записан'}` });
    b.addEventListener('click', () => render(i));
    return b;
  }));
  render(0);
}
