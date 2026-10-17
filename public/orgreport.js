// Сводка за месяц по экспертам (2.78): руководитель выбирает месяц и видит по каждому эксперту — принял, сдал, позже срока,
// возвращено, вознаграждение и выплачено; ниже итог. «Скачать таблицу» — та же сводка файлом для Excel. «Скачать сданные
// заключения» (2.89) — файлы результата с подписями и опись одним архивом; кнопка есть, только если за месяц что-то сдано.
// Скорость и сроки (2.117): сколько дней в среднем от принятия до сдачи и сколько сдано позже первоначального срока — с
// переносом срока и без. В первоначальный срок, без переносов (2.188) — «N из M сданных».
// Сравнение с прошлым месяцем (2.124): сдано, в срок, возвраты — сейчас и в прошлом месяце, у каждого эксперта и в итоге.
// По услугам (2.135): сколько сдано по каждой услуге — из них позже срока, вознаграждение, у скольких экспертов; у эксперта —
// его сданные по услугам.
// От возврата до новой подписи (2.168): после возвратов руководителя за месяц — сколько дней в среднем эксперт заново
// подписывал файл и сколько возвратов ещё ждут новой подписи; в итоге и у каждого эксперта.
// Подписано без ИИ-проверки (2.199): сколько файлов эксперт подписал за месяц и сколько из них без ИИ-проверки этой версии.
// Расхождения с выпиской ЕГРН при первой подписи (2.265): по делам, впервые подписанным экспертом за месяц, — сколько находок,
// сверенных с выпиской, было в ИИ-проверке файла перед подписью, в скольких делах и в каких пунктах проверки чаще.
// Частые замечания (2.105) — пункты, с которыми руководитель чаще всего возвращал отчёты: по организации и у каждого эксперта.
import { api, el, say } from '/common.js';
import { rub } from '/money.js';

// Частые пункты замечаний (2.105): «Нет даты осмотра» — 3 раза, у 2 экспертов.
const times = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'раз' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'раза' : 'раз'}`;
const experts = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'эксперта' : 'экспертов'}`;

const $ = (id) => document.getElementById(id);
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const monthRu = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
// Дробное — «4,5 дня».
const daysRu = (d) => `${String(d).replace('.', ',')} ${!Number.isInteger(d) ? 'дня' : d % 10 === 1 && d % 100 !== 11 ? 'день'
  : [2, 3, 4].includes(d % 10) && ![12, 13, 14].includes(d % 100) ? 'дня' : 'дней'}`;
// «в первоначальный срок, без переносов: 3 из 5 · в среднем 4,5 дня от принятия до сдачи · позже первоначального срока: 2
// (с переносом — 1, без переноса — 1)».
const pace = (x) => [x.done ? `в первоначальный срок, без переносов: ${x.first_kept} из ${x.done}` : null,
  x.avg_days != null ? `в среднем ${daysRu(x.avg_days)} от принятия до сдачи` : null,
  x.late_first ? `позже первоначального срока: ${x.late_first} (${[x.late_first_moved ? `с переносом — ${x.late_first_moved}` : null,
    x.late_first - x.late_first_moved ? `без переноса — ${x.late_first - x.late_first_moved}` : null].filter(Boolean).join(', ')})` : null,
].filter(Boolean).join(' · ');
// «новая подпись в среднем через 1,5 дня · ещё не подписано заново: 1»; без возвратов — пусто.
const resign = (x) => [x.resign_days != null ? `новая подпись в среднем через ${x.resign_days < 0.1 ? 'меньше 2 часов' : daysRu(x.resign_days)}` : null,
  x.resign_wait ? `ещё не подписано заново: ${x.resign_wait}` : null].filter(Boolean).join(' · ');
// «подписано файлов: 4 · без ИИ-проверки этой версии: 1 · не отметив все пункты замечания: 1» (2.199, 2.217); ничего не
// подписано — пусто.
const signedAi = (x) => (x.signed ? `подписано файлов: ${x.signed}${x.signed_no_ai ? ` · без ИИ-проверки этой версии: ${x.signed_no_ai}`
  : ' · все после ИИ-проверки'}${x.signed_points_left ? ` · не отметив все пункты замечания: ${x.signed_points_left}` : ''}` : '');
const signedWarn = (x) => x.signed_no_ai || x.signed_points_left;
// «при первой подписи расхождений с выпиской ЕГРН: 3 в 1 деле из 2 проверенных ИИ · чаще: Недвижимость и земля — 2 · впервые
// подписано без ИИ-проверки: 1»; ни одно дело не подписано впервые после ИИ-проверки — пусто (без проверки не видно).
const caseWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'деле' : 'делах');
const egrnFirst = (x) => {
  const checked = (x.first_signed ?? 0) - (x.first_no_ai ?? 0);
  if (checked <= 0) return '';
  return [x.egrn_first
    ? `при первой подписи расхождений с выпиской ЕГРН: ${x.egrn_first} в ${x.egrn_first_cases} ${caseWord(x.egrn_first_cases)} из ${checked} проверенных ИИ`
    : `при первой подписи расхождений с выпиской ЕГРН нет (проверено ИИ дел: ${checked})`,
  x.egrn_rules?.length ? `чаще: ${x.egrn_rules.map((r) => `${r.title} — ${r.n}`).join(', ')}` : null,
  x.first_no_ai ? `впервые подписано без ИИ-проверки: ${x.first_no_ai}` : null].filter(Boolean).join(' · ');
};
// 2.275: «при первой подписи расхождений с заявкой и заданием на оценку: 3 в 2 делах из 4 проверенных ИИ (с заявкой — 2, с
// заданием — 1) · чаще: Дата оценки — 1»; без проверенных ИИ дел — пусто (без ИИ-проверки сказано в строке о выписке).
const orderFirst = (x) => {
  const checked = (x.first_signed ?? 0) - (x.first_no_ai ?? 0);
  if (checked <= 0) return '';
  if (!x.order_first) return `при первой подписи расхождений с заявкой и заданием на оценку нет (проверено ИИ дел: ${checked})`;
  const parts = [x.order_first_app ? `с заявкой — ${x.order_first_app}` : null, x.order_first_task ? `с заданием — ${x.order_first_task}` : null]
    .filter(Boolean).join(', ');
  return [`при первой подписи расхождений с заявкой и заданием на оценку: ${x.order_first} в ${x.order_first_cases} ${
    caseWord(x.order_first_cases)} из ${checked} проверенных ИИ (${parts})`,
  x.order_rules?.length ? `чаще: ${x.order_rules.map((r) => `${r.title} — ${r.n}`).join(', ')}` : null].filter(Boolean).join(' · ');
};
// «сдано: 5 (было 3, +2) · в срок: 4 (было 4) · возвраты: 1 (было 2, −1)»; у эксперта без дел в обоих месяцах — пусто.
const diff = (now, was) => `${now} (было ${was}${now > was ? `, +${now - was}` : now < was ? `, −${was - now}` : ''})`;
const compare = (x) => {
  if (!x.prev) return '';
  const now = { done: x.done, on_time: x.done - x.done_late, returned: x.returned_head + x.returned_dispatcher };
  if (![now.done, now.returned, x.prev.done, x.prev.returned].some(Boolean)) return '';
  return `сдано: ${diff(now.done, x.prev.done)} · в срок: ${diff(now.on_time, x.prev.on_time)} · возвраты: ${diff(now.returned, x.prev.returned)}`;
};
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
    ...(pace(t) ? fact('Скорость и сроки', pace(t)) : []),
    ...(compare(t) ? fact(`К прошлому месяцу (${report.prev_month_name})`, compare(t)) : []),
    ...(resign(t) ? fact('После Ваших возвратов', resign(t)) : []),
    ...(signedAi(t) ? fact('Подпись экспертов', signedAi(t), signedWarn(t) ? 'warn' : '') : []),
    ...(egrnFirst(t) ? fact('Выписка ЕГРН', egrnFirst(t), t.egrn_first ? 'warn' : '') : []),
    ...(orderFirst(t) ? fact('Заявка и задание на оценку', orderFirst(t), t.order_first ? 'warn' : '') : []),
    ...(report.current && t.overdue_now ? fact('Просрочено сейчас', String(t.overdue_now), 'overdue') : []),
    ...fact('Вознаграждение за сданные', rub(t.fee_kop), 'money-sum'),
    ...fact('Выплачено экспертам', rub(t.paid_kop)));
  const svc = report.by_service ?? [];
  $('org-report-services-box').classList.toggle('hidden', !svc.length);
  $('org-report-services').replaceChildren(...svc.map((x) => el('li', { 'data-report-service': x.service },
    el('div', { class: 'title', text: `${x.name} — ${x.done}` }),
    el('div', { class: 'muted', text: [x.done_late ? `позже срока: ${x.done_late}` : null,
      x.avg_days != null ? `в среднем ${daysRu(x.avg_days)} от принятия до сдачи` : null, `вознаграждение: ${rub(x.fee_kop)}`,
      `${x.experts === 1 ? 'один эксперт' : `экспертов: ${x.experts}`}`].filter(Boolean).join(' · ') }))));
  const top = report.top_remarks ?? [];
  $('org-report-remarks-box').classList.toggle('hidden', !top.length);
  $('org-report-remarks').replaceChildren(...top.map((x) => el('li', { 'data-remark': '' },
    el('span', { text: x.text }),
    el('span', { class: 'muted', text: ` — ${times(x.n)}${x.experts > 1 ? `, у ${experts(x.experts)}` : ''}` }))));
  $('org-report').replaceChildren(...report.experts.map((x) => el('li', { 'data-report-expert': x.user_id },
    el('div', { class: 'title', text: x.full_name }),
    el('div', { class: 'muted', text: `принял: ${x.accepted} · сдано: ${x.done}` }),
    ...(x.done_late || x.overdue_now ? [el('div', { class: 'overdue', text: [x.done_late ? `позже срока: ${x.done_late}` : null,
      x.overdue_now ? `просрочено сейчас: ${x.overdue_now}` : null].filter(Boolean).join(' · ') })] : []),
    ...(x.services?.length ? [el('div', { class: 'muted', 'data-expert-services': '', text: `по услугам: ${
      x.services.map((s) => `${s.name} — ${s.n}`).join(', ')}` })] : []),
    ...(pace(x) ? [el('div', { class: 'muted', 'data-expert-pace': '', text: pace(x) })] : []),
    ...(compare(x) ? [el('div', { class: 'muted', 'data-expert-prev': '', text: `к прошлому месяцу: ${compare(x)}` })] : []),
    ...(x.returned_head || x.returned_dispatcher ? [el('div', { class: 'muted', text: `возвращено: ${[
      x.returned_head ? `Вами — ${x.returned_head}` : null, x.returned_dispatcher ? `на доработку — ${x.returned_dispatcher}` : null,
    ].filter(Boolean).join(', ')}` })] : []),
    ...(resign(x) ? [el('div', { class: 'muted', 'data-expert-resign': '', text: `после Ваших возвратов: ${resign(x)}` })] : []),
    ...(signedAi(x) ? [el('div', { class: signedWarn(x) ? 'warn' : 'muted', 'data-expert-signed': '', text: signedAi(x) })] : []),
    ...(egrnFirst(x) ? [el('div', { class: x.egrn_first ? 'warn' : 'muted', 'data-expert-egrn': '', text: egrnFirst(x) })] : []),
    ...(orderFirst(x) ? [el('div', { class: x.order_first ? 'warn' : 'muted', 'data-expert-order': '', text: orderFirst(x) })] : []),
    ...(x.remarks?.length ? [el('div', { class: 'muted', 'data-expert-remarks': '', text: `частые замечания: ${
      x.remarks.map((m) => `«${m.text}»${m.n > 1 ? ` ×${m.n}` : ''}`).join(', ')}` })] : []),
    el('div', { class: 'muted', text: `вознаграждение за сданные: ${rub(x.fee_kop)} · выплачено: ${rub(x.paid_kop)}` }))));
}
