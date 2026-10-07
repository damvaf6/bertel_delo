// Выезд помощника по экспресс-заявке (задача 2.4): исполнитель назначает помощника и время выезда, видит ход выезда и
// данные с объекта; фото помощника — в блоке «Дистанционный осмотр» по шагам. Заказчик видит ход и данные, без имени
// помощника. Тексты — через textContent.
import { api, el, say } from '/common.js';
import { loadInspection } from '/inspect.js';
import { setNext } from '/next.js';

const $ = (id) => document.getElementById(id);
const timeRu = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const STATE_RU = { active: 'назначен', finished: 'завершён', cancelled: 'отменён', closed: 'закрыт' };
let ctx = null;   // { order }

// Значение для поля «дата и время» по местному времени: завтра, 10:00.
function tomorrowAt10() {
  const d = new Date(Date.now() + 86400_000);
  d.setHours(10, 0, 0, 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T10:00`;
}

export async function loadOnsite(current) {
  const box = $('onsite-box');
  say($('onsite-msg'), '');
  ctx = { order: current.order };
  if (!current.order.express) { box.classList.add('hidden'); return; }
  const r = await api('GET', `/api/orders/${current.order.id}/onsite`);
  box.classList.remove('hidden');
  const open = r.visits.find((v) => v.state === 'active');
  setNext({ onsite: open ? 'выезд назначен' : r.visits.some((v) => v.state === 'finished') ? 'выезд завершён' : 'выезд не назначен' });
  $('onsite-assign').classList.toggle('hidden', !r.can_assign);
  if (r.can_assign) {
    $('onsite-helper').replaceChildren(...(r.helpers.length
      ? r.helpers.map((h) => el('option', { value: h.user_id, text: `${h.name || 'Помощник без имени'}${h.open_visits ? ` · выездов: ${h.open_visits}` : ''}` }))
      : [el('option', { value: '', text: 'Нет свободных помощников в районе объекта' })]));
    $('onsite-new').disabled = !r.helpers.length;
    $('onsite-new').textContent = open ? 'Назначить другой выезд' : 'Назначить выезд';
    if (!$('onsite-when').value) $('onsite-when').value = tomorrowAt10();
  }
  $('onsite-state').textContent = r.visits.length
    ? 'Фото помощника — в блоке «Дистанционный осмотр» по шагам, данные с объекта — ниже.'
    : r.can_assign ? 'Экспресс: на объект выезжает помощник платформы, Вы работаете дистанционно. Согласуйте время с заказчиком в переписке и назначьте выезд.'
      : 'Экспресс: выезд помощника на объект ещё не назначен.';
  $('onsite-visits').replaceChildren(...r.visits.map((v) => el('li', { 'data-visit': v.id },
    el('div', { class: 'doc' },
      el('div', {},
        el('div', { class: 'name', text: `Выезд ${timeRu(v.planned_at)} — ${STATE_RU[v.state]}` }),
        el('div', { class: 'muted', text: [v.helper_name ? `помощник: ${v.helper_name}` : null, `фото: ${v.photos}`,
          v.finished_at ? `завершён ${timeRu(v.finished_at)}` : null].filter(Boolean).join(' · ') })),
      ...(r.can_assign && v.state === 'active' ? [el('button', { class: 'danger', 'data-action': 'cancel-visit', onclick: () => cancel(v) }, 'Отменить')] : [])),
    ...(v.data.length ? [el('dl', { class: 'facts' }, ...v.data.flatMap((d) => [el('dt', { text: d.label }), el('dd', { text: String(d.value) })]))] : []))));
}

async function cancel(v) {
  if (!confirm('Отменить выезд? Помощник больше не сможет присылать по нему фото; присланное останется в деле.')) return;
  try {
    await api('DELETE', `/api/orders/${ctx.order.id}/onsite/${v.id}`);
    await loadOnsite({ order: ctx.order });
    say($('onsite-msg'), 'Выезд отменён', 'ok');
  } catch (err) { say($('onsite-msg'), err.message); }
}

$('onsite-assign').addEventListener('submit', async (e) => {
  e.preventDefault();
  const when = $('onsite-when').value;
  if (!when) return say($('onsite-msg'), 'Укажите дату и время выезда');
  $('onsite-new').disabled = true;
  try {
    await api('POST', `/api/orders/${ctx.order.id}/onsite`, { helper_id: $('onsite-helper').value, planned_at: new Date(when).toISOString() });
    await Promise.all([loadOnsite({ order: ctx.order }), loadInspection({ order: ctx.order })]);
    say($('onsite-msg'), 'Выезд назначен — помощник получил уведомление', 'ok');
  } catch (err) { say($('onsite-msg'), err.message); } finally { $('onsite-new').disabled = false; }
});
