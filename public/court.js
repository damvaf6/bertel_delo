// Вызов эксперта в суд (задача 2.441). После «готово» заказчик или диспетчер — «Эксперта вызывают в суд»: суд, номер дела,
// дата и время заседания, адрес, файл повестки или определения. Дело не переоткрывается; эксперту — уведомление. В деле у
// всех сторон — блок «Вызов в суд» со списком заседаний (ближайшее — заметно). Текст — через textContent.
// 2.444: у заседания — «Пояснения к отчёту для суда» (вопросы суда и пояснения эксперта, Word) — `public/courtqa.js`.
import { api, el, say } from '/common.js';
import { openCourtQa } from '/courtqa.js';

const $ = (id) => document.getElementById(id);
const MAX_FILE = 3 * 1024 * 1024;
const whenRu = (s) => new Date(s).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const todayMsk = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
let ctx = null; // { orderId, download, reload }

// download(doc) — скачать файл повестки; reload() — открыть дело заново.
export async function loadCourt(current, { download, reload }) {
  const orderId = current.order.id;
  ctx = { orderId, download, reload };
  $('hearing-box').classList.add('hidden');
  try {
    const v = await api('GET', `/api/orders/${orderId}/court`);
    if (ctx?.orderId !== orderId || !v.available || (!v.calls.length && !v.can_add)) return;
    draw(v);
  } catch { /* блок — дополнение к делу; не загрузился — дело открывается как обычно */ }
}

function draw(v) {
  $('hearing-box').classList.remove('hidden');
  $('hearing-lead').textContent = v.calls.length
    ? `Заседаний: ${v.calls.length}`
    : 'Суд вызывает эксперта дать пояснения к отчёту? Укажите заседание — эксперт получит уведомление, дело останется сданным.';
  $('hearing-list').replaceChildren(...v.calls.map((c) => item(c, c.id === v.next, v.can_answer)));
  $('hearing-open').classList.toggle('hidden', !v.can_add);
  if (!v.can_add) $('hearing-form').classList.add('hidden');
  $('hearing-date').min = todayMsk();
}

// Строка пояснений у заседания: эксперту — всегда, остальным — когда эксперт уже начал.
const qaLabel = (c) => (!c.questions ? 'Пояснения к отчёту для суда'
  : c.unanswered ? `Пояснения для суда · вопросов ${c.questions}, без пояснения ${c.unanswered}` : `Пояснения для суда · готовы (вопросов ${c.questions})`);

function qa(c, canAnswer) {
  if (!canAnswer && !c.questions) return [];
  const box = el('div', { class: 'court-qa hidden', 'data-qa': c.id });
  const btn = el('button', { type: 'button', class: 'secondary court-qa-open', 'aria-expanded': 'false' }, qaLabel(c));
  btn.addEventListener('click', () => {
    const open = box.classList.toggle('hidden') === false;
    btn.setAttribute('aria-expanded', String(open));
    if (open) openCourtQa(ctx.orderId, c.id, box, () => refreshLabel(c.id, btn));
  });
  return [btn, box];
}

async function refreshLabel(callId, btn) {
  try {
    const v = await api('GET', `/api/orders/${ctx.orderId}/court`);
    const c = v.calls.find((x) => x.id === callId);
    if (c) btn.textContent = qaLabel(c);
  } catch { /* подпись кнопки — не главное */ }
}

function item(c, next, canAnswer) {
  const past = !next && new Date(c.hearing_at).getTime() < Date.now();
  return el('li', { class: next ? 'hearing-next' : past ? 'muted' : '', 'data-court': c.id },
    el('div', { class: 'title', text: `${whenRu(c.hearing_at)}${next ? ' — ближайшее' : past ? ' — прошло' : ''}` }),
    el('div', { text: `${c.court}, дело № ${c.case_no}` }),
    el('div', { class: 'muted', text: `Адрес: ${c.address}` }),
    ...(c.document ? [el('button', { class: 'link', type: 'button', onclick: () => ctx.download(c.document) }, `Повестка: ${c.document.filename}`)] : []),
    el('div', { class: 'muted', text: c.side === 'dispatcher' ? 'Сообщил диспетчер' : 'Сообщил заказчик' }),
    ...qa(c, canAnswer));
}

$('hearing-open').addEventListener('click', () => {
  const f = $('hearing-form');
  f.classList.toggle('hidden');
  if (!f.classList.contains('hidden')) $('hearing-name').focus();
});

async function send() {
  const msg = $('hearing-msg');
  const body = { court: $('hearing-name').value.trim(), case_no: $('hearing-case').value.trim(), date: $('hearing-date').value,
                 time: $('hearing-time').value.trim(), address: $('hearing-address').value.trim() };
  if (!body.court) return say(msg, 'Укажите суд');
  if (!body.case_no) return say(msg, 'Укажите номер дела в суде');
  if (!body.date) return say(msg, 'Укажите дату заседания');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)) return say(msg, 'Укажите время заседания, например 10:30');
  if (!body.address) return say(msg, 'Укажите адрес суда');
  const file = $('hearing-file').files[0];
  if (file && file.size > MAX_FILE) return say(msg, 'Файл повестки — не больше 3 МБ');
  $('hearing-send').disabled = true;
  try {
    if (file) {
      say(msg, 'Загружаем повестку…', 'ok');
      const { document } = await api('POST', `/api/orders/${ctx.orderId}/court/file`, file, {
        'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name),
      });
      body.document_id = document.id;
    }
    say(msg, 'Отправляем…', 'ok');
    await api('POST', `/api/orders/${ctx.orderId}/court`, body);
    for (const id of ['hearing-name', 'hearing-case', 'hearing-date', 'hearing-time', 'hearing-address', 'hearing-file']) $(id).value = '';
    $('hearing-file-name').textContent = 'не выбран';
    $('hearing-form').classList.add('hidden');
    await ctx.reload();
    say($('status-msg'), 'Вызов в суд передан эксперту', 'ok');
  } catch (err) { say(msg, err.message); } finally { $('hearing-send').disabled = false; }
}

$('hearing-send').addEventListener('click', send);
$('hearing-file').addEventListener('change', () => { $('hearing-file-name').textContent = $('hearing-file').files[0]?.name ?? 'не выбран'; });
