// «Мои итоги за месяц» в профиле специалиста (2.92): по образцу сводки руководителя (2.78), но по своим делам — сдано, из
// них в срок, позже срока, просрочено сейчас, возвраты, вознаграждение и выплачено; ниже — сданные дела месяца со ссылкой.
import { api, el, say } from '/common.js';
import { rub } from '/money.js';
import { dayRu } from '/order.js';

const $ = (id) => document.getElementById(id);
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const monthRu = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const fact = (dt, dd, cls) => [el('dt', { text: dt }), el('dd', { text: dd, ...(cls ? { class: cls } : {}) })];

let seq = 0;
$('my-report-month').addEventListener('change', () => loadMyReport($('my-report-month').value));

export async function loadMyReport(month = '') {
  const my = ++seq;
  let report;
  try {
    ({ report } = await api('GET', `/api/specialist/me/report${month ? `?month=${encodeURIComponent(month)}` : ''}`));
  } catch (err) { say($('my-report-msg'), err.message); return; }
  if (my !== seq) return;
  say($('my-report-msg'), '');
  const sel = $('my-report-month');
  sel.replaceChildren(...report.months.map((m, i) => el('option', { value: m, text: i === 0 ? `${monthRu(m)} (текущий)` : monthRu(m) })));
  sel.value = report.month;
  const t = report.total;
  $('my-report-total').replaceChildren(
    ...fact(`Сдано · ${report.month_name}`, t.done ? `${t.done} (в срок — ${t.done_on_time}${t.done_late ? `, позже срока — ${t.done_late}` : ''})` : '0'),
    ...fact('Принято новых дел', String(t.accepted)),
    ...(report.current && t.overdue_now ? fact('Просрочено сейчас', String(t.overdue_now), 'overdue') : []),
    ...(t.returned_head || t.returned_dispatcher ? fact('Возвращали', [
      t.returned_head ? `руководитель — ${t.returned_head}` : null, t.returned_dispatcher ? `на доработку — ${t.returned_dispatcher}` : null,
    ].filter(Boolean).join(', ')) : fact('Возвращали', 'ни разу')),
    ...fact('Вознаграждение за сданные', rub(t.fee_kop), 'money-sum'),
    ...fact('Выплачено за месяц', rub(t.paid_kop)));
  $('my-report-cases').replaceChildren(...report.cases.map((c) => el('li', { 'data-report-case': c.id },
    el('a', { class: 'title', href: `#order=${c.id}`, text: c.title || 'Дело' }),
    el('div', { class: c.late ? 'overdue' : 'muted', text: `сдано ${dayRu(c.done_on)}${c.deadline ? ` · срок ${dayRu(c.deadline)}` : ''} · ${c.late ? 'позже срока' : 'в срок'}` }),
    el('div', { class: 'muted', text: `${rub(c.fee_kop)} · ${c.paid ? 'выплачено' : 'ждёт выплаты'}` }))));
  $('my-report-empty').classList.toggle('hidden', report.cases.length > 0);
}
