// Сводка за месяц по экспертам (2.78): руководитель выбирает месяц и видит по каждому эксперту — принял, сдал, позже срока,
// возвращено, вознаграждение и выплачено; ниже итог. «Скачать таблицу» — та же сводка файлом для Excel. «Скачать сданные
// заключения» (2.89) — файлы результата с подписями и опись одним архивом; кнопка есть, только если за месяц что-то сдано.
import { api, el, say } from '/common.js';
import { rub } from '/money.js';

const $ = (id) => document.getElementById(id);
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const monthRu = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const fact = (dt, dd, cls) => [el('dt', { text: dt }), el('dd', { text: dd, ...(cls ? { class: cls } : {}) })];

let org = null;

$('org-report-month').addEventListener('change', () => load($('org-report-month').value));
$('org-report-csv').addEventListener('click', () => {
  if (!org) return;
  // Файл отдаёт сервер по той же учётке (вход — по cookie); страница остаётся на месте.
  location.assign(`/api/orgs/${org.id}/report?format=csv&month=${encodeURIComponent($('org-report-month').value)}`);
});

$('org-report-zip').addEventListener('click', () => {
  if (!org) return;
  location.assign(`/api/orgs/${org.id}/report/archive?month=${encodeURIComponent($('org-report-month').value)}`);
});

export async function loadOrgReport(o) {
  org = o;
  say($('org-report-msg'), '');
  await load('');
}

async function load(month) {
  const forOrg = org;
  let report;
  try {
    ({ report } = await api('GET', `/api/orgs/${forOrg.id}/report${month ? `?month=${encodeURIComponent(month)}` : ''}`));
  } catch (err) { say($('org-report-msg'), err.message); return; }
  if (org !== forOrg) return;
  // Экспертов, работающих от организации, нет — сводки не показываем (подсказка — в «Делах экспертов»).
  $('org-report-box').classList.toggle('hidden', report.experts.length === 0);
  const sel = $('org-report-month');
  sel.replaceChildren(...report.months.map((m, i) => el('option', { value: m, text: i === 0 ? `${monthRu(m)} (текущий)` : monthRu(m) })));
  sel.value = report.month;
  const t = report.total;
  $('org-report-zip').classList.toggle('hidden', !t.done);
  $('org-report-zip').textContent = `Заключения архивом (${t.done})`;
  $('org-report-total').replaceChildren(
    ...fact(`Итого · ${report.month_name}`, `принято дел: ${t.accepted} · сдано: ${t.done}${t.done_late ? ` (позже срока: ${t.done_late})` : ''}`),
    ...(report.current && t.overdue_now ? fact('Просрочено сейчас', String(t.overdue_now), 'overdue') : []),
    ...fact('Вознаграждение за сданные', rub(t.fee_kop), 'money-sum'),
    ...fact('Выплачено экспертам', rub(t.paid_kop)));
  $('org-report').replaceChildren(...report.experts.map((x) => el('li', { 'data-report-expert': x.user_id },
    el('div', { class: 'title', text: x.full_name }),
    el('div', { class: 'muted', text: `принял: ${x.accepted} · сдано: ${x.done}` }),
    ...(x.done_late || x.overdue_now ? [el('div', { class: 'overdue', text: [x.done_late ? `позже срока: ${x.done_late}` : null,
      x.overdue_now ? `просрочено сейчас: ${x.overdue_now}` : null].filter(Boolean).join(' · ') })] : []),
    ...(x.returned_head || x.returned_dispatcher ? [el('div', { class: 'muted', text: `возвращено: ${[
      x.returned_head ? `Вами — ${x.returned_head}` : null, x.returned_dispatcher ? `на доработку — ${x.returned_dispatcher}` : null,
    ].filter(Boolean).join(', ')}` })] : []),
    el('div', { class: 'muted', text: `вознаграждение за сданные: ${rub(x.fee_kop)} · выплачено: ${rub(x.paid_kop)}` }))));
}
