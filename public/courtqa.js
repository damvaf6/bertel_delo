// «Пояснения к отчёту для суда» (задача 2.444): у вызова в суд эксперт нажимает «Разобрать вопросы суда» — ИИ делит текст
// определения или повестки (и вписанное экспертом) на вопросы; эксперт правит вопросы, пишет пояснение и где в отчёте.
// На все вопросы есть пояснения — «Скачать „Пояснения эксперта“ Word» (все стороны дела). Заказчик и диспетчер видят
// вопросы и пояснения без правки. Текст — через textContent.
import { api, el, say } from '/common.js';

let st = null; // { orderId, callId, box, can_write, has_file, dirty, list: [{ text, answer, place, by_ai }] }
const pick = ({ text, answer, place, by_ai }) => ({ text, answer: answer ?? '', place: place ?? '', by_ai });

// Открыть пояснения вызова в контейнере box (внутри строки вызова); onChange() — пересчитать строку вызова после сохранения.
export async function openCourtQa(orderId, callId, box, onChange) {
  box.replaceChildren(el('p', { class: 'muted', text: 'Загружаем…' }));
  try {
    const v = await api('GET', `/api/orders/${orderId}/court/${callId}/questions`);
    st = { orderId, callId, box, onChange, can_write: v.can_write, has_file: v.has_file, dirty: false, list: v.items.map(pick) };
    draw();
  } catch (err) { box.replaceChildren(el('p', { class: 'msg error', text: err.message })); }
}

const id = (k) => `cq-${st.callId}-${k}`;
const leftOf = () => st.list.filter((q) => !q.answer.trim()).length;
const leadText = () => {
  if (!st.list.length) {
    return st.can_write
      ? `ИИ найдёт вопросы суда${st.has_file ? ' в файле повестки или определения' : ''} и разделит их на пункты — проверьте их и напишите пояснение к каждому.`
      : 'Эксперт ещё не подготовил пояснения к отчёту.';
  }
  const left = leftOf();
  return left ? `Вопросов: ${st.list.length} · без пояснения: ${left}` : `Вопросов: ${st.list.length} · пояснения ко всем готовы`;
};

function draw() {
  const w = st.can_write;
  const msg = el('p', { class: 'msg', id: id('msg'), role: 'status', 'aria-live': 'polite' });
  const parts = [el('p', { class: 'muted', id: id('lead'), text: leadText() })];
  if (w) {
    const said = el('textarea', { id: id('said'), rows: '3', maxlength: '30000', placeholder: '1. …\n2. …' });
    parts.push(el('div', { class: 'field' },
      el('label', { for: id('said'), text: st.has_file ? 'Вопросы текстом (если в файле повестки их нет или он не читается)' : 'Вопросы суда текстом — из определения или повестки' }), said),
    el('button', { type: 'button', class: 'secondary', id: id('parse'), onclick: () => parse(said.value, msg) }, st.list.length ? 'Разобрать заново' : 'Разобрать вопросы суда'));
  }
  parts.push(el('ol', { class: 'list cq-list', id: id('list') }, ...st.list.map((q, i) => (w ? editItem(q, i) : showItem(q)))));
  if (w) {
    parts.push(el('div', { class: 'row' },
      el('button', { type: 'button', class: 'secondary', onclick: () => { st.list.push({ text: '', answer: '', place: '', by_ai: false }); st.dirty = true; draw(); document.getElementById(id(`q-${st.list.length - 1}`))?.focus(); } }, 'Добавить вопрос'),
      el('button', { type: 'button', id: id('save'), onclick: () => save(msg) }, 'Сохранить')));
  }
  const ready = st.list.length > 0 && !leftOf();
  if (ready || (w && st.list.length)) {
    parts.push(el('button', { type: 'button', class: ready ? '' : 'hidden', id: id('word'), onclick: () => word(msg) }, 'Скачать «Пояснения эксперта» Word'));
    if (w && !ready) parts.push(el('p', { class: 'muted', id: id('word-hint'), text: 'Когда у каждого вопроса будет пояснение, здесь появится Word «Пояснения эксперта к отчёту» — для суда.' }));
  }
  parts.push(msg);
  st.box.replaceChildren(...parts);
}

function showItem(q) {
  return el('li', {},
    el('div', { class: 'title', text: q.text }),
    el('div', { class: q.answer ? '' : 'muted', text: q.answer || 'пояснения ещё нет' }),
    ...(q.place ? [el('div', { class: 'muted', text: `Где в отчёте: ${q.place}` })] : []));
}

function editItem(q, i) {
  const edit = (k) => (e) => { q[k] = e.target.value; st.dirty = true; if (k === 'answer') document.getElementById(id('lead')).textContent = leadText(); };
  const text = el('textarea', { id: id(`q-${i}`), rows: '2', maxlength: '1000', oninput: edit('text') });
  text.value = q.text;
  const answer = el('textarea', { id: id(`a-${i}`), rows: '3', maxlength: '3000', oninput: edit('answer') });
  answer.value = q.answer;
  const place = el('input', { id: id(`p-${i}`), type: 'text', maxlength: '200', placeholder: 'например, раздел 8.2, стр. 31', oninput: edit('place') });
  place.value = q.place;
  return el('li', {},
    el('div', { class: 'field' }, el('label', { for: id(`q-${i}`), text: `Вопрос ${i + 1}${q.by_ai ? ' (нашёл ИИ — проверьте)' : ''}` }), text),
    el('div', { class: 'field' }, el('label', { for: id(`a-${i}`), text: 'Пояснение эксперта' }), answer),
    el('div', { class: 'field' }, el('label', { for: id(`p-${i}`), text: 'Где в отчёте' }), place),
    el('button', { class: 'link', type: 'button', onclick: () => { st.list.splice(i, 1); st.dirty = true; draw(); } }, 'Удалить вопрос'));
}

async function parse(said, msg) {
  if (st.list.length && !confirm('Заменить вопросы новым разбором? Ваши правки и пояснения пропадут.')) return;
  const btn = document.getElementById(id('parse'));
  btn.disabled = true;
  say(msg, 'ИИ ищет вопросы суда…', 'ok');
  try {
    const v = await api('POST', `/api/orders/${st.orderId}/court/${st.callId}/questions/parse`, { replace: st.list.length > 0, text: said.trim() });
    st.list = v.items.map(pick);
    st.dirty = false;
    draw();
    say(document.getElementById(id('msg')), `Вопросов: ${v.items.length}. Это предложение ИИ — сверьте с определением суда${v.file_unread ? '; файл повестки прочитать не удалось — вопросы только из вписанного текста' : ''}.`, 'ok');
    st.onChange?.();
  } catch (err) { say(msg, err.message); btn.disabled = false; }
}

// true — сохранено.
async function save(msg) {
  const empty = st.list.findIndex((q) => !q.text.trim());
  if (empty >= 0) { say(msg, `Вопрос ${empty + 1}: впишите текст или удалите вопрос`); return false; }
  const btn = document.getElementById(id('save'));
  btn.disabled = true;
  try {
    const v = await api('PUT', `/api/orders/${st.orderId}/court/${st.callId}/questions`, { items: st.list });
    st.list = v.items.map(pick);
    st.dirty = false;
    draw();
    say(document.getElementById(id('msg')), v.left ? `Сохранено · без пояснения: ${v.left}` : 'Сохранено · пояснения ко всем вопросам готовы', 'ok');
    st.onChange?.();
    return true;
  } catch (err) { say(msg, err.message); btn.disabled = false; return false; }
}

// Несохранённые правки — сначала сохранить: Word собирается по сохранённым вопросам.
async function word(msg) {
  if (st.dirty && !(await save(msg))) return;
  location.assign(`/api/orders/${st.orderId}/court/${st.callId}/explain`);
}
