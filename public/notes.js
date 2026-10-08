// Мои заметки к делу (задача 2.115): свои записи исполнителя («уточнить этаж у заказчика»), видит только он. По желанию —
// «Напомнить» на дату: в этот день уведомление в ленте и строка в «Сегодня». «Сделано» — заметка уходит вниз списка,
// напоминания больше нет. Заказчик, диспетчер и руководитель блок не видят. Текст — через textContent.
import { api, el, say } from '/common.js';
import { setNext } from '/next.js';

const $ = (id) => document.getElementById(id);
const dayRu = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
let ctx = null; // { order, today }

export async function loadNotes(current) {
  const box = $('notes-box');
  say($('notes-msg'), '');
  if (!current.executor?.is_me || ['closed', 'cancelled'].includes(current.order.status)) { box.classList.add('hidden'); setNext({ notes: null }); return; }
  ctx = { order: current.order, today: null };
  try { render(await api('GET', `/api/orders/${current.order.id}/notes`)); } catch { box.classList.add('hidden'); setNext({ notes: null }); }
}

function remindText(n) {
  if (!n.remind_on || n.done_at) return null;
  if (n.remind_on < ctx.today) return `напомнить было ${dayRu(n.remind_on)}`;
  return n.remind_on === ctx.today ? 'напомнить сегодня' : `напомнить ${dayRu(n.remind_on)}`;
}

function render(r) {
  const box = $('notes-box');
  box.classList.toggle('hidden', !r.available);
  if (!r.available) { setNext({ notes: null }); return; }
  ctx.today = r.today;
  const open = r.notes.filter((n) => !n.done_at);
  const due = open.filter((n) => n.remind_on && n.remind_on <= r.today).length;
  // Строка у свёрнутого блока (2.101): сколько заметок и есть ли напоминание на сегодня.
  setNext({ notes: !r.notes.length ? 'заметок нет'
    : [`заметок: ${open.length}${r.notes.length > open.length ? ` (сделано ${r.notes.length - open.length})` : ''}`, due ? 'есть напоминание на сегодня' : null].filter(Boolean).join(' · ') });
  $('notes-list').replaceChildren(...r.notes.map((n) => {
    const when = remindText(n);
    const done = !!n.done_at;
    return el('li', { 'data-note': n.id, class: done ? 'muted' : '' },
      el('div', { class: 'title', text: done ? `✓ ${n.body}` : n.body }),
      ...(when ? [el('div', { class: n.remind_on <= r.today ? 'overdue' : 'muted', text: when })] : []),
      ...(r.can_write ? [el('div', { class: 'row' },
        el('button', { type: 'button', class: 'secondary', 'data-action': 'note-done', onclick: () => change(n, { done: !done }, done ? 'Заметка снова в работе' : 'Отмечено: сделано') }, done ? 'Вернуть' : 'Сделано'),
        el('button', { type: 'button', class: 'link', 'data-action': 'note-delete', onclick: () => remove(n) }, 'Удалить'))] : []));
  }));
  $('notes-form').classList.toggle('hidden', !r.can_write);
  $('notes-remind').min = r.today;
}

async function change(n, patch, ok) {
  try {
    render(await api('PATCH', `/api/orders/${ctx.order.id}/notes/${n.id}`, patch));
    say($('notes-msg'), ok, 'ok');
  } catch (err) { say($('notes-msg'), err.message); }
}

async function remove(n) {
  if (!window.confirm(`Удалить заметку «${n.body.slice(0, 60)}»?`)) return;
  try {
    render(await api('DELETE', `/api/orders/${ctx.order.id}/notes/${n.id}`));
    say($('notes-msg'), 'Заметка удалена', 'ok');
  } catch (err) { say($('notes-msg'), err.message); }
}

$('notes-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = $('notes-text').value.trim();
  if (!body) return say($('notes-msg'), 'Напишите заметку');
  const remind = $('notes-remind').value || null;
  try {
    render(await api('POST', `/api/orders/${ctx.order.id}/notes`, { body, remind_on: remind }));
    $('notes-text').value = '';
    $('notes-remind').value = '';
    say($('notes-msg'), remind ? `Заметка сохранена — напомним ${dayRu(remind)}` : 'Заметка сохранена', 'ok');
  } catch (err) { say($('notes-msg'), err.message); }
});
