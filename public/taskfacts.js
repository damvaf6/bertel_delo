// «Что сказано в задании на оценку» (задача 2.305). Эксперту и диспетчеру в деле — одним списком, что программа взяла из
// приложенного задания на оценку (письма заказчика, определения суда): дата оценки, вид стоимости, цель, заказчик, адрес,
// срок — с файлом и страницей; нажатие на файл открывает его. В заявке другое — видно рядом. Задания нет — блока нет.
// Срок по заданию взят из письма о переносе срока (2.333) — строка «Срок перенесён письмом: на …» с прежним сроком и файлом.
// Текст — через textContent.
import { api, el, say } from '/common.js';

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
    if (x.was) note.push(`по заданию было — ${x.was}`);
    return el('li', { 'data-task': x.id },
      el('span', {}, el('span', { class: 'title', text: `${x.label}: ` }), el('span', { text: x.v })),
      note.length ? el('p', { class: 'muted', text: note.join('; ') }) : '',
      x.doc_id ? el('button', { type: 'button', class: 'link', 'data-action': 'task-open', onclick: open(x.doc_id) }, `«${x.name}», стр. ${x.page}`) : '');
  });
  if (!items.length) items.push(el('li', { class: 'muted', text: 'Даты оценки, цели, вида стоимости, заказчика, адреса и срока программа в задании не нашла — проверьте файл сами.' }));
  $('task-list').replaceChildren(...items);
}
