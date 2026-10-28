// Замечания к сданному отчёту (задача 2.431). Заказчик после «готово» — «Пришли замечания к отчёту»: что пишет банк или суд
// и файл замечаний; дело снова у эксперта, ответ — за рабочие дни из описания модуля. В деле у всех сторон — блок «Замечания
// к отчёту»: когда пришли, срок ответа, текст и файл. Текст — через textContent.
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
}

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
