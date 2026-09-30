// Общее для разделов кабинета: кто вошёл, переключение разделов, «не найдено».
import { api, el, formatPhone } from '/common.js';

const $ = (id) => document.getElementById(id);
const views = ['list-view', 'order-view', 'missing-view', 'orgs-view', 'org-view', 'profile-view', 'admin-view'];

export const state = { me: null };

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
  const cnt = $('invites-count');
  cnt.textContent = String(me.pending_invites);
  cnt.classList.toggle('hidden', !me.pending_invites);
  const sel = $('order-org');
  sel.replaceChildren(el('option', { value: '', text: 'Лично от себя' }),
    ...me.orgs.map((o) => el('option', { value: o.org_id, text: `От организации «${o.name}»` })));
  $('order-org-box').classList.toggle('hidden', me.orgs.length === 0);
  return me;
}
