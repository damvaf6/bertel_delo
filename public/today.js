// «Сегодня» (2.34): над списком дел — что требует внимания сейчас. Эксперту: горит по срокам, вернули на доработку, новые
// предложения, ждут проверки диспетчера. Руководителю экспертной организации — по делам его экспертов: горит срок, ждут
// подписи организации, вернул эксперту, ждут назначения (без данных заказчика), сроки документов досье экспертов (2.63),
// «горящие» — срок через 1–2 дня, а нет черновика или фото осмотра (2.98).
// «Можно продолжать» (2.86) — пришли документы, осмотр или сообщение. Диспетчеру (2.42) — деньги, проверка, цена, подбор, молчащие исполнители, горящие сроки. Нажатие — в дело или в раздел
// организации.
// Тексты — только через textContent.
import { api, el } from '/common.js';

const $ = (id) => document.getElementById(id);
const dayRu = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
const since = (iso) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
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
      // Можно продолжать (2.86): пришло новое после того, как эксперт открывал дело, — сразу к переписке, документам или осмотру.
      ...group('ready', 'Можно продолжать', e.ready ?? [], (x) => [x.title, `${x.what.join(' · ')} · ${since(x.at)}`, deadline(x, t.today)],
        (x) => { location.hash = `order=${x.id}&to=${x.to}`; }),
      ...group('returned', 'Вернули на доработку', e.returned, (x) => [x.title, `${x.by}: ${x.comment || 'без пояснения'}`, deadline(x, t.today)], toOrder),
      // Осмотр по ссылке 2 дня без фото (2.85) — сразу к осмотру в деле, там «Отправить ссылку снова».
      ...group('inspect-silent', 'Осмотр: 2 дня нет фото', e.inspect_silent ?? [], (x) => [x.title,
        `ссылка от ${since(x.link_at)}${x.expired ? ' — срок истёк' : ''}${x.sms_to ? ` · СМС на ${x.sms_to}` : ''} · отправьте снова`],
      (x) => { location.hash = `order=${x.id}&to=inspect`; }),
      ...group('hot', 'Горит срок', e.hot, (x) => [x.title, `${x.service} · ${deadline(x, t.today)}`], toOrder),
      ...group('offers', 'Новые предложения', e.offers, (x) => [x.title, [x.service, x.fee_kop ? `Вам ${rub(x.fee_kop)}` : null, deadline(x, t.today)].filter(Boolean).join(' · ')], toOrder),
      ...group('review', 'Ждут проверки диспетчера', e.review, (x) => [x.title, `${x.service} · ${deadline(x, t.today)}`], toOrder),
    );
  }
  const d = t.dispatcher;
  if (d) {
    const MONEY = { payout: 'Выплата исполнителю не прошла', refund: 'Возврат заказчику не прошёл', payment: 'Оплата висит больше суток' };
    rows.push(
      ...group('d-money', 'Деньги', d.money, (x) => [x.title, [MONEY[x.what], x.failure].filter(Boolean).join(': ')], toOrder),
      // Перенос срока (2.91) — сразу к блоку «Срок» в деле: согласиться или отказать.
      ...group('d-extend', 'Просят перенести срок', d.extend ?? [], (x) => [x.title, `${deadline(x, t.today)} → просят ${dayRu(x.new_deadline)}`, `причина: ${x.reason}`],
        (x) => { location.hash = `order=${x.id}&to=deadline`; }),
      ...group('d-review', 'Ждут проверки результата', d.review, (x) => [x.title, `${x.service} · ${deadline(x, t.today)}`], toOrder),
      ...group('d-price', 'Назначить цену', d.price, (x) => [x.title, `${x.service} · ${deadline(x, t.today)}`], toOrder),
      ...group('d-match', 'Подобрать исполнителя (оплачено)', d.to_match, (x) => [x.title, x.reason !== undefined ? `Снова в подборе: ${x.reason || 'без причины'}` : x.service, deadline(x, t.today)], toOrder),
      ...group('d-slow', 'Исполнитель не ответил больше суток', d.slow_offers, (x) => [x.title, `предложено ${since(x.offered_at)} · ${deadline(x, t.today)}`], toOrder),
      ...group('d-hot', 'Горит срок', d.hot, (x) => [x.title, `${x.status_name} · ${deadline(x, t.today)}`], toOrder),
    );
  }
  for (const g of t.orgs) {
    // Сразу к делу в разделе организации (2.67): назначить, подписать или само дело в «Делах экспертов».
    const toOrg = (to) => (x) => {
      location.hash = x?.order_ref ? `org=${g.id}&case=${x.order_ref.slice(2)}&to=${to}` : `org=${g.id}`;
    };
    const caseLine = (x) => [`${x.service} · ${x.order_ref}`, [x.expert, deadline(x, t.today)].filter(Boolean).join(' · ')];
    // «Горящие» (2.98) — первой строкой; в «Горит срок у экспертов» они не повторяются.
    const risky = new Set((g.at_risk ?? []).map((x) => x.order_ref));
    const part = [
      ...group(`org-risk-${g.id}`, 'Горит: нет черновика или фото осмотра', g.at_risk ?? [], (x) => [...caseLine(x), x.missing.join(' · ')], toOrg('case')),
      ...group(`org-sign-${g.id}`, 'Ждут подписи организации', g.to_sign, (x) => [...caseLine(x), `файлов: ${x.files}`], toOrg('sign')),
      ...group(`org-pending-${g.id}`, 'Ждут назначения эксперта', g.pending, caseLine, toOrg('pending')),
      ...group(`org-hot-${g.id}`, 'Горит срок у экспертов', g.hot.filter((x) => !risky.has(x.order_ref)), caseLine, toOrg('case')),
      ...group(`org-returned-${g.id}`, 'Вернули эксперту — ждём исправления', g.returned, (x) => [...caseLine(x), `замечание: ${x.comment}`], toOrg('case')),
      // Досье экспертов (2.63): только вид документа и срок; копии руководитель не видит.
      ...group(`org-dossier-${g.id}`, 'Документы экспертов: срок', g.dossier ?? [], (x) => [`${x.expert} · ${x.kind_name}`,
        x.state === 'expired' ? `срок истёк ${dayRu(x.valid_until)} — по оценке эксперт снят с подбора` : `действует до ${dayRu(x.valid_until)} · осталось ${daysLeft(x.valid_until, t.today)} дн.`], toOrg()),
    ];
    if (part.length) rows.push(el('li', { class: 'group org', text: `Организация: ${g.name}` }), ...part);
  }
  // Эксперт или руководитель без срочного — короткая строка «срочного нет»; заказчику карточка не нужна.
  box.classList.toggle('hidden', !e && !d && !t.orgs.length);
  $('today-list').replaceChildren(...rows);
  $('today-empty').classList.toggle('hidden', rows.length > 0);
}
