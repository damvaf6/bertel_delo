// Подбор исполнителя (диспетчер), кабинет специалиста и список специалистов. Тексты — только через textContent.
import { api, el, say, ROLE_RU, quoted } from '/common.js';
import { state, show, refreshMe } from '/shell.js';
import { dayRu } from '/order.js';
import { showDossier } from '/dossier.js';
import { expertLink } from '/expertcard.js';
import { loadMyReport } from '/myreport.js';
import { loadSchedule } from '/schedule.js';

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
  $('match-current').textContent = current.offer_org && !current.executor ? `Сейчас дело у организации ${quoted(current.offer_org.name)}: её руководитель назначает эксперта. Можно передать другому.`
    : current.executor ? `Сейчас предложено: ${current.executor.name || 'специалист без имени'}. Можно передать другому, пока он не ответил.`
    : order.paid ? 'Заявка оплачена — дело можно предложить специалисту.' : 'Дело можно предложить после оплаты заказчиком: назначьте цену и дождитесь оплаты.';
  const { candidates, current_executor_id: cur, orgs, current_org_id: curOrg } = await api('GET', `/api/orders/${order.id}/candidates`);
  // Организации с экспертами, у которых есть допуск (2.17): эксперта назначит руководитель.
  $('org-candidates-empty').classList.toggle('hidden', orgs.length > 0);
  $('org-candidates').replaceChildren(...orgs.map((g) => el('li', { 'data-org': g.org_id },
    el('div', { class: 'row' },
      el('span', { class: 'title', text: g.name }),
      el('span', { class: 'score', text: `до ${g.best} из 100` })),
    el('div', { class: 'muted', text: `Экспертов с допуском: ${g.experts}` }),
    g.org_id === curOrg && !cur ? el('span', { class: 'badge', text: 'Предложено сейчас' })
      : el('button', { class: 'secondary', 'data-action': 'offer-org', onclick: () => offerOrg(order, g, reopen) }, 'Предложить организации'))));
  $('candidates-empty').classList.toggle('hidden', candidates.length > 0);
  $('candidates').replaceChildren(...candidates.map((c) => el('li', { 'data-id': c.user_id },
    el('div', { class: 'row' },
      el('span', { class: 'title', text: c.full_name || 'Без имени' }),
      el('span', { class: 'score', text: `${c.score.total} из 100` })),
    el('ul', { class: 'features' }, ...Object.values(c.score.features).map((f) => el('li', { text: `${f.name}: ${f.score} — ${f.note}` }))),
    // Досье (2.14): истёкший аттестат или полис — предупреждение; предложить дело всё равно можно.
    ...(c.dossier_expired?.length ? [el('div', { class: 'overdue', 'data-role': 'dossier-expired', text: `В досье истёк срок: ${c.dossier_expired.join(', ')}` })] : []),
    expertLink(c.user_id),
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

async function offerOrg(order, g, reopen) {
  if (!confirm(`Предложить дело организации ${quoted(g.name)}? Эксперта назначит её руководитель.`)) return;
  try {
    await api('POST', `/api/orders/${order.id}/offer`, { org_id: g.org_id, from: order.status });
    await reopen();
    say($('status-msg'), 'Дело предложено организации', 'ok');
  } catch (err) { say($('match-msg'), err.message); }
}

// ——— Кабинет специалиста ———

export async function showSpecialist() {
  const sp = state.specialist;
  if (!sp) { location.hash = ''; return; }
  say($('specialist-msg'), '');
  $('specialist-active').checked = sp.active;
  showAway(sp);
  // От какой организации работает (2.5а): из своих организаций; «частная практика» — без подписи организации.
  const orgs = state.me.orgs;
  $('specialist-org').replaceChildren(el('option', { value: '', text: 'Ни от какой — частная практика' }),
    ...orgs.map((o) => el('option', { value: o.org_id, text: o.name })));
  $('specialist-org').value = sp.org?.id ?? '';
  $('specialist-facts').textContent = `Дел сейчас: ${sp.open_orders} из ${sp.capacity}. Район: ${sp.regions.map((r) => (r === 'moscow' ? 'Москва' : 'Московская область')).join(', ')}.`;
  $('specialist-permits').replaceChildren(...sp.permits.map((p) => el('li', { text: permitText(p) })));
  $('specialist-permits-empty').classList.toggle('hidden', sp.permits.length > 0);
  show('specialist-view', 'specialist');
  await Promise.all([showCrm(), showVisits(sp), showDossier(), loadSchedule(), loadMyReport()]);
}

// Выезды помощника на объект (экспресс, 2.4): открываются на странице осмотра — по шагам, с камерой и геометкой.
const VISIT_STATE = { active: 'назначен', finished: 'завершён', cancelled: 'отменён экспертом', closed: 'закрыт' };
async function showVisits(sp) {
  const { visits } = await api('GET', '/api/visits');
  $('visits-box').classList.toggle('hidden', !sp.onsite && !visits.length);
  const when = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  $('visits').replaceChildren(...visits.map((v) => el('li', { 'data-visit': v.id },
    el('div', { class: 'title', text: `${v.service || 'Выезд'} · ${when(v.planned_at)}` }),
    el('div', { class: 'muted', text: [v.place, VISIT_STATE[v.state]].filter(Boolean).join(' · ') }),
    ...(v.state === 'active' ? [el('a', { class: 'btn secondary', href: `/osmotr?visit=${encodeURIComponent(v.id)}`, text: 'Открыть выезд' })] : []))));
  $('visits-empty').classList.toggle('hidden', visits.length > 0);
}

// Госзаказ из БЕРТЕЛ CRM (1.10): число дел там (учитывается в подборе) и короткие предложения; принимаются они в CRM.
async function showCrm() {
  const { crm } = await api('GET', '/api/specialist/crm');
  $('crm-box').classList.toggle('hidden', !crm.linked);
  if (!crm.linked) return;
  $('crm-facts').textContent = [`Дел в CRM сейчас: ${crm.open_cases} — они учитываются, чтобы Вас не перегружали.`,
    crm.languages.length ? `Языки: ${crm.languages.join(', ')}.` : null].filter(Boolean).join(' ');
  $('crm-offers').replaceChildren(...crm.offers.map((o) => el('li', { 'data-id': o.offer_id },
    el('div', { class: 'title', text: o.customer }),
    el('div', { class: 'muted', text: `${o.language} · ${o.volume} · срок ${dayRu(o.deadline)}` }),
    el('div', { class: 'muted', text: o.payment }),
    ...(o.url ? [el('a', { class: 'btn secondary', href: o.url, target: '_blank', rel: 'noopener noreferrer', text: 'Открыть в CRM' })] : []))));
  $('crm-offers-empty').classList.toggle('hidden', crm.offers.length > 0);
}

$('specialist-active').addEventListener('change', async (e) => {
  try {
    await api('PATCH', '/api/specialist/me', { active: e.target.checked });
    await refreshMe();
    say($('specialist-msg'), e.target.checked ? 'Теперь Вам снова предлагают дела' : 'Вам не будут предлагать новые дела', 'ok');
  } catch (err) { e.target.checked = !e.target.checked; say($('specialist-msg'), err.message); }
});

// «Не принимаю новые дела до …» (2.77): отпуск, загрузка. Отметка прошла — сервер её уже не присылает.
const tomorrow = () => new Date(Date.now() + 3 * 3_600_000 + 86_400_000).toISOString().slice(0, 10);
function showAway(sp) {
  const a = sp.away;
  $('specialist-away-now').textContent = a ? `Вы не принимаете новые дела до ${dayRu(a.until)}${a.note ? ` (${a.note})` : ''}.` : '';
  $('specialist-away-now').classList.toggle('hidden', !a);
  $('specialist-away-form').classList.toggle('hidden', !!a);
  $('specialist-away-clear').classList.toggle('hidden', !a);
  $('specialist-away-until').min = tomorrow();
  if (!a) { $('specialist-away-until').value = ''; $('specialist-away-note').value = ''; }
}

async function setAway(away, done) {
  try {
    await api('PATCH', '/api/specialist/me', { away });
    await refreshMe();
    showAway(state.specialist);
    say($('specialist-msg'), done, 'ok');
  } catch (err) { say($('specialist-msg'), err.message); }
}

$('specialist-away-set').addEventListener('click', () => {
  const until = $('specialist-away-until').value;
  if (!until) return say($('specialist-msg'), 'Укажите день, с которого снова принимаете дела');
  setAway({ until, note: $('specialist-away-note').value }, `Новые дела не будут предлагать до ${dayRu(until)}`);
});
$('specialist-away-clear').addEventListener('click', () => setAway(null, 'Теперь Вам снова предлагают дела'));

$('specialist-org').addEventListener('change', async (e) => {
  const before = state.specialist.org?.id ?? '';
  try {
    await api('PATCH', '/api/specialist/me', { org_id: e.target.value || null });
    await refreshMe();
    say($('specialist-msg'), e.target.value ? 'Теперь заключение подписывает ещё руководитель организации' : 'Подпись организации больше не нужна', 'ok');
  } catch (err) { e.target.value = before; say($('specialist-msg'), err.message); }
});

// ——— Список специалистов (диспетчер, администратор) ———

export async function showSpecialists() {
  show('specialists-view', 'specialists');
  const { specialists } = await api('GET', '/api/specialists');
  $('specialists-empty').classList.toggle('hidden', specialists.length > 0);
  $('specialists').replaceChildren(...specialists.map((s) => el('li', {},
    el('div', { class: 'title', text: s.full_name || 'Без имени' }),
    el('div', { class: 'muted', text: [!s.active ? 'не принимает дела' : s.away ? `не принимает новые дела до ${dayRu(s.away.until)}${s.away.note ? ` (${s.away.note})` : ''}` : 'принимает дела', `дел ${s.open_orders} из ${s.capacity}`,
      s.regions.map((r) => (r === 'moscow' ? 'Москва' : 'область')).join(' и ')].join(' · ') }),
    el('div', { class: 'muted', text: s.permits.length ? `Допуски: ${s.permits.map(permitText).join('; ')}` : 'Допусков нет' }),
    ...(s.dossier_alerts?.length ? [el('div', { class: 'overdue', text: s.dossier_alerts.map((a) => `${a.kind_name}: ${a.state === 'expired' ? 'срок истёк' : `срок до ${dayRu(a.valid_until)}`}`).join('; ') })] : []),
    ...(s.crm ? [el('div', { class: 'muted', text: `Из БЕРТЕЛ CRM · дел там: ${s.external_load}${s.crm.languages.length ? ` · языки: ${s.crm.languages.join(', ')}` : ''}` })] : []),
    expertLink(s.user_id))));
}
