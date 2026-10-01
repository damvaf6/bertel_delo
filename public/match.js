// Подбор исполнителя (диспетчер), кабинет специалиста и список специалистов. Тексты — только через textContent.
import { api, el, say, ROLE_RU } from '/common.js';
import { state, show, refreshMe } from '/shell.js';
import { dayRu } from '/order.js';

const $ = (id) => document.getElementById(id);

export function serviceName(moduleId, serviceId) {
  const m = state.catalog.modules.find((x) => x.id === moduleId);
  const s = m?.services.find((x) => x.id === serviceId);
  return s ? `${m.name} · ${s.name}` : `${moduleId} · ${serviceId}`;
}

const permitText = (p) => `${serviceName(p.module, p.service)}${p.valid_until ? ` · до ${dayRu(p.valid_until)}` : ''}`;

// ——— Подбор на странице заявки ———

export async function loadMatch(current, reopen) {
  const box = $('match-box');
  const isDispatcher = state.me.user.platform_role === 'dispatcher';
  const { order } = current;
  const on = isDispatcher && ['matching', 'awaiting_executor'].includes(order.status);
  box.classList.toggle('hidden', !on);
  if (!on) return;
  say($('match-msg'), '');
  // Заказчик платит при заказе: пока не оплачено, предложить дело нельзя (1.6а).
  $('match-current').textContent = current.executor ? `Сейчас предложено: ${current.executor.name || 'специалист без имени'}. Можно передать другому, пока он не ответил.`
    : order.paid ? 'Заявка оплачена — дело можно предложить специалисту.' : 'Дело можно предложить после оплаты заказчиком: назначьте цену и дождитесь оплаты.';
  const { candidates, current_executor_id: cur } = await api('GET', `/api/orders/${order.id}/candidates`);
  $('candidates-empty').classList.toggle('hidden', candidates.length > 0);
  $('candidates').replaceChildren(...candidates.map((c) => el('li', { 'data-id': c.user_id },
    el('div', { class: 'row' },
      el('span', { class: 'title', text: c.full_name || 'Без имени' }),
      el('span', { class: 'score', text: `${c.score.total} из 100` })),
    el('ul', { class: 'features' }, ...Object.values(c.score.features).map((f) => el('li', { text: `${f.name}: ${f.score} — ${f.note}` }))),
    c.user_id === cur ? el('span', { class: 'badge', text: 'Предложено сейчас' })
      : el('button', { class: 'secondary', 'data-action': 'offer', onclick: () => offer(order, c, reopen) }, 'Предложить дело'))));
}

async function offer(order, c, reopen) {
  if (!confirm(`Предложить дело специалисту «${c.full_name || 'без имени'}»?`)) return;
  try {
    await api('POST', `/api/orders/${order.id}/offer`, { specialist_id: c.user_id, from: order.status });
    await reopen();
    say($('status-msg'), 'Дело предложено специалисту', 'ok');
  } catch (err) { say($('match-msg'), err.message); }
}

// ——— Кабинет специалиста ———

export async function showSpecialist() {
  const sp = state.specialist;
  if (!sp) { location.hash = ''; return; }
  say($('specialist-msg'), '');
  $('specialist-active').checked = sp.active;
  $('specialist-facts').textContent = `Дел сейчас: ${sp.open_orders} из ${sp.capacity}. Район: ${sp.regions.map((r) => (r === 'moscow' ? 'Москва' : 'Московская область')).join(', ')}.`;
  $('specialist-permits').replaceChildren(...sp.permits.map((p) => el('li', { text: permitText(p) })));
  $('specialist-permits-empty').classList.toggle('hidden', sp.permits.length > 0);
  show('specialist-view', 'specialist');
}

$('specialist-active').addEventListener('change', async (e) => {
  try {
    await api('PATCH', '/api/specialist/me', { active: e.target.checked });
    await refreshMe();
    say($('specialist-msg'), e.target.checked ? 'Теперь Вам снова предлагают дела' : 'Вам не будут предлагать новые дела', 'ok');
  } catch (err) { e.target.checked = !e.target.checked; say($('specialist-msg'), err.message); }
});

// ——— Список специалистов (диспетчер, администратор) ———

export async function showSpecialists() {
  show('specialists-view', 'specialists');
  const { specialists } = await api('GET', '/api/specialists');
  $('specialists-empty').classList.toggle('hidden', specialists.length > 0);
  $('specialists').replaceChildren(...specialists.map((s) => el('li', {},
    el('div', { class: 'title', text: s.full_name || 'Без имени' }),
    el('div', { class: 'muted', text: [s.active ? 'принимает дела' : 'не принимает дела', `дел ${s.open_orders} из ${s.capacity}`,
      s.regions.map((r) => (r === 'moscow' ? 'Москва' : 'область')).join(' и ')].join(' · ') }),
    el('div', { class: 'muted', text: s.permits.length ? `Допуски: ${s.permits.map(permitText).join('; ')}` : 'Допусков нет' }))));
}
