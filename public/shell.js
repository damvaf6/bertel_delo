// Общее для разделов кабинета: кто вошёл, переключение разделов, «не найдено».
import { api, el, formatPhone, quoted } from '/common.js';

const $ = (id) => document.getElementById(id);
const views = ['list-view', 'order-view', 'missing-view', 'orgs-view', 'org-view', 'profile-view', 'admin-view', 'specialist-view', 'specialists-view', 'money-view', 'notifications-view', 'assistant-view', 'expert-view', 'help-view', 'problems-view'];

export const state = { me: null, catalog: null, specialist: null }; // catalog — услуги, поля и статусы из /api/catalog

// Какой раздел соответствует адресу (#order=…, #org=… и т. д.). Раздел, который догрузился, когда человек уже ушёл
// по другому адресу, не показывается поверх нового (быстрые переходы на медленной связи).
const VIEW_OF = [
  [/^#order=/, 'order-view'], [/^#org=/, 'org-view'], [/^#orgs$/, 'orgs-view'], [/^#expert=/, 'expert-view'],
  [/^#profile$/, 'profile-view'], [/^#assistant(=|$)/, 'assistant-view'], [/^#specialist$/, 'specialist-view'],
  [/^#specialists$/, 'specialists-view'], [/^#admin$/, 'admin-view'], [/^#money$/, 'money-view'],
  [/^#notifications$/, 'notifications-view'], [/^#help$/, 'help-view'], [/^#problems$/, 'problems-view'],
];
function stale(id) {
  if (id === 'list-view') return false;
  if (id === 'missing-view') return !/^#(order|org|expert)=/.test(location.hash);
  const want = VIEW_OF.find(([re]) => re.test(location.hash))?.[1];
  return want !== undefined ? want !== id : false;
}

export function show(id, tab) {
  if (stale(id)) return;
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
  $('problems-tab').classList.toggle('hidden', !staff);
  state.specialist = (await api('GET', '/api/specialist/me')).specialist;
  $('specialist-tab').classList.toggle('hidden', !state.specialist);
  $('money-tab').classList.toggle('hidden', !staff && !state.specialist);
  setCounts(me);
  const sel = $('order-org');
  sel.replaceChildren(el('option', { value: '', text: 'Лично от себя' }),
    ...me.orgs.map((o) => el('option', { value: o.org_id, text: `От организации ${quoted(o.name)}` })));
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
