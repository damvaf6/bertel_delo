// Лента заказов эксперта (2.468, решение Дамира 10.11.2026): эксперт сам берёт оплаченный заказ — заказчик эксперта не
// выбирает. На главной у специалиста — над его делами: услуга, вид объекта, цель, регион, срок, выплата эксперту и
// «Взять заказ». Адреса, имён и описания заказчика до того, как взять, нет. Взял — дело открывается, оно уже в работе.
// Тексты — только через textContent.
import { api, el, say } from '/common.js';

const $ = (id) => document.getElementById(id);
const rub = (kop) => `${Math.floor(kop / 100).toLocaleString('ru-RU')} ₽`;
const dayRu = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

function dueText(x) {
  if (!x.deadline) return 'срок не указан';
  const n = x.days_left;
  return `срок ${dayRu(x.deadline)}${n === 0 ? ' — сегодня' : n === 1 ? ' — завтра' : n > 1 ? ` · ${n} дн.` : ''}`;
}

function item(x, onTake) {
  const take = el('button', { type: 'button', 'data-role': 'feed-take', text: 'Взять заказ' });
  const li = el('li', { 'data-order': x.id },
    el('div', { class: 'title', text: `${x.service_name}${x.express ? ' · экспресс' : ''}` }),
    el('div', { class: 'muted', 'data-role': 'feed-facts', text: x.facts.map((f) => f.value).join(' · ') }),
    el('div', { 'data-role': 'feed-due', text: `${dueText(x)} · Вам — ${rub(x.payout_kop)}` }));
  if (x.bank && !x.bank.accredited) {
    li.append(el('div', { class: 'overdue', 'data-role': 'feed-bank', text: 'Заказ для банка, а у Вас нет аккредитации в нём — банк может не принять отчёт' }));
  }
  const msg = el('p', { class: 'msg', role: 'status', 'aria-live': 'polite' });
  take.addEventListener('click', async () => {
    take.disabled = true;
    say(msg, '');
    try {
      await api('POST', `/api/specialist/feed/${x.id}/take`);
      onTake(x);
    } catch (e) {
      say(msg, e.message);
      take.disabled = false;
    }
  });
  li.append(el('div', { class: 'row' }, take), msg);
  return li;
}

// Показать ленту (только специалисту). Взятый заказ открывается сразу.
export async function loadFeed(isSpecialist) {
  const box = $('feed-box');
  if (!box) return;
  box.classList.toggle('hidden', !isSpecialist);
  if (!isSpecialist) return;
  let r;
  try { r = await api('GET', '/api/specialist/feed'); } catch (e) { say($('feed-msg'), e.message); return; }
  const list = $('feed-list');
  list.replaceChildren(...r.feed.map((x) => item(x, () => { location.hash = `#order=${x.id}`; })));
  $('feed-count').textContent = r.feed.length ? `${r.feed.length}` : '';
  const empty = $('feed-empty');
  empty.classList.toggle('hidden', r.feed.length > 0);
  empty.textContent = r.active === false
    ? 'Вы отметили «Не принимаю новые дела» — заказы в ленте не показываются. Включить — в разделе «Специалист».'
    : 'Свободных заказов по Вашим услугам сейчас нет. Новые появятся здесь, как только заказчик оплатит.';
}
