// Кабинет: разделы «Заявки», «Организации», «Профиль», «Управление» (только администратору).
// Разделы переключаются адресом после «#»: #order=…, #orgs, #org=…, #profile, #admin.
import { api, el, say, formatPhone, formatSize, ROLE_RU } from '/common.js';
import { state, show, notFoundView, refreshMe } from '/shell.js';
import { showOrgs, showOrg } from '/orgs.js';
import { showAdmin } from '/admin.js';

const $ = (id) => document.getElementById(id);
const MAX_FILE = 5 * 1024 * 1024;
const dateRu = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
let current = null;

async function start() {
  api('GET', '/api/health').then((h) => { if (h?.test_data) $('test-mark').classList.remove('hidden'); }).catch(() => {});
  try {
    await refreshMe();
  } catch (err) {
    if (err.status === 401) return location.replace('/');
    throw err;
  }
  window.addEventListener('hashchange', route);
  await route();
}

async function route() {
  const h = location.hash;
  let m;
  if ((m = h.match(/^#order=([0-9a-f-]{36})$/i))) return openOrder(m[1]);
  if ((m = h.match(/^#org=([0-9a-f-]{36})$/i))) return showOrg(m[1]);
  current = null;
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
      el('div', { class: 'muted', text: [dateRu(o.created_at), o.org_name ? `${o.org_name} · ведёт ${o.responsible_name || 'сотрудник'}` : null].filter(Boolean).join(' · ') })))));
  $('orders-empty').classList.toggle('hidden', orders.length > 0);
}

async function openOrder(id) {
  try {
    const { order, access } = await api('GET', `/api/orders/${id}`);
    current = { ...order, access };
    $('order-title').textContent = order.title;
    $('order-meta').textContent = `Создана ${dateRu(order.created_at)}`;
    $('order-org-line').textContent = order.org_name
      ? `Организация: ${order.org_name} · Ведёт: ${order.responsible_name || 'сотрудник без имени'}`
      : 'Личная заявка';
    $('upload-box').classList.toggle('hidden', access === 'read');
    say($('doc-msg'), '');
    say($('transfer-msg'), '');
    show('order-view', 'orders');
    await Promise.all([loadDocs(), loadTransfer()]);
  } catch (err) {
    if (err.status === 404) { current = null; return notFoundView('Заявка не найдена', ''); }
    throw err;
  }
}

// Руководитель и старший видят, кто ведёт дело, и могут передать его другому участнику организации.
async function loadTransfer() {
  const box = $('transfer-box');
  box.classList.toggle('hidden', current.access !== 'manage');
  if (current.access !== 'manage') return;
  const { members } = await api('GET', `/api/orgs/${current.org_id}/members`);
  $('transfer-to').replaceChildren(...members.map((m) => el('option', {
    value: m.user_id,
    text: [m.full_name || (m.phone ? formatPhone(m.phone) : 'Без имени'), ROLE_RU[m.role].toLowerCase(), m.orders !== undefined ? `дел ${m.orders}` : null].filter(Boolean).join(' · '),
  })));
  $('transfer-to').value = current.owner_user_id;
}

async function loadDocs() {
  const canChange = current.access !== 'read';
  const { documents } = await api('GET', `/api/orders/${current.id}/documents`);
  $('docs').replaceChildren(...documents.map((d) => el('li', { class: 'doc' },
    el('div', {},
      el('div', { class: 'name', text: d.filename }),
      el('div', { class: 'muted', text: formatSize(d.size_bytes) })),
    el('div', { class: 'row' },
      el('button', { class: 'secondary', 'data-action': 'download', onclick: () => download(d) }, 'Скачать'),
      ...(canChange ? [el('button', { class: 'danger', 'data-action': 'delete', onclick: () => remove(d) }, 'Удалить')] : [])))));
  $('docs-empty').classList.toggle('hidden', documents.length > 0);
}

async function download(d) {
  try {
    const { url } = await api('GET', `/api/documents/${d.id}/link`);
    location.assign(url);
  } catch (err) { say($('doc-msg'), err.message); }
}

async function remove(d) {
  if (!confirm(`Удалить «${d.filename}»?`)) return;
  try {
    await api('DELETE', `/api/documents/${d.id}`);
    say($('doc-msg'), 'Файл удалён', 'ok');
    await loadDocs();
  } catch (err) { say($('doc-msg'), err.message); }
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

$('transfer-box').addEventListener('submit', async (e) => {
  e.preventDefault();
  const userId = $('transfer-to').value;
  if (userId === current.owner_user_id) return say($('transfer-msg'), 'Дело уже ведёт этот сотрудник');
  $('transfer').disabled = true;
  try {
    const { order } = await api('PATCH', `/api/orders/${current.id}/responsible`, { user_id: userId });
    current = { ...current, ...order };
    $('order-org-line').textContent = `Организация: ${order.org_name} · Ведёт: ${order.responsible_name || 'сотрудник без имени'}`;
    say($('transfer-msg'), 'Дело передано', 'ok');
  } catch (err) { say($('transfer-msg'), err.message); } finally { $('transfer').disabled = false; }
});

$('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > MAX_FILE) return say($('doc-msg'), 'Файл больше 5 МБ');
  say($('doc-msg'), 'Загружаем…', 'ok');
  try {
    await api('POST', `/api/orders/${current.id}/documents`, file, {
      'content-type': file.type || 'application/octet-stream',
      'x-file-name': encodeURIComponent(file.name),
    });
    say($('doc-msg'), 'Файл добавлен', 'ok');
    await loadDocs();
  } catch (err) { say($('doc-msg'), err.message); }
});

$('new-order').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('title').value.trim();
  if (!title) return say($('new-msg'), 'Опишите, что нужно');
  const orgId = $('order-org').value || null;
  $('create').disabled = true;
  try {
    const { order } = await api('POST', '/api/orders', orgId ? { title, org_id: orgId } : { title });
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
