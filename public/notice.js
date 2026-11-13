// Извещение об осмотре (задача 2.470, «Ущерб автомобилю после ДТП»). Эксперт дела, пока дело в работе: кого извещает
// (страховая, второй участник ДТП), дата, время и место осмотра → образец Word (автомобиль и ДТП из заявки); отправляет
// сам и отмечает «извещены, как и когда». Отмеченное — одной строкой в раздел «Осмотр» черновика (при подготовке ИИ —
// программой, здесь — кнопкой). Остальные стороны дела видят список и Word. Текст — через textContent.
import { api, el, say } from '/common.js';
import { insertNoticeLine } from '/draft.js';

const $ = (id) => document.getElementById(id);
const ruDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const todayMsk = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
let ctx = null; // { orderId, v }

export async function loadNotices(current) {
  const orderId = current.order.id;
  ctx = { orderId, v: null };
  $('inspnotice-box').classList.add('hidden');
  say($('inspnotice-msg'), '');
  try {
    const v = await api('GET', `/api/orders/${orderId}/notices`);
    if (ctx?.orderId !== orderId || !v.available || (!v.notices.length && !v.can_write)) return;
    draw(v);
  } catch { /* блок — дополнение к делу; не загрузился — дело открывается как обычно */ }
}

function draw(v) {
  ctx.v = v;
  $('inspnotice-box').classList.remove('hidden');
  const marked = v.notices.filter((n) => n.how).length;
  $('inspnotice-lead').textContent = !v.notices.length
    ? `${v.lead ?? 'Сообщите сторонам дату, время и место осмотра'}: запишите здесь — получите образец извещения Word, отправьте его сами и отметьте, как и когда известили. Отметка попадёт в раздел «Осмотр» черновика.`
    : `Извещений: ${v.notices.length}, отмечено «извещены»: ${marked}.`;
  $('inspnotice-list').replaceChildren(...v.notices.map((n) => item(n, v)));
  $('inspnotice-draft-row').classList.toggle('hidden', !v.can_write || !v.line);
  $('inspnotice-open').classList.toggle('hidden', !v.can_write || v.notices.length >= v.max);
  if (!v.can_write) $('inspnotice-form').classList.add('hidden');
  if (v.name_label) $('inspnotice-name-label').textContent = v.name_label;
  if (!$('inspnotice-party').options.length) {
    $('inspnotice-party').replaceChildren(...v.parties.map((p) => el('option', { value: p.id }, p.name)));
  }
}

function item(n, v) {
  const state = n.how
    ? `Извещены ${n.how_name} ${ruDate(n.sent_on)}${n.late ? ' — позже осмотра: перенесите осмотр или так и напишите в заключении' : ''}`
    : 'Ещё не отмечено, как и когда известили';
  const li = el('li', { 'data-notice': n.id },
    el('strong', {}, `${n.party_name}: ${n.name}`),
    el('p', { class: 'muted' }, `Осмотр ${ruDate(n.date)} в ${n.time}, ${n.place}`),
    el('p', { class: `notice-state ${n.how ? (n.late ? 'late' : 'ok') : 'muted'}` }, state),
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'link', onclick: () => location.assign(`/api/orders/${ctx.orderId}/notices/${n.id}/doc`) }, 'Скачать извещение Word')));
  if (v.can_write) li.append(markForm(n), el('div', { class: 'row' },
    ...(n.how ? [el('button', { type: 'button', class: 'link', onclick: () => send('PUT', `/notices/${n.id}/mark`, { how: null }, 'Отметка снята') }, 'Снять отметку')] : []),
    el('button', { type: 'button', class: 'link', onclick: () => send('DELETE', `/notices/${n.id}`, undefined, 'Извещение удалено') }, 'Удалить')));
  return li;
}

function markForm(n) {
  const how = el('select', { 'aria-label': 'Как известили' }, ...ctx.v.how.map((h) => el('option', { value: h.id }, h.name)));
  if (n.how) how.value = n.how;
  const day = el('input', { type: 'date', 'aria-label': 'Когда известили', max: todayMsk(), value: n.sent_on ?? todayMsk() });
  const btn = el('button', { type: 'button', class: 'secondary', 'data-action': 'notice-mark' }, n.how ? 'Изменить отметку' : 'Извещены');
  btn.addEventListener('click', () => send('PUT', `/notices/${n.id}/mark`, { how: how.value, sent_on: day.value }, 'Отмечено: извещены'));
  return el('div', { class: 'row' }, how, day, btn);
}

async function send(method, path, body, ok) {
  try {
    draw(await api(method, `/api/orders/${ctx.orderId}${path}`, body));
    say($('inspnotice-msg'), ok, 'ok');
  } catch (err) { say($('inspnotice-msg'), err.message); }
}

$('inspnotice-open').addEventListener('click', () => {
  $('inspnotice-form').classList.remove('hidden');
  $('inspnotice-open').classList.add('hidden');
  if (!$('inspnotice-date').value) $('inspnotice-date').value = todayMsk();
  $('inspnotice-name').focus();
});

$('inspnotice-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { party: $('inspnotice-party').value, name: $('inspnotice-name').value, date: $('inspnotice-date').value,
    time: $('inspnotice-time').value.trim().replace('.', ':'), place: $('inspnotice-place').value };
  try {
    const v = await api('POST', `/api/orders/${ctx.orderId}/notices`, body);
    $('inspnotice-name').value = '';
    $('inspnotice-form').classList.add('hidden');
    draw(v);
    say($('inspnotice-msg'), 'Записано. Скачайте извещение Word, отправьте его и отметьте «Извещены».', 'ok');
  } catch (err) { say($('inspnotice-msg'), err.message); }
});

$('inspnotice-draft').addEventListener('click', async () => {
  try {
    const done = await insertNoticeLine(ctx.v?.line);
    if (done === 'same') say($('inspnotice-msg'), 'Эта строка уже есть в черновике.', 'ok');
    else if (done) say($('inspnotice-msg'), 'Строка об извещении вставлена в раздел «Осмотр», черновик сохранён.', 'ok');
    else say($('inspnotice-msg'), 'Черновик сейчас не правится — откройте блок черновика выше.');
  } catch (err) { say($('inspnotice-msg'), err.message); }
});
