// «Сегодня» (2.34): над списком дел — что требует внимания сейчас. Эксперту: горит по срокам, вернули на доработку, новые
// предложения, ждут проверки диспетчера. Руководителю экспертной организации — по делам его экспертов: горит срок, ждут
// подписи организации, вернул эксперту, ждут назначения (без данных заказчика). Нажатие — в дело или в раздел организации.
// Тексты — только через textContent.
import { api, el } from '/common.js';

const $ = (id) => document.getElementById(id);
const dayRu = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
const rub = (kop) => `${Math.floor(kop / 100).toLocaleString('ru-RU')} ₽`;

function daysLeft(iso, today) {
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400_000);
}
function deadline(x, today) {
  if (!x.deadline) return 'срок не указан';
  const n = daysLeft(x.deadline, today);
  if (x.overdue || n < 0) return `просрочено — срок был ${dayRu(x.deadline)}`;
  return n === 0 ? 'срок сегодня' : n === 1 ? 'срок завтра' : `срок ${dayRu(x.deadline)} · осталось ${n} дн.`;
}

// Группа строк: заголовок с числом и строки-кнопки.
function group(id, title, items, line, go) {
  if (!items.length) return [];
  return [el('li', { class: 'group', 'data-today': id, text: `${title} · ${items.length}` }),
    ...items.map((x) => el('li', { 'data-today-item': id },
      el('button', { class: 'open', onclick: () => go(x) }, ...line(x).map((t, i) => el('div', { class: i ? 'muted' : 'title', text: t })))))];
}

export async function loadToday() {
  const box = $('today-box');
  let t;
  try { t = await api('GET', '/api/today'); } catch { box.classList.add('hidden'); return; }
  const toOrder = (x) => { location.hash = `order=${x.id}`; };
  const rows = [];
  const e = t.expert;
  if (e) {
    rows.push(
      ...group('returned', 'Вернули на доработку', e.returned, (x) => [x.title, `${x.by}: ${x.comment || 'без пояснения'}`, deadline(x, t.today)], toOrder),
      ...group('hot', 'Горит срок', e.hot, (x) => [x.title, `${x.service} · ${deadline(x, t.today)}`], toOrder),
      ...group('offers', 'Новые предложения', e.offers, (x) => [x.title, [x.service, x.fee_kop ? `Вам ${rub(x.fee_kop)}` : null, deadline(x, t.today)].filter(Boolean).join(' · ')], toOrder),
      ...group('review', 'Ждут проверки диспетчера', e.review, (x) => [x.title, `${x.service} · ${deadline(x, t.today)}`], toOrder),
    );
  }
  for (const g of t.orgs) {
    const toOrg = () => { location.hash = `org=${g.id}`; };
    const caseLine = (x) => [`${x.service} · ${x.order_ref}`, [x.expert, deadline(x, t.today)].filter(Boolean).join(' · ')];
    const part = [
      ...group(`org-sign-${g.id}`, 'Ждут подписи организации', g.to_sign, (x) => [...caseLine(x), `файлов: ${x.files}`], toOrg),
      ...group(`org-pending-${g.id}`, 'Ждут назначения эксперта', g.pending, caseLine, toOrg),
      ...group(`org-hot-${g.id}`, 'Горит срок у экспертов', g.hot, caseLine, toOrg),
      ...group(`org-returned-${g.id}`, 'Вернули эксперту — ждём исправления', g.returned, (x) => [...caseLine(x), `замечание: ${x.comment}`], toOrg),
    ];
    if (part.length) rows.push(el('li', { class: 'group org', text: `Организация: ${g.name}` }), ...part);
  }
  // Эксперт или руководитель без срочного — короткая строка «срочного нет»; заказчику карточка не нужна.
  box.classList.toggle('hidden', !e && !t.orgs.length);
  $('today-list').replaceChildren(...rows);
  $('today-empty').classList.toggle('hidden', rows.length > 0);
}
