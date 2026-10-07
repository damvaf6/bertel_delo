// Дела экспертов (2.16, устав 1а): руководитель организации видит дела, которые ведут эксперты от неё, — услугу, номер,
// срок (просрочено — крупно), состояние, эксперта и вознаграждение; нагрузку по экспертам и деньги за месяц.
// Заказчика, поля заявки, документы и переписку по заявке — нет (их сервер и не присылает); внутренняя переписка
// с экспертом (2.28) — у каждого дела.
// Дело в работе руководитель передаёт другому эксперту организации (2.62); предложенное и ещё не принятое — отдаёт другому
// или забирает назад, не дожидаясь отказа (2.76).
// «Ждут назначения» (2.17): дела, предложенные диспетчером организации, — руководитель назначает эксперта или отказывается.
import { api, el, say } from '/common.js';
import { expertLink } from '/expertcard.js';
import { dayRu } from '/order.js';
import { rub } from '/money.js';
import { orgChat } from '/orgchat.js';
import { matcher, wireSearch } from '/search.js';

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

export async function loadOrgCases(org) {
  const { pending, cases, load, money } = await api('GET', `/api/orgs/${org.id}/cases`);
  // Другая организация — поиск с чистого листа; та же (передали дело, подписали) — запрос остаётся.
  if (shown.org !== org.id) $('org-cases-search').value = '';
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
    expertLink(l.user_id))));
  $('org-cases-empty').classList.toggle('hidden', cases.length > 0 || pending.length > 0 || load.length === 0);
  renderCases();
}

// Поиск по делам экспертов (2.73): номер, вид услуги, эксперт, состояние. Адреса и заказчика руководитель не видит (2.16) —
// по ним и не ищется. Строка поиска — когда дел больше одного.
function renderCases() {
  const { orgObj: org, cases } = shown;
  if (!org) return;
  $('org-cases-search-box').classList.toggle('hidden', cases.length < 2);
  const q = cases.length < 2 ? '' : $('org-cases-search').value;
  const hit = matcher(q);
  const found = cases.filter((c) => hit([c.order_ref, c.service, c.expert, c.status_name].join(' ')));
  const active = found.filter((c) => c.active);
  const done = found.filter((c) => !c.active);
  const none = cases.length > 0 && !found.length;
  $('org-cases-none').classList.toggle('hidden', !none);
  $('org-cases-none').textContent = none ? `Ничего не найдено по «${q.trim()}». Ищите по номеру дела, виду услуги или эксперту.` : '';
  $('org-cases').replaceChildren(
    ...active.map((c) => caseItem(org, c)),
    ...(done.length ? [el('li', { class: 'group', text: `Завершённые · ${done.length}` })] : []),
    ...done.map((c) => caseItem(org, c)));
}

function caseItem(org, c) {
  const deadline = c.deadline ? `срок ${dayRu(c.deadline)}${c.overdue ? ' · ПРОСРОЧЕНО' : ''}` : 'срок не указан';
  return el('li', { 'data-case': c.order_ref },
    el('div', { class: 'title', text: `${c.service} · ${c.order_ref}` }),
    ...(c.overdue ? [el('div', { class: 'overdue big', text: deadline })] : []),
    // Дело предложено эксперту, он ещё не принял (2.90): «Ждёт исполнителя · эксперт: …» читалось как «уже назначен».
    el('div', { class: 'muted', text: [c.status === 'awaiting_executor' ? 'Предложено эксперту' : c.status_name, `эксперт: ${c.expert}`,
      c.overdue ? null : deadline].filter(Boolean).join(' · ') }),
    el('div', { class: 'muted', text: [c.fee_kop != null ? `вознаграждение ${rub(c.fee_kop)}` : 'цена ещё не назначена',
      c.payout ? PAYOUT_RU[c.payout] : null].filter(Boolean).join(' · ') }),
    // Что ждёт руководителя по делу (2.36) — прямо в списке дел, с переходом к подписи.
    ...(c.sign_wait ? [el('div', { class: 'row', 'data-role': 'sign-wait' },
      el('span', { class: 'badge warn', text: `Ждёт Вашей подписи: ${c.sign_wait}` }),
      el('button', { class: 'secondary', 'data-action': 'go-sign', onclick: () => goSign(c.order_ref) }, 'К подписи'))] : []),
    ...(c.returned_open ? [el('div', { class: 'muted', 'data-role': 'returned', text: 'Вы вернули отчёт эксперту — ждём исправления' })] : []),
    // Эксперт попросил перенести срок (2.100): решает диспетчер, руководитель видит новую дату.
    ...(c.extend ? [el('div', { class: 'muted', 'data-role': 'extend',
      text: `Эксперт просит перенести срок на ${dayRu(c.extend.new_deadline)} — ждёт ответа диспетчера` })] : []),
    ...(c.status === 'in_work' ? [transferDetails(org, c)] : []),
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
  if ($('org-cases-search').value) { $('org-cases-search').value = ''; renderCases(); }
  const r = CSS.escape(ref);
  if (to === 'sign' && document.querySelector(`#org-sign li[data-item="${r}"]`)) return goSign(ref);
  const li = (to === 'pending' && document.querySelector(`#org-pending li[data-pending="${r}"]`))
    || document.querySelector(`#org-cases li[data-case="${r}"]`);
  if (!li) return;
  if (to === 'chat') li.querySelector('details[data-chat]')?.setAttribute('open', '');
  li.scrollIntoView({ block: 'start' });
  li.classList.add('flash');
  setTimeout(() => li.classList.remove('flash'), 2000);
}

// Передать дело в работе другому эксперту организации (2.62): заболел, ушёл. Файлы, черновик, осмотр и переписка
// остаются в деле; прежний эксперт дело больше не видит; заказчик имени эксперта не видит.
function transferDetails(org, c) {
  const msg = el('p', { class: 'msg', role: 'status', 'aria-live': 'polite' });
  const body = c.transfer_to.length ? (() => {
    const pick = el('select', { 'aria-label': `Кому передать дело ${c.order_ref}`, 'data-transfer-pick': c.order_ref },
      ...c.transfer_to.map((x) => el('option', { value: x.user_id, text: x.full_name })));
    const reason = el('input', { type: 'text', maxlength: '1000', placeholder: 'Причина: заболел, ушёл из организации…',
      'aria-label': `Причина передачи дела ${c.order_ref}`, 'data-transfer-reason': c.order_ref });
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
  return el('details', { class: 'org-transfer', 'data-transfer': c.order_ref },
    el('summary', { text: 'Передать другому эксперту' }), ...body, msg);
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
    ...w.reassign_to.map((x) => el('option', { value: x.user_id, text: x.full_name }))) : null;
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

// Перейти к делу в «Подписи организации» и выделить его.
function goSign(ref) {
  document.querySelector(`#org-sign li.signed[data-item="${CSS.escape(ref)}"] details`)?.setAttribute('open', '');
  const li = document.querySelector(`#org-sign li[data-item="${CSS.escape(ref)}"]`) ?? $('org-sign-box');
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
  d.addEventListener('toggle', () => { if (d.open && !box.firstChild) orgChat(box, c.id); });
  return d;
}

function pendingItem(org, p) {
  const deadline = p.deadline ? `срок ${dayRu(p.deadline)}${p.overdue ? ' · ПРОСРОЧЕНО' : ''}` : 'срок не указан';
  const pick = el('select', { 'aria-label': `Эксперт для дела ${p.order_ref}`, 'data-pick': p.order_ref },
    ...p.experts.map((x) => el('option', { value: x.user_id,
      text: `${x.full_name} · в работе ${x.in_work}${x.overdue ? ` · просрочено ${x.overdue}` : ''}` })));
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
