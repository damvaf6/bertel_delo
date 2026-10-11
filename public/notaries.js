// Нотариусы-партнёры (2а.4). Администратору в «Управлении» — справочник: ФИО, адрес, контакты, окна (день недели и часы),
// оплата, электронный файл для паспортов; добавить, поправить, выключить. Переводчику в «Специалисте» — окна нотариусов на
// две недели и пачка: свои нотариальные переводы в работе (что нести нотариусу).
import { api, el, say } from '/common.js';

const $ = (id) => document.getElementById(id);
const DAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const short = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
};

// ——— Администратор: справочник ———

let editing = null; // id нотариуса в форме; null — новый

export async function loadNotaries() {
  const { notaries } = await api('GET', '/api/admin/notaries');
  $('notaries-empty').classList.toggle('hidden', notaries.length > 0);
  $('notaries').replaceChildren(...notaries.map((n) => el('li', { 'data-notary': n.id },
    el('div', { class: 'title', text: `${n.full_name}${n.active ? '' : ' · не работаем'}` }),
    el('div', { class: 'muted', text: [n.address, n.contacts].filter(Boolean).join(' · ') }),
    el('div', { class: 'muted', text: [`Окна: ${n.windows_text || 'не указаны'}`, `оплата ${n.payment_name}`,
      n.file_for_identity ? 'паспорт файлом — заверяет' : 'паспорт файлом — нет'].join(' · ') }),
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'secondary', 'data-action': 'notary-edit', onclick: () => openForm(n) }, 'Изменить'),
      el('button', { type: 'button', class: n.active ? 'danger' : 'secondary', 'data-action': 'notary-active', onclick: () => setActive(n, !n.active) },
        n.active ? 'Не работаем' : 'Снова работаем')))));
}

function windowRow(w = { weekday: 2, from: '10:00', to: '12:00' }) {
  const day = el('select', { 'aria-label': 'День недели', 'data-w': 'weekday' },
    ...DAYS.map((d, i) => el('option', { value: String(i + 1), text: d })));
  day.value = String(w.weekday);
  const time = (v, label, k) => { const i = el('input', { type: 'time', 'aria-label': label, 'data-w': k }); i.value = v; return i; };
  const li = el('li', { class: 'row', 'data-window': '' }, day, time(w.from, 'С', 'from'), el('span', { text: '–' }), time(w.to, 'До', 'to'));
  li.append(el('button', { type: 'button', class: 'danger', 'aria-label': 'Убрать окно', onclick: () => li.remove() }, '✕'));
  return li;
}

function openForm(n = null) {
  editing = n?.id ?? null;
  $('notary-form-title').textContent = n ? 'Изменить нотариуса' : 'Новый нотариус';
  $('nt-name').value = n?.full_name ?? '';
  $('nt-address').value = n?.address ?? '';
  $('nt-contacts').value = n?.contacts ?? '';
  $('nt-payment').value = n?.payment ?? 'invoice';
  $('nt-identity').checked = !!n?.file_for_identity;
  // Обычно окна — два раза в неделю.
  const windows = n ? n.windows : [{ weekday: 2, from: '10:00', to: '12:00' }, { weekday: 4, from: '10:00', to: '12:00' }];
  $('nt-windows').replaceChildren(...windows.map(windowRow));
  $('notary-form').classList.remove('hidden');
  $('notary-new').classList.add('hidden');
  say($('notary-msg'), '');
  $('nt-name').focus();
}

function closeForm() {
  editing = null;
  $('notary-form').classList.add('hidden');
  $('notary-new').classList.remove('hidden');
}

async function setActive(n, active) {
  if (!active && !confirm(`Перестать работать с нотариусом ${n.full_name}? Его окна пропадут у переводчиков.`)) return;
  try {
    await api('PUT', `/api/admin/notaries/${n.id}`, { active });
    await loadNotaries();
    say($('notary-msg'), active ? 'Нотариус снова в работе' : 'Нотариус выключен', 'ok');
  } catch (err) { say($('notary-msg'), err.message); }
}

$('notary-new').addEventListener('click', () => openForm());
$('nt-cancel').addEventListener('click', () => { closeForm(); say($('notary-msg'), ''); });
$('nt-add-window').addEventListener('click', () => $('nt-windows').append(windowRow()));

$('notary-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const windows = [...$('nt-windows').querySelectorAll('[data-window]')].map((li) => ({
    weekday: Number(li.querySelector('[data-w="weekday"]').value),
    from: li.querySelector('[data-w="from"]').value,
    to: li.querySelector('[data-w="to"]').value,
  }));
  const body = {
    full_name: $('nt-name').value, address: $('nt-address').value, contacts: $('nt-contacts').value,
    windows, payment: $('nt-payment').value, file_for_identity: $('nt-identity').checked,
  };
  try {
    if (editing) await api('PUT', `/api/admin/notaries/${editing}`, body);
    else await api('POST', '/api/admin/notaries', body);
    closeForm();
    await loadNotaries();
    say($('notary-msg'), 'Нотариус сохранён', 'ok');
  } catch (err) { say($('notary-msg'), err.message); }
});

// ——— Переводчик: окна и пачка ———

export async function loadNotaryDesk() {
  let desk;
  try {
    ({ desk } = await api('GET', '/api/specialist/me/notary'));
  } catch (err) { say($('desk-msg'), err.message); return; }
  $('desk-box').classList.toggle('hidden', !desk.translator);
  if (!desk.translator) return;
  $('desk-no-windows').classList.toggle('hidden', desk.windows.length > 0);
  $('desk-windows').replaceChildren(...desk.windows.map((w) => el('li', { 'data-desk-window': w.date },
    el('div', { class: 'title', text: `${w.weekday}, ${short(w.date)} · ${w.from}–${w.to}` }),
    el('div', { class: 'muted', text: [w.notary.full_name, w.notary.address, w.notary.contacts].filter(Boolean).join(' · ') }))));
  const t = desk.totals;
  $('desk-batch-title').textContent = t.orders ? `Пачка: ${t.orders} пер. · документов ${t.docs}` : 'Пачка';
  $('desk-no-batch').classList.toggle('hidden', desk.batch.length > 0);
  $('desk-batch').replaceChildren(...desk.batch.map((b) => el('li', { 'data-desk-order': b.order_id },
    el('a', { class: 'open', href: `#order=${encodeURIComponent(b.order_id)}` },
      el('span', { text: `${b.ref} · ${b.title}` }),
      el('span', { class: 'what', text: [b.service, b.doc_kind, b.language, b.docs ? `${b.docs} док.` : '', b.pages ? `${b.pages} стр.` : '',
        b.original ? `оригинал: ${b.original.toLowerCase()}` : '', b.urgent ? 'срочно' : '', b.deadline ? `срок ${short(b.deadline)}` : '']
        .filter(Boolean).join(' · ') })))));
}
