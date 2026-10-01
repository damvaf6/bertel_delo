// Работа по делу (задача 1.5): проверка результата по правилам и переписка по заявке. Тексты — только через textContent.
import { api, el, say } from '/common.js';

const $ = (id) => document.getElementById(id);
const SIDE_RU = { customer: 'Заказчик', executor: 'Исполнитель', dispatcher: 'Диспетчер' };
const VERDICT_RU = { ok: 'В порядке', issue: 'Замечание' };
const timeRu = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
let orderRef = null;

// ——— Проверка результата ———

const AI_SIDE_RU = { executor: 'исполнитель перед сдачей', dispatcher: 'диспетчер' };

export async function loadReview(current) {
  const box = $('review-box');
  const { order } = current;
  say($('review-msg'), '');
  const r = await api('GET', `/api/orders/${order.id}/review`);
  // Заказчику — только итог после выдачи; исполнителю и служебным — отметки по правилам, когда результат сдавали,
  // и подсказки ИИ (исполнитель может проверить результат с помощью ИИ ещё до сдачи).
  const on = (r.round > 0 && (r.details || ['done', 'closed'].includes(order.status))) || (r.details && (r.can_ai || !!r.ai));
  box.classList.toggle('hidden', !on);
  if (!on) return;
  const s = r.summary;
  let summary;
  if (r.round === 0) summary = 'Перед сдачей можно проверить результат с помощью ИИ по тем же правилам, что и при проверке.';
  else if (s.unchecked === 0 && s.issues === 0) summary = `Результат проверен: все правила (${s.total}) в порядке.`;
  else summary = `Круг проверки ${r.round}. В порядке: ${s.ok} из ${s.total}${s.issues ? `, замечаний: ${s.issues}` : ''}${s.unchecked ? `, не проверено: ${s.unchecked}` : ''}.`;
  $('review-summary').textContent = summary;
  $('ai-review-box').classList.toggle('hidden', !r.details || (!r.can_ai && !r.ai));
  $('ai-review-run').classList.toggle('hidden', !r.can_ai);
  $('ai-review-run').onclick = () => runAi(order);
  $('ai-review-state').textContent = r.ai ? aiState(r.ai) : 'ИИ-проверка ещё не запускалась.';
  if (!r.details) { $('review-checks').replaceChildren(); return; }
  const hints = new Map((r.ai?.items ?? []).map((i) => [i.id, i]));
  $('review-checks').replaceChildren(...r.checks.map((c) => checkItem(order, r, c, hints.get(c.id))));
  // Для возврата на доработку причина собирается из замечаний (диспетчер может её поправить).
  const issues = r.checks.filter((c) => c.verdict === 'issue');
  if (r.can_mark && issues.length && !$('reason').value.trim()) {
    $('reason').value = issues.map((c) => `${c.title}: ${c.note}`).join('; ').slice(0, 1000);
  }
}

function aiState(ai) {
  const unread = ai.files.filter((f) => !f.read).map((f) => f.name);
  const attention = ai.items.filter((i) => i.hint === 'attention').length;
  return [
    `ИИ-проверка: запускал ${AI_SIDE_RU[ai.side]}, ${timeRu(ai.at)}.`,
    attention ? `Стоит посмотреть: ${attention} из ${ai.items.length}.` : 'Замечаний ИИ не видит.',
    unread.length ? `Не прочитаны (такие файлы ИИ пока не читает): ${unread.join(', ')}.` : null,
    'Это подсказка: решение и отметки — за человеком.',
  ].filter(Boolean).join(' ');
}

async function runAi(order) {
  $('ai-review-run').disabled = true;
  say($('review-msg'), 'ИИ проверяет результат…', 'ok');
  try {
    await api('POST', `/api/orders/${order.id}/review/ai`);
    await loadReview({ order });
    say($('review-msg'), 'ИИ-проверка готова', 'ok');
  } catch (err) { say($('review-msg'), err.message); } finally { $('ai-review-run').disabled = false; }
}

function checkItem(order, r, c, hint) {
  const li = el('li', { 'data-check': c.id },
    el('div', { class: 'title', text: c.title }),
    ...(r.round > 0 ? [el('div', { class: `verdict ${c.verdict || 'none'}`, text: VERDICT_RU[c.verdict] || 'Не проверено' })] : []),
    ...(c.note ? [el('p', { class: 'check-note', text: c.note })] : []),
    ...(hint ? [el('p', { class: `ai-hint ${hint.hint}`, text: hint.hint === 'ok' ? `ИИ: ${hint.note || 'замечаний не видно'}` : `ИИ: посмотрите — ${hint.note}` })] : []));
  if (!r.can_mark) return li;
  const note = el('input', { type: 'text', maxlength: '1000', 'aria-label': `Замечание: ${c.title}`, placeholder: 'Что не так (для замечания)' });
  note.value = c.verdict === 'issue' ? c.note || '' : '';
  const send = async (verdict) => {
    try {
      await api('PUT', `/api/orders/${order.id}/review/${c.id}`, { verdict, note: verdict === 'issue' ? note.value : undefined, round: r.round });
      await loadReview({ order });
      say($('review-msg'), 'Отметка сохранена', 'ok');
    } catch (err) { say($('review-msg'), err.message); }
  };
  li.append(el('div', { class: 'check-form' }, note,
    el('div', { class: 'row' },
      el('button', { class: 'secondary', type: 'button', 'data-action': 'ok', onclick: () => send('ok') }, 'В порядке'),
      el('button', { class: 'danger', type: 'button', 'data-action': 'issue', onclick: () => send('issue') }, 'Замечание'))));
  return li;
}

// ——— Переписка ———

export async function loadChat(current) {
  orderRef = current.order;
  say($('chat-msg'), '');
  const { messages, can_write: canWrite } = await api('GET', `/api/orders/${current.order.id}/messages`);
  $('messages').replaceChildren(...messages.map((m) => el('li', { class: m.mine ? 'mine' : '' },
    el('div', { class: 'who', text: [m.mine ? 'Вы' : SIDE_RU[m.side], m.author_name && !m.mine ? m.author_name : null, timeRu(m.at)].filter(Boolean).join(' · ') }),
    el('div', { class: 'body', text: m.body }))));
  $('messages-empty').classList.toggle('hidden', messages.length > 0);
  $('message-form').classList.toggle('hidden', !canWrite);
}

$('message-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = $('message-text').value.trim();
  if (!body) return say($('chat-msg'), 'Напишите сообщение');
  $('message-send').disabled = true;
  try {
    await api('POST', `/api/orders/${orderRef.id}/messages`, { body });
    $('message-text').value = '';
    await loadChat({ order: orderRef });
    say($('chat-msg'), 'Сообщение отправлено', 'ok');
  } catch (err) { say($('chat-msg'), err.message); } finally { $('message-send').disabled = false; }
});
