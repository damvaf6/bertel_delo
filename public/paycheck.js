// Оплата ЮKassa: проверка перед подключением (2а.10). Администратору в «Управлении»: адрес уведомлений и возврата, ключи,
// чеки, реквизиты — по пунктам; «Проверить адрес уведомлений» — доходит ли уведомление снаружи; частые ошибки.
import { api, el, say } from '/common.js';

const $ = (id) => document.getElementById(id);
const MARK = { true: '✓', false: '✗', null: '•' };

export async function loadPayCheck(probe = false) {
  let check;
  try {
    ({ check } = await api('GET', `/api/admin/payments-check${probe ? '?probe=1' : ''}`));
  } catch (err) { say($('pc-msg'), err.message); return; }
  $('pc-items').replaceChildren(...check.items.map((i) => el('li', { 'data-pc': i.key, 'data-ok': String(i.ok) },
    el('div', { class: 'title', text: `${MARK[String(i.ok)]} ${i.title}` }),
    el('div', { class: 'muted', text: i.text }))));
  $('pc-mistakes').replaceChildren(...check.mistakes.map((m) => el('li', { 'data-pc-mistake': m.key },
    el('div', { class: 'title', text: m.title }), el('div', { class: 'muted', text: m.hint }))));
  if (check.probe) say($('pc-msg'), `Адрес уведомлений: ${check.probe.text}`, check.probe.ok ? 'ok' : undefined);
}

$('pc-probe').addEventListener('click', async () => {
  $('pc-probe').disabled = true;
  say($('pc-msg'), 'Проверяю…', 'ok');
  try { await loadPayCheck(true); } finally { $('pc-probe').disabled = false; }
});
