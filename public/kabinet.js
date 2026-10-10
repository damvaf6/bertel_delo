// Кабинет: разделы «Заявки», «Помощник» (ИИ), «Уведомления», «Организации», «Профиль», «Управление» (только администратору). Заявка — order.js.
// Разделы переключаются адресом после «#»: #order=…, #assistant, #notifications, #orgs, #org=…, #profile, #help, #admin, #money (деньги — служебным
// и специалистам).
import { api, el, say, formatPhone } from '/common.js';
import { state, show, refreshMe, refreshCounts } from '/shell.js';
import { openOrder, serviceOptions, dayRu } from '/order.js';
import { showOrgs, showOrg } from '/orgs.js';
import { showAdmin } from '/admin.js';
import { showSpecialist, showSpecialists } from '/match.js';
import { showMoney } from '/money.js';
import { showNotifications } from '/notify.js';
import { showAssistant } from '/assistant.js';
import { showMail } from '/mail.js';
import { loadToday } from '/today.js';
import { showExpertCard } from '/expertcard.js';
import { showFirstHint, showHelp } from '/help.js';
import { showProblems } from '/problems.js';
import { matcher, wireSearch } from '/search.js';

const $ = (id) => document.getElementById(id);
const dateRu = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

async function start() {
  api('GET', '/api/health').then((h) => {
    if (h?.test_data) $('test-mark').classList.remove('hidden');
    if (h?.demo) $('test-mark').textContent = 'Демо-площадка · всё вымышленное · данные сбрасываются каждую ночь';
  }).catch(() => {});
  try {
    [, state.catalog] = await Promise.all([refreshMe(), api('GET', '/api/catalog')]);
  } catch (err) {
    if (err.status === 401) return location.replace(location.hash ? `/?next=${encodeURIComponent(location.hash)}` : '/');
    throw err;
  }
  serviceOptions($('service'));
  window.addEventListener('hashchange', route);
  await route();
}

async function route() {
  const h = location.hash;
  if (h === '#notifications') return showNotifications();
  refreshCounts();
  let m;
  if ((m = h.match(/^#order=([0-9a-f-]{36})(?:&to=(inspect|chat|docs|deadline|extend|sign|handover|onsite|notes|result|fix))?$/i))) return openOrder(m[1], { to: m[2] });
  // #org=…&case=XXXXXXXX&to=pending|sign|chat|case|handover|transfer — сразу к делу организации (2.67: из уведомления или «Сегодня»).
  if ((m = h.match(/^#org=([0-9a-f-]{36})(?:&case=([0-9A-F]{8})(?:&to=(pending|sign|chat|case|handover|transfer))?)?$/i))) return showOrg(m[1], m[2] ? { ref: `№ ${m[2].toUpperCase()}`, to: m[3] } : null);
  // #org=…&to=week|overdue|sign|handover|returned|idle — к блоку организации без дела (2.130, 2.141, 2.153, 2.158: из утренней
  // сводки руководителю).
  if ((m = h.match(/^#org=([0-9a-f-]{36})&to=(week|overdue|sign|handover|returned|idle)$/i))) return showOrg(m[1], { block: m[2] });
  if (h === '#orgs') return showOrgs();
  if ((m = h.match(/^#expert=([0-9a-f-]{36})$/i))) return showExpertCard(m[1]);
  if (h === '#profile') return showProfile();
  if (h === '#help') return showHelp();
  if (h === '#problems' && ['dispatcher', 'admin'].includes(state.me.user.platform_role)) return showProblems();
  if (h === '#assistant') return showAssistant();
  if ((m = h.match(/^#assistant=([0-9a-f-]{36})$/i))) return showAssistant(m[1]);
  if (h === '#specialist') return showSpecialist();
  if (h === '#specialist&to=schedule') return showSpecialist({ to: 'schedule' });
  if (h === '#specialists' && ['dispatcher', 'admin'].includes(state.me.user.platform_role)) return showSpecialists();
  if (h === '#admin' && state.me.user.platform_role === 'admin') return showAdmin();
  if (h === '#money') return showMoney();
  show('list-view', 'orders');
  showFirstHint();
  await Promise.all([loadOrders(), loadToday()]);
  // #today — к «Сегодня» на главной (2.142: утренняя сводка эксперта, где только дела из «Сегодня»).
  if (h === '#today') $('today-box').scrollIntoView({ block: 'start' });
}

let allOrders = [];

// Диспетчеру и администратору список — «все заявки» с отбором по статусу (очередь подбора — сверху по умолчанию).
function setupFilter() {
  const staff = ['dispatcher', 'admin'].includes(state.me.user.platform_role);
  $('orders-title').textContent = staff ? 'Все заявки' : 'Мои заявки';
  $('orders-filter-box').classList.toggle('hidden', !staff);
  // Диспетчеру (2.42) подсказка «не знаете, какая услуга» ни к чему — он сам подбирает услугу и исполнителя.
  $('problem-card').classList.toggle('hidden', staff);
  if (!staff || $('orders-filter').options.length) return;
  $('orders-filter').replaceChildren(el('option', { value: '', text: 'Все' }),
    ...state.catalog.statuses.map((s) => el('option', { value: s.id, text: s.name })));
  $('orders-filter').addEventListener('change', renderOrders);
}

// Поиск по своим делам (2.73): номер, адрес и другие поля заявки, вид услуги, заказчик (организация и кто ведёт),
// номер дела суда, состояние. Варианты выбора — названиями, как на экране, а не внутренними кодами.
const orderRef = (o) => `№ ${o.id.slice(0, 8).toUpperCase()}`;
function searchText(o) {
  const fields = state.catalog.modules.find((m) => m.id === o.module)?.services.find((s) => s.id === o.service)?.fields ?? [];
  const values = Object.entries(o.fields ?? {}).map(([k, v]) => {
    const f = fields.find((x) => x.id === k);
    return f?.type === 'select' ? f.options?.find((x) => x.id === v)?.name ?? v : v;
  });
  return [orderRef(o), o.id.slice(0, 8), o.title, o.service_name, o.module_name, o.status_name, o.org_name, o.responsible_name,
    o.basis_name, o.basis_number, ...values].filter((x) => x != null && x !== '').join(' \n ');
}
wireSearch($('orders-search'), () => renderOrders());

async function loadOrders() {
  setupFilter();
  ({ orders: allOrders } = await api('GET', '/api/orders'));
  renderOrders();
}

// Специалисту — дела по группам (разбор 03.10.2026, 2.11–2.12): предложения сверху с «Принять» и «Отказаться» прямо из
// списка, дальше в работе, на проверке, готовые; внутри группы — по сроку; «осталось N дн.», вознаграждение в строке.
// Заявки, где он заказчик, — отдельной группой. Служебным — все заявки с отбором по статусу.
const EXEC_GROUPS = [
  { id: 'offers', title: 'Предложены Вам', statuses: ['awaiting_executor'] },
  { id: 'work', title: 'В работе', statuses: ['in_work'] },
  { id: 'review', title: 'На проверке', statuses: ['review'] },
  { id: 'done', title: 'Готовы и закрыты', statuses: ['done', 'closed', 'cancelled'] },
];
const rubShort = (kop) => `${Math.floor(kop / 100).toLocaleString('ru-RU')} ₽`;
const daysLeft = (iso) => {
  const [y, m, d] = String(iso).split('-').map(Number);
  const msk = new Date(Date.now() + 3 * 3600_000);
  const today = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate());
  return Math.round((Date.UTC(y, m - 1, d) - today) / 86400_000);
};
const byDeadline = (a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999');

function deadlineText(o) {
  if (!o.deadline) return ['closed', 'cancelled'].includes(o.status) ? '' : 'срок не указан';
  if (['done', 'closed', 'cancelled'].includes(o.status)) return `срок ${dayRu(o.deadline)}`;
  const n = daysLeft(o.deadline);
  if (o.overdue || n < 0) return `срок ${dayRu(o.deadline)} · просрочено`;
  return `срок ${dayRu(o.deadline)} · ${n === 0 ? 'сегодня' : `осталось ${n} дн.`}`;
}

function orderItem(o) {
  const soon = o.deadline && !['done', 'closed', 'cancelled'].includes(o.status) && daysLeft(o.deadline) <= 2;
  const li = el('li', {},
    el('button', { class: 'open', 'data-id': o.id, onclick: () => { location.hash = `order=${o.id}`; } },
      el('div', { class: 'title', text: o.title }),
      el('div', { class: 'row' },
        el('span', { class: `badge status${o.status === 'cancelled' ? ' cancelled' : ''}`, text: o.status_name }),
        el('span', { class: `muted${o.overdue || soon ? ' overdue' : ''}`, text: deadlineText(o) })),
      el('div', { class: 'muted', text: [o.service_name, orderRef(o), o.as_executor && o.fee_kop ? `Вам ${rubShort(o.fee_kop)}` : null, o.as_executor ? null : dateRu(o.created_at),
        o.org_name ? `${o.org_name} · ведёт ${o.responsible_name || 'сотрудник'}` : null].filter(Boolean).join(' · ') }),
      ...(o.as_executor && o.brief ? [el('div', { class: 'brief', text: o.brief })] : [])));
  if (o.as_executor && o.status === 'awaiting_executor') {
    li.append(el('div', { class: 'row offer-actions' },
      el('button', { 'data-action': 'accept', onclick: () => answerOffer(o, 'in_work') }, 'Принять дело'),
      el('button', { class: 'secondary', 'data-action': 'decline', onclick: () => answerOffer(o, 'matching') }, 'Отказаться')));
  }
  return li;
}

async function answerOffer(o, to) {
  let reason;
  if (to === 'matching') {
    reason = prompt('Почему отказываетесь? Причину увидит тот, кто предложил дело, и предложит его другому.');
    if (reason === null) return;
    if (!reason.trim()) return say($('orders-msg'), 'Укажите причину отказа');
  } else if (!confirm(`Принять дело «${o.title}»?`)) return;
  try {
    await api('POST', `/api/orders/${o.id}/status`, { from: 'awaiting_executor', to, reason: reason?.trim() || undefined });
    // Принял — сразу в дело (2.33): дальше работа там, «Что дальше» подскажет первый шаг.
    if (to === 'in_work') { location.hash = `order=${o.id}`; return; }
    await loadOrders();
    say($('orders-msg'), to === 'in_work' ? 'Дело принято — оно в разделе «В работе»' : 'Вы отказались от дела', 'ok');
  } catch (err) { say($('orders-msg'), err.message); }
}

function renderOrders() {
  const ul = $('orders');
  const staff = ['dispatcher', 'admin'].includes(state.me.user.platform_role);
  const status = $('orders-filter').value;
  // Строка поиска — когда дел больше одного; запрос остаётся при обновлении списка (принял дело, отказался).
  $('orders-search-box').classList.toggle('hidden', allOrders.length < 2);
  const q = allOrders.length < 2 ? '' : $('orders-search').value;
  const hit = matcher(q);
  const orders = allOrders.filter((o) => (!status || o.status === status) && hit(searchText(o)));
  const exec = !staff && orders.some((o) => o.as_executor);
  if (!exec) {
    ul.replaceChildren(...orders.map(orderItem));
  } else {
    const groups = EXEC_GROUPS.map((g) => ({ ...g, items: orders.filter((o) => o.as_executor && g.statuses.includes(o.status)).sort(byDeadline) }));
    const own = orders.filter((o) => !o.as_executor);
    ul.replaceChildren(
      ...groups.filter((g) => g.items.length).flatMap((g) => [el('li', { class: 'group', 'data-group': g.id, text: `${g.title} · ${g.items.length}` }), ...g.items.map(orderItem)]),
      ...(own.length ? [el('li', { class: 'group', 'data-group': 'own', text: `Мои заявки как заказчика · ${own.length}` }), ...own.map(orderItem)] : []));
  }
  const none = !orders.length && allOrders.length > 0 && q.trim() !== '';
  $('orders-empty').classList.toggle('hidden', orders.length > 0 || none);
  $('orders-none').classList.toggle('hidden', !none);
  $('orders-none').textContent = none ? `Ничего не найдено по «${q.trim()}». Ищите по номеру дела, адресу, виду услуги или заказчику.` : '';
}

function showProfile() {
  $('full-name').value = state.me.user.full_name;
  $('profile-phone').textContent = `Телефон для входа: ${formatPhone(state.me.user.phone)}`;
  say($('profile-msg'), '');
  show('profile-view', 'profile');
  return showMail();
}

$('profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fullName = $('full-name').value.trim();
  if (!fullName) return say($('profile-msg'), 'Укажите, как к Вам обращаться');
  $('save-profile').disabled = true;
  try {
    await api('PATCH', '/api/me', { full_name: fullName });
    await refreshMe();
    say($('profile-msg'), 'Сохранено', 'ok');
  } catch (err) { say($('profile-msg'), err.message); } finally { $('save-profile').disabled = false; }
});

$('new-order').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('title').value.trim();
  const [module, service] = $('service').value.split('/');
  const orgId = $('order-org').value || null;
  $('create').disabled = true;
  try {
    const { order } = await api('POST', '/api/orders', { module, service, ...(title ? { title } : {}), ...(orgId ? { org_id: orgId } : {}) });
    $('title').value = '';
    say($('new-msg'), '');
    location.hash = `order=${order.id}`;
  } catch (err) { say($('new-msg'), err.message); } finally { $('create').disabled = false; }
});

$('logout').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout').catch(() => {});
  location.replace('/');
});
const back = () => { location.hash = ''; };
$('back').addEventListener('click', back);
$('back2').addEventListener('click', () => { location.hash = $('back2').dataset.back || ''; });

start();
