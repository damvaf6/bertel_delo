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
// Подпись организации (2.366): сколько дней в среднем от принятия дела до подписи организации и сколько файл ждал её после
// подписи эксперта.
// Задание на оценку от банка (2.309): сколько раз эксперты просили его у заказчика, сколько пришло и через сколько дней.
// Возвраты диспетчера на доработку (2.376): сколько раз, по скольким делам и с какими причинами — по организации и у
// каждого эксперта.
// Частые замечания (2.105) — пункты, с которыми руководитель чаще всего возвращал отчёты: по организации и у каждого эксперта.
// Сводка за год (2.408): в выборе — и годы (текущий и прошлый); то же за весь год, сравнение с прошлым годом и сданные по
// месяцам — в итоге и у каждого эксперта (только месяцы, где что-то сдано). Таблица и архив — за тот же год.
import { api, el, say } from '/common.js';
import { rub } from '/money.js';

// Частые пункты замечаний (2.105): «Нет даты осмотра» — 3 раза, у 2 экспертов.
const times = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'раз' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'раза' : 'раз'}`;
const experts = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'эксперта' : 'экспертов'}`;

// «в 1 деле», «в 3 делах».
const casesRu = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'деле' : 'делах'}`;
// 2.437: «2 дела», и строка о замечаниях к сданным отчётам — сколько дел, сколько раз, пунктов.
const casesN = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'дело' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'дела' : 'дел'}`;
const afterRemarks = (x) => [`замечания к сданному отчёту пришли по ${x.remarks_after_cases === 1 ? 'одному делу' : `${x.remarks_after_cases} делам`}`,
  x.remarks_after > x.remarks_after_cases ? `всего ${times(x.remarks_after)}` : null,
  x.remarks_after_items ? `пунктов: ${x.remarks_after_items}` : null].filter(Boolean).join(' · ');
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
  x.order_rules?.length ? `чаще: ${x.order_rules.map((r) => `${r.title} — ${r.n}`).join(', ')}` : null,
  // 2.297: «по заданию чаще: адрес — 2, дата оценки — 1».
  x.order_task_kinds?.length ? `по заданию чаще: ${x.order_task_kinds.map((r) => `${r.title} — ${r.n}`).join(', ')}` : null]
    .filter(Boolean).join(' · ');
};
// 2.289: «до первой подписи исправлено кнопкой в черновике: 3 в 2 делах (по выписке ЕГРН — 2, по заданию на оценку — 1)»;
// ничего не заменяли — пусто.
const swapFirst = (x) => {
  if (!x.swap_first) return '';
  const parts = [x.swap_first_egrn ? `по выписке ЕГРН — ${x.swap_first_egrn}` : null,
    x.swap_first_task ? `по заданию на оценку — ${x.swap_first_task}` : null].filter(Boolean).join(', ');
  return `до первой подписи исправлено кнопкой в черновике: ${x.swap_first} в ${x.swap_first_cases} ${caseWord(x.swap_first_cases)} (${parts})`;
};
// 2.309: «задание на оценку от банка запрошено: 3 в 2 делах · пришло: 2, в среднем через 1,5 дня · ещё ждут: 1»; не
// запрашивали — пусто.
const bankTask = (x) => {
  if (!x.bank_task) return '';
  return [`задание на оценку от банка запрошено: ${x.bank_task}${x.bank_task_cases !== x.bank_task ? ` в ${x.bank_task_cases} ${caseWord(x.bank_task_cases)}` : ''}`,
    x.bank_task_got ? `пришло: ${x.bank_task_got}${x.bank_task_days != null ? `, в среднем через ${x.bank_task_days < 0.1 ? 'меньше 2 часов' : daysRu(x.bank_task_days)}` : ''}` : 'пока не пришло ни одного',
    x.bank_task_wait && x.bank_task_got ? `ещё ждут: ${x.bank_task_wait}` : null].filter(Boolean).join(' · ');
};
// 2.323: «из сданных дел со сроком по заданию на оценку позже него: 1 из 3, в среднем на 2 дня (больше всего — 3 дня)»;
// все в срок — «… позже него — ни одного (из 3)»; таких дел нет — пусто.
const taskLate = (x) => {
  if (!x.task_due_cases) return '';
  if (!x.task_late) return `из сданных дел со сроком по заданию на оценку позже него — ни одного (из ${x.task_due_cases})`;
  return `из сданных дел со сроком по заданию на оценку позже него: ${x.task_late} из ${x.task_due_cases}, в среднем на ${
    daysRu(x.task_late_days)}${x.task_late > 1 && x.task_late_max !== x.task_late_days ? ` (больше всего — ${daysRu(x.task_late_max)})` : ''}`;
};
// 2.346: срок из письма о переносе срока — отдельно: «из сданных дел со сроком по письму о переносе позже него: 1 из 2, в
// среднем на 2 дня»; все в срок — «… позже него — ни одного (из 2)»; таких дел нет — пусто.
const letterLate = (x) => {
  if (!x.letter_cases) return '';
  if (!x.letter_late) return `из сданных дел со сроком по письму о переносе позже него — ни одного (из ${x.letter_cases})`;
  return `из сданных дел со сроком по письму о переносе позже него: ${x.letter_late} из ${x.letter_cases}, в среднем на ${
    daysRu(x.letter_late_days)}${x.letter_late > 1 && x.letter_late_max !== x.letter_late_days ? ` (больше всего — ${daysRu(x.letter_late_max)})` : ''}`;
};
// 2.329: «дела для банка: 4 · задание на оценку пришло после черновика: 1 (25%)»; ни разу — «… ни в одном»; дел для банка
// нет — пусто.
const bankAfter = (x) => {
  if (!x.bank_cases) return '';
  return `дела для банка: ${x.bank_cases} · задание на оценку пришло после черновика: ${x.bank_after
    ? `${x.bank_after} (${x.bank_after_pct}%)` : 'ни в одном'}`;
};
// 2.336: «срок переносили по просьбе эксперта в 3 делах (4 раза) · позже срока по заданию на оценку: 2, письмо о переносе
// есть: 1 из 2»; переносов нет — пусто.
const extMoves = (x) => {
  if (!x.ext_cases) return '';
  return [`срок переносили по просьбе эксперта в ${x.ext_cases} ${caseWord(x.ext_cases)}${x.ext_times !== x.ext_cases ? ` (${times(x.ext_times)})` : ''}`,
    x.ext_need ? `позже срока по заданию на оценку: ${x.ext_need}, письмо о переносе есть: ${x.ext_letter
      ? `${x.ext_letter} из ${x.ext_need}` : 'ни в одном'}` : null].filter(Boolean).join(' · ');
};
const extWarn = (x) => x.ext_letter < x.ext_need;
// 2.358: «письмо о переносе с новым сроком попросили: 3 в 2 делах · пришло: 2, в среднем через 2 дня (дольше всего — 3 дня) ·
// ещё ждут: 1»; не просили — пусто.
const waitRu = (d) => (d < 0.1 ? 'меньше 2 часов' : daysRu(d));
const letterAsk = (x) => {
  if (!x.letter_ask) return '';
  return [`письмо о переносе с новым сроком попросили: ${x.letter_ask}${x.letter_ask_cases !== x.letter_ask ? ` в ${x.letter_ask_cases} ${caseWord(x.letter_ask_cases)}` : ''}`,
    x.letter_ask_got ? `пришло: ${x.letter_ask_got}${x.letter_ask_days != null ? `, в среднем через ${waitRu(x.letter_ask_days)}${
      x.letter_ask_got > 1 && x.letter_ask_max !== x.letter_ask_days ? ` (дольше всего — ${waitRu(x.letter_ask_max)})` : ''}` : ''}` : 'пока не пришло ни одного',
    x.letter_ask_wait && x.letter_ask_got ? `ещё ждут: ${x.letter_ask_wait}` : null].filter(Boolean).join(' · ');
};
// 2.366: «до подписи организации в среднем 6,5 дня от принятия (больше всего — 9 дней; дел: 2) · после подписи эксперта
// файл ждал Вашей подписи в среднем 1,5 дня»; сданных дел с подписью организации нет — пусто.
const orgSign = (x) => {
  if (!x.org_sign_cases) return '';
  return [`до подписи организации в среднем ${daysRu(x.org_sign_days)} от принятия${x.org_sign_cases > 1 && x.org_sign_max !== x.org_sign_days
    ? ` (больше всего — ${daysRu(x.org_sign_max)}; дел: ${x.org_sign_cases})` : x.org_sign_cases > 1 ? ` (дел: ${x.org_sign_cases})` : ''}`,
  x.org_sign_wait != null ? `после подписи эксперта файл ждал Вашей подписи в среднем ${waitRu(x.org_sign_wait)}` : null]
    .filter(Boolean).join(' · ');
};
// «сдано: 5 (было 3, +2) · в срок: 4 (было 4) · возвраты: 1 (было 2, −1)»; у эксперта без дел в обоих месяцах — пусто.
const diff = (now, was) => `${now} (было ${was}${now > was ? `, +${now - was}` : now < was ? `, −${was - now}` : ''})`;
const compare = (x) => {
  if (!x.prev) return '';
  const now = { done: x.done, on_time: x.done - x.done_late, returned: x.returned_head + x.returned_dispatcher };
  if (![now.done, now.returned, x.prev.done, x.prev.returned].some(Boolean)) return '';
  return `сдано: ${diff(now.done, x.prev.done)} · в срок: ${diff(now.on_time, x.prev.on_time)} · возвраты: ${diff(now.returned, x.prev.returned)}`;
};
// 2.408: «январь — 2 · март — 1 (позже срока: 1)»; ничего не сдано — пусто.
const byMonth = (rows) => rows.filter((m) => m.done).map((m) => `${m.name.split(' ')[0]} — ${m.done}${m.done_late ? ` (позже срока: ${m.done_late})` : ''}`).join(' · ');
const fact = (dt, dd, cls) => [el('dt', { text: dt }), el('dd', { text: dd, ...(cls ? { class: cls } : {}) })];

let org = null;
// Период из выбора: «2026» — год (2.408), «2026-10» — месяц.
const periodQ = (p) => (/^\d{4}$/.test(p) ? `year=${p}` : `month=${encodeURIComponent(p)}`);

$('org-report-month').addEventListener('change', () => load($('org-report-month').value));
$('org-report-csv').addEventListener('click', () => {
  if (!org) return;
  // Файл отдаёт сервер по той же учётке (вход — по cookie); страница остаётся на месте.
  location.assign(`/api/orgs/${org.id}/report?format=csv&${periodQ($('org-report-month').value)}`);
});

$('org-report-zip').addEventListener('click', () => {
  if (!org) return;
  location.assign(`/api/orgs/${org.id}/report/archive?${periodQ($('org-report-month').value)}`);
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
    ({ report } = await api('GET', `/api/orgs/${forOrg.id}/report${month ? `?${periodQ(month)}` : ''}`));
  } catch (err) { say($('org-report-msg'), err.message); return; }
  if (org !== forOrg) return;
  // Экспертов, работающих от организации, нет — сводки не показываем (подсказка — в «Делах экспертов»).
  $('org-report-box').classList.toggle('hidden', report.experts.length === 0);
  const sel = $('org-report-month');
  sel.replaceChildren(
    el('optgroup', { label: 'Месяц' }, ...report.months.map((m, i) => el('option', { value: m, text: i === 0 ? `${monthRu(m)} (текущий)` : monthRu(m) }))),
    ...(report.years?.length ? [el('optgroup', { label: 'Год' }, ...report.years.map((y, i) => el('option', { value: y,
      'data-year': '', text: i === 0 ? `${y} год (по сегодня)` : `${y} год` })))] : []));
  sel.value = report.month;
  const prevWord = report.year ? 'году' : 'месяцу';
  const expertMonths = (x) => (x.by_month ? byMonth(x.by_month.map((n, i) => ({ name: report.by_month[i].name, done: n }))) : '');
  const t = report.total;
  $('org-report-zip').classList.toggle('hidden', !t.done);
  $('org-report-zip-note').classList.toggle('hidden', !t.done);
  $('org-report-zip').textContent = `Заключения архивом (${t.done})`;
  $('org-report-total').replaceChildren(
    ...fact(`Итого · ${report.month_name}`, `принято дел: ${t.accepted} · сдано: ${t.done}${t.done_late ? ` (позже срока: ${t.done_late})` : ''}`),
    ...(pace(t) ? fact('Скорость и сроки', pace(t)) : []),
    ...(orgSign(t) ? fact('Подпись организации', orgSign(t)) : []),
    ...(compare(t) ? fact(`К прошлому ${prevWord} (${report.prev_month_name})`, compare(t)) : []),
    ...(report.by_month && byMonth(report.by_month) ? fact('Сдано по месяцам', byMonth(report.by_month)) : []),
    ...(resign(t) ? fact('После Ваших возвратов', resign(t)) : []),
    ...(signedAi(t) ? fact('Подпись экспертов', signedAi(t), signedWarn(t) ? 'warn' : '') : []),
    ...(egrnFirst(t) ? fact('Выписка ЕГРН', egrnFirst(t), t.egrn_first ? 'warn' : '') : []),
    ...(orderFirst(t) ? fact('Заявка и задание на оценку', orderFirst(t), t.order_first ? 'warn' : '') : []),
    ...(swapFirst(t) ? fact('Исправлено кнопкой', swapFirst(t)) : []),
    ...(bankTask(t) ? fact('Задание от банка', bankTask(t), t.bank_task_wait ? 'warn' : '') : []),
    ...(taskLate(t) ? fact('Срок по заданию на оценку', taskLate(t), t.task_late ? 'warn' : '') : []),
    ...(letterLate(t) ? fact('Срок по письму о переносе', letterLate(t), t.letter_late ? 'warn' : '') : []),
    ...(bankAfter(t) ? fact('Дела для банка', bankAfter(t), t.bank_after ? 'warn' : '') : []),
    ...(extMoves(t) ? fact('Переносы срока', extMoves(t), extWarn(t) ? 'warn' : '') : []),
    ...(letterAsk(t) ? fact('Письмо с новым сроком', letterAsk(t), t.letter_ask_wait ? 'warn' : '') : []),
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
  const disp = report.disp_reasons ?? [];
  $('org-report-disp-box').classList.toggle('hidden', !report.total.returned_dispatcher);
  $('org-report-disp-total').textContent = report.total.returned_dispatcher
    ? `Возвращено на доработку: ${report.total.returned_dispatcher}, в ${casesRu(report.total.returned_dispatcher_cases)}.` : '';
  $('org-report-disp').replaceChildren(...disp.map((x) => el('li', { 'data-disp-reason': '' },
    el('span', { text: x.text }),
    el('span', { class: 'muted', text: ` — ${times(x.n)}${x.experts > 1 ? `, у ${experts(x.experts)}` : ''}` }))));
  // 2.437: замечания к сданным отчётам от банка и суда — по пользователям отчёта и частые пункты.
  $('org-report-after-box').classList.toggle('hidden', !report.total.remarks_after);
  $('org-report-after-total').textContent = report.total.remarks_after ? afterRemarks(report.total) : '';
  $('org-report-after-users').replaceChildren(...(report.after_by_user ?? []).map((x) => el('li', { 'data-after-user': x.id },
    el('div', { class: 'title', text: `${x.name} — ${casesN(x.cases)}` }),
    el('div', { class: 'muted', text: [x.n > x.cases ? `замечания приходили ${times(x.n)}` : null,
      x.items ? `пунктов: ${x.items}` : 'на пункты ещё не разобраны',
      x.top.length ? `чаще всего: ${x.top.map((m) => `«${m.text}»${m.n > 1 ? ` ×${m.n}` : ''}`).join(', ')}` : null]
      .filter(Boolean).join(' · ') }))));
  const after = report.after_remarks ?? [];
  $('org-report-after').previousElementSibling.classList.toggle('hidden', !after.length);
  $('org-report-after').replaceChildren(...after.map((x) => el('li', { 'data-after-remark': '' },
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
    ...(orgSign(x) ? [el('div', { class: 'muted', 'data-expert-orgsign': '', text: orgSign(x) })] : []),
    ...(compare(x) ? [el('div', { class: 'muted', 'data-expert-prev': '', text: `к прошлому ${prevWord}: ${compare(x)}` })] : []),
    ...(expertMonths(x) ? [el('div', { class: 'muted', 'data-expert-months': '', text: `по месяцам: ${expertMonths(x)}` })] : []),
    ...(x.returned_head || x.returned_dispatcher ? [el('div', { class: 'muted', text: `возвращено: ${[
      x.returned_head ? `Вами — ${x.returned_head}` : null, x.returned_dispatcher ? `на доработку — ${x.returned_dispatcher}` : null,
    ].filter(Boolean).join(', ')}` })] : []),
    ...(x.disp_reasons?.length ? [el('div', { class: 'muted', 'data-expert-disp': '', text: `причины возврата на доработку: ${
      x.disp_reasons.map((m) => `«${m.text}»${m.n > 1 ? ` ×${m.n}` : ''}`).join(', ')}` })] : []),
    ...(resign(x) ? [el('div', { class: 'muted', 'data-expert-resign': '', text: `после Ваших возвратов: ${resign(x)}` })] : []),
    ...(signedAi(x) ? [el('div', { class: signedWarn(x) ? 'warn' : 'muted', 'data-expert-signed': '', text: signedAi(x) })] : []),
    ...(egrnFirst(x) ? [el('div', { class: x.egrn_first ? 'warn' : 'muted', 'data-expert-egrn': '', text: egrnFirst(x) })] : []),
    ...(orderFirst(x) ? [el('div', { class: x.order_first ? 'warn' : 'muted', 'data-expert-order': '', text: orderFirst(x) })] : []),
    ...(swapFirst(x) ? [el('div', { class: 'muted', 'data-expert-swap': '', text: swapFirst(x) })] : []),
    ...(bankTask(x) ? [el('div', { class: x.bank_task_wait ? 'warn' : 'muted', 'data-expert-banktask': '', text: bankTask(x) })] : []),
    ...(taskLate(x) ? [el('div', { class: x.task_late ? 'warn' : 'muted', 'data-expert-tasklate': '', text: taskLate(x) })] : []),
    ...(letterLate(x) ? [el('div', { class: x.letter_late ? 'warn' : 'muted', 'data-expert-letterlate': '', text: letterLate(x) })] : []),
    ...(bankAfter(x) ? [el('div', { class: x.bank_after ? 'warn' : 'muted', 'data-expert-bankafter': '', text: bankAfter(x) })] : []),
    ...(extMoves(x) ? [el('div', { class: extWarn(x) ? 'warn' : 'muted', 'data-expert-ext': '', text: extMoves(x) })] : []),
    ...(letterAsk(x) ? [el('div', { class: x.letter_ask_wait ? 'warn' : 'muted', 'data-expert-letterask': '', text: letterAsk(x) })] : []),
    ...(x.remarks_after ? [el('div', { class: 'warn', 'data-expert-after': '', text: `${afterRemarks(x)}${
      x.after_remarks?.length ? `; чаще всего: ${x.after_remarks.map((m) => `«${m.text}»${m.n > 1 ? ` ×${m.n}` : ''}`).join(', ')}` : ''}` })] : []),
    ...(x.remarks?.length ? [el('div', { class: 'muted', 'data-expert-remarks': '', text: `частые замечания: ${
      x.remarks.map((m) => `«${m.text}»${m.n > 1 ? ` ×${m.n}` : ''}`).join(', ')}` })] : []),
    el('div', { class: 'muted', text: `вознаграждение за сданные: ${rub(x.fee_kop)} · выплачено: ${rub(x.paid_kop)}` }))));
}
