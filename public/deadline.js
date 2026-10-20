// Перенос срока дела (задача 2.91). Исполнитель просит новую дату с причиной; диспетчер соглашается или отказывает одной
// кнопкой; заказчик видит просьбу и ответ. Ниже — история переносов. Текст — через textContent.
import { api, el, say } from '/common.js';
import { setNext } from '/next.js';

const $ = (id) => document.getElementById(id);
const dayRu = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const whenRu = (s) => new Date(s).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const OUTCOME = { approved: ['перенесён', 'ok'], declined: ['отказано', 'warn'], withdrawn: ['отозвана', ''] };
let ctx = null; // { order, reload, open, task }

export async function loadDeadline(current, reload) {
  const box = $('deadline-box');
  say($('deadline-msg'), '');
  $('deadline-fresh').classList.add('hidden');
  if (!current.order.module || !current.order.deadline) { box.classList.add('hidden'); setNext({ deadline: null }); return; }
  ctx = { order: current.order, reload };
  render(await api('GET', `/api/orders/${current.order.id}/deadline-requests`));
}

function render(r) {
  ctx.open = r.open;
  setNext({ deadline: { deadline: r.deadline, open: !!r.open } });
  const box = $('deadline-box');
  box.classList.toggle('hidden', !(r.can_request || r.requests.length || r.history));
  if (box.classList.contains('hidden')) return;
  const o = r.open;
  $('deadline-lead').textContent = o ? `Сейчас срок — ${dayRu(r.deadline)} Исполнитель просит перенести его; пока нет ответа, действует прежний.`
    : r.can_request ? `Сейчас срок — ${dayRu(r.deadline)} Не успеваете — попросите перенести: диспетчер согласится или откажет, заказчик увидит.`
      : `Сейчас срок — ${dayRu(r.deadline)}`;
  renderFresh(r.fresh_answer);
  renderTaskMoved(r.task_moved);
  renderMoved(r.moved);
  renderPace(r.pace);
  $('deadline-open').classList.toggle('hidden', !o);
  if (o) $('deadline-open-text').textContent = `Просьба${o.org_name ? ` организации «${o.org_name}» (передать дело некому)` : ''} от ${whenRu(o.requested_at)}: перенести на ${dayRu(o.new_deadline)}. Причина: ${o.reason}`;
  $('deadline-answer-field').classList.toggle('hidden', !r.can_decide);
  for (const id of ['deadline-approve', 'deadline-decline']) $(id).classList.toggle('hidden', !r.can_decide);
  $('deadline-withdraw').classList.toggle('hidden', !r.can_withdraw);
  $('deadline-form').classList.toggle('hidden', !r.can_request);
  // Попросил или отозвал перенос (2.140) — предупреждение «нет файла результата» в деле пересчитывает свои кнопки.
  document.dispatchEvent(new Event('deadline-changed'));
  if (r.can_request) $('deadline-new').min = r.min_new ?? r.deadline;
  ctx.task = r.task_due ?? null;
  renderTask();
  // Готовые причины (2.126): текст в поле причины, новый срок — если ещё не выбран и сервер его предложил.
  const reasons = r.reasons ?? [];
  $('deadline-reasons').classList.toggle('hidden', !reasons.length);
  $('deadline-reason-list').replaceChildren(...reasons.map((p) => el('button', {
    class: 'secondary', type: 'button', 'data-reason': p.id,
    onclick: () => {
      $('deadline-reason').value = p.reason;
      if (p.new_deadline && !$('deadline-new').value) $('deadline-new').value = p.new_deadline;
      renderTask();
      $('deadline-reason').focus();
      say($('deadline-msg'), p.new_deadline ? 'Причина и новый срок в полях — поправьте и отправьте' : 'Причина в поле — выберите новый срок и отправьте', 'ok');
    },
  }, p.label)));
  renderHistory(r.history);
  const past = r.requests.filter((x) => x.outcome);
  $('deadline-history').replaceChildren(...past.map((x) => {
    const [word, kind] = OUTCOME[x.outcome];
    return el('li', { 'data-deadline-request': x.id },
      el('div', {},
        el('div', { class: 'name' }, el('span', { text: `${dayRu(x.old_deadline)} → ${dayRu(x.new_deadline)} ` }), el('span', { class: `badge ${kind}`, text: word })),
        el('div', { class: 'muted', text: [`причина: ${x.reason}`, x.answer ? `ответ: ${x.answer}` : null, x.decided_at ? whenRu(x.decided_at) : null].filter(Boolean).join(' · ') })));
  }));
}

// История сроков (2.337): исполнителю одним списком по времени — срок при заказе, срок по заданию на оценку, просьбы о
// переносе с ответом, просьба письма о переносе и письма с новым сроком по заданию.
const dayShort = (s) => new Date(s).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' });
function historyLine(x) {
  if (x.kind === 'start') return [`Срок дела при заказе — ${dayRu(x.day)}`, ''];
  if (x.kind === 'task') return [`Срок ${x.by} — не позднее ${dayRu(x.day)}`, `файл «${x.name}»`];
  if (x.kind === 'letter') return [`Письмо о переносе: срок ${x.day > x.was ? 'перенесён' : 'изменён'} с ${dayRu(x.was)} на ${dayRu(x.day)}`, `файл «${x.name}»`];
  if (x.kind === 'ask') return ['Попросили у заказчика письмо о переносе срока', x.came_at ? `заказчик приложил документ ${whenRu(x.came_at)}` : 'документа пока нет'];
  const who = x.org_name ? `Организация «${x.org_name}» попросила` : 'Попросили';
  const [word] = OUTCOME[x.outcome] ?? ['ждёт ответа диспетчера'];
  const res = x.outcome === 'approved' ? `диспетчер согласился ${whenRu(x.decided_at)}`
    : x.outcome === 'declined' ? `диспетчер отказал ${whenRu(x.decided_at)}${x.answer ? `: ${x.answer}` : ''}`
      : x.outcome ? `просьба ${word}` : word;
  return [`${who} перенести срок с ${dayRu(x.old_deadline)} на ${dayRu(x.new_deadline)}`, [`причина: ${x.reason}`, res].join(' · ')];
}
function renderHistory(h) {
  const box = $('deadline-timeline');
  box.classList.toggle('hidden', !h);
  $('deadline-timeline-list').replaceChildren(...(h ?? []).map((x) => {
    const [main, sub] = historyLine(x);
    const kind = x.kind === 'request' ? (OUTCOME[x.outcome]?.[1] ?? '') : '';
    return el('li', { 'data-history': x.kind },
      el('div', {},
        el('div', { class: 'name' }, el('span', { class: 'muted', text: `${dayShort(x.at)} · ` }), el('span', { text: `${main} ` }),
          ...(kind ? [el('span', { class: `badge ${kind}`, text: OUTCOME[x.outcome][0] })] : [])),
        ...(sub ? [el('div', { class: 'muted', text: sub })] : [])));
  }));
}

// Ответ диспетчера, который исполнитель видит впервые (2.155): согласился — новый срок, отказал — срок прежний и почему.
// Показывается до следующего открытия дела; дальше — только в истории ниже.
function renderFresh(a) {
  const box = $('deadline-fresh');
  // Нет нового ответа — оставляем показанный в этом открытии дела (после своих действий в блоке не прячем).
  if (!a) return;
  const why = a.answer ? ` Пояснение: ${a.answer}` : '';
  box.textContent = a.outcome === 'approved'
    ? `Диспетчер согласился ${whenRu(a.decided_at)}: срок перенесён с ${dayRu(a.old_deadline)} на ${dayRu(a.new_deadline)}.${why}`
    : `Диспетчер отказал ${whenRu(a.decided_at)} в переносе на ${dayRu(a.new_deadline)} — срок прежний, ${dayRu(a.old_deadline)}.${why || ' Пояснения нет.'}`;
  box.className = a.outcome === 'approved' ? 'msg ok' : 'msg warn';
  box.dataset.outcome = a.outcome;
}

// Перенос согласован, а новый срок позже срока по заданию на оценку (2.326): банк (суд) ждёт отчёт к прежнему дню —
// приложите к делу письмо о переносе; одной кнопкой — попросить его у заказчика. Пришло письмо с новым сроком — блока нет.
const ASK_TEXT = 'Попросить письмо о переносе у заказчика';
function renderTaskMoved(m) {
  const box = $('deadline-task-moved');
  box.classList.toggle('hidden', !m);
  if (!m) return;
  // 2.335: письмо о переносе пришло, а срок в нём раньше согласованного срока дела — сдать по письму или попросить другое.
  $('deadline-task-moved-text').textContent = m.letter
    ? `${m.doc} о переносе пришло${m.name ? ` («${m.name}», стр. ${m.page})` : ''}, но срок в нём — ${dayRu(m.day)}`
      + `${m.letter.was ? ` (${m.letter.was_letter ? 'по прежнему письму' : 'по заданию'} было — ${dayRu(m.letter.was)})` : ''}, а срок дела перенесён на ${dayRu(m.deadline)}. `
      + `${m.who} ждёт отчёт к ${dayRu(m.day)}: сдайте к этому дню или попросите ${m.doc.toLowerCase()} с новым сроком — ${dayRu(m.deadline)}.`
    : `Срок перенесён на ${dayRu(m.deadline)}, а ${m.by} ${m.who.toLowerCase()} ждёт отчёт к ${dayRu(m.day)}`
      + `${m.name ? ` («${m.name}», стр. ${m.page})` : ''}. Приложите к делу ${m.doc.toLowerCase()} о переносе срока — `
      + 'иначе отчёт с новой датой могут не принять.';
  box.dataset.letter = m.letter ? 'short' : '';
  const ask = $('deadline-task-moved-ask');
  const msg = $('deadline-task-moved-msg');
  const waiting = !!m.asked && !m.asked.came;
  ask.classList.toggle('hidden', waiting || ctx.order.status !== 'in_work');
  ask.textContent = m.letter ? `Попросить ${m.doc.toLowerCase()} с новым сроком` : ASK_TEXT;
  msg.classList.toggle('hidden', !m.asked || (!waiting && !!m.letter));
  msg.textContent = !m.asked ? '' : waiting ? `Попросили у заказчика ${whenRu(m.asked.at)} — ждём документ.`
    : 'Заказчик приложил документ, но нового срока в нём не видно — проверьте, что срок в нём не раньше нового срока дела.';
  box.dataset.taskDue = m.day;
}
$('deadline-task-moved-ask').addEventListener('click', async () => {
  const btn = $('deadline-task-moved-ask');
  btn.disabled = true;
  try {
    await api('POST', `/api/orders/${ctx.order.id}/doc-requests`, { task_move: true });
    await ctx.reload();
    say($('deadline-msg'), 'Запрошено — заказчику отправлено уведомление', 'ok');
  } catch (err) { say($('deadline-msg'), err.message); }
  btn.disabled = false;
});

// Срок по заданию на оценку (2.319): выбранный новый срок позже дня, к которому отчёт ждут по заданию (письму заказчика,
// определению суда), — предупреждение до отправки: кто ждёт и к какому дню. Отправить можно: решают диспетчер и заказчик.
function renderTask() {
  const box = $('deadline-task');
  const t = ctx?.task;
  const v = $('deadline-new').value;
  const late = !!t && !!v && v > t.day;
  box.classList.toggle('hidden', !late);
  if (!late) { box.textContent = ''; return; }
  box.textContent = `${t.who} ждёт отчёт к ${dayRu(t.day)} (${t.by}${t.name ? `: «${t.name}», стр. ${t.page}` : ''}) — новый срок позже. `
    + 'Выберите срок не позже или напишите в причине, что с заказчиком перенос согласован.';
  box.dataset.taskDue = t.day;
}
$('deadline-new').addEventListener('input', renderTask);
$('deadline-new').addEventListener('change', renderTask);

const days = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'день' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'дня' : 'дней'}`;
const daysRu = (x) => (Number.isInteger(x) ? days(x) : `${String(x).replace('.', ',')} дня`);

const timesRu = (n) => `${n} ${n % 10 >= 2 && n % 10 <= 4 && ![12, 13, 14].includes(n % 100) ? 'раза' : 'раз'}`;

// Сколько раз уже переносили срок (2.169): одной строкой, чтобы не считать по истории — и первоначальный срок.
function renderMoved(m) {
  const box = $('deadline-moved');
  box.classList.toggle('hidden', !m);
  if (!m) return;
  box.textContent = `Срок переносили ${m.times === 1 ? 'один раз' : timesRu(m.times)} — всего на ${days(m.days)}. Первоначальный срок — ${dayRu(m.first)}`;
  box.dataset.times = String(m.times);
  box.dataset.days = String(m.days);
}

// Свой темп (2.145): сколько дней осталось и сколько у исполнителя обычно занимает такая услуга; обычно нужно больше, чем
// осталось, — мягкое предупреждение. Сданных дел этой услуги мало — только «осталось».
function renderPace(p) {
  const box = $('deadline-pace');
  box.classList.toggle('hidden', !p);
  if (!p) return;
  const left = p.days_left < 0 ? `Срок прошёл ${days(-p.days_left)} назад.` : p.days_left === 0 ? 'Срок сегодня.' : `До срока ${days(p.days_left)}.`;
  const usual = p.usual_days == null ? ''
    : ` Такие дела Вы обычно сдаёте за ${daysRu(p.usual_days)} от принятия${p.spent_days == null ? '' : `, это дело у Вас ${days(p.spent_days)}`}.`;
  const warn = p.late && p.days_left >= 0
    ? ` По Вашему обычному темпу нужно ещё около ${days(p.need_days)} — можно не успеть. Начните с главного или заранее попросите перенести срок.`
    : '';
  box.textContent = left + usual + warn;
  box.className = warn ? 'msg warn' : 'muted';
  box.dataset.late = p.late ? '1' : '0';
}

async function decide(approve) {
  if (!ctx?.open) return;
  try {
    await api('POST', `/api/orders/${ctx.order.id}/deadline-requests/${ctx.open.id}/decide`, { approve, answer: $('deadline-answer').value });
    $('deadline-answer').value = '';
    await ctx.reload();
    say($('deadline-msg'), approve ? 'Срок перенесён. Исполнителю и заказчику пришло уведомление.' : 'Отказано. Исполнителю пришло уведомление.', 'ok');
  } catch (err) { say($('deadline-msg'), err.message); }
}

$('deadline-approve').addEventListener('click', () => decide(true));
$('deadline-decline').addEventListener('click', () => decide(false));
$('deadline-withdraw').addEventListener('click', async () => {
  if (!ctx?.open) return;
  try {
    render(await api('DELETE', `/api/orders/${ctx.order.id}/deadline-requests/${ctx.open.id}`));
    say($('deadline-msg'), 'Просьба отозвана', 'ok');
  } catch (err) { say($('deadline-msg'), err.message); }
});
$('deadline-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    render(await api('POST', `/api/orders/${ctx.order.id}/deadline-requests`,
      { new_deadline: $('deadline-new').value, reason: $('deadline-reason').value, from: ctx.order.deadline }));
    $('deadline-new').value = '';
    $('deadline-reason').value = '';
    renderTask();
    say($('deadline-msg'), 'Просьба отправлена диспетчеру. Пока нет ответа, действует прежний срок.', 'ok');
  } catch (err) { say($('deadline-msg'), err.message); }
});
