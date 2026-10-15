// «Пока Вас не было» в разделе «Специалист» (2.239): неделю после дней «не принимаю дела» — что произошло с делами за эти
// дни: какие дела руководитель передал коллегам (только числом — их уже не открыть) и какие передал Вам, что решил диспетчер
// по срокам, новые сообщения заказчика, диспетчера и руководителя, пришедшие запрошенные документы. Строка открывает дело.
import { api, el } from '/common.js';
import { dayRu } from '/order.js';

const $ = (id) => document.getElementById(id);
// Последний день «не принимаю» — накануне дня, с которого снова принимает (until).
const dayBefore = (iso) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
const many = (n, one, few, lot) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : lot;
};

function row(orderId, to, title, what, cls = '') {
  return el('li', { 'data-back-order': orderId },
    el('a', { class: `open ${cls}`.trim(), href: `#order=${encodeURIComponent(orderId)}&to=${to}` },
      el('span', { text: title }), el('span', { class: 'what', text: what })));
}

function deadlineRow(d) {
  if (!d.outcome) {
    return row(d.order_id, 'deadline', `Срок: ${d.title}`,
      `${d.by_org ? 'Руководитель организации' : 'Просят'} перенести срок на ${dayRu(d.new_deadline)} — ждёт ответа диспетчера`, 'wait');
  }
  const who = d.by_org ? 'по просьбе организации' : d.not_mine ? '' : 'по Вашей просьбе';
  if (d.outcome === 'approved') return row(d.order_id, 'deadline', `Срок перенесён: ${d.title}`, [`новый срок ${dayRu(d.new_deadline)}`, who].filter(Boolean).join(' · '));
  return row(d.order_id, 'deadline', `Диспетчер отказал в переносе срока: ${d.title}`,
    [`срок остаётся ${dayRu(d.deadline)}`, who, d.answer ? `«${d.answer}»` : null].filter(Boolean).join(' · '), 'hot');
}

export async function loadAwayBack() {
  const { back } = await api('GET', '/api/specialist/me/back');
  $('back-box').classList.toggle('hidden', !back);
  if (!back) return;
  $('back-span').textContent = `С ${dayRu(back.from)} по ${dayRu(dayBefore(back.until))} Вы не принимали новые дела. Вот что произошло с Вашими делами за эти дни.`;
  const items = [];
  if (back.taken) {
    items.push(el('li', { 'data-back-taken': String(back.taken) }, el('p', { class: 'away-mark',
      text: `Руководитель или диспетчер передали другому эксперту ${back.taken} ${many(back.taken, 'Ваше дело', 'Ваших дела', 'Ваших дел')} — отвечать по ${back.taken === 1 ? 'нему' : 'ним'} не нужно.` })));
  }
  for (const g of back.given) items.push(row(g.order_id, 'deadline', `Передано Вам: ${g.title}`, g.deadline ? `срок ${dayRu(g.deadline)}` : 'дело в работе'));
  for (const d of back.deadlines) items.push(deadlineRow(d));
  for (const m of back.messages) {
    if (m.chat) items.push(row(m.order_id, 'chat', `Новые сообщения: ${m.title}`, `${m.chat} ${many(m.chat, 'сообщение', 'сообщения', 'сообщений')} от заказчика или диспетчера`));
    if (m.head) items.push(row(m.order_id, 'orgchat', `Пишет руководитель: ${m.title}`, `${m.head} ${many(m.head, 'сообщение', 'сообщения', 'сообщений')} в переписке с руководителем`));
  }
  for (const d of back.docs) items.push(row(d.order_id, 'docs', `Пришли документы: ${d.title}`, `заказчик загрузил ${d.n} ${many(d.n, 'запрошенный документ', 'запрошенных документа', 'запрошенных документов')}`));
  $('back-list').replaceChildren(...items);
}
