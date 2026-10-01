// Кабинет: разделы «Заявки», «Организации», «Профиль», «Управление» (только администратору). Заявка — order.js.
// Разделы переключаются адресом после «#»: #order=…, #orgs, #org=…, #profile, #admin.
import { api, el, say, formatPhone } from '/common.js';
import { state, show, refreshMe } from '/shell.js';
import { openOrder, serviceOptions, dayRu } from '/order.js';
import { showOrgs, showOrg } from '/orgs.js';
import { showAdmin } from '/admin.js';

const $ = (id) => document.getElementById(id);
const dateRu = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

async function start() {
  api('GET', '/api/health').then((h) => { if (h?.test_data) $('test-mark').classList.remove('hidden'); }).catch(() => {});
  try {
    [, state.catalog] = await Promise.all([refreshMe(), api('GET', '/api/catalog')]);
  } catch (err) {
    if (err.status === 401) return location.replace('/');
    throw err;
  }
  serviceOptions($('service'));
  window.addEventListener('hashchange', route);
  await route();
}

async function route() {
  const h = location.hash;
  let m;
  if ((m = h.match(/^#order=([0-9a-f-]{36})$/i))) return openOrder(m[1]);
  if ((m = h.match(/^#org=([0-9a-f-]{36})$/i))) return showOrg(m[1]);
  if (h === '#orgs') return showOrgs();
  if (h === '#profile') return showProfile();
  if (h === '#admin' && state.me.user.platform_role === 'admin') return showAdmin();
  show('list-view', 'orders');
  await loadOrders();
}

async function loadOrders() {
  const { orders } = await api('GET', '/api/orders');
  const ul = $('orders');
  ul.replaceChildren(...orders.map((o) => el('li', {},
    el('button', { class: 'open', 'data-id': o.id, onclick: () => { location.hash = `order=${o.id}`; } },
      el('div', { class: 'title', text: o.title }),
      el('div', { class: 'row' },
        el('span', { class: `badge status${o.status === 'cancelled' ? ' cancelled' : ''}`, text: o.status_name }),
        el('span', { class: `muted${o.overdue ? ' overdue' : ''}`, text: o.deadline ? `срок ${dayRu(o.deadline)}${o.overdue ? ' · просрочено' : ''}` : ['closed', 'cancelled'].includes(o.status) ? '' : 'срок не указан' })),
      el('div', { class: 'muted', text: [o.service_name, dateRu(o.created_at), o.org_name ? `${o.org_name} · ведёт ${o.responsible_name || 'сотрудник'}` : null].filter(Boolean).join(' · ') })))));
  $('orders-empty').classList.toggle('hidden', orders.length > 0);
}

function showProfile() {
  $('full-name').value = state.me.user.full_name;
  $('profile-phone').textContent = `Телефон для входа: ${formatPhone(state.me.user.phone)}`;
  say($('profile-msg'), '');
  show('profile-view', 'profile');
}

$('profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fullName = $('full-name').value.trim();
  if (!fullName) return say($('profile-msg'), 'Укажите, как к Вам обращаться');
  $('save-profile').disabled = true;
  try {
    await api('PATCH', '/api/me', { full_name: fullName });
    await refreshMe();
    say($('profile-msg'), 'Сохранено', 'ok');
  } catch (err) { say($('profile-msg'), err.message); } finally { $('save-profile').disabled = false; }
});

$('new-order').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('title').value.trim();
  const [module, service] = $('service').value.split('/');
  const orgId = $('order-org').value || null;
  $('create').disabled = true;
  try {
    const { order } = await api('POST', '/api/orders', { module, service, ...(title ? { title } : {}), ...(orgId ? { org_id: orgId } : {}) });
    $('title').value = '';
    say($('new-msg'), '');
    location.hash = `order=${order.id}`;
  } catch (err) { say($('new-msg'), err.message); } finally { $('create').disabled = false; }
});

$('logout').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout').catch(() => {});
  location.replace('/');
});
const back = () => { location.hash = ''; };
$('back').addEventListener('click', back);
$('back2').addEventListener('click', () => { location.hash = $('back2').dataset.back || ''; });

start();
