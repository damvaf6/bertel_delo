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
// Сколько дней по делу ничего не происходило и отбор «Без движения» (2.133) — переписка с заказчиком не в счёт.
// Отбор «Срок прошёл» (2.158): только просроченные, дольше всех просроченные — первыми; на сколько дней — у дела.
// «Ждут назначения» (2.17): дела, предложенные диспетчером организации, — руководитель назначает эксперта или отказывается.
import { api, el, say } from '/common.js';
import { expertLink } from '/expertcard.js';
import { dayRu } from '/order.js';
import { rub } from '/money.js';
import { orgChat } from '/orgchat.js';
import { matcher, wireSearch } from '/search.js';
import { loadOrgSchedule } from '/orgschedule.js';

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
  ? `не принимает новые дела до ${dayRu(a.away?.until ?? a.until)}${(a.away?.note ?? a.note) ? ` (${a.away?.note ?? a.note})` : ''}`
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
  { id: 'overdue', text: 'Срок прошёл', test: (c) => c.overdue },
  { id: 'hot', text: 'Горит', test: (c) => c.hot },
  { id: 'week', text: 'Срок на этой неделе', test: (c) => c.week },
  { id: 'idle', text: 'Без движения', test: (c) => c.idle },
  { id: 'sign', text: 'Ждёт моей подписи', test: (c) => c.sign_wait > 0 },
  { id: 'returned', text: 'Вернул эксперту', test: (c) => c.returned_open },
  { id: 'extend', text: 'Просят перенести срок', test: (c) => !!c.extend },
  { id: 'silent', text: 'Предложено, молчит', test: (c) => c.status === 'awaiting_executor' },
];
let filter = null;
// Подпись организации ждёт два дня и дольше (2.148) — строка красная, в отборе «Ждёт моей подписи» такие дела выше.
const SIGN_LONG_DAYS = 2;
const signLong = (c) => !!c.sign_since && Date.now() - new Date(c.sign_since).getTime() >= SIGN_LONG_DAYS * 86_400_000;
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
  const counts = new Map(FILTERS.map((f) => [f.id, mine.filter((c) => c.active && f.test(c)).length]));
  if (filter && !counts.get(filter)) filter = null;
  const chosen = FILTERS.find((f) => f.id === filter);
  renderFilters(counts);
  const found = mine.filter((c) => hit([c.order_ref, c.id, c.service, c.expert, c.status_name].join(' '))
    && (!chosen || (c.active && chosen.test(c))));
  const active = found.filter((c) => c.active);
  // «Ждёт моей подписи» (2.148): дольше всех ждущие — первыми.
  if (filter === 'sign') active.sort((a, b) => new Date(a.sign_since) - new Date(b.sign_since));
  // «Срок прошёл» (2.158): дольше всех просроченные — первыми.
  if (filter === 'overdue') active.sort((a, b) => b.overdue_days - a.overdue_days);
  const done = found.filter((c) => !c.active);
  const none = cases.length > 0 && !found.length;
  $('org-cases-none').classList.toggle('hidden', !none);
  const who = expert ? ` у эксперта «${mine[0]?.expert ?? ''}»` : '';
  $('org-cases-none').textContent = !none ? '' : chosen
    ? `По отбору «${chosen.text}»${who} ничего не найдено${q.trim() ? ` по «${q.trim()}»` : ''}. Нажмите «Все»${expert ? ' или выберите «Все эксперты»' : ''}, чтобы искать по всем делам.`
    : expert ? `У эксперта «${mine[0]?.expert ?? ''}» ничего не найдено по «${q.trim()}». Выберите «Все эксперты», чтобы искать по всем делам.`
      : `Ничего не найдено по «${q.trim()}». Ищите по номеру дела, виду услуги или эксперту.`;
  $('org-cases').replaceChildren(
    ...active.map((c) => caseItem(org, c)),
    ...(done.length ? [el('li', { class: 'group', text: `Завершённые · ${done.length}` })] : []),
    ...done.map((c) => caseItem(org, c)));
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

function caseItem(org, c) {
  const late = c.overdue_days ? ` на ${c.overdue_days} дн.` : '';
  const deadline = c.deadline ? `срок ${dayRu(c.deadline)}${c.overdue ? ` · ПРОСРОЧЕНО${late}` : ''}` : 'срок не указан';
  return el('li', { 'data-case': c.order_ref },
    el('div', { class: 'title', text: `${c.service} · ${c.order_ref}` }),
    ...(c.overdue ? [el('div', { class: 'overdue big', text: deadline })] : []),
    // Дело предложено эксперту, он ещё не принял (2.90): «Ждёт исполнителя · эксперт: …» читалось как «уже назначен».
    el('div', { class: 'muted', text: [c.status === 'awaiting_executor' ? 'Предложено эксперту' : c.status_name, `эксперт: ${c.expert}`,
      c.overdue ? null : deadline].filter(Boolean).join(' · ') }),
    el('div', { class: 'muted', text: [c.fee_kop != null ? `вознаграждение ${rub(c.fee_kop)}` : 'цена ещё не назначена',
      c.payout ? PAYOUT_RU[c.payout] : null].filter(Boolean).join(' · ') }),
    // Что ждёт руководителя по делу (2.36) — прямо в списке дел, с переходом к подписи.
    // Сколько ждёт и напоминал ли эксперт (2.148): долго ждёт — заметно.
    ...(c.sign_wait ? [el('div', { class: 'row', 'data-role': 'sign-wait' },
      el('span', { class: 'badge warn', text: `Ждёт Вашей подписи: ${c.sign_wait}` }),
      el('button', { class: 'secondary', 'data-action': 'go-sign', onclick: () => goSign(c.order_ref) }, 'К подписи')),
    ...(c.sign_since ? [el('div', { class: signLong(c) ? 'overdue' : 'muted', 'data-role': 'sign-since', text: signSinceText(c) })] : [])] : []),
    ...(c.returned_open ? [el('div', { class: 'muted', 'data-role': 'returned', text: returnedText(c) })] : []),
    // Эксперт попросил перенести срок (2.100): решает диспетчер, руководитель видит новую дату.
    ...(c.extend ? [el('div', { class: 'muted', 'data-role': 'extend',
      text: `Эксперт просит перенести срок на ${dayRu(c.extend.new_deadline)} — ждёт ответа диспетчера` })] : []),
    // Эксперт не принимает дела до … (2.113), а срок дела — в эти дни: «Передать другому эксперту» сразу открыто.
    ...(c.away && !c.handover ? [el('div', { class: 'notice-warn', 'data-role': 'away',
      text: `Эксперт не принимает дела до ${dayRu(c.away.until)}${c.away.note ? ` (${c.away.note})` : ''}, а срок дела — в эти дни. Передайте его коллеге.` })] : []),
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
  }
  if (to === 'handover') li.querySelector('[data-handover]')?.querySelector('select, button')?.focus({ preventScroll: true });
  li.scrollIntoView({ block: 'start' });
  li.classList.add('flash');
  setTimeout(() => li.classList.remove('flash'), 2000);
}

// Последнее движение по делу (2.133): смена состояния, файл эксперта, черновик, проверка, аналог, подпись, осмотр.
// Три дня и больше — «Без движения», заметно; рядом «Напомнить эксперту».
function moveRow(c) {
  const d = c.last_move.days;
  const ago = d === 0 ? 'сегодня' : d === 1 ? 'вчера' : `${d} дн. назад`;
  return c.idle
    ? el('div', { class: 'row', 'data-role': 'idle' }, el('span', { class: 'badge warn', text: `Без движения ${d} дн.` }),
      el('span', { class: 'muted', text: `последнее — ${timeRu(c.last_move.at)}` }))
    : el('div', { class: 'muted', 'data-role': 'last-move', text: `Последнее движение по делу: ${ago}` });
}

// «Напомнить эксперту» (2.125): дело в работе — одной кнопкой, не чаще раза в сутки по делу; эксперт получит уведомление,
// которое ведёт к делу. Когда напоминали — видно здесь же.
function remindRow(org, c) {
  const r = c.remind;
  const note = el('span', { class: 'muted', 'data-role': 'remind-note', text: r.reminded_at
    ? `Напоминали ${timeRu(r.reminded_at)}${r.next_remind_at ? ` · снова — после ${timeRu(r.next_remind_at)}` : ''}` : '' });
  const btn = el('button', { type: 'button', class: 'secondary', 'data-action': 'remind-expert', ...(r.can_remind ? {} : { disabled: '' }),
    onclick: async () => {
      btn.disabled = true;
      try {
        await api('POST', `/api/orgs/${org.id}/cases/${c.id}/remind`);
        await loadOrgCases(org);
        say($('org-cases-msg'), `Эксперту отправлено напоминание по делу ${c.order_ref}`, 'ok');
      } catch (err) { say($('org-cases-msg'), err.message); await loadOrgCases(org); }
    } }, 'Напомнить эксперту');
  return el('div', { class: 'row', 'data-role': 'remind' }, btn, note);
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
      ...(c.away ? { value: `Эксперт не принимает дела до ${dayRu(c.away.until)}${c.away.note ? `: ${c.away.note}` : ''}`.slice(0, 1000) } : {}) });
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
      : [el('p', { class: 'muted', text: 'Передать некому: в организации нет другого эксперта с допуском на эту услугу, который принимает дела.' })]),
    el('div', { class: 'row gap' },
      ...(pick ? [el('button', { 'data-action': 'handover-give', onclick: give }, 'Передать')] : []),
      el('button', { class: 'secondary', 'data-action': 'handover-decline', onclick: refuse }, 'Отказать')),
    answer, msg);
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

// К блоку организации из утренней сводки (2.130): «sign» — к подписи организации; «week», «overdue», «handover», «returned»,
// «idle» — к списку дел с отбором «Срок на этой неделе» (2.127; в нём и просроченные), «Срок прошёл» (2.158), «Просят
// передать», «Вернул эксперту» (2.153) или «Без движения» (2.141). Отбора уже
// нет (дела сданы, эксперт ответил) — список целиком.
export function focusOrgBlock(to) {
  if (to === 'sign') return goSign(null);
  $('org-cases-search').value = '';
  expert = '';
  filter = to;
  renderCases();
  $('org-cases-list-title').scrollIntoView({ block: 'start' });
}

// Перейти к делу в «Подписи организации» и выделить его.
function goSign(ref) {
  document.querySelector(`#org-sign li.signed[data-item="${CSS.escape(ref)}"] details`)?.setAttribute('open', '');
  const li = (ref && document.querySelector(`#org-sign li[data-item="${CSS.escape(ref)}"]`)) || $('org-sign-box');
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
