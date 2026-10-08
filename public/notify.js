// Раздел «Уведомления» (задача 1.7): лента (непрочитанные отмечены точкой; при открытии раздела отмечаются прочитанными)
// и настройки СМС по видам. Тексты — только через textContent.
import { api, el, say, quoted } from '/common.js';
import { show, setUnread } from '/shell.js';

const $ = (id) => document.getElementById(id);
const dateRu = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

function item(n) {
  // По делу организации (2.67) — и организация, и номер дела: у руководителя организаций может быть несколько.
  const where = [n.order_title, n.org_name ? `Организация ${quoted(n.org_name)}` : null,
    n.order_ref ? `заявка ${n.order_ref.replace(' ', '\u00a0')}` : null].filter(Boolean).join(' · ') || null;
  const body = [
    el('div', { class: 'title', text: n.title }),
    ...(where ? [el('div', { class: 'muted', text: where })] : []),
    el('div', { class: 'muted', text: dateRu(n.at) }),
  ];
  const go = n.order_id ? `order=${n.order_id}${n.to ? `&to=${n.to}` : ''}` : n.section;
  return el('li', { class: n.read ? '' : 'unread' },
    go ? el('button', { class: 'open', onclick: () => { location.hash = go; } }, ...body) : el('div', {}, ...body));
}

export async function showNotifications() {
  show('notifications-view', 'notifications');
  say($('notify-msg'), '');
  const [{ notifications, unread }, { settings }] = await Promise.all([
    api('GET', '/api/notifications'), api('GET', '/api/notifications/settings'),
  ]);
  $('notifications').replaceChildren(...notifications.map(item));
  $('notifications-empty').classList.toggle('hidden', notifications.length > 0);
  renderSettings(settings);
  // Показали — значит, прочитано (точки остаются до следующего открытия раздела).
  if (unread) setUnread((await api('POST', '/api/notifications/read', { all: true })).unread);
}

function renderSettings(settings) {
  $('notify-types').replaceChildren(...settings.map((t) => {
    const box = el('input', { type: 'checkbox', id: `sms-${t.type}`, 'data-type': t.type });
    box.checked = t.sms;
    box.addEventListener('change', () => save(box));
    return el('div', { class: 'notify-type' },
      el('label', { class: 'row', for: `sms-${t.type}` }, box, el('span', { text: t.name })),
      ...(t.hint ? [el('p', { class: 'muted', text: t.hint })] : []));
  }));
}

async function save(box) {
  box.disabled = true;
  try {
    await api('PUT', '/api/notifications/settings', { type: box.dataset.type, sms: box.checked });
    say($('notify-msg'), box.checked ? 'СМС включены' : 'СМС выключены — уведомления останутся в кабинете', 'ok');
  } catch (err) {
    box.checked = !box.checked;
    say($('notify-msg'), err.message);
  } finally { box.disabled = false; }
}
