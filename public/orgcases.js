// Дела экспертов (2.16, устав 1а): руководитель организации видит дела, которые ведут эксперты от неё, — услугу, номер,
// срок (просрочено — крупно), состояние, эксперта и вознаграждение; нагрузку по экспертам и деньги за месяц.
// Заказчика, поля заявки, документы и переписку по заявке — нет (их сервер и не присылает); внутренняя переписка
// с экспертом (2.28) — у каждого дела.
// Дело в работе руководитель передаёт другому эксперту организации (2.62); предложенное и ещё не принятое — отдаёт другому
// или забирает назад, не дожидаясь отказа (2.76).
// Отбор одной кнопкой (2.102): горит, ждёт моей подписи, вернул эксперту, просят перенести срок, предложено и молчит —
// с числом дел; работает вместе с поиском.
// Эксперт просит передать дело коллеге (2.107): причина и выбор, кому, — «Передать» одной кнопкой или «Отказать».
// «Напомнить эксперту» о деле в работе (2.125) — одной кнопкой, раз в сутки.
// Отбор по эксперту и «Срок на этой неделе» (2.127) — вместе с отбором 2.102 и поиском.
// Отбор «Срок по заданию на этой неделе» (2.325): срок из задания на оценку раньше срока дела — ближайший первым.
// Сколько дней по делу ничего не происходило и отбор «Без движения» (2.133) — переписка с заказчиком не в счёт.
// Отбор «Без движения 5 дней и дольше» (2.368): дело в работе стоит у эксперта (документы от заказчика не ждём) — дольше всех
// стоящие первыми; «Напомнить всем» — одним нажатием по каждому делу, где сегодня ещё не напоминали.
// Отбор «Срок прошёл» (2.158): только просроченные, дольше всех просроченные — первыми; на сколько дней — у дела.
// Отбор «Исправленный файл ждёт подписи эксперта» (2.171): после возврата эксперт загрузил новый файл, но не подписал —
// дольше всех ждущие первыми; 2 дня и дольше — строка красная.
// Отбор «Осмотр не закончен» (2.216): владелец нажал «Готово», сняв не всё, или ссылка перестанет действовать в ближайшие
// сутки — «снял не всё» первыми, дольше всех ждущие первыми; затем ссылки, что кончаются раньше.
// Поиск по номеру отчёта эксперта (2.417): в списке — по номеру, выданному делу; не нашлось — сервер ищет среди сданных за этот
// и прошлый год (и по номеру из файла отчёта); дело старше 90 дней — без ссылки, с «Заключениями архивом» за тот месяц.
// «Ждут назначения» (2.17): дела, предложенные диспетчером организации, — руководитель назначает эксперта или отказывается.
import { api, el, say } from '/common.js';
import { expertLink } from '/expertcard.js';
import { awaySpan, dayRu } from '/order.js';
import { rub } from '/money.js';
import { orgChat } from '/orgchat.js';
import { matcher, numberMatch, wireSearch } from '/search.js';
import { loadOrgSchedule } from '/orgschedule.js';
import { pickSignFilter } from '/orgsign.js';
import { showSoonAccreditations } from '/orgaccr.js';
import { newYearCaseText, taskLetterLines, taskMovedText } from '/today.js';

const $ = (id) => document.getElementById(id);
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const PAYOUT_RU = { pending: 'выплата проводится', succeeded: 'выплачено', failed: 'выплата не прошла' };
const timeRu = (s) => new Date(s).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
// Сколько эксперт молчит: «3 ч», «2 дн.» — руководителю видно, пора ли переназначать.
function waited(s) {
  const h = Math.floor((Date.now() - new Date(s).getTime()) / 3_600_000);
  return h < 1 ? 'меньше часа' : h < 24 ? `${h} ч` : `${Math.floor(h / 24)} дн.`;
}
// Эксперт сам не принимает новые дела (2.77): до какого дня и почему, или выключил приём совсем.
const awayText = (a) => (a.away || a.until
  ? `не принимает новые дела ${awaySpan(a.away ?? a)}${(a.away?.note ?? a.note) ? ` (${a.away?.note ?? a.note})` : ''}`
  : 'не принимает новые дела — выключил приём');
const upper = (t) => t[0].toUpperCase() + t.slice(1);
const fact = (dt, dd, cls) => [el('dt', { text: dt }), el('dd', { text: dd, ...(cls ? { class: cls } : {}) })];

// Последний список дел — для поиска (2.73) без нового запроса.
let shown = { org: null, orgObj: null, cases: [] };
wireSearch($('org-cases-search'), () => renderCases());
$('org-cases-expert').addEventListener('change', (e) => { expert = e.target.value; renderCases(); });

// Отборы (2.102): только среди активных дел; кнопка видна, когда есть хоть одно такое дело.
const FILTERS = [
  { id: 'handover', text: 'Просят передать', test: (c) => !!c.handover },
  // 2.228: передать некому, а перенос срока ещё не просят — руководителю «Попросить диспетчера перенести срок» (2.221).
  { id: 'stuck', text: 'Просят передать — передать некому', test: (c) => !!c.handover && !c.transfer_to.length && !c.extend },
  { id: 'overdue', text: 'Срок прошёл', test: (c) => c.overdue },
  { id: 'hot', text: 'Горит', test: (c) => c.hot },
  { id: 'week', text: 'Срок на этой неделе', test: (c) => c.week },
  // 2.325: срок из задания на оценку (письма банка, определения суда) раньше срока дела и на этой неделе — ближайший первым.
  { id: 'task_week', text: 'Срок по заданию на этой неделе', test: (c) => c.task_week },
  // 2.332: перенос срока согласован позже срока по заданию на оценку, а письма банка (определения суда) о переносе нет.
  { id: 'task_moved', text: 'Перенос позже срока по заданию — нет письма', test: (c) => !!c.task_moved && !c.task_moved.letter },
  // 2.348: письмо о переносе пришло, а срок в нём раньше срока дела — сдавать по письму; ближайший срок по письму первым.
  { id: 'task_letter', text: 'Сдать по письму о переносе — раньше срока дела', test: (c) => !!c.task_moved?.letter },
  // 2.209: срок в дни, когда эксперт не принимает дела; о которых эксперт уже просит передать — в «Просят передать».
  // 2.394: за две недели до новогодних каникул — дела в работе со сроком в каникулы (как у эксперта 2.393); ближайший первым.
  { id: 'new_year', text: 'Срок в новогодние каникулы', test: (c) => !!c.new_year },
  { id: 'away', text: 'Эксперт не принимает дела — срок в эти дни', test: (c) => !!c.away && !c.handover },
  // 2.249: эксперт вернулся после дней «не принимаю дела» за последнюю неделю — что изменилось по его делам, пока его не было.
  { id: 'back', text: 'Эксперт вернулся после «не принимаю дела»', test: (c) => !!c.back },
  { id: 'inspect', text: 'Осмотр не закончен', test: (c) => !!c.inspection },
  // 2.427: акт осмотра готов, а владелец, снимавший по ссылке, с ним не ознакомился — суд и банк спросят отметку.
  { id: 'act', text: 'Акт осмотра: владелец не ознакомлен', test: (c) => !!c.act?.owner && !c.act.owner.acked_at },
  { id: 'idle', text: 'Без движения', test: (c) => c.idle },
  { id: 'idle_long', text: 'Без движения 5 рабочих дней и дольше', test: (c) => c.idle_long && c.status === 'in_work' && !c.docs_wait },
  // 2.235: эксперт запросил документы у заказчика, а их ещё нет — почему дело стоит.
  { id: 'docs', text: 'Ждём документы от заказчика', test: (c) => !!c.docs_wait },
  // 2.436: дело снова у эксперта по замечаниям банка или суда к сданному отчёту (2.431) — ближайший срок ответа первым.
  { id: 'remarks', text: 'Замечания к сданному отчёту', test: (c) => !!c.remarks },
  // 2.446: эксперта вызывают в суд по сданному делу (2.441) — дело сдано, поэтому отбор и среди завершённых (`done`);
  // ближайшее заседание первым.
  { id: 'court', text: 'Вызов в суд', test: (c) => !!c.court, done: true },
  { id: 'sign', text: 'Ждёт моей подписи', test: (c) => c.sign_wait > 0 },
  { id: 'returned', text: 'Вернул эксперту', test: (c) => c.returned_open },
  { id: 'fresh', text: 'Исправленный файл ждёт подписи эксперта', test: (c) => !!c.returned?.fresh_file },
  { id: 'extend', text: 'Просят перенести срок', test: (c) => !!c.extend },
  // 2.238: руководитель сам попросил диспетчера перенести срок (2.221) — ждём ответа или отказано (отказы выше).
  { id: 'orgext', text: 'Перенос от организации: ждём ответа / отказано', test: (c) => !!c.org_extend && c.org_extend.state !== 'approved' },
  { id: 'silent', text: 'Предложено, молчит', test: (c) => c.status === 'awaiting_executor' },
];
let filter = null;
// Подпись организации ждёт два дня и дольше (2.148) — строка красная, в отборе «Ждёт моей подписи» такие дела выше.
const SIGN_LONG_DAYS = 2;
// 2 рабочих дня и дольше (2.383) — считает сервер.
const signLong = (c) => !!c.sign_long;
const signSinceText = (c) => [`Эксперт подписал ${timeRu(c.sign_since)} — ждёт ${waited(c.sign_since)}`,
  c.sign_reminded_at ? `напомнил ${timeRu(c.sign_reminded_at)}` : null].filter(Boolean).join(' · ');
// Возврат эксперту (2.151): когда вернул и сколько пунктов замечания эксперт уже отметил исправленными.
function returnedText(c) {
  const r = c.returned;
  const when = r ? ` ${timeRu(r.at)} (${waited(r.at)} назад)` : '';
  const state = !r?.items ? 'ждём исправления'
    : r.fixed === r.items ? `эксперт отметил исправленным всё (${r.fixed} из ${r.items}) — ждём его подписи`
      : `эксперт отметил исправленными ${r.fixed} из ${r.items}`;
  return `Вы вернули отчёт эксперту${when} — ${state}`;
}
// Исправленный файл после возврата загружен, эксперт его ещё не подписал (2.171).
const freshLong = (c) => Date.now() - new Date(c.returned.fresh_file.at).getTime() >= SIGN_LONG_DAYS * 86_400_000;
const freshText = (c) => `Эксперт загрузил исправленный файл ${timeRu(c.returned.fresh_file.at)} — ещё не подписал (${waited(c.returned.fresh_file.at)})`;
// Чьи дела показать (2.127): номер эксперта или '' — все.
let expert = '';
// Сколько сдавать за две недели (2.111) — у каждого эксперта в выборе «кому передать».
let due14 = new Map();
const pickText = (x) => `${x.full_name} · сдать за 2 недели: ${due14.get(x.user_id) ?? 0}`;

export async function loadOrgCases(org) {
  const { pending, cases, load, money } = await api('GET', `/api/orgs/${org.id}/cases`);
  // Другая организация — поиск с чистого листа; та же (передали дело, подписали) — запрос остаётся.
  if (shown.org !== org.id) { $('org-cases-search').value = ''; filter = null; expert = ''; }
  shown = { org: org.id, orgObj: org, cases };
  $('org-cases-box').classList.remove('hidden');
  $('org-pending-box').classList.toggle('hidden', pending.length === 0);
  $('org-pending').replaceChildren(...pending.map((p) => pendingItem(org, p)));
  const month = MONTHS[Number(money.month.slice(5, 7)) - 1];
  $('org-cases-money').replaceChildren(
    ...fact(`Выплачено экспертам · ${month}`, rub(money.paid_kop), 'money-sum'),
    ...fact('Ждёт выдачи результата', rub(money.waiting_kop)));
  // Экспертов, работающих от организации, ещё нет (2.67) — вместо пустой «Нагрузки» подсказка и переход к приглашению.
  $('org-cases-load-title').classList.toggle('hidden', load.length === 0);
  $('org-no-experts').classList.toggle('hidden', load.length > 0);
  $('org-cases-load').replaceChildren(...load.map((l) => el('li', { 'data-expert': l.user_id },
    el('div', { class: 'title', text: l.full_name }),
    el('div', { class: `muted${l.overdue ? ' overdue' : ''}`, text: [`в работе: ${l.in_work}`, l.offered ? `предложено: ${l.offered}` : null,
      l.overdue ? `просрочено: ${l.overdue}` : null].filter(Boolean).join(' · ') }),
    // Ближайший срок (2.90): кому ещё можно дать дело — видно сразу.
    ...(l.next_deadline && !l.overdue ? [el('div', { class: 'muted', 'data-next': '', text: `ближайший срок ${dayRu(l.next_deadline)}` })] : []),
    ...(l.away || l.paused ? [el('div', { class: 'muted', 'data-away': '', text: upper(awayText(l)) })] : []),
    // Дела этого эксперта (2.127) — одной кнопкой: тот же отбор, что в списке дел ниже.
    ...(cases.some((c) => c.expert_id === l.user_id) && new Set(cases.map((c) => c.expert_id)).size > 1
      ? [el('button', { type: 'button', class: 'secondary', 'data-action': 'expert-cases', onclick: () => showExpert(l.user_id) }, 'Дела эксперта')] : []),
    expertLink(l.user_id))));
  $('org-cases-empty').classList.toggle('hidden', cases.length > 0 || pending.length > 0 || load.length === 0);
  due14 = new Map(load.map((l) => [l.user_id, l.due14]));
  renderCases();
  // Нагрузка на две недели (2.111) — отдельным запросом, список дел её не ждёт.
  loadOrgSchedule(org);
}

// Поиск по делам экспертов (2.73): номер (2.165: и полный — из письма или ссылки), вид услуги, эксперт, состояние.
// Адреса и заказчика руководитель не видит (2.16) — по ним и не ищется. Строка поиска — когда дел больше одного.
function renderCases() {
  const { orgObj: org, cases } = shown;
  if (!org) return;
  $('org-cases-search-box').classList.toggle('hidden', cases.length < 2);
  const q = cases.length < 2 ? '' : $('org-cases-search').value;
  const hit = matcher(q);
  renderExperts(cases);
  const mine = expert ? cases.filter((c) => c.expert_id === expert) : cases;
  // Отбор, по которому дел не осталось (подписали, эксперт ответил), снимается сам.
  const counts = new Map(FILTERS.map((f) => [f.id, mine.filter((c) => (c.active || f.done) && f.test(c)).length]));
  // Из утренней сводки «task_moved» (2.338): там и дела, где письмо пришло со сроком раньше (2.335), — к их отбору (2.348).
  if (filter === 'task_moved' && !counts.get(filter) && counts.get('task_letter')) filter = 'task_letter';
  if (filter && !counts.get(filter)) filter = null;
  const chosen = FILTERS.find((f) => f.id === filter);
  renderFilters(counts);
  const found = mine.filter((c) => hit([c.order_ref, c.id, c.service, c.expert, c.status_name, c.report_number ?? ''].join(' '))
    && (!chosen || ((c.active || chosen.done) && chosen.test(c))));
  const active = found.filter((c) => c.active);
  // «Ждёт моей подписи» (2.148): дольше всех ждущие — первыми.
  if (filter === 'sign') active.sort((a, b) => new Date(a.sign_since) - new Date(b.sign_since));
  // «Срок прошёл» (2.158): дольше всех просроченные — первыми.
  if (filter === 'overdue') active.sort((a, b) => b.overdue_days - a.overdue_days);
  // «Исправленный файл ждёт подписи эксперта» (2.171): дольше всех ждущие — первыми.
  if (filter === 'fresh') active.sort((a, b) => new Date(a.returned.fresh_file.at) - new Date(b.returned.fresh_file.at));
  // «Эксперт не принимает дела — срок в эти дни» (2.209): ближайший срок — первым.
  if (filter === 'orgext') {
    active.sort((a, b) => (a.org_extend.state === b.org_extend.state ? new Date(b.org_extend.decided_at ?? b.org_extend.requested_at)
      - new Date(a.org_extend.decided_at ?? a.org_extend.requested_at) : a.org_extend.state === 'declined' ? -1 : 1));
  }
  if (filter === 'idle_long') active.sort((a, b) => b.last_move.work_days - a.last_move.work_days || b.last_move.days - a.last_move.days);
  if (filter === 'remarks') active.sort((a, b) => String(a.remarks.due).localeCompare(String(b.remarks.due)));
  if (filter === 'docs') active.sort((a, b) => new Date(a.docs_wait.since) - new Date(b.docs_wait.since));
  if (filter === 'back') active.sort((a, b) => b.back.until.localeCompare(a.back.until) || String(a.deadline).localeCompare(String(b.deadline)));
  if (filter === 'task_week') active.sort((a, b) => a.task_due.day.localeCompare(b.task_due.day));
  if (filter === 'task_moved' || filter === 'task_letter') active.sort((a, b) => a.task_moved.day.localeCompare(b.task_moved.day));
  if (filter === 'new_year') active.sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)));
  if (filter === 'away') active.sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)));
  if (filter === 'inspect') active.sort((a, b) => (a.inspection.kind === b.inspection.kind
    ? new Date(a.inspection.at) - new Date(b.inspection.at) : a.inspection.kind === 'incomplete' ? -1 : 1));
  const done = found.filter((c) => !c.active);
  if (filter === 'court') done.sort((a, b) => new Date(a.court.next.hearing_at) - new Date(b.court.next.hearing_at));
  const none = cases.length > 0 && !found.length;
  $('org-cases-none').classList.toggle('hidden', !none);
  const who = expert ? ` у эксперта «${mine[0]?.expert ?? ''}»` : '';
  $('org-cases-none').textContent = !none ? '' : chosen
    ? `По отбору «${chosen.text}»${who} ничего не найдено${q.trim() ? ` по «${q.trim()}»` : ''}. Нажмите «Все»${expert ? ' или выберите «Все эксперты»' : ''}, чтобы искать по всем делам.`
    : expert ? `У эксперта «${mine[0]?.expert ?? ''}» ничего не найдено по «${q.trim()}». Выберите «Все эксперты», чтобы искать по всем делам.`
      : `Ничего не найдено по «${q.trim()}». Ищите по номеру дела или отчёта, виду услуги или эксперту.`;
  // Ни у одного дела в списке номер отчёта не совпал — ищем и среди сданных раньше (цифры запроса найдутся и в номере дела).
  const byNumber = found.some((c) => c.report_number && numberMatch(q, c.report_number));
  findNumber(org, !chosen && !expert && !byNumber && /\d/.test(q) ? q.trim() : '', new Set(found.map((c) => c.id)));
  renderRemindAll(org, filter === 'idle_long' ? active : []);
  $('org-cases').replaceChildren(
    ...active.map((c) => caseItem(org, c)),
    ...(done.length ? [el('li', { class: 'group', text: `Завершённые · ${done.length}` })] : []),
    ...done.map((c) => caseItem(org, c)));
}

// Номер отчёта не нашёлся в списке (2.417): через полсекунды после набора — поиск на сервере; ответ на устаревший запрос не
// показываем. Пустой запрос — блок прячется.
let numberSeq = 0;
let numberTimer = null;
const OLD_CASE = 'Сдано больше 90 дней назад — в «Делах экспертов» его уже нет; файлы отчёта — в «Заключениях архивом» сводки за тот месяц';
function findNumber(org, q, listed) {
  clearTimeout(numberTimer);
  const box = $('org-cases-number');
  const my = ++numberSeq;
  if (!q) { box.classList.add('hidden'); box.replaceChildren(); return; }
  numberTimer = setTimeout(async () => {
    let r;
    try { r = await api('GET', `/api/orgs/${org.id}/cases/number?q=${encodeURIComponent(q)}`); } catch { r = null; }
    if (my !== numberSeq || !r) return;
    // Что уже видно в списке выше — не повторяем; ничего не нашлось, а в списке что-то есть — блок не нужен.
    r.found = r.found.filter((f) => !listed.has(f.id));
    if (!r.found.length && listed.size) { box.classList.add('hidden'); box.replaceChildren(); return; }
    box.classList.remove('hidden');
    box.replaceChildren(
      el('p', { class: 'muted', 'data-role': 'number-head', text: r.found.length
        ? `Номер отчёта «${q}» — среди сданных за этот и прошлый год:`
        : `Номер отчёта «${q}» не нашёлся и среди сданных экспертами организации за этот и прошлый год.` }),
      ...(r.found.length ? [el('ul', { class: 'list' }, ...r.found.map((f) => numberItem(org, f)))] : []));
  }, 500);
}

function numberItem(org, f) {
  return el('li', { 'data-number-case': f.order_ref },
    el('div', { class: 'title', text: `Отчёт № ${f.number} · ${f.service}` }),
    el('div', { class: 'muted', text: [`дело ${f.order_ref}`, `эксперт: ${f.expert}`, f.status_name,
      f.done_on ? `сдано ${dayRu(f.done_on)}` : null].filter(Boolean).join(' · ') }),
    ...(f.in_cases
      ? [el('button', { type: 'button', class: 'secondary', 'data-action': 'show-case', onclick: () => {
        $('org-cases-search').value = f.order_ref; renderCases();
      } }, 'Показать дело')]
      : [el('div', { class: 'muted', 'data-role': 'old-case', text: OLD_CASE }),
        ...(f.archive ? [el('button', { type: 'button', class: 'secondary', 'data-action': 'number-archive',
          onclick: () => location.assign(`/api/orgs/${org.id}/report/archive?month=${encodeURIComponent(f.archive.month)}`) },
        `Заключения архивом за ${f.archive.name}`)] : [])]));
}

// Выбор эксперта (2.127): когда дела ведут хотя бы двое — «Все эксперты» и каждый с числом его дел в работе и всего.
// Эксперт, у которого дел не осталось, из выбора уходит, отбор снимается сам.
function renderExperts(cases) {
  const by = new Map();
  for (const c of cases) {
    const x = by.get(c.expert_id) ?? { name: c.expert, all: 0, active: 0 };
    x.all += 1; if (c.active) x.active += 1;
    by.set(c.expert_id, x);
  }
  if (!by.has(expert)) expert = '';
  $('org-cases-expert-box').classList.toggle('hidden', by.size < 2);
  const sel = $('org-cases-expert');
  sel.replaceChildren(el('option', { value: '', text: `Все эксперты · дел: ${cases.length}` }),
    ...[...by].sort((a, b) => a[1].name.localeCompare(b[1].name, 'ru')).map(([id, x]) => el('option', { value: id,
      text: `${x.name} · в работе: ${x.active}${x.all > x.active ? `, всего: ${x.all}` : ''}` })));
  sel.value = expert;
}

// «Дела эксперта» из нагрузки (2.127): выбрать эксперта и показать его дела.
function showExpert(id) {
  expert = id; filter = null;
  renderCases();
  $('org-cases-expert-box').scrollIntoView({ block: 'start' });
}

// Кнопки отбора: «Все» и те, по которым есть дела, с числом. Ни одного отбора — строки нет.
function renderFilters(counts) {
  const box = $('org-cases-filter');
  const used = FILTERS.filter((f) => counts.get(f.id));
  box.classList.toggle('hidden', used.length === 0);
  const chip = (id, text) => el('button', { type: 'button', class: 'secondary', 'data-filter': id ?? 'all',
    'aria-pressed': String(filter === id), onclick: () => { filter = id; renderCases(); } }, text);
  box.replaceChildren(...(used.length ? [chip(null, 'Все'), ...used.map((f) => chip(f.id, `${f.text} · ${counts.get(f.id)}`))] : []));
}

// Вызов в суд (2.446): ближайшее заседание — день, время, суд, адрес; сегодня или в следующий рабочий день — заметно.
// Подал ли эксперт ходатайство «Не смогу прийти» (2.445) и готовы ли письменные пояснения (2.444); заседаний больше — сколько.
function courtLines(c) {
  const h = c.court.next;
  const more = c.court.count > 1 ? ` · ещё заседаний: ${c.court.count - 1}` : '';
  const state = [h.absence ? `эксперт просит ${h.absence}` : null,
    h.explain === 'ready' ? 'письменные пояснения готовы' : h.explain === 'draft' ? 'письменные пояснения готовятся' : null].filter(Boolean).join(' · ');
  return [el('div', { class: h.soon && !h.absence ? 'overdue' : 'muted', 'data-role': 'court',
    text: `Вызов в суд: ${dayRu(h.day)}, ${h.time} · ${h.court}${more}` }),
  el('div', { class: 'muted', 'data-role': 'court-place', text: [h.address, state].filter(Boolean).join(' · ') }),
  // 2.449: в день заседания эксперт не принимает дела — красным, пока нет ходатайства.
  ...(h.away_until ? [el('div', { class: h.absence ? 'muted' : 'overdue', 'data-role': 'court-away',
    text: `в этот день эксперт не принимает дела (до ${dayRu(h.away_until)})${h.absence ? '' : ' — ходатайства нет, свяжитесь с экспертом'}` })] : [])];
}

// Замечания к сданному отчёту (2.436): когда пришли, ответить до, что с пунктами и ответом.
function remarksText(r) {
  const when = new Date(r.at).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
  const points = !r.items ? 'пункты ещё не разобраны'
    : r.left ? `пунктов ${r.items}, без отметки ${r.left}` : `все ${r.items} пунктов отмечены`;
  return [`Замечания к отчёту от ${dayRu(when)}${r.round > 1 ? ` (${r.round}-й раз)` : ''}`,
    r.due ? `ответить до ${dayRu(r.due)}${r.overdue ? ' — срок прошёл' : ''}` : null, points,
    r.answer ? 'ответ на замечания приложен' : null].filter(Boolean).join(' · ');
}

function caseItem(org, c) {
  const late = c.overdue_days ? ` на ${c.overdue_days} дн.` : '';
  const deadline = c.deadline ? `срок ${dayRu(c.deadline)}${c.overdue ? ` · ПРОСРОЧЕНО${late}` : ''}` : 'срок не указан';
  return el('li', { 'data-case': c.order_ref },
    el('div', { class: 'title', text: `${c.service} · ${c.order_ref}` }),
    ...(c.report_number ? [el('div', { class: 'muted', 'data-role': 'report-number', text: `Отчёт № ${c.report_number}` })] : []),
    ...(c.overdue ? [el('div', { class: 'overdue big', text: deadline })] : []),
    // Дело предложено эксперту, он ещё не принял (2.90): «Ждёт исполнителя · эксперт: …» читалось как «уже назначен».
    el('div', { class: 'muted', text: [c.status === 'awaiting_executor' ? 'Предложено эксперту' : c.status_name, `эксперт: ${c.expert}`,
      c.overdue ? null : deadline].filter(Boolean).join(' · ') }),
    // Срок по заданию на оценку раньше срока дела (2.325): прошёл или через 1–2 дня — красным.
    // Перенос согласован позже срока по заданию на оценку, а письма о переносе нет (2.332) — вместо строки «Сдать по заданию».
    // 2.348: письмо пришло, а срок в нём раньше — «Сдать по письму … к …», близко (прошёл или через 1–2 дня) — красным.
    ...(c.task_moved?.letter ? taskLetterLines(c.task_moved) : []),
    ...(c.task_moved && !c.task_moved.letter ? [el('div', { class: c.task_moved.asked ? 'muted' : 'overdue', 'data-role': 'task-moved', text: taskMovedText(c.task_moved) })] : []),
    ...(c.task_due && !c.task_moved ? [el('div', { class: c.task_due.hot ? 'overdue' : 'muted', 'data-role': 'task-due',
      text: `Сдать ${c.task_due.by} — к ${dayRu(c.task_due.day)}${c.task_due.overdue ? ', срок прошёл' : ''} (срок дела позже)` })] : []),
    // 2.436: замечания к сданному отчёту — ответить до …; прошёл, сегодня или в следующий рабочий день — красным.
    ...(c.remarks ? [el('div', { class: c.remarks.hot ? 'overdue' : 'muted', 'data-role': 'remarks', text: remarksText(c.remarks) })] : []),
    // 2.446: эксперта вызывают в суд по сданному делу — ближайшее заседание.
    ...(c.court ? courtLines(c) : []),
    // 2.394: срок в новогодние каникулы — сдать до последнего рабочего дня перед ними.
    ...(c.new_year ? [el('div', { class: 'overdue', 'data-role': 'new-year', text: newYearCaseText(c.new_year) })] : []),
    el('div', { class: 'muted', text: [c.fee_kop != null ? `вознаграждение ${rub(c.fee_kop)}` : 'цена ещё не назначена',
      c.payout ? PAYOUT_RU[c.payout] : null].filter(Boolean).join(' · ') }),
    // Что ждёт руководителя по делу (2.36) — прямо в списке дел, с переходом к подписи.
    // Сколько ждёт и напоминал ли эксперт (2.148): долго ждёт — заметно.
    ...(c.sign_wait ? [el('div', { class: 'row', 'data-role': 'sign-wait' },
      el('span', { class: 'badge warn', text: `Ждёт Вашей подписи: ${c.sign_wait}` }),
      el('button', { class: 'secondary', 'data-action': 'go-sign', onclick: () => goSign(c.order_ref) }, 'К подписи')),
    ...(c.sign_since ? [el('div', { class: signLong(c) ? 'overdue' : 'muted', 'data-role': 'sign-since', text: signSinceText(c) })] : [])] : []),
    ...(c.returned_open ? [el('div', { class: 'muted', 'data-role': 'returned', text: returnedText(c) })] : []),
    ...(c.returned?.fresh_file ? [el('div', { class: freshLong(c) ? 'overdue' : 'muted', 'data-role': 'fresh-file', text: freshText(c) })] : []),
    // Эксперт попросил перенести срок (2.100): решает диспетчер, руководитель видит новую дату.
    ...(c.extend && !c.extend.by_org ? [el('div', { class: 'muted', 'data-role': 'extend',
      text: `Эксперт просит перенести срок на ${dayRu(c.extend.new_deadline)} — ждёт ответа диспетчера` })] : []),
    // Перенос от организации (2.238): ждём ответа диспетчера, отказал (с пояснением) или согласился.
    ...(c.org_extend ? [orgExtendRow(c)] : []),
    // Эксперт не принимает дела до … (2.113), а срок дела — в эти дни: «Передать другому эксперту» сразу открыто.
    ...(c.away && !c.handover ? [el('div', { class: 'notice-warn', 'data-role': 'away',
      text: `Эксперт не принимает дела ${awaySpan(c.away)}${c.away.note ? ` (${c.away.note})` : ''}, а срок дела — в эти дни. ${c.transfer_to?.length
        ? 'Передайте его коллеге.' : 'Передать его некому — попросите эксперта перенести срок.'}` })] : []),
    // Передать некому (2.201): одной кнопкой — эксперту уведомление, дело откроется на просьбе о переносе с готовой причиной.
    ...(c.away && !c.handover && !c.transfer_to?.length && !c.extend && c.remind ? [remindRow(org, c, 'extend')] : []),
    ...(c.back ? [backRow(c)] : []),
    ...(c.inspection ? [inspectRow(c)] : []),
    ...(c.act ? [actRow(c)] : []),
    ...(c.docs_wait ? [docsRow(c)] : []),
    ...(c.last_move ? [moveRow(c)] : []),
    ...(c.remind ? [remindRow(org, c)] : []),
    ...(c.handover && c.status === 'in_work' ? [handoverBlock(org, c)] : []),
    ...(c.status === 'in_work' && !c.handover ? [transferDetails(org, c)] : []),
    ...(c.offer_wait ? offerWait(org, c) : []),
    // Предложил диспетчер — переназначает тоже он; руководитель видит, сколько эксперт молчит.
    ...(c.status === 'awaiting_executor' && !c.offer_wait ? [el('div', { class: 'muted', 'data-role': 'offer-wait',
      text: c.offered_at ? `Предложил диспетчер ${timeRu(c.offered_at)} (${waited(c.offered_at)}) — эксперт ещё не ответил`
        : 'Предложил диспетчер — эксперт ещё не ответил' })] : []),
    chatDetails(c));
}

// Открыть организацию сразу на нужном деле (2.67): из уведомления или «Сегодня» — назначить, подписать, ответить эксперту.
export function focusOrgCase({ ref, to }) {
  // Поиск мог спрятать нужное дело — переход из уведомления важнее.
  if ($('org-cases-search').value || filter || expert) { $('org-cases-search').value = ''; filter = null; expert = ''; renderCases(); }
  const r = CSS.escape(ref);
  if (to === 'sign' && document.querySelector(`#org-sign li[data-item="${r}"]`)) return goSign(ref);
  const li = (to === 'pending' && document.querySelector(`#org-pending li[data-pending="${r}"]`))
    || document.querySelector(`#org-cases li[data-case="${r}"]`);
  if (!li) return;
  if (to === 'chat') li.querySelector('details[data-chat]')?.setAttribute('open', '');
  // Из «Сегодня» (2.113): эксперт не принимает дела — сразу к выбору, кому передать.
  if (to === 'transfer') {
    li.querySelector('details[data-transfer]')?.setAttribute('open', '');
    li.querySelector('select[data-transfer-pick]')?.focus({ preventScroll: true });
    // Передать некому (2.201) — к кнопке «Напомнить эксперту попросить перенос срока».
    li.querySelector('[data-action="remind-extend"]')?.focus({ preventScroll: true });
  }
  if (to === 'handover') li.querySelector('[data-handover]')?.querySelector('select, button')?.focus({ preventScroll: true });
  li.scrollIntoView({ block: 'start' });
  li.classList.add('flash');
  setTimeout(() => li.classList.remove('flash'), 2000);
}

// Эксперт вернулся после дней «не принимаю дела» (2.249): когда вернулся и с какого дня не принимал — сегодня заметно.
function backRow({ back: b }) {
  const span = b.since ? ` (с ${dayRu(b.since)})` : '';
  return el('div', { class: b.today ? 'notice-warn' : 'muted', 'data-role': 'back',
    text: `Эксперт ${b.today ? 'сегодня вернулся' : `вернулся ${dayRu(b.until)}`} после дней «не принимаю дела»${span} — посмотрите, что изменилось по делу, пока его не было.` });
}

// Последнее движение по делу (2.133): смена состояния, файл эксперта, черновик, проверка, аналог, подпись, осмотр.
// Три дня и больше — «Без движения», заметно; рядом «Напомнить эксперту».
// Осмотр не закончен (2.216): что не снято и попросил ли эксперт доснять, или когда кончится ссылка владельцу.
function inspectRow({ inspection: i }) {
  const text = i.kind === 'incomplete'
    ? `Осмотр не закончен: владелец нажал «Готово» ${timeRu(i.at)}, а не снял: ${i.missing.join(', ')}. ${i.asked
      ? `Эксперт попросил доснять${i.asked < i.missing.length ? ` (${i.asked} из ${i.missing.length})` : ''} — новую ссылку ещё не выдал.`
      : 'Эксперт ещё не попросил доснять.'}`
    : `Осмотр не закончен: ссылка владельцу перестанет действовать ${timeRu(i.at)}, а «Готово» не нажато${i.photos
      ? ` (фото пришло: ${i.photos})` : ' — фото ещё нет'}.`;
  return el('div', { class: i.kind === 'incomplete' ? 'notice-warn' : 'muted', 'data-role': 'inspect', text });
}

// Акт осмотра (2.427): готов (фото осмотра есть, съёмка закончена) и ознакомился ли владелец. Не ознакомился — заметно;
// 30 дней после «Готово» прошли — по старой ссылке уже нельзя, эксперт выдаёт новую.
function actRow({ act: a }) {
  const o = a.owner;
  const owner = !o ? null : o.acked_at ? `владелец ознакомлен ${timeRu(o.acked_at)}`
    : o.open ? 'владелец ещё не ознакомлен' : 'владелец не ознакомлен, а по прежней ссылке уже нельзя — эксперт может выдать новую';
  return el('div', { class: o && !o.acked_at ? 'notice-warn' : 'muted', 'data-role': 'act',
    text: [`Акт осмотра готов (фото: ${a.photos})`, owner].filter(Boolean).join(' · ') });
}

// Ждём документы от заказчика (2.235): что запросил эксперт, сколько дней ждём самый старый, напоминал ли заказчику (2.234).
// Три дня и дольше — заметно: дело стоит не по вине эксперта.
function docsRow({ docs_wait: w }) {
  const ago = w.days === 0 ? 'с сегодняшнего дня' : w.days === 1 ? 'со вчерашнего дня' : `${w.days} дн.`;
  const text = [`Ждём документы от заказчика ${ago}: ${w.titles.join(', ')}`,
    w.reminded_at ? `эксперт напоминал заказчику ${timeRu(w.reminded_at)}` : w.long ? 'эксперт заказчику ещё не напоминал' : null]
    .filter(Boolean).join(' · ');
  return el('div', { class: w.long ? 'notice-warn' : 'muted', 'data-role': 'docs-wait', text });
}

// Перенос срока по просьбе организации (2.221, 2.238): что ответил диспетчер. Отказал — заметно, и что делать дальше.
function orgExtendRow({ org_extend: x, transfer_to: mates, deadline }) {
  const asked = `Организация попросила перенести срок на ${dayRu(x.new_deadline)} (${timeRu(x.requested_at)})`;
  if (x.state === 'waiting') return el('div', { class: 'muted', 'data-role': 'org-extend', text: `${asked} — ждёт ответа диспетчера` });
  if (x.state === 'approved') {
    return el('div', { class: 'muted', 'data-role': 'org-extend', text: `Диспетчер согласился перенести срок по просьбе организации — новый срок ${dayRu(x.new_deadline)}` });
  }
  const next = mates?.length ? 'Передайте дело коллеге или напомните эксперту о сроке.' : 'Передать дело некому — напомните эксперту о сроке.';
  return el('div', { class: 'notice-warn', 'data-role': 'org-extend',
    text: [`Диспетчер отказал в переносе срока на ${dayRu(x.new_deadline)} (${timeRu(x.decided_at)})${x.answer ? `: «${x.answer}»` : ''}.`,
      `Срок дела — ${deadline ? dayRu(deadline) : 'не указан'}. ${next}`].join(' ') });
}

function moveRow(c) {
  const d = c.last_move.days;
  const ago = d === 0 ? 'сегодня' : d === 1 ? 'вчера' : `${d} дн. назад`;
  // Прогон 2.370: на проверке у диспетчера ход за ним, не за экспертом — без «Без движения».
  if (c.last_move.review) {
    return el('div', { class: 'muted', 'data-role': 'last-move', text: `На проверке у диспетчера, последнее движение по делу: ${ago}` });
  }
  return c.idle
    ? el('div', { class: 'row', 'data-role': 'idle' }, el('span', { class: 'badge warn', text: `Без движения ${c.last_move.work_days} раб. дн.` }),
      el('span', { class: 'muted', text: `последнее — ${timeRu(c.last_move.at)}` }))
    : el('div', { class: 'muted', 'data-role': 'last-move', text: `Последнее движение по делу: ${ago}` });
}

// «Напомнить эксперту» (2.125): дело в работе — одной кнопкой, не чаще раза в сутки по делу; эксперт получит уведомление,
// которое ведёт к делу. Когда напоминали — видно здесь же.
// kind 'extend' (2.201) — «попросите перенос срока»; предел общий: одно напоминание по делу в сутки.
function remindRow(org, c, kind = 'case') {
  const r = c.remind;
  const what = r.kind === 'extend' ? 'Напоминали попросить перенос срока' : 'Напоминали';
  const note = el('span', { class: 'muted', 'data-role': 'remind-note', text: r.reminded_at
    ? `${what} ${timeRu(r.reminded_at)}${r.next_remind_at ? ` · снова — после ${timeRu(r.next_remind_at)}` : ''}` : '' });
  const btn = el('button', { type: 'button', class: 'secondary', 'data-action': kind === 'extend' ? 'remind-extend' : 'remind-expert',
    ...(r.can_remind ? {} : { disabled: '' }),
    onclick: async () => {
      btn.disabled = true;
      try {
        await api('POST', `/api/orgs/${org.id}/cases/${c.id}/remind`, kind === 'extend' ? { kind } : undefined);
        await loadOrgCases(org);
        say($('org-cases-msg'), kind === 'extend' ? `Эксперту отправлена просьба попросить перенос срока по делу ${c.order_ref}`
          : `Эксперту отправлено напоминание по делу ${c.order_ref}`, 'ok');
      } catch (err) { say($('org-cases-msg'), err.message); await loadOrgCases(org); }
    } }, kind === 'extend' ? 'Напомнить эксперту попросить перенос срока' : 'Напомнить эксперту');
  // Под «Эксперт не принимает дела…» — только кнопка, когда напоминали — видно в общей строке «Напомнить эксперту».
  return kind === 'extend' ? el('div', { class: 'row', 'data-role': 'remind-extend' }, btn) : el('div', { class: 'row', 'data-role': 'remind' }, btn, note);
}

// «Напомнить всем» (2.368) в отборе «Без движения 5 дней и дольше»: то же напоминание, что у каждого дела (2.125), подряд по
// делам, где сегодня ещё не напоминали; по остальным — когда снова можно. Предел прежний: одно напоминание по делу в сутки.
function renderRemindAll(org, list) {
  const box = $('org-cases-remind-all');
  const can = list.filter((c) => c.remind?.can_remind);
  box.classList.toggle('hidden', !list.length);
  if (!list.length) return box.replaceChildren();
  const experts = new Set(can.map((c) => c.expert_id)).size;
  const btn = el('button', { type: 'button', 'data-action': 'remind-all', ...(can.length ? {} : { disabled: '' }),
    onclick: async () => {
      btn.disabled = true;
      let sent = 0;
      let fail = null;
      for (const c of can) {
        try { await api('POST', `/api/orgs/${org.id}/cases/${c.id}/remind`); sent += 1; } catch (err) { fail = err.message; }
      }
      await loadOrgCases(org);
      say($('org-cases-msg'), fail && !sent ? fail : `Напоминания отправлены по делам: ${sent}${fail ? ` · не отправлено: ${can.length - sent} (${fail})` : ''}`,
        fail ? undefined : 'ok');
    } }, can.length ? `Напомнить всем · дел: ${can.length}` : 'Напомнить всем');
  const note = can.length
    ? `Каждому эксперту придёт уведомление по его делу${experts > 1 ? ` (экспертов: ${experts})` : ''}.`
    : 'По всем этим делам сегодня уже напоминали — снова можно через сутки после напоминания.';
  box.replaceChildren(btn, el('p', { class: 'muted', 'data-role': 'remind-all-note', text: note }));
}

// Передать дело в работе другому эксперту организации (2.62): заболел, ушёл. Файлы, черновик, осмотр и переписка
// остаются в деле; прежний эксперт дело больше не видит; заказчик имени эксперта не видит.
function transferDetails(org, c) {
  const msg = el('p', { class: 'msg', role: 'status', 'aria-live': 'polite' });
  const body = c.transfer_to.length ? (() => {
    const pick = el('select', { 'aria-label': `Кому передать дело ${c.order_ref}`, 'data-transfer-pick': c.order_ref },
      ...c.transfer_to.map((x) => el('option', { value: x.user_id, text: pickText(x) })));
    const reason = el('input', { type: 'text', maxlength: '1000', placeholder: 'Причина: заболел, ушёл из организации…',
      'aria-label': `Причина передачи дела ${c.order_ref}`, 'data-transfer-reason': c.order_ref,
      // Эксперт не принимает дела (2.113) — причина уже подставлена, руководитель может поправить.
      ...(c.away ? { value: `Эксперт не принимает дела ${awaySpan(c.away)}${c.away.note ? `: ${c.away.note}` : ''}`.slice(0, 1000) } : {}) });
    const go = async () => {
      if (!reason.value.trim()) return say(msg, 'Укажите причину');
      try {
        await api('POST', `/api/orgs/${org.id}/cases/${c.id}/transfer`, { specialist_id: pick.value, reason: reason.value.trim() });
        await loadOrgCases(org);
        say($('org-cases-msg'), 'Дело передано — новый эксперт получил уведомление', 'ok');
      } catch (err) { say(msg, err.message); }
    };
    return [el('label', { text: 'Кому' }), pick, el('label', { text: 'Причина' }), reason,
      el('p', { class: 'muted', text: 'Файлы, черновик, фото осмотра и переписка останутся в деле. Прежний эксперт дело больше не увидит; его ссылка на осмотр и выезд помощника закроются — новый эксперт выдаст новые.' }),
      el('button', { 'data-action': 'transfer', onclick: go }, 'Передать дело')];
  })() : [el('p', { class: 'muted', text: 'Передать некому: в организации нет другого эксперта с допуском на эту услугу, который принимает дела.' })];
  return el('details', { class: 'org-transfer', 'data-transfer': c.order_ref, ...(c.away ? { open: '' } : {}) },
    el('summary', { text: 'Передать другому эксперту' }), ...body, msg);
}

// Эксперт просит передать дело коллеге (2.107): причина, когда попросил; выбрать, кому, и передать одной кнопкой (та же
// передача, что 2.62, причина — из просьбы) или отказать с пояснением по желанию — эксперт получит уведомление.
function handoverBlock(org, c) {
  const h = c.handover;
  const msg = el('p', { class: 'msg', role: 'status', 'aria-live': 'polite' });
  const pick = c.transfer_to.length ? el('select', { 'aria-label': `Кому передать дело ${c.order_ref}`, 'data-handover-pick': c.order_ref },
    ...c.transfer_to.map((x) => el('option', { value: x.user_id, text: pickText(x) }))) : null;
  const answer = el('input', { type: 'text', maxlength: '1000', placeholder: 'Пояснение эксперту, если отказываете (необязательно)',
    'aria-label': `Пояснение эксперту по делу ${c.order_ref}`, 'data-handover-answer': c.order_ref });
  const run = async (fn, done) => {
    try {
      await fn();
      await loadOrgCases(org);
      say($('org-cases-msg'), done, 'ok');
    } catch (err) { say(msg, err.message); }
  };
  const give = () => run(() => api('POST', `/api/orgs/${org.id}/cases/${c.id}/transfer`, { specialist_id: pick.value, reason: `По просьбе эксперта: ${h.reason}`.slice(0, 1000) }),
    'Дело передано — новый эксперт получил уведомление');
  const refuse = () => run(() => api('POST', `/api/orgs/${org.id}/cases/${c.id}/handover/decline`, { answer: answer.value.trim() }),
    'Отказано — дело остаётся у эксперта, ему пришло уведомление');
  return el('div', { class: 'notice-warn', 'data-handover': c.order_ref },
    el('p', { text: `Эксперт просит передать дело коллеге (${timeRu(h.requested_at)}). Причина: ${h.reason}` }),
    ...(pick ? [el('label', { text: 'Кому передать' }), pick]
      : [el('p', { class: 'muted', text: 'Передать некому: в организации нет другого эксперта с допуском на эту услугу, который принимает дела.' }),
        ...(h.suggest ? extendForm(org, c, run) : [])]),
    el('div', { class: 'row gap' },
      ...(pick ? [el('button', { 'data-action': 'handover-give', onclick: give }, 'Передать')] : []),
      el('button', { class: 'secondary', 'data-action': 'handover-decline', onclick: refuse }, 'Отказать')),
    answer, msg);
}

// Передать некому (2.221): одной кнопкой — просьба к диспетчеру перенести срок от организации. Новый срок и причина готовы
// (день возвращения эксперта или неделя от срока), поправить можно; причину увидит заказчик — без того, что писал эксперт.
function extendForm(org, c, run) {
  const s = c.handover.suggest;
  const date = el('input', { type: 'date', value: s.new_deadline, min: c.deadline, 'aria-label': `Новый срок дела ${c.order_ref}`,
    'data-handover-extend-date': c.order_ref });
  const reason = el('textarea', { maxlength: '1000', rows: '2', 'aria-label': `Причина переноса дела ${c.order_ref}`,
    'data-handover-extend-reason': c.order_ref });
  reason.value = s.reason;
  // Новый срок позже срока по заданию на оценку (2.327): банк или суд ждёт отчёт раньше — понадобится их письмо о переносе.
  const late = el('p', { class: 'overdue', 'data-handover-task-late': c.order_ref, hidden: '' });
  const check = () => {
    late.hidden = !(c.task_due && date.value > c.task_due.day);
    if (!late.hidden) late.textContent = `Новый срок позже срока ${c.task_due.by} (к ${dayRu(c.task_due.day)}): кроме согласия диспетчера `
      + 'понадобится письмо банка (определение суда) о переносе срока — эксперт попросит его у заказчика в деле.';
  };
  date.addEventListener('input', check);
  check();
  const ask = () => run(() => api('POST', `/api/orgs/${org.id}/cases/${c.id}/handover/extend`,
    { new_deadline: date.value, reason: reason.value.trim(), from: c.deadline }),
  'Диспетчеру отправлена просьба перенести срок от организации — эксперт получил уведомление');
  return [el('p', { text: 'Можно попросить диспетчера перенести срок от организации. Причину увидит заказчик.' }),
    el('label', { text: 'Новый срок' }), date, late, el('label', { text: 'Причина' }), reason,
    el('div', { class: 'row gap' }, el('button', { 'data-action': 'handover-extend', onclick: ask }, 'Попросить диспетчера перенести срок'))];
}

// Эксперт ещё не ответил на предложенное дело (2.76): сколько ждём; отдать другому эксперту или забрать назад в «Ждут
// назначения» — не дожидаясь отказа. Прежний эксперт получит уведомление, что отвечать не нужно.
function offerWait(org, c) {
  const w = c.offer_wait;
  const msg = el('p', { class: 'msg', role: 'status', 'aria-live': 'polite' });
  const send = async (specialistId, done) => {
    try {
      await api('POST', `/api/orgs/${org.id}/cases/${c.id}/reassign`, { from: w.from, specialist_id: specialistId });
      await loadOrgCases(org);
      // Сообщение — там, куда ушло дело; прежнее из другого списка убираем, чтобы не путало.
      say(specialistId ? $('org-pending-msg') : $('org-cases-msg'), '');
      say(specialistId ? $('org-cases-msg') : $('org-pending-msg'), done, 'ok');
    } catch (err) { say(msg, err.message); }
  };
  const pick = w.reassign_to.length ? el('select', { 'aria-label': `Кому предложить дело ${c.order_ref}`, 'data-reassign-pick': c.order_ref },
    ...w.reassign_to.map((x) => el('option', { value: x.user_id, text: pickText(x) }))) : null;
  return [
    el('div', { class: 'muted', 'data-role': 'offer-wait', text: w.offered_at
      ? `Эксперт ещё не ответил · предложено ${timeRu(w.offered_at)} (${waited(w.offered_at)})` : 'Эксперт ещё не ответил на предложение' }),
    el('details', { class: 'org-transfer', 'data-reassign': c.order_ref },
      el('summary', { text: 'Не ждать ответа — переназначить' }),
      ...(pick ? [el('label', { text: 'Кому предложить' }), pick,
        el('button', { 'data-action': 'reassign', onclick: () => send(pick.value, 'Дело предложено другому эксперту — прежний получил уведомление, что отвечать не нужно') }, 'Предложить другому')]
        : [el('p', { class: 'muted', text: 'Другого эксперта с допуском на эту услугу, который принимает дела, нет — дело можно забрать назад.' })]),
      el('button', { class: 'secondary', 'data-action': 'take-back',
        onclick: () => send(null, 'Дело снова в «Ждут назначения» — эксперту сообщили, что отвечать не нужно') }, 'Забрать назад'),
      msg)];
}

// К блоку организации из утренней сводки (2.130): «sign» — к подписи организации; «away» (2.209) — к отбору «Эксперт не принимает
// дела — срок в эти дни»; «stuck» (2.228) — к отбору «Просят передать — передать некому» и кнопке «Попросить диспетчера
// перенести срок» первого дела; «orgext» (2.238) — к отбору «Перенос от организации: ждём ответа / отказано»; «back» (2.249) —
// к отбору «Эксперт вернулся после «не принимаю дела»»; «task_moved» (2.338) — к отбору «Перенос позже срока по заданию — нет
// письма» (2.332), а таких нет — к «Сдать по письму о переносе — раньше срока дела» (2.348); «new_year» (2.394) — к отбору «Срок
// в новогодние каникулы»; «week», «overdue», «handover», «returned»,
// «fresh», «idle», «docs» — к списку дел с отбором «Срок на этой неделе» (2.127; в нём и просроченные), «Срок прошёл» (2.158), «Просят
// передать», «Вернул эксперту» (2.153), «Исправленный файл ждёт подписи эксперта» (2.172), «Без движения» (2.141) или «Ждём документы от заказчика» (2.235). Отбора уже
// нет (дела сданы, эксперт ответил) — список целиком.
export function focusOrgBlock(to) {
  if (to === 'sign') return goSign(null);
  // «sign_order» (2.286) — к подписи организации с отбором «Есть расхождения с заявкой или заданием на оценку» (2.276).
  if (to === 'sign_order') { pickSignFilter('order'); return goSign(null); }
  // «sign_long» (2.374) — к подписи организации с отбором «Ждут Вашей подписи 2 дня и дольше».
  if (to === 'sign_long') { pickSignFilter('long'); return goSign(null); }
  // «numbering» (2.419) — из «Сегодня»: в январе образец номера организации без года.
  if (to === 'numbering') return $('org-numbering-box').scrollIntoView({ block: 'start' });
  // «accr» (2.454) — из «Сегодня»: срок аккредитации организации или эксперта в банке кончается; руководителю — к таблице
  // по банкам с отбором «кончается» (2.455).
  if (to === 'accr') return showSoonAccreditations();
  $('org-cases-search').value = '';
  expert = '';
  filter = to;
  renderCases();
  $('org-cases-list-title').scrollIntoView({ block: 'start' });
  if (to === 'stuck') document.querySelector('#org-cases [data-action="handover-extend"]')?.focus({ preventScroll: true });
}

// Перейти к делу в «Подписи организации» и выделить его.
function goSign(ref) {
  document.querySelector(`#org-sign li.signed[data-item="${CSS.escape(ref)}"] details`)?.setAttribute('open', '');
  // Из утренней сводки без номера дела (2.257): есть дело, где после возврата расхождение с выпиской осталось, — к нему.
  const kept = !ref && document.querySelector('#org-sign li[data-egrn="kept"]')?.closest('#org-sign > li[data-item]');
  const li = (ref && document.querySelector(`#org-sign li[data-item="${CSS.escape(ref)}"]`)) || kept || $('org-sign-box');
  li.scrollIntoView({ behavior: 'smooth', block: 'start' });
  li.classList.add('flash');
  setTimeout(() => li.classList.remove('flash'), 2000);
}

// Внутренняя переписка с экспертом по делу (2.28): раскрывается по нажатию; заказчик и диспетчер её не видят.
function chatDetails(c) {
  const box = el('div');
  // Сколько сообщений и ждёт ли эксперт ответа — видно, не раскрывая (2.67).
  const n = c.chat?.messages ?? 0;
  const title = ['Переписка с экспертом', n ? `сообщений: ${n}` : null, c.chat?.expert_last ? 'ждёт Вашего ответа' : null].filter(Boolean).join(' · ');
  const d = el('details', { class: 'org-chat', 'data-chat': c.order_ref }, el('summary', { text: title }), box);
  d.addEventListener('toggle', () => { if (d.open && !box.firstChild) orgChat(box, c.id, { orgId: shown.org }); });
  return d;
}

function pendingItem(org, p) {
  const deadline = p.deadline ? `срок ${dayRu(p.deadline)}${p.overdue ? ' · ПРОСРОЧЕНО' : ''}` : 'срок не указан';
  const pick = el('select', { 'aria-label': `Эксперт для дела ${p.order_ref}`, 'data-pick': p.order_ref },
    ...p.experts.map((x) => el('option', { value: x.user_id,
      text: `${x.full_name} · в работе ${x.in_work}${x.overdue ? ` · просрочено ${x.overdue}` : ''} · сдать за 2 недели: ${x.due14}` })));
  return el('li', { 'data-pending': p.order_ref },
    el('div', { class: 'title', text: `${p.service} · ${p.order_ref}` }),
    el('div', { class: p.overdue ? 'overdue big' : 'muted', text: deadline }),
    el('div', { class: 'muted', text: p.fee_kop != null ? `вознаграждение ${rub(p.fee_kop)}` : 'цена ещё не назначена' }),
    ...(p.declined ? [el('div', { class: 'muted', text: `Эксперт отказался: ${p.declined}` })] : []),
    // Список экспертов — во всю ширину: имя и нагрузка не обрезаются на телефоне (2.67).
    ...(p.experts.length ? [pick] : [el('div', { class: 'muted', text: 'Свободных экспертов с допуском на эту услугу нет.' })]),
    ...(p.away.length ? [el('div', { class: 'muted', 'data-away': '', text: `${p.away.map((a) => `${a.full_name} ${awayText(a)}`).join('; ')}.` })] : []),
    el('div', { class: 'row gap' },
      ...(p.experts.length ? [el('button', { 'data-action': 'assign', onclick: () => assign(org, p, pick.value) }, 'Назначить')] : []),
      el('button', { class: 'secondary', 'data-action': 'org-decline', onclick: () => decline(org, p) }, 'Отказаться от дела')));
}

async function assign(org, p, specialistId) {
  try {
    await api('POST', `/api/orgs/${org.id}/cases/${p.id}/assign`, { specialist_id: specialistId });
    await loadOrgCases(org);
    say($('org-pending-msg'), 'Дело предложено эксперту — он примет его или откажется', 'ok');
  } catch (err) { say($('org-pending-msg'), err.message); }
}

async function decline(org, p) {
  const reason = prompt('Почему организация отказывается? Диспетчер увидит причину и предложит дело другому.');
  if (reason === null) return;
  if (!reason.trim()) return say($('org-pending-msg'), 'Укажите причину отказа');
  try {
    await api('POST', `/api/orgs/${org.id}/cases/${p.id}/decline`, { reason: reason.trim() });
    await loadOrgCases(org);
    say($('org-pending-msg'), 'Вы отказались от дела — оно вернулось диспетчеру', 'ok');
  } catch (err) { say($('org-pending-msg'), err.message); }
}
