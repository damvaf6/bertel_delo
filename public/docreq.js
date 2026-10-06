// Запрос недостающих документов (задача 2.64). Исполнитель отмечает документы из списка услуги (или пишет свои) и одной
// кнопкой просит их у заказчика; заказчик видит список с отметками и загружает файл к каждому. Текст — через textContent.
import { api, el, say } from '/common.js';

const $ = (id) => document.getElementById(id);
let ctx = null; // { order, upload(file, msg) → документ или null }

export async function loadDocRequests(current, upload) {
  const box = $('docreq-box');
  say($('docreq-msg'), '');
  if (!current.order.module) { box.classList.add('hidden'); return; }
  ctx = { order: current.order, upload };
  render(await api('GET', `/api/orders/${current.order.id}/doc-requests`));
}

function render(r) {
  const box = $('docreq-box');
  box.classList.toggle('hidden', !(r.can_request || r.requests.length));
  if (box.classList.contains('hidden')) return;
  const waiting = r.requests.filter((x) => !x.done).length;
  $('docreq-lead').textContent = r.can_request
    ? (r.requests.length ? `Получено ${r.requests.length - waiting} из ${r.requests.length}. Заказчику пришло уведомление; файлы появятся и в «Документах».`
      : 'Чего не хватает для работы — отметьте ниже: заказчик получит уведомление и загрузит файлы к каждому пункту.')
    : waiting ? (r.can_upload ? `Исполнитель просит документы: осталось загрузить ${waiting}. Нажмите «Загрузить файл» у каждого.` : `Исполнитель ждёт документы от заказчика: ${waiting}.`)
      : 'Все запрошенные документы получены.';
  $('docreq-list').replaceChildren(...r.requests.map((x) => item(x, r)));
  $('docreq-form').classList.toggle('hidden', !r.can_request);
  if (r.can_request) {
    $('docreq-items').replaceChildren(...r.catalog.map((c) => {
      const id = `docreq-item-${c.id}`;
      return el('label', { class: 'row gap', for: id },
        el('input', { type: 'checkbox', id, value: c.id, ...(c.open ? { disabled: '' } : {}) }),
        el('span', {}, el('span', { text: c.title }), ...(c.open ? [el('span', { class: 'muted', text: ' — уже запрошен' })] : [])));
    }));
  }
}

function item(x, r) {
  const sub = [x.done ? `Получено: ${x.document.filename}` : null, x.hint, x.note ? `Пояснение: ${x.note}` : null].filter(Boolean).join(' · ');
  const actions = [];
  if (!x.done && r.can_upload) {
    const id = `docreq-file-${x.id}`;
    actions.push(el('label', { class: 'btn secondary', for: id }, 'Загрузить файл'),
      el('input', { id, type: 'file', class: 'visually-hidden', 'aria-label': `Файл: ${x.title}`, onchange: (e) => attach(x, e) }));
  }
  if (!x.done && r.can_request) actions.push(el('button', { type: 'button', class: 'danger', 'data-action': 'cancel', onclick: () => cancel(x) }, 'Не нужен'));
  return el('li', { class: 'doc', 'data-request': x.id },
    el('div', {},
      el('div', { class: 'name' }, el('span', { text: `${x.title} ` }), el('span', { class: `badge${x.done ? ' ok' : ' warn'}`, text: x.done ? 'получен' : 'нужен' })),
      ...(sub ? [el('div', { class: 'muted', text: sub })] : [])),
    ...(actions.length ? [el('div', { class: 'row' }, ...actions)] : []));
}

async function attach(x, e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const doc = await ctx.upload(file, $('docreq-msg'));
  if (!doc) return;
  try {
    render(await api('POST', `/api/orders/${ctx.order.id}/doc-requests/${x.id}/attach`, { document_id: doc.id }));
    say($('docreq-msg'), `«${x.title}»: файл получен, исполнитель увидит его в деле`, 'ok');
  } catch (err) { say($('docreq-msg'), err.message); }
}

async function cancel(x) {
  try {
    render(await api('DELETE', `/api/orders/${ctx.order.id}/doc-requests/${x.id}`));
    say($('docreq-msg'), `«${x.title}» больше не запрашивается`, 'ok');
  } catch (err) { say($('docreq-msg'), err.message); }
}

$('docreq-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const items = [...document.querySelectorAll('#docreq-items input:checked')].map((i) => i.value);
  const custom = $('docreq-custom').value.split('\n').map((s) => s.trim()).filter(Boolean);
  try {
    const r = await api('POST', `/api/orders/${ctx.order.id}/doc-requests`, { items, custom, note: $('docreq-note').value });
    $('docreq-custom').value = '';
    $('docreq-note').value = '';
    render(r);
    say($('docreq-msg'), `Запрошено документов: ${r.requested}. Заказчику отправлено уведомление.`, 'ok');
  } catch (err) { say($('docreq-msg'), err.message); }
});
