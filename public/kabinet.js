import { api, el, say, formatPhone, formatSize } from '/common.js';

const $ = (id) => document.getElementById(id);
const MAX_FILE = 5 * 1024 * 1024;
const views = ['list-view', 'order-view', 'missing-view'];
const show = (id) => views.forEach((v) => $(v).classList.toggle('hidden', v !== id));
const dateRu = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

let current = null;

async function start() {
  api('GET', '/api/health').then((h) => { if (h?.test_data) $('test-mark').classList.remove('hidden'); }).catch(() => {});
  try {
    const me = await api('GET', '/api/me');
    $('who').textContent = me.user.full_name || formatPhone(me.user.phone);
  } catch (err) {
    if (err.status === 401) return location.replace('/');
    throw err;
  }
  window.addEventListener('hashchange', route);
  await route();
}

async function route() {
  const m = location.hash.match(/^#order=([0-9a-f-]{36})$/i);
  if (m) return openOrder(m[1]);
  current = null;
  show('list-view');
  await loadOrders();
}

async function loadOrders() {
  const { orders } = await api('GET', '/api/orders');
  const ul = $('orders');
  ul.replaceChildren(...orders.map((o) => el('li', {},
    el('button', { class: 'open', 'data-id': o.id, onclick: () => { location.hash = `order=${o.id}`; } },
      el('div', { class: 'title', text: o.title }),
      el('div', { class: 'muted', text: dateRu(o.created_at) })))));
  $('orders-empty').classList.toggle('hidden', orders.length > 0);
}

async function openOrder(id) {
  try {
    const { order } = await api('GET', `/api/orders/${id}`);
    current = order;
    $('order-title').textContent = order.title;
    $('order-meta').textContent = `Создана ${dateRu(order.created_at)}`;
    say($('doc-msg'), '');
    show('order-view');
    await loadDocs();
  } catch (err) {
    if (err.status === 404) { current = null; return show('missing-view'); }
    throw err;
  }
}

async function loadDocs() {
  const { documents } = await api('GET', `/api/orders/${current.id}/documents`);
  $('docs').replaceChildren(...documents.map((d) => el('li', { class: 'doc' },
    el('div', {},
      el('div', { class: 'name', text: d.filename }),
      el('div', { class: 'muted', text: formatSize(d.size_bytes) })),
    el('div', { class: 'row' },
      el('button', { class: 'secondary', 'data-action': 'download', onclick: () => download(d) }, 'Скачать'),
      el('button', { class: 'danger', 'data-action': 'delete', onclick: () => remove(d) }, 'Удалить')))));
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
  $('create').disabled = true;
  try {
    const { order } = await api('POST', '/api/orders', { title });
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
$('back2').addEventListener('click', back);

start();
