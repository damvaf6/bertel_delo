// «Мои сроки на две недели» в разделе «Специалист» (2.109): по дням — сроки своих дел, выезды помощника, до какого дня
// действует ссылка на осмотр, на какой день эксперт просил перенести срок. Подряд идущие пустые дни — одной строкой
// «свободно». Нажатие на строку открывает дело на нужном блоке. Свои напоминания по заметкам (2.120) — открывают заметки;
// «Сделано» у напоминания отмечает заметку, не открывая дело (2.157).
import { api, el, say } from '/common.js';
import { dayRu } from '/order.js';

const $ = (id) => document.getElementById(id);
const short = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
};
// «13 октября» — когда напоминал руководитель (по Москве).
const when = (t) => new Date(t).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' });
const dayName = (d) => `${d.weekday}, ${short(d.date)}`;
// Выездов в перегруженном дне (2.179): «выезд», «2 выезда».
const trips = (n) => (n === 1 ? 'выезд' : `${n} ${n < 5 ? 'выезда' : 'выездов'}`);
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
    const away = i.away_due ? 'срок в дни, когда Вы не принимаете новые дела' : null;
    // 2.219: руководитель просил попросить перенос срока (2.201), а просьбы с тех пор нет.
    const asked = i.head_ask ? `напоминал руководитель${i.head_ask.by ? ` ${i.head_ask.by}` : ''} ${when(i.head_ask.at)} — попросите перенос срока` : null;
    const li = link(order('deadline'), `Сдать: ${i.title}`, [i.service, note, ext, away, asked].filter(Boolean).join(' · '), hot || away || asked ? 'hot' : '');
    if (asked) li.dataset.headAsk = '1';
    // Перегруженный день (2.134): рядом — «Попросить перенос», дело откроется с готовой причиной и новым сроком. Срок в отпуске
    // (2.195) — причина «меня не будет», новый срок — день возвращения; эксперту от организации — ещё «Передать коллеге».
    if (i.can_extend) li.append(el('a', { class: 'ask', href: order(i.away_due ? 'away' : 'extend'), 'data-ask-extend': i.order_id, text: 'Попросить перенос' }));
    if (i.can_handover) li.append(el('a', { class: 'ask', href: order('handover'), 'data-ask-handover': i.order_id, text: 'Передать коллеге' }));
    return li;
  }
  if (i.kind === 'extend') {
    return link(order('deadline'), `Просите перенести сюда срок: ${i.title}`, `сейчас срок ${short(i.deadline)} · ждёт ответа диспетчера`, 'wait');
  }
  if (i.kind === 'visit') return link(order('onsite'), `${i.time} · Выезд помощника: ${i.title}`, i.service);
  if (i.kind === 'note') {
    // 2.157: «за день до срока» — со сроком дела; «Сделано» — прямо здесь, не открывая дело.
    const li = link(order('notes'), `Напоминание по заметке: ${i.title}`,
      [i.note, i.by_deadline ? `за день до срока (срок ${short(i.deadline)})` : null,
        i.late ? `напомнить было ${short(i.remind_on)}, не отмечено «Сделано»` : null].filter(Boolean).join(' · '));
    li.append(el('button', { type: 'button', class: 'ask', 'data-note-done': i.note_id, text: 'Сделано',
      onclick: (e) => noteDone(e.currentTarget, i) }));
    return li;
  }
  if (i.kind === 'my_visit') return link(`/osmotr?visit=${encodeURIComponent(i.visit_id)}`, `${i.time} · Мой выезд на объект`, i.service);
  return link(order('inspect'), `до ${i.time} · Ссылка на осмотр перестанет действовать: ${i.title}`,
    i.has_photos ? 'фото уже есть, владелец не нажал «Готово»' : 'фото ещё нет — напомните владельцу');
}

async function noteDone(btn, i) {
  btn.disabled = true;
  try {
    await api('PATCH', `/api/orders/${encodeURIComponent(i.order_id)}/notes/${encodeURIComponent(i.note_id)}`, { done: true });
  } catch (err) { btn.disabled = false; say($('schedule-msg'), err.message); return; }
  await loadSchedule();
  say($('schedule-msg'), `Отмечено: сделано — «${i.note}»`, 'ok');
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
    ? `Новые дела Вам не предлагают до ${dayRu(s.away.until)}${s.away.note ? ` (${s.away.note})` : ''}. Дела, которые уже у Вас, — ниже.${s.away_due
      ? ` Срок сдачи в эти дни: ${s.away_due} — попросите перенос или передайте дело коллеге.` : ''}` : '';
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
  // Подряд пустые дни — одной строкой: «сб, 10 октября — пн, 12 октября · свободно». Дни «не принимаю новые дела» (2.189) —
  // своей строкой «новые дела не предлагают», день возвращения — «снова предлагают дела»: пустой день в отпуске не «свободно».
  const back = s.away?.until;
  const kind = (d) => (d.away ? 'away' : d.date === back ? 'back' : 'free');
  const FREE = { away: 'новые дела не предлагают', back: 'снова предлагают дела', free: 'свободно' };
  const rows = [];
  for (let k = 0; k < s.days.length; k++) {
    const d = s.days[k];
    if (d.items.length) {
      rows.push(el('li', { 'data-day': d.date, class: [d.today ? 'today' : '', d.weekend ? 'weekend' : '', d.busy ? 'busy' : '', kind(d) !== 'free' ? kind(d) : ''].filter(Boolean).join(' ') },
        el('div', { class: 'day' }, el('span', { text: `${d.today ? 'Сегодня, ' : ''}${dayName(d)}` }),
          el('span', { class: d.busy ? 'busy-mark' : 'muted', text: d.busy ? `много: к сдаче ${d.due}${d.trips ? ` + ${trips(d.trips)}` : ''}` : d.deadlines > 1 ? `сдать дел: ${d.deadlines}` : '' })),
        ...(kind(d) !== 'free' ? [el('p', { class: 'away-mark', text: FREE[kind(d)] })] : []),
        ...(d.busy ? [el('p', { class: 'muted', text: d.trips
          ? `В этот день к сдаче ${d.due} ${d.due === 1 ? 'дело' : d.due < 5 ? 'дела' : 'дел'} и ${trips(d.trips)} на объект — можно попросить перенести срок.`
          : 'В этот день больше двух дел к сдаче — можно попросить перенести срок одного из них.' })] : []),
        el('ul', {}, ...d.items.map((i) => item(i, k)))));
      continue;
    }
    let j = k;
    while (j + 1 < s.days.length && !s.days[j + 1].items.length && kind(s.days[j + 1]) === kind(d) && kind(d) !== 'back') j++;
    const span = j === k ? dayName(d) : `${dayName(d)} — ${dayName(s.days[j])}`;
    rows.push(el('li', { 'data-day': d.date, class: kind(d) === 'free' ? 'free' : `free ${kind(d)}` },
      el('div', { class: 'day' }, el('span', { text: `${d.today ? 'Сегодня, ' : ''}${span}` }), el('span', { text: FREE[kind(d)] }))));
    k = j;
  }
  $('schedule-days').replaceChildren(...rows);
  $('schedule-ics-box').classList.toggle('hidden', !s.days.some((d) => d.items.some((i) => IN_CALENDAR.has(i.kind))));
}
