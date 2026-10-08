// «Мои сроки на две недели» в разделе «Специалист» (2.109): по дням — сроки своих дел, выезды помощника, до какого дня
// действует ссылка на осмотр, на какой день эксперт просил перенести срок. Подряд идущие пустые дни — одной строкой
// «свободно». Нажатие на строку открывает дело на нужном блоке. Свои напоминания по заметкам (2.120) — открывают заметки.
import { api, el, say } from '/common.js';
import { dayRu } from '/order.js';

const $ = (id) => document.getElementById(id);
const short = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
};
const dayName = (d) => `${d.weekday}, ${short(d.date)}`;
// «Горит» — как в «Сегодня»: срок сегодня, завтра или послезавтра.
const HOT_DAYS = 2;
// Файл для календаря телефона (2.122): сроки дел и выезды — в файле только они.
const IN_CALENDAR = new Set(['deadline', 'visit', 'my_visit']);
$('schedule-ics').addEventListener('click', () => location.assign('/api/specialist/me/schedule?format=ics'));

function item(i, index) {
  const order = (to) => `#order=${encodeURIComponent(i.order_id)}&to=${to}`;
  const link = (href, title, what, cls = '') => el('li', { 'data-schedule-item': i.kind },
    el('a', { class: `open ${cls}`.trim(), href }, el('span', { text: title }), el('span', { class: 'what', text: what })));
  if (i.kind === 'deadline') {
    const note = i.status === 'review' ? 'сдано, ждёт проверки'
      : i.status === 'awaiting_executor' ? 'предложено Вам, ещё не приняли' : null;
    const ext = i.extend_to ? `просите перенести на ${short(i.extend_to)} — ждёт ответа` : null;
    const hot = index !== null && index <= HOT_DAYS && i.status !== 'review';
    return link(order('deadline'), `Сдать: ${i.title}`, [i.service, note, ext].filter(Boolean).join(' · '), hot ? 'hot' : '');
  }
  if (i.kind === 'extend') {
    return link(order('deadline'), `Просите перенести сюда срок: ${i.title}`, `сейчас срок ${short(i.deadline)} · ждёт ответа диспетчера`, 'wait');
  }
  if (i.kind === 'visit') return link(order('onsite'), `${i.time} · Выезд помощника: ${i.title}`, i.service);
  if (i.kind === 'note') {
    return link(order('notes'), `Напоминание по заметке: ${i.title}`,
      [i.note, i.late ? `напомнить было ${short(i.remind_on)}, не отмечено «Сделано»` : null].filter(Boolean).join(' · '));
  }
  if (i.kind === 'my_visit') return link(`/osmotr?visit=${encodeURIComponent(i.visit_id)}`, `${i.time} · Мой выезд на объект`, i.service);
  return link(order('inspect'), `до ${i.time} · Ссылка на осмотр перестанет действовать: ${i.title}`,
    i.has_photos ? 'фото уже есть, владелец не нажал «Готово»' : 'фото ещё нет — напомните владельцу');
}

let seq = 0;
export async function loadSchedule() {
  const my = ++seq;
  let schedule;
  try {
    ({ schedule } = await api('GET', '/api/specialist/me/schedule'));
  } catch (err) { say($('schedule-msg'), err.message); return; }
  if (my !== seq) return;
  say($('schedule-msg'), '');
  const s = schedule;
  $('schedule-away').textContent = s.away
    ? `Новые дела Вам не предлагают до ${dayRu(s.away.until)}${s.away.note ? ` (${s.away.note})` : ''}. Дела, которые уже у Вас, — ниже.` : '';
  $('schedule-away').classList.toggle('hidden', !s.away);
  $('schedule-overdue-box').classList.toggle('hidden', s.overdue.length === 0);
  $('schedule-overdue').replaceChildren(...s.overdue.map((i) => {
    const li = item(i, null);
    const what = li.querySelector('.what');
    what.textContent = i.kind === 'deadline' ? `срок был ${short(i.deadline)}${what.textContent ? ` · ${what.textContent}` : ''}`
      : `выезд был назначен на ${short(i.day)} и не завершён`;
    li.querySelector('a').classList.add('hot');
    return li;
  }));
  // Подряд пустые дни — одной строкой: «сб, 10 октября — пн, 12 октября · свободно».
  const rows = [];
  for (let k = 0; k < s.days.length; k++) {
    const d = s.days[k];
    if (d.items.length) {
      rows.push(el('li', { 'data-day': d.date, class: [d.today ? 'today' : '', d.weekend ? 'weekend' : ''].filter(Boolean).join(' ') },
        el('div', { class: 'day' }, el('span', { text: `${d.today ? 'Сегодня, ' : ''}${dayName(d)}` }),
          el('span', { class: 'muted', text: d.deadlines > 1 ? `сдать дел: ${d.deadlines}` : '' })),
        el('ul', {}, ...d.items.map((i) => item(i, k)))));
      continue;
    }
    let j = k;
    while (j + 1 < s.days.length && !s.days[j + 1].items.length) j++;
    const span = j === k ? dayName(d) : `${dayName(d)} — ${dayName(s.days[j])}`;
    rows.push(el('li', { 'data-day': d.date, class: 'free' },
      el('div', { class: 'day' }, el('span', { text: `${d.today ? 'Сегодня, ' : ''}${span}` }), el('span', { text: 'свободно' }))));
    k = j;
  }
  $('schedule-days').replaceChildren(...rows);
  $('schedule-ics-box').classList.toggle('hidden', !s.days.some((d) => d.items.some((i) => IN_CALENDAR.has(i.kind))));
}
