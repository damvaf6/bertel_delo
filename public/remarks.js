// Замечания к сданному отчёту (задача 2.431). Заказчик после «готово» — «Пришли замечания к отчёту»: что пишет банк или суд
// и файл замечаний; дело снова у эксперта, ответ — за рабочие дни из описания модуля. В деле у всех сторон — блок «Замечания
// к отчёту»: когда пришли, срок ответа, текст и файл. Текст — через textContent.
// 2.432: «Замечания пунктами» — эксперт нажимает «Разобрать на пункты» (ИИ делит текст и файл замечаний), правит пункты и
// у каждого отмечает «исправлено в отчёте» или «пояснение без правки»; заказчик и диспетчер видят пункты без правки.
// 2.433: у пункта — «Где в отчёте»; все отмечены — «Ответ на замечания» Word: скачать (все стороны) и «Приложить к
// исправленному отчёту» (исполнитель, файлом результата; несохранённые правки сначала сохраняются).
// 2.435: исполнителю и диспетчеру — у пункта «исправлено в отчёте» проверка по черновику: изменился ли раздел с прихода
// замечаний; итог — строкой под заголовком. Проверка — по сохранённым пунктам.
import { api, el, say } from '/common.js';

const $ = (id) => document.getElementById(id);
const dayRu = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' });
const whenRu = (s) => new Date(s).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
let ctx = null; // { order, action, upload, download, reload }

// action — шаг «Пришли замечания к отчёту» из доступных (или null); upload(file) — загрузка файла в «Документы» дела,
// download(doc) — скачать файл замечаний.
export function renderRemarks(current, { action, upload, download, reload }) {
  ctx = { order: current.order, action, upload, download, reload };
  const rm = current.remarks;
  $('remarks-view').classList.toggle('hidden', !rm?.open);
  if (rm?.open) {
    $('remarks-title').textContent = rm.round > 1 ? `Замечания к отчёту (${rm.round}-й раз)` : 'Замечания к отчёту';
    $('remarks-when').textContent = `Пришли ${whenRu(rm.at)} · ответить до ${dayRu(rm.due)}`;
    $('remarks-text-view').textContent = rm.text;
    $('remarks-doc').replaceChildren(...(rm.document ? [el('button', { class: 'link', type: 'button', onclick: () => download(rm.document) }, `Файл замечаний: ${rm.document.filename}`)] : []));
  }
  if (!action) $('remarks-form').classList.add('hidden');
  $('remarks-items-box').classList.add('hidden');
  if (rm) loadItems(current.order.id);
}

// ——— Замечания пунктами (2.432) ———
const RES = [['fixed', 'Исправлено в отчёте'], ['explained', 'Пояснение без правки']];
const NOTE_LABEL = { fixed: 'Что исправлено', explained: 'Что пояснить банку или суду', '': 'Что сделано (по желанию)' };
let items = null; // { orderId, can_write, answer, check, dirty, list: [{ text, resolution, note, place, by_ai, check }] }
const pick = ({ text, resolution, note, place, by_ai, check }) => ({ text, resolution, note, place, by_ai, check });
const abz = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'абзац' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'абзаца' : 'абзацев'}`;

async function loadItems(orderId) {
  try {
    const v = await api('GET', `/api/orders/${orderId}/remarks/items`);
    if (!v.available || ctx?.order.id !== orderId) return;
    items = { orderId, can_write: v.can_write, answer: v.answer, check: v.check ?? null, dirty: false, list: v.items.map(pick) };
    // Сдано и пунктов нет — блок не нужен.
    if (!v.can_write && !items.list.length) return;
    say($('remarks-items-msg'), '');
    drawItems();
  } catch { /* блок пунктов — дополнение к замечаниям; не загрузился — дело открывается как обычно */ }
}

function drawItems() {
  const { can_write: w, list } = items;
  $('remarks-items-box').classList.remove('hidden');
  const left = list.filter((i) => !i.resolution).length;
  $('remarks-items-lead').textContent = !list.length
    ? 'ИИ разделит замечания и файл замечаний на пункты — проверьте их, поправьте и отметьте у каждого, что сделано.'
    : left ? `Пунктов: ${list.length} · без отметки: ${left}` : `Пунктов: ${list.length} · все отмечены`;
  $('remarks-items-box').dataset.state = list.length && !left ? 'ok' : '';
  $('remarks-parse').classList.toggle('hidden', !w);
  $('remarks-parse').textContent = list.length ? 'Разобрать заново' : 'Разобрать на пункты';
  $('remarks-items-actions').classList.toggle('hidden', !w);
  $('remarks-items').replaceChildren(...list.map((it, i) => (w ? editItem(it, i) : showItem(it))));
  drawCheck();
  drawAnswer();
}

// Проверка исправленного отчёта (2.435): итог по пунктам «исправлено в отчёте».
function drawCheck() {
  const box = $('remarks-check');
  const c = items.check;
  const fixed = items.list.filter((i) => i.check && i.resolution === 'fixed');
  const doubt = fixed.filter((i) => i.check.state !== 'changed').length;
  box.className = `${c?.available && !doubt ? 'muted' : 'warn-line'}${!c || (c.available && !fixed.length) ? ' hidden' : ''}`;
  if (!c) return;
  box.textContent = !c.available ? 'Черновика до замечаний нет — сравнить исправления не с чем.'
    : !c.changed ? `Черновик с прихода замечаний не менялся, а исправлено отмечено у пунктов: ${fixed.length}.`
      : `Проверка по черновику: изменения видны по ${fixed.length - doubt} из ${fixed.length} исправленных пунктов${doubt ? ` · проверьте: ${doubt}` : ''}.`;
}

// Строка проверки у пункта: только у «исправлено в отчёте» и по сохранённой отметке.
function checkLine(it) {
  const c = it.check;
  if (!c || it.resolution !== 'fixed') return [];
  if (c.state === 'changed') {
    const what = [c.added && `добавлено ${abz(c.added)}`, c.removed && `убрано ${abz(c.removed)}`].filter(Boolean).join(', ');
    return [el('div', { class: 'mark rm-check', text: `По черновику: раздел «${c.section}» изменён (${what})${c.by === 'text' ? ' — правка похожа на этот пункт' : ''}` })];
  }
  if (c.state === 'same') return [el('div', { class: 'warn-line rm-check', text: `По черновику: в разделе «${c.section}» с прихода замечаний ничего не изменилось — проверьте` })];
  if (c.state === 'not_found') return [el('div', { class: 'warn-line rm-check', text: 'По черновику: правок по этому пункту не нашлось — проверьте или укажите раздел в «Где в отчёте»' })];
  return [];
}

// «Ответ на замечания» (2.433): по сохранённым пунктам; без отметки хоть у одного — кнопок нет, только подсказка.
function drawAnswer() {
  const { can_write: w, list, answer } = items;
  const ready = list.length > 0 && list.every((i) => i.resolution);
  $('remarks-answer-box').classList.toggle('hidden', !ready && !(w && list.length));
  $('remarks-answer-get').classList.toggle('hidden', !ready);
  $('remarks-answer-attach').classList.toggle('hidden', !ready || !w || ctx?.order.status !== 'in_work');
  $('remarks-answer-attach').textContent = answer ? 'Заменить приложенный ответ' : 'Приложить к исправленному отчёту';
  $('remarks-answer-lead').textContent = !ready
    ? 'Когда у каждого пункта будет отметка, здесь появится «Ответ на замечания» Word: пункт, что сделано и где в отчёте.'
    : answer ? `Ответ приложен к делу файлом результата: ${answer.filename}. Подпишите его вместе с исправленным отчётом.`
      : 'Ответ на замечания Word — пункт, что сделано и где в отчёте. Приложите его к исправленному отчёту.';
}

function showItem(it) {
  return el('li', {},
    el('div', { text: it.text }),
    el('div', { class: it.resolution ? 'mark' : 'muted', text: it.resolution ? RES.find(([k]) => k === it.resolution)[1] : 'ещё без отметки' }),
    ...(it.note ? [el('div', { class: 'muted', text: it.note })] : []),
    ...(it.place ? [el('div', { class: 'muted', text: `Где в отчёте: ${it.place}` })] : []),
    ...checkLine(it));
}

function editItem(it, i) {
  const textId = `rm-item-${i}`;
  const noteId = `rm-note-${i}`;
  const placeId = `rm-place-${i}`;
  const edit = (k) => (e) => { it[k] = e.target.value; items.dirty = true; };
  const area = el('textarea', { id: textId, rows: '2', maxlength: '1000', oninput: edit('text') });
  area.value = it.text;
  const note = el('textarea', { id: noteId, rows: '2', maxlength: '1000', oninput: edit('note') });
  note.value = it.note ?? '';
  const place = el('input', { id: placeId, type: 'text', maxlength: '200', placeholder: 'например, раздел 8.2, стр. 31', oninput: edit('place') });
  place.value = it.place ?? '';
  const noteLabel = el('label', { for: noteId, text: NOTE_LABEL[it.resolution ?? ''] });
  const choice = el('div', { class: 'choice', role: 'radiogroup', 'aria-label': `Пункт ${i + 1}: что сделано` }, ...RES.map(([k, name]) => {
    const r = el('input', { type: 'radio', name: `rm-res-${i}`, value: k, onchange: () => { it.resolution = k; items.dirty = true; noteLabel.textContent = NOTE_LABEL[k]; countLeft(); } });
    r.checked = it.resolution === k;
    return el('label', {}, r, name);
  }));
  return el('li', {},
    el('div', { class: 'field' }, el('label', { for: textId, text: `Пункт ${i + 1}${it.by_ai ? ' (разобрал ИИ — проверьте)' : ''}` }), area),
    choice,
    el('div', { class: 'field' }, noteLabel, note),
    el('div', { class: 'field' }, el('label', { for: placeId, text: 'Где в отчёте' }), place),
    ...checkLine(it),
    el('button', { class: 'link', type: 'button', onclick: () => { items.list.splice(i, 1); items.dirty = true; drawItems(); } }, 'Удалить пункт'));
}

function countLeft() {
  const left = items.list.filter((i) => !i.resolution).length;
  $('remarks-items-lead').textContent = left ? `Пунктов: ${items.list.length} · без отметки: ${left}` : `Пунктов: ${items.list.length} · все отмечены`;
}

async function parse() {
  const msg = $('remarks-items-msg');
  if (items.list.length && !confirm('Заменить пункты новым разбором? Ваши правки и отметки пропадут.')) return;
  $('remarks-parse').disabled = true;
  say(msg, 'ИИ разбирает замечания…', 'ok');
  try {
    const v = await api('POST', `/api/orders/${items.orderId}/remarks/items/parse`, { replace: items.list.length > 0 });
    items.list = v.items.map(pick);
    items.answer = v.answer;
    items.check = v.check ?? null;
    items.dirty = false;
    drawItems();
    say(msg, `Пунктов: ${v.items.length}. Это предложение ИИ — проверьте текст каждого пункта${v.file_unread ? '; файл замечаний прочитать не удалось — пункты только по тексту заказчика' : ''}.`, 'ok');
  } catch (err) { say(msg, err.message); } finally { $('remarks-parse').disabled = false; }
}

// true — сохранено.
async function save() {
  const msg = $('remarks-items-msg');
  const empty = items.list.findIndex((i) => !i.text.trim());
  if (empty >= 0) { say(msg, `Пункт ${empty + 1}: впишите текст или удалите пункт`); return false; }
  $('remarks-save').disabled = true;
  try {
    const v = await api('PUT', `/api/orders/${items.orderId}/remarks/items`, { items: items.list });
    items.list = v.items.map(pick);
    items.answer = v.answer;
    items.check = v.check ?? null;
    items.dirty = false;
    drawItems();
    say(msg, v.left ? `Сохранено · без отметки: ${v.left}` : 'Сохранено · все пункты отмечены', 'ok');
    return true;
  } catch (err) { say(msg, err.message); return false; } finally { $('remarks-save').disabled = false; }
}

// Несохранённые правки — сначала сохранить: Word собирается по сохранённым пунктам.
const saved = async () => !items.dirty || save();

async function getAnswer() {
  if (await saved()) location.assign(`/api/orders/${items.orderId}/remarks/answer`);
}

async function attachAnswer() {
  const msg = $('remarks-items-msg');
  if (!(await saved())) return;
  if (items.answer && !confirm(`Ответ уже приложен (${items.answer.filename}). Заменить новым? Прежний файл уберётся из дела.`)) return;
  $('remarks-answer-attach').disabled = true;
  try {
    const v = await api('POST', `/api/orders/${items.orderId}/remarks/answer`, { replace: !!items.answer });
    await ctx.reload();
    say($('status-msg'), `Ответ на замечания приложен: ${v.document.filename}. Подпишите его вместе с исправленным отчётом и сдайте на проверку.`, 'ok');
  } catch (err) { say(msg, err.message); } finally { $('remarks-answer-attach').disabled = false; }
}

$('remarks-parse').addEventListener('click', parse);
$('remarks-save').addEventListener('click', save);
$('remarks-answer-get').addEventListener('click', getAnswer);
$('remarks-answer-attach').addEventListener('click', attachAnswer);
$('remarks-add').addEventListener('click', () => {
  items.list.push({ text: '', resolution: null, note: '', place: '', by_ai: false });
  items.dirty = true;
  drawItems();
  $(`rm-item-${items.list.length - 1}`).focus();
});

// Кнопка шага открывает форму; повторное нажатие — закрывает.
export function openRemarks() {
  const f = $('remarks-form');
  f.classList.toggle('hidden');
  if (!f.classList.contains('hidden')) $('remarks-text').focus();
}

async function send() {
  const msg = $('remarks-msg');
  const text = $('remarks-text').value.trim();
  if (!text) return say(msg, 'Опишите, что пишут в замечаниях');
  const file = $('remarks-file').files[0];
  $('remarks-send').disabled = true;
  try {
    let documentId;
    if (file) {
      const doc = await ctx.upload(file, msg);
      if (!doc) return;
      documentId = doc.id;
    }
    say(msg, 'Отправляем…', 'ok');
    await api('POST', `/api/orders/${ctx.order.id}/status`, { from: ctx.order.status, to: ctx.action.to, reason: text, ...(documentId ? { document_id: documentId } : {}) });
    $('remarks-text').value = '';
    $('remarks-file').value = '';
    $('remarks-file-name').textContent = 'не выбран';
    $('remarks-form').classList.add('hidden');
    await ctx.reload();
    say($('status-msg'), 'Замечания переданы эксперту', 'ok');
  } catch (err) { say(msg, err.message); } finally { $('remarks-send').disabled = false; }
}

$('remarks-send').addEventListener('click', send);
$('remarks-text').addEventListener('input', () => say($('remarks-msg'), ''));
$('remarks-file').addEventListener('change', () => { $('remarks-file-name').textContent = $('remarks-file').files[0]?.name ?? 'не выбран'; });
