// Журнал действий по делу и выгрузка архивом (2.55): кто что сделал и когда — загружается при раскрытии; «Выгрузить
// дело архивом» — заказчику и платформе (карточка дела, файлы с подписями, акт; для суда или для себя).
import { api, el, say } from '/common.js';
import { state } from '/shell.js';

const $ = (id) => document.getElementById(id);
const dt = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
let orderId = null;

// access — уровень вошедшего по заявке (read / write / manage); выгружать могут сторона заказчика и служебные
// (то же правило — exportsCase в src/access/policy.mjs, сервер проверяет сам).
export function loadJournal(order, access) {
  orderId = order.id;
  $('journal-details').open = false;
  $('journal').replaceChildren();
  $('journal-lead').textContent = '';
  $('journal-empty').classList.add('hidden');
  say($('journal-msg'), '');
  const can = ['write', 'manage'].includes(access) || ['dispatcher', 'admin'].includes(state.me.user.platform_role);
  $('export-case').classList.toggle('hidden', !can);
  $('export-hint').classList.toggle('hidden', !can);
}

$('journal-details').addEventListener('toggle', async () => {
  if (!$('journal-details').open || !orderId) return;
  const id = orderId;
  try {
    const j = await api('GET', `/api/orders/${id}/journal`);
    if (id !== orderId) return;
    $('journal-lead').textContent = j.full ? 'Все действия по делу, с именами — видно только платформе.'
      : 'Что происходило с делом и кто это сделал. Внутренняя работа эксперта и платформы здесь не показывается.';
    $('journal-empty').classList.toggle('hidden', j.journal.length > 0);
    $('journal').replaceChildren(...j.journal.slice().reverse().map((x) => el('li', {},
      el('div', { class: 'muted', text: `${dt(x.at)} · ${x.who}` }),
      el('div', { text: x.what }))));
  } catch (err) {
    say($('journal-msg'), err.message);
  }
});

$('export-case').addEventListener('click', () => { location.href = `/api/orders/${orderId}/export`; });
