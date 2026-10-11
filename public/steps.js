// Ход заказа перевода (задача 2а.6): передача оригинала, подпись у нотариуса, файл нотариуса, выдача бумаги. Отмечают
// переводчик или платформа (кто — по шагу), заказчик видит, что сделано и когда. Шаги «до сдачи» нужны, чтобы сдать перевод
// на проверку. Файл нотариуса — выбор среди своих файлов результата. Текст — через textContent.
import { api, el, say } from '/common.js';
import { setNext } from '/next.js';

const $ = (id) => document.getElementById(id);
const when = (iso) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
let orderId = null;

export async function loadSteps(current) {
  orderId = current.order.id;
  say($('steps-msg'), '');
  try { render(await api('GET', `/api/orders/${orderId}/steps`)); } catch { hide(); }
}

function hide() { $('steps-box').classList.add('hidden'); setNext({ steps: null }); }

function render(r) {
  if (!r.available) return hide();
  $('steps-box').classList.remove('hidden');
  const need = r.steps.filter((s) => s.before_review);
  setNext({ steps: { need: need.length, done: need.filter((s) => s.done).length, total: r.steps.length, all: r.steps.filter((s) => s.done).length } });
  $('steps-list').replaceChildren(...r.steps.map((s) => item(s, r.files ?? [])));
}

function item(s, files) {
  const li = el('li', { 'data-order-step': s.id, class: s.done ? '' : 'muted' },
    el('div', { class: 'title', text: `${s.done ? '✓' : '○'} ${s.title}` }));
  if (s.done) {
    li.append(el('div', { class: 'muted', text: [when(s.done_at), s.note].filter(Boolean).join(' · ') }));
  } else if (s.hint) {
    li.append(el('div', { class: 'muted', text: `${s.hint}${s.before_review ? ' · нужно до сдачи' : ''}` }));
  }
  if (s.can_mark) {
    const id = `step-${s.id}`;
    if (s.file) {
      const sel = el('select', { id, 'data-role': 'step-file' },
        el('option', { value: '' }, files.length ? 'Выберите файл нотариуса' : 'Сначала добавьте файл результата'),
        ...files.map((f) => el('option', { value: f.id }, f.filename)));
      li.append(el('div', { class: 'field' }, el('label', { for: id, text: 'Файл с подписью нотариуса' }), sel),
        el('button', { type: 'button', class: 'secondary', 'data-action': 'step-mark', onclick: () => mark(s, { document_id: sel.value }) }, 'Отметить'));
    } else {
      const input = s.note_label ? el('input', { id, maxlength: '300', 'data-role': 'step-note' }) : null;
      li.append(...(input ? [el('div', { class: 'field' }, el('label', { for: id, text: s.note_label }), input)] : []),
        el('button', { type: 'button', class: 'secondary', 'data-action': 'step-mark', onclick: () => mark(s, { note: input?.value ?? '' }) }, 'Отметить: сделано'));
    }
  }
  if (s.can_undo) li.append(el('button', { type: 'button', class: 'link', 'data-action': 'step-undo', onclick: () => undo(s) }, 'Снять отметку'));
  return li;
}

async function mark(s, body) {
  if (s.file && !body.document_id) return say($('steps-msg'), 'Выберите файл нотариуса');
  try {
    render(await api('POST', `/api/orders/${orderId}/steps/${s.id}`, body));
    say($('steps-msg'), `Отмечено: ${s.title}`, 'ok');
  } catch (err) { say($('steps-msg'), err.message); }
}

async function undo(s) {
  if (!window.confirm(`Снять отметку «${s.title}»?`)) return;
  try {
    render(await api('DELETE', `/api/orders/${orderId}/steps/${s.id}`));
    say($('steps-msg'), 'Отметка снята', 'ok');
  } catch (err) { say($('steps-msg'), err.message); }
}
