// Дела экспертов (2.16, устав 1а): руководитель организации видит дела, которые ведут эксперты от неё, — услугу, номер,
// срок (просрочено — крупно), состояние, эксперта и вознаграждение; нагрузку по экспертам и деньги за месяц.
// Заказчика, поля заявки, документы и переписку — нет (их сервер и не присылает).
import { api, el } from '/common.js';
import { dayRu } from '/order.js';
import { rub } from '/money.js';

const $ = (id) => document.getElementById(id);
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const PAYOUT_RU = { pending: 'выплата проводится', succeeded: 'выплачено', failed: 'выплата не прошла' };
const fact = (dt, dd, cls) => [el('dt', { text: dt }), el('dd', { text: dd, ...(cls ? { class: cls } : {}) })];

export async function loadOrgCases(org) {
  const { cases, load, money } = await api('GET', `/api/orgs/${org.id}/cases`);
  $('org-cases-box').classList.remove('hidden');
  const month = MONTHS[Number(money.month.slice(5, 7)) - 1];
  $('org-cases-money').replaceChildren(
    ...fact(`Выплачено экспертам · ${month}`, rub(money.paid_kop), 'money-sum'),
    ...fact('Ждёт выдачи результата', rub(money.waiting_kop)));
  $('org-cases-load').replaceChildren(...load.map((l) => el('li', { 'data-expert': l.user_id },
    el('div', { class: 'title', text: l.full_name }),
    el('div', { class: `muted${l.overdue ? ' overdue' : ''}`, text: [`в работе: ${l.in_work}`, l.offered ? `предложено: ${l.offered}` : null,
      l.overdue ? `просрочено: ${l.overdue}` : null].filter(Boolean).join(' · ') }))));
  const active = cases.filter((c) => c.active);
  const done = cases.filter((c) => !c.active);
  $('org-cases-empty').classList.toggle('hidden', cases.length > 0);
  $('org-cases').replaceChildren(
    ...active.map(caseItem),
    ...(done.length ? [el('li', { class: 'group', text: `Завершённые · ${done.length}` })] : []),
    ...done.map(caseItem));
}

function caseItem(c) {
  const deadline = c.deadline ? `срок ${dayRu(c.deadline)}${c.overdue ? ' · ПРОСРОЧЕНО' : ''}` : 'срок не указан';
  return el('li', { 'data-case': c.order_ref },
    el('div', { class: 'title', text: `${c.service} · ${c.order_ref}` }),
    ...(c.overdue ? [el('div', { class: 'overdue big', text: deadline })] : []),
    el('div', { class: 'muted', text: [c.status_name, `эксперт: ${c.expert}`, c.overdue ? null : deadline].filter(Boolean).join(' · ') }),
    el('div', { class: 'muted', text: [c.fee_kop != null ? `вознаграждение ${rub(c.fee_kop)}` : 'цена ещё не назначена',
      c.payout ? PAYOUT_RU[c.payout] : null].filter(Boolean).join(' · ') }));
}
