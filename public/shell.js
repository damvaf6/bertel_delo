// Общее для разделов кабинета: кто вошёл, переключение разделов, «не найдено».
import { api, el, formatPhone } from '/common.js';

const $ = (id) => document.getElementById(id);
const views = ['list-view', 'order-view', 'missing-view', 'orgs-view', 'org-view', 'profile-view', 'admin-view', 'specialist-view', 'specialists-view', 'money-view', 'notifications-view'];

export const state = { me: null, catalog: null, specialist: null }; // catalog — услуги, поля и статусы из /api/catalog

export function show(id, tab) {
  views.forEach((v) => $(v).classList.toggle('hidden', v !== id));
  document.querySelectorAll('.tabs a').forEach((a) => {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
}

export function notFoundView(title, backHash) {
  $('missing-title').textContent = title;
  $('back2').dataset.back = backHash;
  show('missing-view', null);
}

// Кто я, мои организации, число приглашений. Вызывается при входе и после изменений состава.
export async function refreshMe() {
  const me = await api('GET', '/api/me');
  state.me = me;
  $('who').textContent = me.user.full_name || formatPhone(me.user.phone);
  $('admin-tab').classList.toggle('hidden', me.user.platform_role !== 'admin');
  const staff = ['dispatcher', 'admin'].includes(me.user.platform_role);
  $('specialists-tab').classList.toggle('hidden', !staff);
  state.specialist = (await api('GET', '/api/specialist/me')).specialist;
  $('specialist-tab').classList.toggle('hidden', !state.specialist);
  $('money-tab').classList.toggle('hidden', !staff && !state.specialist);
  setCounts(me);
  const sel = $('order-org');
  sel.replaceChildren(el('option', { value: '', text: 'Лично от себя' }),
    ...me.orgs.map((o) => el('option', { value: o.org_id, text: `От организации «${o.name}»` })));
  $('order-org-box').classList.toggle('hidden', me.orgs.length === 0);
  return me;
}

function setCount(id, n) {
  const cnt = $(id);
  cnt.textContent = String(n);
  cnt.classList.toggle('hidden', !n);
}

function setCounts(me) {
  setCount('invites-count', me.pending_invites);
  setCount('notify-count', me.unread_notifications);
}

export const setUnread = (n) => setCount('notify-count', n);

// Счётчики приглашений и непрочитанных уведомлений — при каждом переходе между разделами.
export async function refreshCounts() {
  try { setCounts(await api('GET', '/api/me')); } catch { /* не страшно: обновятся при следующем переходе */ }
}
