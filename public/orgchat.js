// Внутренняя переписка руководителя организации и эксперта по делу (2.28): отдельная лента — у эксперта в деле,
// у руководителя в «Делах экспертов». Заказчик и диспетчер её не видят, в письма по заявке она не уходит.
// У руководителя — свои заготовки фраз (2.137): частое сообщение эксперту вставляется одной кнопкой.
import { api, el, say } from '/common.js';

const SIDE_RU = { head: 'Руководитель', expert: 'Эксперт' };
const timeRu = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

// Заготовки фраз руководителя — одни на организацию для всех открытых переписок; после изменения перерисовываются все.
const phrases = { org: null, list: [], views: new Set() };
const redraw = () => phrases.views.forEach((v) => (v.isConnected() ? v.draw() : phrases.views.delete(v)));

async function loadPhrases(orgId) {
  if (phrases.org === orgId) return;
  try { phrases.list = (await api('GET', `/api/orgs/${orgId}/phrases`)).phrases; phrases.org = orgId; } catch { phrases.list = []; }
}

function phraseTools(orgId, area, msg) {
  const chips = el('div', { class: 'chips phrases' });
  const hint = el('div', { class: 'muted' });
  // Свой список — кнопкой, не вложенным <details>: переписка сама раскрывается по <summary>.
  const list = el('ul', { class: 'list hidden' });
  const sum = el('button', { type: 'button', class: 'link', 'aria-expanded': 'false', 'data-action': 'org-phrases-own',
    onclick: () => { list.classList.toggle('hidden'); sum.setAttribute('aria-expanded', String(!list.classList.contains('hidden'))); } });
  const own = el('div', { class: 'phrases-own' }, sum, list);
  const short = (t) => { const l = t.split('\n')[0]; return l.length > 70 || t.includes('\n') ? `${l.slice(0, 70).trimEnd()}…` : l; };
  const draw = () => {
    chips.replaceChildren(...phrases.list.map((p) => el('button', { type: 'button', 'data-phrase': p.id, title: p.text, onclick: () => insert(p.text) }, `+ ${short(p.text)}`)));
    hint.textContent = phrases.list.length ? 'Нажмите заготовку — она добавится в сообщение.'
      : 'Частое сообщение эксперту можно запомнить кнопкой «Запомнить как заготовку» — потом вставлять одной кнопкой.';
    sum.textContent = `Мои заготовки фраз · ${phrases.list.length}`;
    own.classList.toggle('hidden', !phrases.list.length);
    list.replaceChildren(...phrases.list.map((p) => el('li', { 'data-phrase-item': p.id }, el('span', { text: p.text }),
      el('button', { type: 'button', class: 'secondary', 'data-action': 'org-phrase-remove', onclick: () => remove(p) }, 'Убрать'))));
  };
  function insert(t) {
    if (area.value.includes(t)) return say(msg, 'Эта фраза уже есть в сообщении');
    area.value = area.value.trim() ? `${area.value.replace(/\s+$/, '')}\n${t}` : t;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    say(msg, '');
  }
  async function save() {
    if (!area.value.trim()) return say(msg, 'Напишите сообщение, потом нажмите «Запомнить как заготовку»');
    try {
      const r = await api('POST', `/api/orgs/${orgId}/phrases`, { text: area.value });
      phrases.list = r.phrases;
      redraw();
      say(msg, r.added ? 'Заготовка запомнена' : 'Такая заготовка уже есть', 'ok');
    } catch (err) { say(msg, err.message); }
  }
  async function remove(p) {
    if (!confirm(`Убрать заготовку «${short(p.text)}»? В уже отправленных сообщениях текст останется.`)) return;
    try {
      phrases.list = (await api('DELETE', `/api/orgs/${orgId}/phrases/${p.id}`)).phrases;
      redraw();
      say(msg, 'Заготовка убрана', 'ok');
    } catch (err) { say(msg, err.message); }
  }
  phrases.views.add({ draw, isConnected: () => chips.isConnected });
  loadPhrases(orgId).then(draw);
  draw();
  return [hint, chips, own,
    el('button', { type: 'button', class: 'secondary', 'data-action': 'org-phrase-save', onclick: save }, 'Запомнить как заготовку')];
}

// Лента с полем ответа; рисует себя в узел box. Возвращает функцию обновления. orgId — у руководителя: его заготовки фраз.
export function orgChat(box, orderId, { orgId } = {}) {
  const list = el('ul', { class: 'list chat', 'data-org-chat': orderId });
  const empty = el('p', { class: 'muted hidden', text: 'Сообщений пока нет.' });
  const text = el('textarea', { maxlength: '4000', 'aria-label': 'Сообщение во внутренней переписке' });
  const send = el('button', { type: 'submit', class: 'secondary', 'data-action': 'org-chat-send' }, 'Отправить');
  const msg = el('p', { class: 'msg', role: 'status', 'aria-live': 'polite' });
  const form = el('form', { class: 'hidden', novalidate: '' }, ...(orgId ? phraseTools(orgId, text, msg) : []),
    el('div', { class: 'field' }, text), el('div', { class: 'row' }, send));
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
