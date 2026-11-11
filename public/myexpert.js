// «Ваш эксперт» и «Принять» (2.465, схема 5 экранов — решение Дамира 31.10/02.11.2026). Заказчику, когда эксперт взял дело:
// имя, организация, документы досье (аттестат, СРО, полис — без номеров и копий), сколько дел сдано через платформу и в срок;
// «Принять» — согласие с условиями заказа с этим экспертом. Эксперту и диспетчеру — строкой в шапке дела, принял ли заказчик.
// Тексты — через textContent.
import { api, el, say } from '/common.js';

const $ = (id) => document.getElementById(id);
const dayRu = (iso) => new Date(iso).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric' });
const untilRu = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const rub = (kop) => `${Math.floor(kop / 100).toLocaleString('ru-RU')} ₽`;
let ctx = null; // { order, expert, reload }

const docLine = (d) => {
  const term = d.valid_until
    ? (d.state === 'expired' ? `срок истёк ${untilRu(d.valid_until)}` : `действует до ${untilRu(d.valid_until)}`) : null;
  return el('li', { 'data-kind': d.kind },
    el('div', { class: 'title', text: d.kind_name }),
    el('div', { class: 'muted', text: [d.title, d.amount_kop ? `страховая сумма ${rub(d.amount_kop)}` : null].filter(Boolean).join(' · ') }),
    ...(term ? [el('div', { class: d.state === 'expired' ? 'state-bad' : 'muted', text: term })] : []));
};

export function renderMyExpert(current, reload) {
  const x = current.my_expert ?? null;
  ctx = { order: current.order, expert: x, reload };
  $('expert-box').classList.toggle('hidden', !x);
  say($('expert-box-msg'), '');
  if (x) {
    $('expert-box-name').textContent = x.name;
    $('expert-box-org').classList.toggle('hidden', !x.org);
    $('expert-box-org').textContent = x.org ? `Работает от организации: ${x.org}` : '';
    $('expert-box-docs').replaceChildren(...x.docs.map(docLine));
    $('expert-box-stats').textContent = x.done
      ? `Сдано дел через платформу: ${x.done}, из них в срок: ${x.on_time}.`
      : 'Через платформу дел пока не сдавал.';
    $('expert-box-lead').textContent = x.accepted_at ? ''
      : x.can_accept ? 'Эксперт уже взял дело и работает. Нажмите «Принять» — это согласие с условиями заказа с этим экспертом (они ниже, в «Условиях заказа»). Вопросы — в переписке.'
        : 'Эксперт взял дело.';
    $('expert-box-accept').classList.toggle('hidden', !x.can_accept);
    $('expert-box-accepted').classList.toggle('hidden', !x.accepted_at);
    $('expert-box-accepted').textContent = x.accepted_at ? `Вы приняли эксперта ${dayRu(x.accepted_at)} — условия заказа приняты.` : '';
  }
  // Эксперту и диспетчеру — принял ли заказчик.
  const c = current.customer_accept ?? null;
  const me = !!current.executor?.is_me;
  $('order-accept-line').classList.toggle('hidden', !c);
  $('order-accept-line').textContent = !c ? ''
    : c.accepted_at ? `Заказчик принял ${me ? 'Вас' : 'эксперта'} ${dayRu(c.accepted_at)} — условия заказа приняты`
      : `Заказчик ещё не нажал «Принять» у карточки ${me ? 'эксперта — работать можно, условия заказа ниже' : 'эксперта'}`;
}

$('expert-box-accept').addEventListener('click', async () => {
  if (!ctx?.expert) return;
  const btn = $('expert-box-accept');
  btn.disabled = true;
  try {
    await api('POST', `/api/orders/${ctx.order.id}/expert/accept`, { executor_user_id: ctx.expert.executor_user_id });
    await ctx.reload();
    say($('expert-box-msg'), 'Готово: эксперт принят, ему придёт уведомление', 'ok');
  } catch (err) {
    say($('expert-box-msg'), err.message);
  } finally {
    btn.disabled = false;
  }
});
