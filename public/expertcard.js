// Карточка эксперта (2.35): квалификация и допуски, досье (без копий), итоги работы и оценка «качество» в подборе,
// загрузка, «Сейчас в работе» (2.143), сданное за год по услугам и средний срок (2.139), история дел. Для диспетчера и администратора, руководителя
// организации эксперта и самого эксперта.
// Открывается по адресу #expert=<id> из подбора, списка специалистов и «Дел экспертов». Тексты — через textContent.
import { api, el } from '/common.js';
import { state, show, notFoundView } from '/shell.js';

const $ = (id) => document.getElementById(id);
const dayRu = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
const rub = (kop) => `${Math.floor(kop / 100).toLocaleString('ru-RU')} ₽`;
const STATE = { ok: 'действует', soon: 'скоро истекает', expired: 'срок истёк', none: 'без срока' };
const REGION = { moscow: 'Москва', mo: 'Московская область' };

const serviceName = (moduleId, serviceId) => {
  const m = state.catalog.modules.find((x) => x.id === moduleId);
  return m?.services.find((x) => x.id === serviceId)?.name ?? serviceId;
};

export const expertLink = (id) => el('a', { class: 'link', href: `#expert=${id}`, 'data-action': 'expert-card' }, 'Карточка эксперта');

// «Назад» — туда, откуда открыли карточку (подбор, список специалистов, дела организации).
$('expert-back').addEventListener('click', (e) => { e.preventDefault(); history.back(); });

// Сдано за год (2.139): всего и по услугам — сколько, из них позже срока, в среднем дней от принятия дела до «готово».
const daysRu = (n) => {
  const s = String(n).replace('.', ',');
  if (!Number.isInteger(n)) return `${s} дн.`;
  const m10 = n % 10, m100 = n % 100;
  return `${s} ${m10 === 1 && m100 !== 11 ? 'день' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'дня' : 'дней'}`;
};
const yearLine = (x) => [`сдано ${x.done}`, x.done_late ? `позже срока ${x.done_late}` : 'все в срок',
  x.avg_days != null ? `в среднем ${daysRu(x.avg_days)} от принятия до сдачи` : null].filter(Boolean).join(' · ');

function showYear(y) {
  $('expert-year-note').textContent = y.done ? `С ${dayRu(y.since)} по сегодня: ${yearLine(y)}.` : `С ${dayRu(y.since)} сданных дел нет.`;
  $('expert-year').replaceChildren(...y.by_service.map((x) => el('li', { 'data-service': `${x.module}/${x.service}` },
    el('div', { class: 'title', text: x.name }),
    el('div', { class: x.done_late ? 'overdue' : 'muted', text: yearLine(x) }))));
}

// Сейчас в работе (2.143): дела со сроками, «без движения» (как в «Делах экспертов», 2.133) и просьбы о переносе срока.
// Руководителю организации эксперта — ссылка к делу в «Делах экспертов» (там напомнить, передать, написать эксперту).
function showNow(now) {
  const n = now.cases.length;
  const idle = now.cases.filter((x) => x.idle).length;
  const hot = now.cases.filter((x) => x.hot).length;
  $('expert-now-note').textContent = n
    ? [`Дел: ${n}`, hot ? `срок горит: ${hot}` : null, idle ? `без движения 3 дня и больше: ${idle}` : null].filter(Boolean).join(' · ') + '. Без заказчика и данных заявки.'
    : 'Дел в работе нет.';
  $('expert-now').replaceChildren(...now.cases.map((x) => el('li', { 'data-now': x.order_ref },
    el('div', { class: 'title', text: `${x.service} · ${x.order_ref}` }),
    el('div', { class: x.overdue || x.hot ? 'overdue' : 'muted', text: [x.status_name,
      x.deadline ? `срок ${dayRu(x.deadline)}` : 'без срока', x.overdue ? 'просрочено' : x.hot ? 'срок горит' : null].filter(Boolean).join(' · ') }),
    ...(x.idle ? [el('div', { class: 'overdue', 'data-idle': '', text: `Без движения ${x.idle_days} дн.` })] : []),
    ...(x.extend ? [el('div', { class: 'muted', 'data-extend': '', text: `Просит перенести срок на ${dayRu(x.extend.new_deadline)} — ждёт решения диспетчера` })] : []),
    ...(now.org_id ? [el('a', { class: 'link', href: `#org=${now.org_id}&case=${x.order_ref.slice(2)}&to=case`, 'data-action': 'now-open' }, 'Открыть в делах экспертов')] : []))));
}

export async function showExpertCard(id) {
  let c;
  try { c = await api('GET', `/api/specialists/${id}/card`); } catch (err) {
    if (err.status === 404) return notFoundView('Эксперт не найден', '');
    throw err;
  }
  show('expert-view', null);
  const s = c.specialist;
  $('expert-name').textContent = s.full_name || 'Без имени';
  $('expert-facts').replaceChildren(...[
    ['Организация', s.org ? s.org.name : 'частная практика'],
    ['Принимает дела', s.active ? 'да' : 'нет'],
    ['Загрузка', `дел сейчас ${s.open_orders} из ${s.capacity}${s.external_load ? ` · вне платформы ${s.external_load}` : ''}`],
    ['Район работы', s.regions.map((r) => REGION[r] ?? r).join(', ') || 'не указан'],
    ['Качество в подборе', `${c.quality.score} из 100 — ${c.quality.note}`],
    ['Итоги', `сдано ${c.stats.done}, из них в срок ${c.stats.on_time}; возвратов на доработку ${c.stats.returned}; предложений принято ${c.stats.accepted} из ${c.stats.offers}`],
  ].flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
  showNow(c.now);
  showYear(c.year);
  $('expert-permits').replaceChildren(...(s.permits.length ? s.permits.map((p) => el('li', { text: `${serviceName(p.module, p.service)}${p.valid_until ? ` · до ${dayRu(p.valid_until)}` : ''}` }))
    : [el('li', { class: 'muted', text: 'Допусков нет' })]));
  $('expert-dossier').replaceChildren(...(c.dossier.length ? c.dossier.map((d) => el('li', { 'data-kind': d.kind },
    el('div', { class: 'title', text: `${d.kind_name}: ${d.title}` }),
    el('div', { class: d.state === 'expired' ? 'overdue' : 'muted', text: [d.number ? `№ ${d.number}` : null, d.amount_kop ? `сумма ${rub(d.amount_kop)}` : null,
      d.valid_until ? `до ${dayRu(d.valid_until)} — ${STATE[d.state]}` : null, d.has_copy ? 'копия есть' : 'копии нет'].filter(Boolean).join(' · ') })))
    : [el('li', { class: 'muted', text: 'Досье не заполнено' })]));
  $('expert-history').replaceChildren(...(c.history.length ? c.history.map((h) => el('li', { 'data-case': h.order_ref },
    el('div', { class: 'title', text: `${h.service} · ${h.order_ref}` }),
    el('div', { class: h.on_time === false ? 'overdue' : 'muted', text: [h.status_name, h.deadline ? `срок ${dayRu(h.deadline)}` : null,
      h.submitted ? `сдано ${dayRu(h.submitted)}` : null, h.on_time === true ? 'в срок' : h.on_time === false ? 'с опозданием' : null,
      h.returns ? `возвратов: ${h.returns}` : null].filter(Boolean).join(' · ') })))
    : [el('li', { class: 'muted', text: 'Дел пока нет' })]));
}
