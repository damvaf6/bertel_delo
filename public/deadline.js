// Перенос срока дела (задача 2.91). Исполнитель просит новую дату с причиной; диспетчер соглашается или отказывает одной
// кнопкой; заказчик видит просьбу и ответ. Ниже — история переносов. Текст — через textContent.
import { api, el, say } from '/common.js';
import { setNext } from '/next.js';

const $ = (id) => document.getElementById(id);
const dayRu = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const whenRu = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const OUTCOME = { approved: ['перенесён', 'ok'], declined: ['отказано', 'warn'], withdrawn: ['отозвана', ''] };
let ctx = null; // { order, reload, open }

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
  box.classList.toggle('hidden', !(r.can_request || r.requests.length));
  if (box.classList.contains('hidden')) return;
  const o = r.open;
  $('deadline-lead').textContent = o ? `Сейчас срок — ${dayRu(r.deadline)} Исполнитель просит перенести его; пока нет ответа, действует прежний.`
    : r.can_request ? `Сейчас срок — ${dayRu(r.deadline)} Не успеваете — попросите перенести: диспетчер согласится или откажет, заказчик увидит.`
      : `Сейчас срок — ${dayRu(r.deadline)}`;
  renderFresh(r.fresh_answer);
  renderPace(r.pace);
  $('deadline-open').classList.toggle('hidden', !o);
  if (o) $('deadline-open-text').textContent = `Просьба от ${whenRu(o.requested_at)}: перенести на ${dayRu(o.new_deadline)}. Причина: ${o.reason}`;
  $('deadline-answer-field').classList.toggle('hidden', !r.can_decide);
  for (const id of ['deadline-approve', 'deadline-decline']) $(id).classList.toggle('hidden', !r.can_decide);
  $('deadline-withdraw').classList.toggle('hidden', !r.can_withdraw);
  $('deadline-form').classList.toggle('hidden', !r.can_request);
  // Попросил или отозвал перенос (2.140) — предупреждение «нет файла результата» в деле пересчитывает свои кнопки.
  document.dispatchEvent(new Event('deadline-changed'));
  if (r.can_request) $('deadline-new').min = r.min_new ?? r.deadline;
  // Готовые причины (2.126): текст в поле причины, новый срок — если ещё не выбран и сервер его предложил.
  const reasons = r.reasons ?? [];
  $('deadline-reasons').classList.toggle('hidden', !reasons.length);
  $('deadline-reason-list').replaceChildren(...reasons.map((p) => el('button', {
    class: 'secondary', type: 'button', 'data-reason': p.id,
    onclick: () => {
      $('deadline-reason').value = p.reason;
      if (p.new_deadline && !$('deadline-new').value) $('deadline-new').value = p.new_deadline;
      $('deadline-reason').focus();
      say($('deadline-msg'), p.new_deadline ? 'Причина и новый срок в полях — поправьте и отправьте' : 'Причина в поле — выберите новый срок и отправьте', 'ok');
    },
  }, p.label)));
  const past = r.requests.filter((x) => x.outcome);
  $('deadline-history').replaceChildren(...past.map((x) => {
    const [word, kind] = OUTCOME[x.outcome];
    return el('li', { 'data-deadline-request': x.id },
      el('div', {},
        el('div', { class: 'name' }, el('span', { text: `${dayRu(x.old_deadline)} → ${dayRu(x.new_deadline)} ` }), el('span', { class: `badge ${kind}`, text: word })),
        el('div', { class: 'muted', text: [`причина: ${x.reason}`, x.answer ? `ответ: ${x.answer}` : null, x.decided_at ? whenRu(x.decided_at) : null].filter(Boolean).join(' · ') })));
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

const days = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'день' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'дня' : 'дней'}`;
const daysRu = (x) => (Number.isInteger(x) ? days(x) : `${String(x).replace('.', ',')} дня`);

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
    say($('deadline-msg'), 'Просьба отправлена диспетчеру. Пока нет ответа, действует прежний срок.', 'ok');
  } catch (err) { say($('deadline-msg'), err.message); }
});
