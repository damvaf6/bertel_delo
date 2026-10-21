// «Что сказано в задании на оценку» (задача 2.305). Эксперту и диспетчеру в деле — одним списком, что программа взяла из
// приложенного задания на оценку (письма заказчика, определения суда): дата оценки, вид стоимости, цель, заказчик, адрес,
// срок — с файлом и страницей; нажатие на файл открывает его. В заявке другое — видно рядом. Задания нет — блока нет.
// Срок по заданию взят из письма о переносе срока (2.333) — строка «Срок перенесён письмом: на …» с прежним сроком и файлом.
// Черновик готовили до письма, и в строке «Срок» таблицы задания старый срок (2.343) — «Заменить срок в черновике» одной
// кнопкой, с «Отменить». Текст — через textContent.
import { api, el, say } from '/common.js';
import { swapDueInDraft, undoSwap } from '/draft.js';

const $ = (id) => document.getElementById(id);

export async function loadTaskFacts(current) {
  const box = $('task-box');
  say($('task-msg'), '');
  const mine = current.executor?.is_me && ['in_work', 'review', 'done'].includes(current.order.status);
  if (!mine) { box.classList.add('hidden'); return; }
  let v;
  try { v = await api('GET', `/api/orders/${current.order.id}/task`); } catch { box.classList.add('hidden'); return; }
  box.classList.toggle('hidden', !v.files.length);
  if (!v.files.length) return;
  $('task-lead').textContent = v.files.length > 1
    ? `Из файлов задания (${v.files.length}) программа взяла в черновик и проверку:`
    : 'Из файла задания программа взяла в черновик и проверку:';
  const open = (id) => async () => {
    try { location.assign((await api('GET', `/api/documents/${id}/link`)).url); } catch (err) { say($('task-msg'), err.message); }
  };
  const items = v.items.map((x) => {
    const note = [];
    if (x.many) note.push('в файлах задания разные — выберите сами');
    if (x.typed) note.push(`в заявке — ${x.typed}`);
    if (x.later) note.push(`срок дела — ${x.later}, позже срока по заданию`);
    if (x.was) note.push(`${x.was_letter ? 'по прежнему письму' : 'по заданию'} было — ${x.was}`);
    return el('li', { 'data-task': x.id },
      el('span', {}, el('span', { class: 'title', text: `${x.label}: ` }), el('span', { text: x.v })),
      note.length ? el('p', { class: 'muted', text: note.join('; ') }) : '',
      x.doc_id ? el('button', { type: 'button', class: 'link', 'data-action': 'task-open', onclick: open(x.doc_id) }, `«${x.name}», стр. ${x.page}`) : '',
      x.swap ? dueSwapBox(x) : '');
  });
  if (!items.length) items.push(el('li', { class: 'muted', text: 'Даты оценки, цели, вида стоимости, заказчика, адреса и срока программа в задании не нашла — проверьте файл сами.' }));
  $('task-list').replaceChildren(...items);
}

// 2.343: в черновике в строке «Срок» — прежний срок, а пришло письмо о переносе: замена одной кнопкой и отмена.
function dueSwapBox(x) {
  const day = x.v.replace(/^на /u, '');
  const line = el('p', { class: 'warn-line', 'data-task-due-draft': '', text: `В черновике в строке «Срок» — ${x.swap.was || 'пусто'}, а по письму о переносе — ${day}` });
  const btn = el('button', { type: 'button', class: 'secondary', 'data-action': 'task-due-swap' }, 'Заменить срок в черновике');
  const box = el('div', {}, line, btn);
  let last = null;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      if (last) {
        const ok = await undoSwap(last);
        say($('task-msg'), ok ? 'Замена отменена — в строке «Срок» снова прежний срок' : 'Строку «Срок» уже правили — поправьте её в черновике сами', ok ? 'ok' : 'error');
        if (ok) { last = null; btn.textContent = 'Заменить срок в черновике'; line.classList.remove('hidden'); }
        return;
      }
      const r = await swapDueInDraft(x.swap, day);
      if (r === 'same') { say($('task-msg'), 'В черновике срок из письма уже стоит', 'ok'); box.classList.add('hidden'); return; }
      if (!r) { say($('task-msg'), 'Строки «Срок» в черновике нет — откройте черновик и поправьте срок сами', 'error'); return; }
      last = r;
      line.classList.add('hidden');
      btn.textContent = 'Отменить';
      say($('task-msg'), `Срок в черновике заменён на ${day} — соберите Word заново`, 'ok');
    } catch (err) {
      say($('task-msg'), err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
  return box;
}
