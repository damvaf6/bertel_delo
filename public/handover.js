// Просьба передать дело коллеге (задача 2.107). Эксперт, который работает от организации, просит руководителя передать дело
// в работе другому эксперту (отпуск, болезнь) с причиной; пока нет ответа — может отозвать. Руководитель передаёт или
// отказывает в «Сегодня» и «Делах экспертов». Заказчик и диспетчер блок не видят. Текст — через textContent.
import { api, say } from '/common.js';

const $ = (id) => document.getElementById(id);
const whenRu = (s) => new Date(s).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
let ctx = null; // { order, open }

export async function loadHandover(current) {
  const box = $('handover-box');
  say($('handover-msg'), '');
  if (!current.executor?.is_me || current.order.status !== 'in_work') { box.classList.add('hidden'); return; }
  ctx = { order: current.order, open: null };
  render(await api('GET', `/api/orders/${current.order.id}/handover`));
}

function render(r) {
  const box = $('handover-box');
  box.classList.toggle('hidden', !r.available || (!r.open && !r.can_request));
  if (box.classList.contains('hidden')) return;
  ctx.open = r.open;
  $('handover-lead').textContent = r.open ? `Ждём ответа руководителя организации «${r.org}». Пока он не ответил, дело ведёте Вы.`
    : `Уходите в отпуск или заболели? Попросите руководителя организации «${r.org}» передать дело другому эксперту — файлы, черновик, фото и переписка останутся в деле.`;
  $('handover-open').classList.toggle('hidden', !r.open);
  if (r.open) $('handover-open-text').textContent = `Вы попросили ${whenRu(r.open.requested_at)}. Причина: ${r.open.reason}`;
  const d = r.declined;
  $('handover-declined').classList.toggle('hidden', !d);
  if (d) $('handover-declined').textContent = `Руководитель не стал передавать дело ${whenRu(d.decided_at)}${d.answer ? `: ${d.answer}` : ''}.`;
  $('handover-form').classList.toggle('hidden', !r.can_request);
}

$('handover-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!$('handover-reason').value.trim()) return say($('handover-msg'), 'Укажите причину');
  try {
    render(await api('POST', `/api/orders/${ctx.order.id}/handover`, { reason: $('handover-reason').value.trim() }));
    $('handover-reason').value = '';
    say($('handover-msg'), 'Просьба отправлена руководителю — он передаст дело коллеге или ответит Вам.', 'ok');
  } catch (err) { say($('handover-msg'), err.message); }
});
$('handover-withdraw').addEventListener('click', async () => {
  if (!ctx?.open) return;
  try {
    render(await api('DELETE', `/api/orders/${ctx.order.id}/handover/${ctx.open.id}`));
    say($('handover-msg'), 'Просьба отозвана — дело остаётся у Вас', 'ok');
  } catch (err) { say($('handover-msg'), err.message); }
});
