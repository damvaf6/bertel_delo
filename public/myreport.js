// «Мои итоги за месяц» в профиле специалиста (2.92): по образцу сводки руководителя (2.78), но по своим делам — сдано, из
// них в срок, позже срока, просрочено сейчас, возвраты, вознаграждение и выплачено; ниже — сданные дела месяца со ссылкой.
// Средний срок от принятия до сдачи, у дела — на сколько позже срока, сколько дней шло и сколько раз возвращали (2.377).
// «Мои итоги за год» (2.409): в выборе — и годы (текущий и прошлый); за год — то же и «По месяцам»: сдано, в срок,
// возвраты, вознаграждение и выплачено (только месяцы, где что-то было).
import { api, el, say } from '/common.js';
import { rub } from '/money.js';
import { dayRu } from '/order.js';

const $ = (id) => document.getElementById(id);
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const monthRu = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const plural = (n, one, few, many) => {
  const t = Math.abs(n) % 100; const u = t % 10;
  return t > 10 && t < 20 ? many : u === 1 ? one : u >= 2 && u <= 4 ? few : many;
};
const daysRu = (d) => (Number.isInteger(d) ? `${d} ${plural(d, 'день', 'дня', 'дней')}` : `${String(d).replace('.', ',')} дня`);
const fact = (dt, dd, cls) => [el('dt', { text: dt }), el('dd', { text: dd, ...(cls ? { class: cls } : {}) })];

// Период из выбора: «2026» — год (2.409), «2026-10» — месяц.
const periodQ = (p) => (/^\d{4}$/.test(p) ? `year=${p}` : `month=${encodeURIComponent(p)}`);
const returnsRu = (h, d) => [h ? `руководитель — ${h}` : null, d ? `на доработку — ${d}` : null].filter(Boolean).join(', ');

let seq = 0;
$('my-report-month').addEventListener('change', () => loadMyReport($('my-report-month').value));

export async function loadMyReport(month = '') {
  const my = ++seq;
  let report;
  try {
    ({ report } = await api('GET', `/api/specialist/me/report${month ? `?${periodQ(month)}` : ''}`));
  } catch (err) { say($('my-report-msg'), err.message); return; }
  if (my !== seq) return;
  say($('my-report-msg'), '');
  const sel = $('my-report-month');
  sel.replaceChildren(
    el('optgroup', { label: 'Месяц' }, ...report.months.map((m, i) => el('option', { value: m, text: i === 0 ? `${monthRu(m)} (текущий)` : monthRu(m) }))),
    ...(report.years?.length ? [el('optgroup', { label: 'Год' }, ...report.years.map((y, i) => el('option', { value: y,
      'data-year': '', text: i === 0 ? `${y} год (по сегодня)` : `${y} год` })))] : []));
  sel.value = report.month;
  const t = report.total;
  $('my-report-total').replaceChildren(
    ...fact(`Сдано · ${report.month_name}`, t.done ? `${t.done} (в срок — ${t.done_on_time}${t.done_late ? `, позже срока — ${t.done_late}` : ''})` : '0'),
    // Средний срок (2.377): дней от принятия дела до сдачи — как в сводке руководителя.
    ...(t.avg_days != null ? fact('В среднем от принятия до сдачи', daysRu(t.avg_days)) : []),
    ...fact('Принято новых дел', String(t.accepted)),
    ...(report.current && t.overdue_now ? fact('Просрочено сейчас', String(t.overdue_now), 'overdue') : []),
    ...(t.returned_head || t.returned_dispatcher ? fact('Возвращали', returnsRu(t.returned_head, t.returned_dispatcher)) : fact('Возвращали', 'ни разу')),
    ...fact('Вознаграждение за сданные', rub(t.fee_kop), 'money-sum'),
    ...fact(report.year ? 'Выплачено за год' : 'Выплачено за месяц', rub(t.paid_kop)));
  // 2.409: за год — по месяцам.
  const months = report.by_month ?? [];
  $('my-report-months-box').classList.toggle('hidden', months.length === 0);
  $('my-report-months').replaceChildren(...months.map((m) => el('li', { 'data-report-month': m.month },
    el('div', { class: 'title', text: MONTHS[Number(m.month.slice(5, 7)) - 1].replace(/^./, (c) => c.toUpperCase()) }),
    el('div', { class: m.done_late ? 'overdue' : 'muted', text: m.done
      ? `сдано ${m.done} · в срок — ${m.done - m.done_late}${m.done_late ? `, позже срока — ${m.done_late}` : ''}` : 'сданных нет' }),
    ...(m.returned_head || m.returned_dispatcher ? [el('div', { class: 'muted', text: `возвращали: ${returnsRu(m.returned_head, m.returned_dispatcher)}` })] : []),
    el('div', { class: 'muted', text: `вознаграждение ${rub(m.fee_kop)} · выплачено ${rub(m.paid_kop)}` }))));
  $('my-report-cases').replaceChildren(...report.cases.map((c) => el('li', { 'data-report-case': c.id },
    el('a', { class: 'title', href: `#order=${c.id}`, text: c.title || 'Дело' }),
    el('div', { class: c.late ? 'overdue' : 'muted', text: `сдано ${dayRu(c.done_on)}${c.deadline ? ` · срок ${dayRu(c.deadline)}` : ''} · ${c.late ? `позже срока на ${daysRu(c.late_days)}` : 'в срок'}` }),
    ...(c.days != null || c.returns ? [el('div', { class: 'muted', 'data-report-pace': c.id, text: [
      c.days != null ? `от принятия до сдачи — ${daysRu(c.days)}` : null,
      c.returns ? `возвращали ${c.returns} ${plural(c.returns, 'раз', 'раза', 'раз')}` : null,
    ].filter(Boolean).join(' · ') })] : []),
    el('div', { class: 'muted', text: `${rub(c.fee_kop)} · ${c.paid ? 'выплачено' : 'ждёт выплаты'}` }))));
  $('my-report-empty').classList.toggle('hidden', report.cases.length > 0);
}
