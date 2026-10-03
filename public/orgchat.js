// Внутренняя переписка руководителя организации и эксперта по делу (2.28): отдельная лента — у эксперта в деле,
// у руководителя в «Делах экспертов». Заказчик и диспетчер её не видят, в письма по заявке она не уходит.
import { api, el, say } from '/common.js';

const SIDE_RU = { head: 'Руководитель', expert: 'Эксперт' };
const timeRu = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

// Лента с полем ответа; рисует себя в узел box. Возвращает функцию обновления.
export function orgChat(box, orderId) {
  const list = el('ul', { class: 'list chat', 'data-org-chat': orderId });
  const empty = el('p', { class: 'muted hidden', text: 'Сообщений пока нет.' });
  const text = el('textarea', { maxlength: '4000', 'aria-label': 'Сообщение во внутренней переписке' });
  const send = el('button', { type: 'submit', class: 'secondary', 'data-action': 'org-chat-send' }, 'Отправить');
  const form = el('form', { class: 'hidden', novalidate: '' }, el('div', { class: 'field' }, text), send);
  const msg = el('p', { class: 'msg', role: 'status', 'aria-live': 'polite' });
  box.replaceChildren(list, empty, form, msg);

  async function load() {
    try {
      const r = await api('GET', `/api/orders/${orderId}/org-chat`);
      list.replaceChildren(...r.messages.map((m) => el('li', { class: m.mine ? 'mine' : '' },
        el('div', { class: 'who', text: [m.mine ? 'Вы' : SIDE_RU[m.side], m.mine ? null : m.author_name, timeRu(m.at)].filter(Boolean).join(' · ') }),
        el('div', { class: 'body', text: m.body }))));
      empty.classList.toggle('hidden', r.messages.length > 0);
      form.classList.toggle('hidden', !r.can_write);
    } catch (err) { say(msg, err.message); }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = text.value.trim();
    if (!body) return say(msg, 'Напишите сообщение');
    send.disabled = true;
    try {
      await api('POST', `/api/orders/${orderId}/org-chat`, { body });
      text.value = '';
      await load();
      say(msg, 'Сообщение отправлено', 'ok');
    } catch (err) { say(msg, err.message); } finally { send.disabled = false; }
  });
  load();
  return load;
}
