// Срок первого ответа заказчику по модулям (задача штаба 3fd17197). Администратору в «Управлении»: часы или пусто
// (срок не обещаем); сохранить; история — кто, когда, что; «Как на деле» — от отправки до цены за 90 дней.
import { api, el, say } from '/common.js';

const $ = (id) => document.getElementById(id);
const timeRu = (s) => `${new Date(s).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })} МСК`;
const hoursText = (h) => (h ? `${h} ч` : 'не обещаем');
const factText = (f, days) => (f.orders
  ? `заявок с ценой за ${days} дней: ${f.orders}; от отправки до цены обычно ${f.median_hours} ч, дольше всего ${f.max_hours} ч`
  : `за ${days} дней цену ещё не назначали — считать не из чего`);

let modules = [];

export async function loadOrderAck() {
  let ack;
  try {
    ({ ack } = await api('GET', '/api/admin/order-ack'));
  } catch (err) { say($('ack-msg'), err.message); return; }
  render(ack);
}

function render(a) {
  modules = a.modules;
  $('ack-fields').replaceChildren(...modules.map((m) => {
    const input = el('input', { id: `ack-${m.id}`, 'data-ack-module': m.id, type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: 'пусто — не обещаем' });
    input.value = m.hours ? String(m.hours) : '';
    return el('div', { class: 'field' }, el('label', { for: `ack-${m.id}`, text: `${m.name}, часов (1–${a.max_hours})` }), input);
  }));
  $('ack-facts').replaceChildren(...a.facts.map((f) => el('li', {},
    el('div', { class: 'title', text: f.name }), el('div', { class: 'muted', text: factText(f, a.fact_days) }))));
  $('ack-history-empty').classList.toggle('hidden', a.history.length > 0);
  $('ack-history').replaceChildren(...a.history.map((h) => el('li', {},
    el('div', { class: 'title', text: `${timeRu(h.at)}${h.by ? ` · ${h.by}` : ''}` }),
    el('div', { class: 'muted', text: modules.map((m) => `${m.name}: ${hoursText(h.hours[m.id])}`).join(' · ') }))));
}

$('ack-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const hours = {};
  for (const m of modules) {
    const v = $(`ack-${m.id}`).value.trim();
    hours[m.id] = v === '' ? null : /^\d+$/.test(v) ? Number(v) : v;
  }
  try {
    const r = await api('PUT', '/api/admin/order-ack', { hours });
    render(r.ack);
    say($('ack-msg'), r.changed.length ? `Сохранено: ${r.ack.modules.map((m) => `${m.name} — ${hoursText(m.hours)}`).join('; ')}` : 'Ничего не изменилось', 'ok');
  } catch (err) { say($('ack-msg'), err.message); }
});
