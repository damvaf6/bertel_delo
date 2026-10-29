// Страница заявки: данные (заполнение, пока заявка «новая»), ход заявки и шаги, кто ведёт дело, документы и результат;
// проверка результата и переписка — work.js; цена, оплата, выплата и закрывающие документы — money.js.
// Поля рисуются по описанию модуля из /api/catalog — у каждой профессии свои, код страницы один.
import { api, el, say, formatPhone, formatSize, ROLE_RU, quoted } from '/common.js';
import { state, show, notFoundView } from '/shell.js';
import { loadMatch } from '/match.js';
import { loadReview, loadChat, egrnSwapState, egrnSwapFor, taskSwapFor, orderFixState, toOrderFix } from '/work.js';
import { loadMoney } from '/money.js';
import { loadDraft, canFixInDraft, madeInDraft } from '/draft.js';
import { loadAnalogs } from '/analogs.js';
import { loadInspection } from '/inspect.js';
import { loadOnsite } from '/onsite.js';
import { signatureLines, uploadSignatureButton, SIGN_CONFIRM, UPLOAD_HINT, MANUAL_HINT, SIGN_HOWTO, COURT_HOWTO, memo } from '/sign.js';
import { setNext } from '/next.js';
import { reveal } from '/fold.js';
import { orgChat } from '/orgchat.js';
import { loadJournal } from '/journal.js';
import { loadDocRequests } from '/docreq.js';
import { loadDeadline } from '/deadline.js';
import { loadHandover } from '/handover.js';
import { loadNotes } from '/notes.js';
import { loadSteps } from '/steps.js';
import { loadPredecessor } from '/predecessor.js';
import { loadTaskFacts } from '/taskfacts.js';
import { loadRepeat } from '/repeat.js';
import { loadSimilar } from '/similar.js';
import { renderRemarks, openRemarks } from '/remarks.js';

const $ = (id) => document.getElementById(id);
// До 3 МБ — обычной загрузкой через ядро; больше — прямо в хранилище (облако: запрос не больше 3,5 МБ, 2.49).
const MAX_FILE = 3 * 1024 * 1024;
const MAX_DIRECT = 100 * 1024 * 1024;
const PHOTOS_UNFOLDED = 6;
const FINAL = ['closed', 'cancelled'];
const WORK_STARTED = ['in_work', 'review'];
const DOC_KIND_RU = { basis: 'Основание', result: 'Результат работы', inspection: 'Фото осмотра' };
let current = null; // { order, access, editable, actions, history }

const dateTimeRu = (s) => new Date(s).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
export function dayRu(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

// Дни «не принимаю дела» (2.77, 2.226): «до 30 октября» или, если ещё не начались, «с 20 октября до 30 октября».
export const awaySpan = (a) => `${a.from ? `с ${dayRu(a.from)} ` : ''}до ${dayRu(a.until)}`;
// Нерабочий праздник в «Моих сроках» и нагрузке экспертов (2.371): название; срок сдачи в этот день — сдать до последнего
// рабочего дня перед ним (`work_before`).
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
export const holidayText = (d, due) => `Праздник, нерабочий день: ${d.holiday}${due ? ` — заказчик в этот день не работает; сдайте лучше до него, последний рабочий день — ${
  WD[new Date(`${d.work_before}T00:00:00Z`).getUTCDay()]}, ${dayRu(d.work_before)}` : ''}.`;

// Рабочая суббота по переносу выходного (2.392) — в «Моих сроках» и нагрузке экспертов, не обычный выходной.
export const WORKING_DAY = 'Рабочая суббота (перенос)';

export function serviceDef(moduleId, serviceId) {
  const m = state.catalog.modules.find((x) => x.id === moduleId);
  const s = m?.services.find((x) => x.id === serviceId);
  return s ? { module: m, service: s } : null;
}

// Список услуг для выбора: по модулям; значение — «модуль/услуга».
export function serviceOptions(select) {
  select.replaceChildren(...state.catalog.modules.map((m) => el('optgroup', { label: m.name },
    ...m.services.map((s) => el('option', { value: `${m.id}/${s.id}`, text: s.name })))));
}

// to — сразу к разделу дела (2.115: напоминание по заметке → заметки; 2.85: «Сегодня» → осмотр без фото; 2.86: «можно продолжать» → переписка, документы, осмотр).
export async function openOrder(id, { to } = {}) {
  try {
    current = await api('GET', `/api/orders/${id}`);
  } catch (err) {
    if (err.status === 404) { current = null; return notFoundView('Заявка не найдена', ''); }
    throw err;
  }
  for (const m of ['doc-msg', 'transfer-msg', 'details-msg', 'status-msg']) say($(m), '');
  $('reason').value = '';
  $('cancel-fault').value = '';
  $('cancel-quality').value = '';
  $('done-percent').value = '';
  render();
  show('order-view', 'orders');
  setNext({ reset: true, current, step: doStep, signAll });
  loadOrgChat();
  loadJournal(current.order, current.access);
  await Promise.all([loadDocs(true), loadTransfer(), loadMatch(current, () => openOrder(id)), loadDraft(current, () => openOrder(id)), loadAnalogs(current), loadInspection(current), loadOnsite(current), loadDocRequests(current, (file, msg) => uploadFile(file, 'other', msg)), loadDeadline(current, () => openOrder(id)), loadHandover(current), loadNotes(current), loadSteps(current), loadPredecessor(current, () => openOrder(id)), loadTaskFacts(current), loadRepeat(current, () => openOrder(id)), loadSimilar(current), loadReview(current), loadChat(current), loadMoney(current, () => openOrder(id))]);
  setNext({ loaded: true }); // разделы осмотра и черновика показаны — шаги пересчитываются, нужный сейчас блок раскрыт
  // Черновик и «Срок» уже показаны — у предупреждения «нет файла результата» (2.138) видны нужные кнопки.
  renderResultDue(lastDocs?.result_due ?? null);
  // Черновик и ИИ-проверка показаны — у пунктов замечания руководителя видна «Заменить по выписке» (2.262).
  if (orgReturnsNow.length) renderOrgReturns(orgReturnsNow);
  const box = { result: 'docs-box', inspect: 'inspect-box', chat: 'chat-box', remind: 'chat-box', orgchat: 'org-chat-box', docs: 'docreq-box', review: 'review-box', deadline: 'deadline-box', extend: 'deadline-box', away: 'deadline-box', late: 'deadline-box', sign: 'sign-wait-box', fix: 'org-returns-box', fresh: 'org-returns-box', unsigned: 'docs-box', handover: 'handover-box', rebuild: 'draft-box', task: 'draft-box', onsite: 'onsite-box', notes: 'notes-box', steps: 'steps-box', remarks: 'remarks-items-box' }[to];
  if (box && !$(box).classList.contains('hidden')) { reveal(box); $(box).scrollIntoView({ block: 'start' }); }
  // «Попросить перенос» из «Моих сроков» (2.134): причина «много дел в этот день» и новый срок — сразу в полях.
  if (to === 'extend') document.querySelector('#deadline-reason-list [data-reason="busy"]')?.click();
  // Срок в дни «не принимаю новые дела» (2.195): причина «меня не будет» и день возвращения — сразу в полях.
  if (to === 'away') document.querySelector('#deadline-reason-list [data-reason="away"]')?.click();
  // Исправленный файл больше суток не подписан (2.204): сразу к нему в «Документах»; файла уже нет — остаётся у замечаний.
  if (to === 'fresh') {
    const d = orgReturnsNow.filter((r) => r.open).map((r) => freshAfter(r).at(-1)).find(Boolean);
    if (d) toDoc(d.id);
  }
  // Срок по письму о переносе близко, а свой файл результата не подписан (2.351): сразу к последнему такому файлу.
  if (to === 'unsigned') {
    const d = (lastDocs?.documents ?? []).filter((x) => x.kind === 'result' && x.own !== false && !x.signatures?.expert).at(-1);
    if (d) toDoc(d.id);
  }
  // Заказчик 2 дня не отвечает (2.375): готовая фраза-напоминание сразу в поле сообщения — отправляет эксперт сам.
  if (to === 'remind') document.querySelector('#message-phrase-list [data-phrase="remind"]')?.click();
  if (to === 'handover' && !$('handover-form').classList.contains('hidden')) $('handover-reason').focus();
  // Заменил по выписке в черновике, а файл собран до замены (2.272): сразу к кнопке сборки Word из черновика.
  if (to === 'rebuild' && !$('draft-box').classList.contains('hidden')) {
    $('draft-attach').scrollIntoView({ block: 'center' });
    $('draft-attach').focus();
    say($('draft-msg'), 'Черновик изменён после загрузки файла результата — отметьте, что проверили текст, и приложите Word заново; прежний файл удалите', 'ok');
  }
  // Задание на оценку пришло позже черновика (2.295): сразу к таблице задания в тексте черновика — строки выделены.
  if (to === 'task' && !$('draft-box').classList.contains('hidden') && !$('draft-edit').classList.contains('hidden')) {
    const area = $('draft-text');
    const at = area.value.search(/^\|\s*Сведение\s*\|/mu);
    if (at >= 0) {
      const end = area.value.slice(at).search(/\n(?!\|)/u);
      area.focus();
      area.setSelectionRange(at, end < 0 ? area.value.length : at + end);
    }
    area.scrollIntoView({ block: 'center' });
    say($('draft-msg'), 'Задание на оценку пришло после черновика — сверьте с ним таблицу задания (дата оценки, вид стоимости, адрес, цель оценки, срок, пользователь результатов оценки) и заказчика или подготовьте черновик заново', 'ok');
  }
  // «Попросить перенести срок» у просроченного дела из «Сегодня» (2.166): сразу к полю нового срока; готовые причины — над ним.
  if (to === 'late' && !$('deadline-form').classList.contains('hidden')) {
    $('deadline-new').focus();
    say($('deadline-msg'), 'Срок прошёл — выберите новый срок и напишите причину', 'ok');
  }
}

function render() {
  const { order } = current;
  $('order-title').textContent = order.title;
  $('order-service').textContent = order.service_name ? `${order.module_name} · ${order.service_name}` : 'Услуга не выбрана';
  $('order-status').textContent = order.status_name;
  $('order-status').classList.toggle('cancelled', order.status === 'cancelled');
  $('order-deadline').textContent = order.deadline ? `Срок: ${dayRu(order.deadline)}${order.overdue ? ' · просрочено' : ''}` : 'Срок не указан';
  $('order-deadline').classList.toggle('overdue', order.overdue);
  $('order-meta').textContent = `Создана ${dateTimeRu(order.created_at)}${order.express ? ' · Экспресс: выезд помощника' : ''}`;
  // Ответ сразу после отправки (задача штаба 3fd17197): обещанный срок цены, а не успели — «задерживаемся».
  $('order-ack').classList.toggle('hidden', !current.ack);
  $('order-ack').classList.toggle('overdue', !!current.ack?.late);
  $('order-ack').textContent = current.ack?.text ?? '';
  renderOrgLine();
  $('ask-assistant').href = `#assistant=${order.id}`;
  $('details-form').classList.toggle('hidden', !current.editable);
  $('details-view').classList.toggle('hidden', current.editable);
  if (current.editable) renderForm(); else renderFacts();
  renderQuote();
  renderTerms();
  renderProgress();
  $('upload-box').classList.toggle('hidden', current.access === 'read' || FINAL.includes(order.status));
  $('result-upload-box').classList.toggle('hidden', !(current.executor?.is_me && order.status === 'in_work'));
  // Копии из досье (2.14) — тем, у кого есть профиль специалиста.
  for (const id of ['dossier-attach', 'dossier-attach-note']) $(id).classList.toggle('hidden', !state.specialist);
}

function renderOrgLine() {
  const { order } = current;
  $('order-org-line').textContent = order.org_name
    ? `Организация: ${order.org_name} · Ведёт: ${order.responsible_name || 'сотрудник без имени'}`
    : 'Личная заявка';
  if (current.executor) $('order-org-line').textContent += ` · Исполнитель: ${current.executor.is_me ? 'Вы' : current.executor.name || 'специалист без имени'}`;
  // Заявка по письму (1.9): ход заявки и результат уходят письмами в ту же переписку.
  $('order-mail-line').classList.toggle('hidden', !current.mail);
  $('order-mail-line').textContent = !current.mail ? ''
    : current.mail.email ? `Пришла по письму. Ход заявки и результат — письмами на ${current.mail.email}` : 'Заявка пришла по письму';
}

// Перевод (задача штаба 3f617197): предварительный расчёт по таблице цен и предупреждения («туда нужен нотариальный»).
// Окончательную цену назначает диспетчер; тарифы нотариуса и доставка — без вознаграждения платформы.
const rubKop = (kop) => `${(kop / 100).toLocaleString('ru-RU')} ₽`;
function renderQuote() {
  const quote = current.quote ?? null;
  const notices = current.notices ?? [];
  $('quote-box').classList.toggle('hidden', !quote && notices.length === 0);
  $('quote-notices').replaceChildren(...notices.map((n) => el('div', { class: 'notice-warn', 'data-notice': n.id }, el('p', { text: n.text }))));
  $('quote-lines').replaceChildren(...(quote?.lines ?? []).map((l) => el('li', { class: 'row' },
    el('span', { text: l.title }), el('b', { text: rubKop(l.kop) }))));
  $('quote-total').textContent = quote ? `Итого по таблице цен: ${rubKop(quote.total_kop)}` : '';
  $('quote-note').textContent = !quote ? 'Стоимость появится, когда будут указаны документы и страницы.'
    : `Предварительно. Окончательную цену назначит диспетчер.${quote.transit_kop ? ` Тарифы нотариуса и доставка (${rubKop(quote.transit_kop)}) — без наценки платформы.` : ''}`;
}

// Условия заказа (2а.8): главные пункты оферты модуля; пока юрист не проверил — пометка «черновик».
function renderTerms() {
  const offer = current.terms ?? null;
  $('terms-box').classList.toggle('hidden', !offer);
  if (!offer) return;
  const items = (list) => list.map((p) => el('li', { 'data-point': p.id, text: p.text }));
  $('terms-draft').classList.toggle('hidden', !offer.draft);
  $('terms-customer').replaceChildren(...items(offer.customer));
  $('terms-executor-title').classList.toggle('hidden', offer.executor.length === 0);
  $('terms-executor').replaceChildren(...items(offer.executor));
  const [y, m, d] = offer.version.split('-');
  $('terms-version').textContent = `Редакция от ${d}.${m}.${y}`;
}

// ——— Данные заявки: форма ———

function renderForm() {
  const { order } = current;
  serviceOptions($('d-service'));
  if (order.module) $('d-service').value = `${order.module}/${order.service}`;
  else $('d-service').value = '';
  $('d-title').value = order.title;
  renderFields(order.fields);
  $('d-deadline').value = order.deadline || '';
  showDeadlineOff();
  $('d-express').checked = !!order.express;
  toggleExpress();
  const def = selectedDef();
  const basis = def?.module.basis ?? state.catalog.modules[0].basis;
  $('d-basis').replaceChildren(...basis.map((b) => el('option', { value: b.id, text: b.name })));
  $('d-basis').value = order.basis_kind;
  $('d-basis-number').value = order.basis_number || '';
  $('d-basis-date').value = order.basis_date || '';
  toggleCourt();
}

function selectedDef() {
  const [m, s] = ($('d-service').value || '').split('/');
  return serviceDef(m, s);
}

function renderFields(values) {
  const def = selectedDef();
  const box = $('d-fields');
  if (!def) { box.replaceChildren(); return; }
  box.replaceChildren(...def.service.fields.map((f) => {
    const id = `f-${f.id}`;
    let input;
    if (f.type === 'select') {
      input = el('select', { id, 'data-field': f.id },
        el('option', { value: '', text: '— выберите —' }),
        ...f.options.map((o) => el('option', { value: o.id, text: o.name })));
    } else if (f.type === 'longtext') {
      input = el('textarea', { id, 'data-field': f.id, maxlength: String(f.max ?? 2000) });
    } else if (f.type === 'number') {
      input = el('input', { id, 'data-field': f.id, type: 'text', inputmode: f.integer ? 'numeric' : 'decimal' });
    } else {
      input = el('input', { id, 'data-field': f.id, type: 'text', maxlength: String(f.max ?? 300) });
    }
    const v = values?.[f.id];
    input.value = v === undefined || v === null ? '' : String(v);
    return el('div', { class: 'field' },
      el('label', { for: id, text: f.required ? `${f.label} *` : f.label }),
      input,
      ...(f.hint ? [el('p', { class: 'muted', text: f.hint })] : []));
  }));
}

function formValues() {
  const out = {};
  for (const node of $('d-fields').querySelectorAll('[data-field]')) out[node.dataset.field] = node.value;
  return out;
}

// Срок в выходной или праздник (2.396): «4 ноября — День народного единства, нерабочий день: эксперт сдаст до 3 ноября»
// и одной кнопкой — на последний рабочий день перед ним (не раньше сегодня). Нерабочие дни и сегодня по Москве — из /api/catalog.
const minusDay = (iso) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
function showDeadlineOff() {
  const off = state.catalog?.off_days ?? {};
  const v = $('d-deadline').value;
  const name = v ? off[v] : null;
  let before = null;
  if (name) {
    let d = minusDay(v);
    while (off[d]) d = minusDay(d);
    before = d >= (state.catalog.today ?? '') ? d : null;
  }
  $('d-deadline-off').classList.toggle('hidden', !name);
  $('d-deadline-off').textContent = name ? `${dayRu(v)} — ${name}, нерабочий день${before ? `: эксперт сдаст до ${dayRu(before)}` : ''}` : '';
  $('d-deadline-workday').classList.toggle('hidden', !before);
  $('d-deadline-workday').textContent = before ? `Поставить срок ${dayRu(before)}` : '';
  $('d-deadline-workday').dataset.day = before ?? '';
}
$('d-deadline').addEventListener('input', showDeadlineOff);
$('d-deadline').addEventListener('change', showDeadlineOff);
$('d-deadline-workday').addEventListener('click', () => {
  $('d-deadline').value = $('d-deadline-workday').dataset.day;
  showDeadlineOff();
  $('d-deadline').focus();
});

// Экспресс (2.4) — только для услуг, где он есть в описании модуля.
function toggleExpress() {
  $('express-box').classList.toggle('hidden', !selectedDef()?.service.express);
}

function toggleCourt() {
  const def = selectedDef();
  const kind = (def?.module.basis ?? []).find((b) => b.id === $('d-basis').value);
  $('court-box').classList.toggle('hidden', !kind?.details);
}

async function saveForm() {
  const [module, service] = ($('d-service').value || '').split('/');
  const body = {
    module, service,
    title: $('d-title').value,
    fields: formValues(),
    deadline: $('d-deadline').value || null,
    basis_kind: $('d-basis').value,
    express: !$('express-box').classList.contains('hidden') && $('d-express').checked,
  };
  if (!$('court-box').classList.contains('hidden')) {
    body.basis_number = $('d-basis-number').value;
    body.basis_date = $('d-basis-date').value || null;
  }
  const { order } = await api('PATCH', `/api/orders/${current.order.id}`, body);
  current.order = { ...current.order, ...order };
  return order;
}

// Чего не хватает для отправки черновика (2.41) — после сохранения и после файлов: «Что дальше» у заказчика.
async function refreshMissing() {
  if (!current?.editable) return;
  const fresh = await api('GET', `/api/orders/${current.order.id}`);
  current.submit_missing = fresh.submit_missing;
  current.quote = fresh.quote;
  current.notices = fresh.notices;
  renderQuote();
  setNext({});
}

$('d-service').addEventListener('change', () => {
  renderFields(formValues());
  toggleExpress();
  const def = selectedDef();
  if (def) $('d-basis').replaceChildren(...def.module.basis.map((b) => el('option', { value: b.id, text: b.name })));
  toggleCourt();
});
$('d-basis').addEventListener('change', toggleCourt);

$('details-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('save-details').disabled = true;
  try {
    await saveForm();
    render();
    await refreshMissing();
    say($('details-msg'), 'Сохранено', 'ok');
  } catch (err) { say($('details-msg'), err.message); } finally { $('save-details').disabled = false; }
});

// ——— Данные заявки: просмотр ———

function renderFacts() {
  const { order } = current;
  const def = serviceDef(order.module, order.service);
  const pairs = [['Услуга', order.service_name || '—']];
  for (const f of def?.service.fields ?? []) {
    const v = order.fields?.[f.id];
    if (v === undefined || v === null || v === '') continue;
    // Числа — по-русски: «54,3», «120 000»; год — без пробела (2.41).
    const shown = f.type === 'select' ? (f.options.find((o) => o.id === v)?.name ?? v)
      : f.type === 'number' && Number.isFinite(Number(v)) ? Number(v).toLocaleString('ru-RU', { useGrouping: Math.abs(Number(v)) >= 10000 }) : String(v);
    pairs.push([f.label, shown]);
  }
  pairs.push(['Срок', order.deadline ? dayRu(order.deadline) : '—']);
  if (order.express) pairs.push(['Формат', 'Экспресс: выезд помощника, эксперт работает дистанционно']);
  let basis = order.basis_name || '—';
  if (order.basis_number) basis += `, № ${order.basis_number}`;
  if (order.basis_date) basis += ` от ${dayRu(order.basis_date)}`;
  pairs.push(['Основание', basis]);
  $('facts').replaceChildren(...pairs.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
}

// ——— Ход заявки ———

// Шаги и история свёрнуты в одну строку (2.72); раскрытые остаются раскрытыми, пока открыто то же дело.
let foldedFor = null;

function renderProgress() {
  const { order, actions, history } = current;
  const flow = state.catalog.statuses.filter((s) => s.id !== 'cancelled');
  const at = flow.findIndex((s) => s.id === order.status);
  if (foldedFor !== order.id) {
    foldedFor = order.id;
    $('steps-details').open = false;
    $('history-details').open = false;
  }
  $('steps-summary').textContent = order.status === 'cancelled' ? 'Заявка отменена · все шаги'
    : `Шаг ${at + 1} из ${flow.length}: ${flow[at]?.name || order.status} · все шаги`;
  $('steps').replaceChildren(...(order.status === 'cancelled'
    ? [el('li', { class: 'current', text: 'Заявка отменена' })]
    : flow.map((s, i) => el('li', { class: i < at ? 'done' : i === at ? 'current' : '', text: s.name }))));

  // Замечания к сданному отчёту (2.431) — своей формой, не полем «Причина».
  $('reason-box').classList.toggle('hidden', !actions.some((a) => a.reason && !a.remarks));
  // Отмена после начала работ (диспетчер): по чьей причине и какая часть работы сделана — от этого зависит возврат.
  // Исполнителю уже выплачено (переделка или выданный перевод, 2а.11) — вместо «по чьей причине» диспетчер указывает, чем
  // проверка признала результат: плохим (удержание у исполнителя) или нормальным (возврат за счёт платформы).
  const lateCancel = (WORK_STARTED.includes(order.status) || current.after_payout) && actions.some((a) => a.to === 'cancelled');
  $('cancel-box').classList.toggle('hidden', !lateCancel);
  $('cancel-quality-box').classList.toggle('hidden', !current.after_payout);
  $('cancel-fault-box').classList.toggle('hidden', !!current.after_payout);
  if (lateCancel) syncCancelBox();
  // Правило возврата модуля (2а.7): у перевода — только за качество.
  $('cancel-note').textContent = current.cancel_note || '';
  $('cancel-note').classList.toggle('hidden', !lateCancel || !current.cancel_note);
  $('actions').replaceChildren(...actions.map((a) => el('button', {
    class: a.to === 'cancelled' ? 'danger' : a.to === 'matching' && order.status === 'new' ? 'wide' : 'secondary',
    'data-to': a.to,
    onclick: () => (a.remarks ? openRemarks() : doStep(a)),
  }, a.name)));
  const remarksAction = actions.find((a) => a.remarks) ?? null;
  if (remarksAction && current.remarks_days) $('remarks-lead').textContent = `Банк или суд прислал замечания — опишите их и приложите файл: дело снова у эксперта, ответ — за ${current.remarks_days} ${current.remarks_days === 1 ? 'рабочий день' : current.remarks_days < 5 ? 'рабочих дня' : 'рабочих дней'}.`;
  renderRemarks(current, { action: remarksAction, upload: (file, msg) => uploadFile(file, 'other', msg), download, reload: () => openOrder(order.id) });

  const last = history[history.length - 1];
  $('history-details').classList.toggle('hidden', !last);
  $('history-summary').textContent = last
    ? `История: ${history.length} · последнее — ${last.to_name}, ${new Date(last.at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : '';
  $('history').replaceChildren(...history.slice().reverse().map((h) => el('li', {},
    el('div', { class: 'title', text: h.to_name }),
    el('div', { class: 'muted', text: [dateTimeRu(h.at), { dispatcher: 'диспетчер', executor: 'исполнитель' }[h.side] || 'заказчик'].join(' · ') }),
    ...(h.reason ? [el('div', { text: `Причина: ${h.reason}` })] : []))));
}

function syncCancelBox() {
  $('done-percent-box').classList.toggle('hidden', !!current?.after_payout || $('cancel-fault').value !== 'customer');
}
$('cancel-fault').addEventListener('change', syncCancelBox);

async function doStep(a) {
  const reason = $('reason').value.trim();
  if (a.reason && !reason) return say($('status-msg'), 'Укажите причину');
  const extra = {};
  if (a.to === 'cancelled' && current.after_payout) {
    extra.quality = $('cancel-quality').value;
    if (!extra.quality) return say($('status-msg'), 'Укажите, чем проверка признала результат');
  } else if (a.to === 'cancelled' && WORK_STARTED.includes(current.order.status)) {
    extra.fault = $('cancel-fault').value;
    if (!extra.fault) return say($('status-msg'), 'Укажите, по чьей причине отмена');
    if (extra.fault === 'customer') {
      const v = $('done-percent').value.trim();
      if (!/^\d{1,3}$/.test(v) || Number(v) > 100) return say($('status-msg'), 'Укажите, какая часть работы сделана: от 0 до 100%');
      extra.done_percent = Number(v);
    }
  }
  if (a.to === 'cancelled' && !confirm('Отменить заявку?')) return;
  const buttons = [...$('actions').querySelectorAll('button')];
  buttons.forEach((b) => { b.disabled = true; });
  let saved = false;
  try {
    // «Отправить» сначала сохраняет то, что заполнено на экране.
    if (a.to === 'matching' && current.editable) { await saveForm(); saved = true; }
    await api('POST', `/api/orders/${current.order.id}/status`, { from: current.order.status, to: a.to, reason: reason || undefined, ...extra });
    await openOrder(current.order.id);
    say($('status-msg'), a.to === 'matching' && current.order.status === 'matching' ? 'Заявка отправлена' : 'Статус изменён', 'ok');
  } catch (err) {
    // Данные сохранились, а отправить не вышло — шапка (срок и т. п.) должна показать сохранённое.
    if (saved) render();
    say($('status-msg'), err.message);
    [...$('actions').querySelectorAll('button')].forEach((b) => { b.disabled = false; });
  }
}

// ——— Кто ведёт дело: руководитель и старший передают дело другому участнику организации ———

async function loadTransfer() {
  const box = $('transfer-box');
  box.classList.toggle('hidden', current.access !== 'manage');
  if (current.access !== 'manage') return;
  const { members } = await api('GET', `/api/orgs/${current.order.org_id}/members`);
  $('transfer-to').replaceChildren(...members.map((m) => el('option', {
    value: m.user_id,
    text: [m.full_name || (m.phone ? formatPhone(m.phone) : 'Без имени'), ROLE_RU[m.role].toLowerCase(), m.orders !== undefined ? `дел ${m.orders}` : null].filter(Boolean).join(' · '),
  })));
  $('transfer-to').value = current.order.owner_user_id;
}

$('transfer-box').addEventListener('submit', async (e) => {
  e.preventDefault();
  const userId = $('transfer-to').value;
  if (userId === current.order.owner_user_id) return say($('transfer-msg'), 'Дело уже ведёт этот сотрудник');
  $('transfer').disabled = true;
  try {
    const { order } = await api('PATCH', `/api/orders/${current.order.id}/responsible`, { user_id: userId });
    current.order = { ...current.order, ...order };
    renderOrgLine();
    say($('transfer-msg'), 'Дело передано', 'ok');
  } catch (err) { say($('transfer-msg'), err.message); } finally { $('transfer').disabled = false; }
});

// ——— Документы ———

async function loadDocs(initial = false) {
  const { order, access } = current;
  const canChange = access !== 'read' && !FINAL.includes(order.status);
  const documentsBody = await api('GET', `/api/orders/${order.id}/documents`);
  const { documents, results_hidden: resultsHidden } = documentsBody;
  const mineResults = current.executor?.is_me && order.status === 'in_work';
  const signRequired = !!documentsBody.signature_required;
  $('result-sign-note').classList.toggle('hidden', !signRequired);
  if (documentsBody.sign_mode === 'manual') $('result-sign-note').textContent = 'Перед сдачей подпишите каждый файл результата своей КЭП (КриптоПро, программа удостоверяющего центра, «Госключ») и загрузите файл подписи .sig у файла. Платформа проверит подпись на Госуслугах. Если Вы работаете от организации, файл подписывает ещё её руководитель.';
  lastDocs = documentsBody;
  // Файлы результата поменялись — у «Хода заказа» новый список для «файла нотариуса» (2а.6).
  if (!initial && current.executor?.is_me && !$('steps-box').classList.contains('hidden')) loadSteps(current);
  orgReturnsNow = documentsBody.org_returns ?? []; // окно подписи файла (2.159) показывает пункты замечаний
  // Вопрос «исправленная версия?» (2.251) больше не к месту — возвращённый файл удалили или замечание закрыто.
  if (replacePair && !(documentsBody.org_returns ?? []).some((r) => r.open && r.id === replacePair.r.id && documents.some((x) => x.id === r.document_id))) {
    replacePair = null;
    $('replace-box').classList.add('hidden');
  }
  // «Подписать все» (2.15): несколько неподписанных файлов результата — одним подтверждением.
  const unsigned = mineResults && signRequired && documentsBody.sign_mode !== 'manual' ? documents.filter((d) => d.kind === 'result' && d.own !== false && !d.signatures?.expert) : [];
  $('sign-all').classList.toggle('hidden', unsigned.length < 2);
  $('sign-all').textContent = `Подписать все файлы результата (${unsigned.length})`;
  const docLi = (d) => {
    // Результат убирает только исполнитель, пока не сдал; документы заказчика — заказчик (основание — до отправки).
    // Фото дистанционного осмотра не удаляются никем: это свидетельство осмотра со временем и местом (2.3).
    const removable = d.kind === 'inspection' ? false
      : d.kind === 'result' ? mineResults && !d.prior_edition : canChange && !(d.kind === 'basis' && order.status !== 'new');
    return el('li', { class: 'doc', 'data-doc': String(d.id) },
      el('div', {},
        el('div', { class: 'name', text: d.filename }),
        el('div', { class: 'muted', text: [DOC_KIND_RU[d.kind], d.step_file, formatSize(d.size_bytes)].filter(Boolean).join(' · ') }),
        // После передачи дела (2.110): файл прежнего эксперта остаётся в деле, но в сдачу не идёт — подписывает и сдаёт свой.
        ...(d.kind === 'result' && d.own === false ? [el('div', { class: 'muted', 'data-role': 'former', text: 'Файл прежнего эксперта — в сдачу не идёт. Загрузите свой файл результата.' })] : []),
        // Исправленный отчёт после замечаний (2.434): прежняя редакция остаётся в деле, новая — рядом, с тем же номером.
        ...(d.prior_edition ? [el('div', { class: 'muted', 'data-role': 'prior-edition', text: `Прежняя редакция — сдана до замечаний от ${d.prior_edition.split('-').reverse().join('.')}. Остаётся в деле.` })] : [])),
      el('div', { class: 'row' },
        el('button', { class: 'secondary', 'data-action': 'download', onclick: () => download(d) }, 'Скачать'),
        ...(removable ? [el('button', { class: 'danger', 'data-action': 'delete', onclick: () => remove(d) }, 'Удалить')] : [])),
      ...(d.kind === 'result' ? signatureBlock(d, { canSign: mineResults && signRequired && d.own !== false, signOrg: documentsBody.signature_org, manual: documentsBody.sign_mode === 'manual', canCheck: !!documentsBody.can_check_signature, checkUrl: documentsBody.signature_check_url }) : []),
      ...(d.kind === 'result' ? certificateBlock(d) : []));
  };
  // Много фото осмотра (2.49: бывает 100) — одной свёрнутой строкой, чтобы документы и результат не терялись внизу.
  const photos = documents.filter((d) => d.kind === 'inspection');
  const fold = photos.length > PHOTOS_UNFOLDED;
  $('docs').replaceChildren(...documents.filter((d) => !fold || d.kind !== 'inspection').map(docLi),
    ...(fold ? [el('li', { class: 'doc-group', 'data-group': 'inspection' },
      el('details', {},
        el('summary', { text: `Фото осмотра: ${photos.length} — показать` }),
        el('ul', { class: 'list' }, ...photos.map(docLi))))] : []));
  $('docs-empty').classList.toggle('hidden', documents.length > 0);
  $('results-later').textContent = 'Результат работы появится здесь после проверки.';
  $('results-later').classList.toggle('hidden', !(resultsHidden && ['in_work', 'review'].includes(order.status)));
  renderResultDue(documentsBody.result_due ?? null);
  renderDossierTerm(documentsBody.dossier_term ?? null);
  renderOrgReturns(documentsBody.org_returns ?? []);
  renderSignWait(documentsBody.sign_wait ?? null, documentsBody.signature_org);
  setNext({ docs: documentsBody });
  if (!initial) await refreshMissing(); // приложили определение суда — «Что дальше» знает сразу
  const basis = documents.filter((d) => d.kind === 'basis');
  $('basis-file-state').textContent = basis.length ? `Приложено: ${basis.map((d) => d.filename).join(', ')}` : 'Файл определения ещё не приложен';
}

// Срок через 1–2 дня или прошёл, а своего файла результата нет (2.138): предупреждение исполнителю над документами —
// загрузить файл, собрать отчёт из черновика или попросить перенести срок (если просить можно).
function renderResultDue(due) {
  $('result-due-box').classList.toggle('hidden', !due);
  if (!due) return;
  const n = due.days_left;
  const when = due.overdue ? `Срок прошёл (${dayRu(due.deadline)})` : n === 0 ? 'Срок сегодня' : n === 1 ? 'Срок завтра' : `Срок ${dayRu(due.deadline)} — через ${n} дн.`;
  // Просить перенос нельзя (уже попросили — 2.140) — и в тексте не предлагаем.
  const canExtend = !$('deadline-form').classList.contains('hidden');
  $('result-due-text').textContent = `${when}, а файла результата ещё нет. ${due.has_draft
    ? 'Черновик есть — соберите из него отчёт Word и загрузите файл.'
    : canExtend ? 'Загрузите файл результата или попросите перенести срок.' : 'Загрузите файл результата.'}`;
  $('result-due-draft').classList.toggle('hidden', !due.has_draft || $('draft-box').classList.contains('hidden'));
  $('result-due-extend').classList.toggle('hidden', !canExtend);
}
document.addEventListener('deadline-changed', () => { if (!$('result-due-box').classList.contains('hidden')) renderResultDue(lastDocs?.result_due ?? null); });
// Аттестат или полис из досье кончаются раньше срока дела (2.365): отчёт надо составить и подписать, пока они действуют.
function renderDossierTerm(term) {
  $('dossier-term-box').classList.toggle('hidden', !term);
  if (!term) return $('dossier-term-items').replaceChildren();
  const expired = term.items.some((i) => i.expired);
  $('dossier-term-text').textContent = expired
    ? `Срок документа в досье истёк, а дело — до ${dayRu(term.deadline)}. Обновите документ в досье до подписи отчёта: в отчёте должны быть действующие аттестат и полис.`
    : `Документ из досье кончается раньше срока дела (${dayRu(term.deadline)}). Составьте и подпишите отчёт, пока он действует, или обновите его в досье.`;
  $('dossier-term-items').replaceChildren(...term.items.map((i) => el('li', { 'data-kind': i.kind,
    text: `${i.kind_name} — ${i.expired ? 'срок истёк' : 'действует до'} ${dayRu(i.valid_until)}` })));
}
$('dossier-term-open').addEventListener('click', () => { location.hash = 'specialist&to=dossier'; });

const goTo = (id) => { reveal(id); $(id).scrollIntoView({ behavior: 'smooth', block: 'start' }); };
$('result-due-upload').addEventListener('click', () => { reveal('result-upload-box'); $('result-file').click(); });
$('result-due-draft').addEventListener('click', () => goTo('draft-box'));
$('result-due-extend').addEventListener('click', () => goTo('deadline-box'));

// Внутренняя переписка с руководителем организации (2.28) — только самому исполнителю, если он работает от организации.
function loadOrgChat() {
  const org = current.org_chat;
  $('org-chat-box').classList.toggle('hidden', !org);
  if (!org) return $('org-chat').replaceChildren();
  $('org-chat-lead').textContent = `Видите только Вы и руководитель организации ${quoted(org)}. Заказчик и диспетчер эту переписку не видят.`;
  orgChat($('org-chat'), current.order.id);
}

// Замечания руководителя организации (2.27): возвраты файла до подписи организации — видит только сам исполнитель.
// Открытые — сверху; закрытые (файл подписан заново) — ниже, как история. Замечание по пунктам (2.93): эксперт отмечает
// исправленные, руководитель видит, что осталось.
let orgReturnsNow = [];
let replacePair = null; // вопрос «исправленная версия?» после загрузки (2.251)
function renderOrgReturns(list) {
  orgReturnsNow = list;
  $('org-returns-box').classList.toggle('hidden', !list.length);
  if (!list.length) return;
  const open = list.filter((r) => r.open);
  $('org-returns-lead').textContent = open.length
    ? 'Руководитель вернул файл с замечанием: исправьте файл (или удалите его и загрузите исправленный), отметьте исправленные пункты и подпишите заново — руководитель увидит, что осталось, и подпишет от организации.'
    : 'Все замечания учтены. История возвратов:';
  const item = (r) => el('li', { class: r.open ? 'return open' : 'return', 'data-return': String(r.id) },
    el('div', { class: 'title', text: `${r.filename} · ${r.open ? 'исправить' : 'исправлено'}` }),
    el('div', { class: 'muted', text: [r.by, r.org, new Date(r.at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' })].filter(Boolean).join(' · ') }),
    ...returnFileState(r), ...returnAiState(r),
    ...(r.items?.length ? returnPoints(r) : [el('div', { class: 'comment', text: r.comment })]));
  $('org-returns').replaceChildren(...[...open].reverse().map(item), ...list.filter((r) => !r.open).reverse().map(item));
}

// Возвращённый файл удалён (2.163): виден ли уже исправленный — загружен после возврата и ждёт подписи эксперта — или его ещё
// нет. «К подписи» ведёт к этому файлу в «Документах».
function returnFileState(r) {
  const docs = lastDocs?.documents ?? [];
  if (!r.open) return [];
  if (docs.some((x) => x.id === r.document_id)) return besideReturned(r, docs);
  const fresh = freshAfter(r);
  if (!fresh.length) return [el('div', { class: 'return-file warn', 'data-role': 'return-file', text: 'Возвращённый файл удалён — загрузите исправленный файл и подпишите его.' })];
  const d = fresh.at(-1);
  return [el('div', { class: 'return-file ok', 'data-role': 'return-file' },
    el('span', { text: `Исправленный файл «${d.filename}» загружен ${new Date(d.created_at).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })} — ждёт Вашей подписи${fresh.length > 1 ? ` (новых файлов: ${fresh.length})` : ''}. ` }),
    el('button', { class: 'link', 'data-action': 'to-return-file', onclick: () => toDoc(d.id) }, 'К подписи'))];
}

// Возвращённый файл не удалён, а рядом после возврата загружен другой (найдено прогоном 2.250): новым файлом замечание не
// закроется — закрывает его новая подпись возвращённого файла или подпись новой версии, когда возвращённый удалён (2.159; рядом
// может лежать приложение). Подсказка — что сделать в каждом случае, кнопка ведёт к возвращённому файлу.
function besideReturned(r, docs) {
  const d = docs.filter((x) => x.kind === 'result' && x.own !== false && x.id !== r.document_id && Date.parse(x.created_at) > Date.parse(r.at)).at(-1);
  if (!d) return [];
  return [el('div', { class: 'return-file warn', 'data-role': 'return-beside' },
    el('span', { text: `После возврата загружен «${d.filename}», а возвращённый «${r.filename}» не удалён — замечание пока открыто. Если «${d.filename}» — исправленная версия, удалите «${r.filename}» и подпишите новый файл: тогда руководитель увидит у него Ваши отметки. Если это приложение — подпишите заново «${r.filename}». ` }),
    el('button', { class: 'link', 'data-action': 'to-returned-file', onclick: () => toDoc(r.document_id) }, 'К возвращённому файлу'),
    // Тот же вопрос, что сразу после загрузки (2.251): ответили «Нет» или обновили страницу — заменить можно и отсюда.
    ...(current.executor?.is_me && current.order.status === 'in_work' ? [' · ', el('button', { class: 'link', 'data-action': 'replace-returned',
      onclick: () => { if (confirm(`Удалить «${r.filename}» — «${d.filename}» его исправленная версия?`)) replaceReturned({ doc: d, r }); } }, `Заменить «${r.filename}» на «${d.filename}»`)] : []))];
}

// Исправленный файл после возврата (2.192): проверял ли его ИИ. Не запускали или есть «посмотрите» — подсказка с переходом к
// ИИ-проверке; проверено без замечаний — так и сказано. Подписать можно и без проверки (как у подписи — 2.136).
function returnAiState(r) {
  if (!r.open) return [];
  const d = freshAfter(r).at(-1);
  if (!d) return [];
  const c = d.ai_check;
  if (!c) return [el('div', { class: 'return-ai ok', 'data-role': 'return-ai', 'data-ai': 'ok', text: `ИИ-проверка исправленного файла «${d.filename}»: замечаний нет.` })];
  const text = c.state === 'none'
    ? `Исправленный файл «${d.filename}» ИИ ещё не проверял — запустите ИИ-проверку этой версии перед подписью. `
    : `В ИИ-проверке исправленного файла «${d.filename}» стоит посмотреть: ${c.count} (${c.titles.join('; ')}${c.count > c.titles.length ? '; …' : ''}). `;
  return [el('div', { class: 'return-ai warn', 'data-role': 'return-ai', 'data-ai': c.state, text },
    el('button', { class: 'link', 'data-action': 'return-to-ai', onclick: toAiReview }, 'К ИИ-проверке'))];
}

// Свои неподписанные файлы результата, загруженные после возврата, — исправленные версии.
const freshAfter = (r) => (lastDocs?.documents ?? []).filter((x) => x.kind === 'result' && x.own !== false && !x.signatures?.expert
  && Date.parse(x.created_at) > Date.parse(r.at));

function toDoc(id) {
  const li = document.querySelector(`#docs li.doc[data-doc="${id}"]`);
  if (!li) return;
  reveal('docs-box');
  li.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function returnPoints(r) {
  const done = r.items.length - r.left;
  const point = (p) => {
    const id = `ret-${r.id}-${p.n}`;
    if (!r.open) {
      return el('li', { class: p.fixed ? 'point fixed' : 'point', 'data-point': String(p.n) },
        el('span', { text: `${p.n}. ${p.text}` }), el('span', { class: 'muted', text: p.fixed ? ' — исправлено' : ' — не отмечено' }));
    }
    const box = el('input', { type: 'checkbox', id, 'data-action': 'point-fixed' });
    box.checked = p.fixed;
    box.addEventListener('change', () => markPoint(r, p, box));
    return el('li', { class: p.fixed ? 'point fixed' : 'point', 'data-point': String(p.n) },
      el('label', { for: id, class: 'row gap' }, box, el('span', { text: `${p.n}. ${p.text}` })), ...pointSwap(p));
  };
  return [el('div', { class: 'muted', 'data-role': 'points-left', text: `Исправлено ${done} из ${r.items.length}` }),
    el('ul', { class: 'points' }, ...r.items.map(point))];
}

// 2.262: пункт из расхождения с выпиской ЕГРН (2.236) — «Заменить по выписке» прямо в замечании: та же замена в черновике,
// что «Заменить на значение из выписки» в ИИ-проверке (2.232); заменено — напоминание собрать Word и отметить пункт.
// Кнопка — пока черновик правится и та же находка есть в ИИ-проверке.
function pointSwap(p) {
  if (p.fix?.date && !p.fixed) return pointMade(p.fix.date);
  if (p.fix && !p.fixed) return pointTaskSwap(p);
  if (!p.egrn || p.fixed) return [];
  const st = egrnSwapFor(p.egrn);
  if (!st) return [];
  if (st.state === 'done') return [el('div', { class: 'point-swap ok', 'data-role': 'point-swap-done', text: `Заменено в черновике: «${st.was}» → «${st.now}», как в выписке ЕГРН. Соберите Word заново, загрузите исправленный файл и отметьте пункт.` })];
  if (st.state === 'missing') return [el('div', { class: 'point-swap muted', 'data-role': 'point-swap-miss', text: `В тексте черновика «${st.was}» нет — исправьте в файле отчёта (в выписке: ${st.now}).` })];
  const btn = el('button', { class: 'secondary', type: 'button', 'data-action': 'point-egrn-swap', onclick: () => { btn.disabled = true; st.swap(); } }, 'Заменить по выписке');
  return [el('div', { class: 'point-swap', 'data-role': 'point-swap' },
    el('span', { class: 'muted', text: `В черновике «${st.was}» — в выписке ЕГРН «${st.now}». ` }), btn)];
}
// 2.285: пункт «… — исправьте, как в задании на оценку» (2.269) — «Заменить на значение из задания» прямо в замечании: та
// же замена, что у находки в ИИ-проверке (2.274, 2.277, 2.278); пользователь результатов оценки — и по заявке (2.312, 2.313).
function pointTaskSwap(p) {
  const st = taskSwapFor(p.fix);
  if (!st) return [];
  if (st.state === 'done') return [el('div', { class: 'point-swap ok', 'data-role': 'point-swap-done', text: `Заменено в черновике: «${st.was}» → «${st.now}», как ${st.from}. Соберите Word заново, загрузите исправленный файл и отметьте пункт.` })];
  if (st.state === 'missing') return [el('div', { class: 'point-swap muted', 'data-role': 'point-swap-miss', text: `В тексте черновика «${st.was}» нет — исправьте в файле отчёта (${st.from}: ${st.now}).` })];
  const btn = el('button', { class: 'secondary', type: 'button', 'data-action': 'point-task-swap', onclick: () => { btn.disabled = true; st.swap(); } }, `Заменить на значение ${st.src}`);
  return [el('div', { class: 'point-swap', 'data-role': 'point-swap' },
    el('span', { class: 'muted', text: `В черновике «${st.was}» — ${st.from} «${st.now}». ` }), btn)];
}
// 2.322: пункт «дата составления позже срока из задания на оценку» (раньше даты задания) — заменить нечем: «К месту в
// черновике» выделяет дату в строке «Дата составления»; такой строки нет — в Word дата составления — день сборки.
const todayRu = () => new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric' });
const dayNum = (d) => d.split('.').reverse().join('');
function pointMade(date) {
  if (!canFixInDraft()) return [];
  // 2.345: срок из письма о переносе срока — так и назван; совет — попросить письмо с новым сроком (письмо уже в деле).
  const rule = date.letter ? `срок по письму о переносе — не позднее ${date.edge}`
    : date.late ? `срок по заданию на оценку — не позднее ${date.edge}` : `задание на оценку от ${date.edge}`;
  const moveTip = date.letter ? 'попросите у заказчика письмо с новым сроком' : 'приложите к делу документ о переносе срока';
  const miss = el('div', { class: 'point-swap muted hidden', 'data-role': 'point-made-miss' });
  const btn = el('button', { class: 'secondary', type: 'button', 'data-action': 'point-made', onclick: () => {
    const ok = madeInDraft(date, (v) => `Выделено «${v}» — ${rule}. Исправьте дату составления и сохраните черновик, затем соберите Word заново${date.late ? ` (или ${moveTip})` : ''}.`);
    miss.classList.toggle('hidden', ok);
    if (ok) return;
    const today = todayRu();
    const fits = date.late ? dayNum(today) <= dayNum(date.edge) : dayNum(today) >= dayNum(date.edge);
    miss.textContent = `В тексте черновика строки «Дата составления» нет: в Word дата составления — день сборки. `
      + (fits ? `Соберите Word заново — дата составления будет ${today}, загрузите исправленный файл и отметьте пункт.`
        : `Срок ${date.letter ? 'по письму о переносе' : 'по заданию'} (${date.edge}) прошёл — ${moveTip} или исправьте дату в файле отчёта.`);
  } }, 'К месту в черновике');
  return [el('div', { class: 'point-swap', 'data-role': 'point-made' },
    el('span', { class: 'muted', text: `В отчёте дата составления ${date.made} — ${rule}. ` }), btn), miss];
}
// ИИ-проверка показана заново (запуск, обновление) — кнопки замены в пунктах замечания по ней.
document.addEventListener('egrn-swaps-ready', () => { if (current && orgReturnsNow.length) renderOrgReturns(orgReturnsNow); });

async function markPoint(r, p, box) {
  box.disabled = true;
  try {
    await api('PUT', `/api/orders/${current.order.id}/org-returns/${r.id}/items/${p.n}`, { fixed: box.checked });
    await loadDocs();
    say($('doc-msg'), box.checked ? `Пункт ${p.n} отмечен исправленным` : `Отметка с пункта ${p.n} снята`, 'ok');
  } catch (err) { box.checked = !box.checked; box.disabled = false; say($('doc-msg'), err.message); }
}

// Напоминание перед подписью (2.136): ИИ-проверку этого файла не запускали или в ней есть пункты «посмотрите». Подсказка —
// подписать можно и без проверки.
function aiCheckText(c) {
  if (!c) return '';
  if (c.state === 'none') return c.other
    ? 'ИИ-проверку этой версии файла не запускали (проверяли другой файл) — перед подписью стоит проверить.'
    : 'ИИ-проверку этого файла не запускали — перед подписью стоит проверить.';
  return `В ИИ-проверке этого файла стоит посмотреть пунктов: ${c.count} (${c.titles.join('; ')}${c.count > c.titles.length ? '; …' : ''}).`;
}

// Открытые возвраты, которые закроет подпись этого файла (2.159): возвращён сам файл или — если возвращённый файл удалён —
// это новая версия, загруженная после возврата.
function returnsForDoc(d) {
  const alive = new Set((lastDocs?.documents ?? []).map((x) => x.id));
  return orgReturnsNow.filter((r) => r.open && (r.document_id === d.id
    || (!alive.has(r.document_id) && Date.parse(d.created_at) > Date.parse(r.at))));
}

// В окне подписи (2.159): пункты замечаний руководителя с отметками «исправлено» — отметить можно здесь же; неотмеченные —
// подсказкой, подписать можно и с ними.
function signReturnPoints(d) {
  return returnsForDoc(d).filter((r) => r.items?.length).map((r) => {
    const point = (p) => {
      const id = `sig-${d.id}-${r.id}-${p.n}`;
      const box = el('input', { type: 'checkbox', id, 'data-action': 'sig-point-fixed' });
      box.checked = p.fixed;
      box.addEventListener('change', () => markPoint(r, p, box));
      return el('li', { class: p.fixed ? 'point fixed' : 'point', 'data-point': String(p.n) },
        // Пометка — в строку за текстом пункта, а не отдельной колонкой справа (найдено прогоном 2.190).
        el('label', { for: id, class: 'row gap' }, box, el('span', { class: 'point-line' }, el('span', { text: `${p.n}. ${p.text}` }),
          el('span', { class: 'muted', text: p.fixed ? ' — исправлено' : ' — не отмечено' }))));
    };
    const done = r.items.length - r.left;
    return el('div', { class: r.left ? 'sig-points warn' : 'sig-points', 'data-sig': 'points', 'data-return': String(r.id) },
      el('div', { 'data-role': 'sig-points-state', text: `Замечание руководителя от ${new Date(r.at).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })}${r.document_id === d.id ? '' : ` к файлу «${r.filename}»`}: исправлено ${done} из ${r.items.length}` }),
      el('ul', { class: 'points' }, ...r.items.map(point)),
      ...(r.left ? [el('div', { class: 'muted', 'data-role': 'sig-points-hint', text: `Не отмечено: ${r.left} (${r.left === 1 ? 'пункт' : 'пункты'} ${r.items.filter((p) => !p.fixed).map((p) => p.n).join(', ')}). Подписать можно и так — руководитель увидит, какие пункты не отмечены.` })] : []));
  });
}

// Перед новой подписью: если в открытых возвратах по файлам остались неотмеченные пункты — напомнить, какие (2.185):
// номер и начало текста каждого пункта; подписать можно и так.
const clip = (t, n = 90) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
function unfixedText(returns) {
  const items = [...new Set(returns)].flatMap((r) => (r.items ?? []).filter((p) => !p.fixed));
  if (!items.length) return '';
  return `Не отмечено исправленными пунктов замечания руководителя: ${items.length}.\n`
    + items.map((p) => `${p.n}. ${clip(p.text)}`).join('\n')
    + '\nРуководитель это увидит. Если исправили — отметьте пункт в окне подписи.\n\n';
}
function signConfirmText(d) {
  const ai = aiCheckText(d.ai_check);
  return unfixedText(returnsForDoc(d)) + (ai ? `${ai}\n\n` : '') + swapConfirmText(d) + orderConfirmText(d) + madeConfirmText(d) + SIGN_CONFIRM(d.filename);
}

// 2.258: в ИИ-проверке этого файла остались расхождения с выпиской ЕГРН, которые можно заменить в черновике одной кнопкой
// («Заменить на значение из выписки», 2.232/2.246). Подсказка в окне подписи: заменить, собрать Word заново, загрузить —
// тогда подписывать; заменили — напоминание собрать Word. Подписать можно и так.
const swapsOf = (d) => d.ai_check?.swap ?? [];
const swapsDone = () => { const st = egrnSwapState(); return !!st && st.left === 0 && st.done > 0; };
const swapsNone = () => { const st = egrnSwapState(); return !!st && st.left === 0 && st.done === 0; };
function swapConfirmText(d) {
  const list = swapsOf(d);
  if (!list.length) return '';
  if (swapsDone()) return 'Расхождения с выпиской ЕГРН заменены в черновике, но этот файл собран до замены — соберите Word заново и загрузите его.\n\n';
  return `Расхождения с выпиской ЕГРН, которые можно заменить в черновике: ${list.length}.\n`
    + list.map((t) => `— ${clip(t)}`).join('\n') + '\nВ файле отчёта они останутся, если подписать его сейчас.\n\n';
}
function signSwapHint(d) {
  const list = swapsOf(d);
  if (!list.length) return [];
  if (swapsDone()) return [el('div', { class: 'sig-swap ok', 'data-sig': 'egrn-swapped', text: 'Расхождения с выпиской ЕГРН заменены в черновике. Этот файл собран до замены — соберите Word заново, загрузите его и подпишите новый файл.' })];
  const n = list.length;
  if (swapsNone()) return [el('div', { class: 'sig-swap warn', 'data-sig': 'egrn-swap-file', text: `В ИИ-проверке остались расхождения с выпиской ЕГРН: ${n}. В тексте черновика этих значений нет — исправьте их в файле отчёта и загрузите его заново. Подписать можно и так.` })];
  const btn = el('button', { class: `secondary${canFixInDraft() ? '' : ' hidden'}`, type: 'button', 'data-action': 'sig-egrn-swap', onclick: () => toSwapAll() },
    n > 1 ? `Заменить всё по выписке (${n})` : 'Заменить по выписке');
  return [el('div', { class: 'sig-swap warn', 'data-sig': 'egrn-swap' },
    el('div', { text: `В ИИ-проверке остались расхождения с выпиской ЕГРН, которые можно заменить в черновике: ${n}.` }),
    el('ul', { class: 'points' }, ...list.slice(0, 3).map((t) => el('li', { text: clip(t, 160) })), ...(n > 3 ? [el('li', { class: 'muted', text: `и ещё ${n - 3}` })] : [])),
    el('div', { class: 'muted', text: 'Замените, соберите Word заново и загрузите исправленный файл — тогда подписывайте. Подписать можно и так.' }),
    el('div', { class: 'row' }, btn))];
}
// 2.279: в ИИ-проверке этого файла остались расхождения с заявкой или заданием на оценку (2.231, 2.269, 2.274–2.278):
// подсказка до подписи — какие (первые три), «исправьте в черновике или в файле, соберите Word заново и загрузите» и
// «К находке» (к ней в ИИ-проверке, там «Исправить в черновике» / «Заменить на значение из задания»). Исправлены в
// черновике — напоминание собрать Word. Подписать можно и так.
const ordersOf = (d) => d.ai_check?.order ?? [];
const ordersDone = () => { const st = orderFixState(); return !!st && st.left === 0 && st.done > 0; };
const orderLine = (x) => clip(x.text, 160);
function orderConfirmText(d) {
  const list = ordersOf(d);
  if (!list.length) return '';
  if (ordersDone()) return 'Расхождения с заявкой и заданием на оценку исправлены в черновике, но этот файл собран до исправления — соберите Word заново и загрузите его.\n\n';
  return `Расхождения с заявкой и заданием на оценку: ${list.length}.\n`
    + list.map((x) => `— ${orderLine(x)}`).join('\n') + '\nВ файле отчёта они останутся, если подписать его сейчас.\n\n';
}
function signOrderHint(d) {
  const list = ordersOf(d);
  if (!list.length) return [];
  if (ordersDone()) return [el('div', { class: 'sig-swap ok', 'data-sig': 'order-fixed', text: 'Расхождения с заявкой и заданием на оценку исправлены в черновике. Этот файл собран до исправления — соберите Word заново, загрузите его и подпишите новый файл.' })];
  const n = list.length;
  const go = el('button', { class: 'secondary', type: 'button', 'data-action': 'sig-order-find', onclick: () => {
    reveal('ai-review-box');
    if (!toOrderFix(list[0].rule)) toAiReview();
  } }, n > 1 ? 'К первой находке' : 'К находке');
  return [el('div', { class: 'sig-swap warn', 'data-sig': 'order-left' },
    el('div', { text: `В ИИ-проверке остались расхождения с заявкой и заданием на оценку: ${n}.` }),
    el('ul', { class: 'points' }, ...list.slice(0, 3).map((x) => el('li', { text: orderLine(x) })), ...(n > 3 ? [el('li', { class: 'muted', text: `и ещё ${n - 3}` })] : [])),
    el('div', { class: 'muted', text: 'Исправьте в черновике или в файле отчёта, соберите Word заново и загрузите исправленный файл — тогда подписывайте. Подписать можно и так.' }),
    el('div', { class: 'row' }, go))];
}
// 2.357: в файле дата составления позже срока по заданию на оценку или по письму о переносе срока (task_made, taskMadeFiles):
// предупреждение до подписи, без ИИ-проверки (как 2.321 в «Сегодня»): «К дате в черновике» и, если срок из письма, — «Попросить
// письмо с новым сроком» (как в «Сроке», 2.335). Подписать можно и так.
const ddmm = (iso) => iso.split('-').reverse().join('.');
const madeEdge = (m) => (m.letter
  ? `срок по письму о переносе — не позднее ${ddmm(m.due.day)}${m.letter.was ? ` (${m.letter.was_letter ? 'по прежнему письму' : 'по заданию'} было ${ddmm(m.letter.was)})` : ''}`
  : `срок ${m.due.by} — не позднее ${ddmm(m.due.day)}`);
function madeTip(m) {
  if (!m.letter) return 'Исправьте дату составления в черновике, соберите Word заново и загрузите файл — или приложите к делу документ о переносе срока.';
  if (m.letter.asked_at) return `Письмо с новым сроком ${m.letter.by_prev ? 'попросил прежний эксперт' : 'Вы попросили'} ${atRu(m.letter.asked_at)} — пока его нет: исправьте дату составления или дождитесь письма.`;
  return `Исправьте дату составления в черновике, соберите Word заново и загрузите файл${m.letter.can_ask ? ' — или попросите у заказчика письмо с новым сроком' : ''}.`;
}
function madeConfirmText(d) {
  const m = d.task_made;
  return m ? `В «${d.filename}» дата составления ${ddmm(m.made.day)} — позже: ${madeEdge(m)}.\n${madeTip(m)}\n\n` : '';
}
function signMadeHint(d) {
  const m = d.task_made;
  if (!m) return [];
  const miss = el('div', { class: 'muted hidden', 'data-role': 'sig-made-miss' });
  const find = canFixInDraft() ? [el('button', { class: 'secondary', type: 'button', 'data-action': 'sig-made-find', onclick: () => {
    reveal('draft-box');
    const ok = madeInDraft({ made: ddmm(m.made.day) }, (v) => `Выделено «${v}» — ${madeEdge(m)}. Исправьте дату составления и сохраните черновик, затем соберите Word заново.`);
    miss.classList.toggle('hidden', ok);
    if (!ok) miss.textContent = 'В тексте черновика строки «Дата составления» нет: в Word дата составления — день сборки. Соберите Word заново или исправьте дату в файле отчёта.';
  } }, 'К дате в черновике')] : [];
  const ask = m.letter?.can_ask ? [el('button', { class: 'secondary', type: 'button', 'data-action': 'sig-made-ask', onclick: (e) => askNewLetter(e.currentTarget) }, 'Попросить письмо с новым сроком')] : [];
  return [el('div', { class: 'sig-swap warn', 'data-sig': m.letter ? 'made-letter' : 'made-task' },
    el('div', { 'data-role': 'sig-made-why', text: `В «${d.filename}» дата составления — ${ddmm(m.made.day)} (стр. ${m.made.page}), а ${madeEdge(m)} («${m.due.name}», стр. ${m.due.page}).` }),
    el('div', { class: 'muted', 'data-role': 'sig-made-tip', text: `${madeTip(m)} Подписать можно и так.` }),
    ...(find.length || ask.length ? [el('div', { class: 'row' }, ...find, ...ask)] : []), miss)];
}
async function askNewLetter(btn) {
  btn.disabled = true;
  try {
    await api('POST', `/api/orders/${current.order.id}/doc-requests`, { task_move: true });
    await loadDocs();
    say($('doc-msg'), 'Заказчику отправлена просьба прислать письмо с новым сроком', 'ok');
  } catch (err) { btn.disabled = false; say($('doc-msg'), err.message); }
}
// Та же замена, что в ИИ-проверке: «Заменить всё по выписке», а если находка одна — её «Заменить на значение из выписки».
function toSwapAll() {
  reveal('ai-review-box');
  const all = document.querySelector('#ai-swap-all:not(.hidden) [data-action="egrn-swap-all"]:not(:disabled)');
  const one = document.querySelector('#review-checks [data-action="egrn-swap"]:not(:disabled):not(.hidden)');
  const btn = all ?? one;
  if (!btn) { toAiReview(); return; }
  btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
  btn.click();
}
document.addEventListener('egrn-swapped', () => { if (current && lastDocs) loadDocs().catch(() => {}); });
// 2.268: «Собрать Word заново» в ИИ-проверке — новый файл результата: список файлов заново и, если открыт возврат
// руководителя, сразу «Это исправленная версия?» (2.251).
document.addEventListener('draft-rebuilt', async (e) => {
  if (!current) return;
  try { await loadDocs(); askReplace(e.detail); } catch { /* список обновится при следующем открытии */ }
});

function toAiReview() {
  if ($('ai-review-box').classList.contains('hidden')) return;
  reveal('ai-review-box');
  $('ai-review-box').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Подписи УКЭП у файла результата (2.5, 2.5а): эксперт и, если он работает от организации, её руководитель. Исполнитель
// подписывает свой файл, пока дело в работе, — в кабинете или загрузив готовую подпись (программа УЦ, «Госключ»).
function signatureBlock(d, { canSign, signOrg, manual = false, canCheck = false, checkUrl = '' }) {
  const { expert, org } = d.signatures ?? {};
  if (!expert && !org && !canSign) return [];
  const lines = [];
  if (expert) lines.push(...signatureLines(expert));
  // Ручная проверка (задача штаба 3f817197-…-81ac): только загрузка своего файла подписи; не подтвердилась — загрузить заново.
  if (manual && canSign && (!expert || expert.manual_check === 'bad')) {
    lines.push(...(expert ? [] : [el('div', { class: 'sig-state', text: 'Не подписан КЭП — без подписи на проверку не сдать' })]),
      ...signReturnPoints(d),
      ...signSwapHint(d),
      ...signOrderHint(d),
      ...signMadeHint(d),
      el('div', { class: 'row' }, ...uploadSignatureButton(d.filename, (file) => uploadSignature(d, file), 'Загрузить файл подписи (.sig)')),
      el('div', { class: 'muted', text: MANUAL_HINT }),
      memo('Как подписать файл КЭП', SIGN_HOWTO, 'sign-howto'));
  } else if (!expert && canSign) {
    lines.push(el('div', { class: 'sig-state', text: 'Не подписан УКЭП — без подписи на проверку не сдать' }),
      ...signReturnPoints(d),
      ...(d.ai_check ? [el('div', { class: 'sig-ai', 'data-sig': `ai-${d.ai_check.state}`, text: `${aiCheckText(d.ai_check)} ` },
        el('button', { class: 'link', 'data-action': 'to-ai-review', onclick: toAiReview }, 'К ИИ-проверке'))] : []),
      ...signSwapHint(d),
      ...signOrderHint(d),
      ...signMadeHint(d),
      el('div', { class: 'row' },
        el('button', { 'data-action': 'sign', onclick: () => signDoc(d) }, 'Подписать'),
        ...uploadSignatureButton(d.filename, (file) => uploadSignature(d, file))),
      el('div', { class: 'muted', text: UPLOAD_HINT }));
  }
  if (org) lines.push(...signatureLines(org));
  else if (signOrg && canSign) lines.push(el('div', { class: 'sig-state', 'data-sig': 'org-wait', text: expert
    ? `Ждёт подписи организации ${quoted(signOrg)} — подписывает руководитель в разделе «Организации»`
    : `После Вашей подписи файл подписывает руководитель организации ${quoted(signOrg)}` }));
  // Сотрудник платформы: подпись ждёт проверки — открыть Госуслуги, сверить файл и подпись и отметить итог.
  if (canCheck) for (const s of [expert, org].filter((x) => x?.manual_check === 'pending')) lines.push(checkBox(d, s, checkUrl));
  // Заказчику с подписанным результатом — как подать его в суд электронно.
  if ((expert || org) && !canSign && !canCheck && current.access !== 'read' && ['done', 'closed'].includes(current.order.status)) {
    lines.push(memo('Как подать отчёт в суд электронно', COURT_HOWTO, 'court-howto'));
  }
  if (expert || org) {
    lines.push(el('div', { class: 'row' },
      el('button', { class: 'secondary', 'data-action': 'signature', onclick: () => downloadSignature(d, 'expert') }, 'Файл подписи'),
      ...(org ? [el('button', { class: 'secondary', 'data-action': 'signature-org', onclick: () => downloadSignature(d, 'org') }, 'Подпись организации')] : []),
      el('button', { class: 'secondary', 'data-action': 'verify', onclick: () => verifyDoc(d) }, 'Проверить подпись')));
  }
  return [el('div', { class: 'sig' }, ...lines)];
}

// Сертификат платформы к переводу без нотариуса (2а.5): номер, ссылка на страницу проверки, лист Word с QR-кодом. Переводчик
// выдаёт его к своему файлу, пока дело в работе; заказчик видит после проверки — вместе с файлом.
function certificateBlock(d) {
  const c = d.certificate;
  if (c) {
    const when = new Date(c.issued_at).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
    if (c.revoked) return [el('div', { class: 'sig', 'data-role': 'certificate' }, el('div', { class: 'sig-state warn', text: `Сертификат № ${c.number} отозван` }))];
    return [el('div', { class: 'sig', 'data-role': 'certificate' },
      el('div', { class: 'sig-state', 'data-cert': c.number, text: `Сертификат платформы № ${c.number} от ${when}` }),
      el('div', { class: 'muted', text: 'Получатель проверит его по QR-коду на листе или по ссылке:' }),
      el('a', { href: c.url, target: '_blank', rel: 'noopener', class: 'cert-link', 'data-role': 'cert-url', text: c.url }),
      el('div', { class: 'row' },
        el('button', { class: 'secondary', 'data-action': 'cert-sheet', onclick: () => location.assign(`/api/documents/${d.id}/certificate`) }, 'Лист сертификата (Word)')))];
  }
  if (!d.can_certify) return [];
  return [el('div', { class: 'sig', 'data-role': 'certificate' },
    el('div', { class: 'muted', text: 'Перевод без нотариуса: выдайте сертификат платформы — номер и QR-код для проверки. В нём — Ваши ФИО, языки и отпечаток этого файла: загрузите окончательную версию перевода.' }),
    el('div', { class: 'row' }, el('button', { 'data-action': 'cert-issue', onclick: (e) => issueCertificate(d, e.currentTarget) }, 'Выдать сертификат')))];
}
async function issueCertificate(d, btn) {
  if (!confirm(`Выдать сертификат платформы к файлу «${d.filename}»? Если потом удалите файл, сертификат будет отозван.`)) return;
  btn.disabled = true;
  try {
    const { certificate } = await api('POST', `/api/documents/${d.id}/certificate`);
    await loadDocs();
    say($('doc-msg'), `Сертификат № ${certificate.number} выдан`, 'ok');
  } catch (err) { btn.disabled = false; say($('doc-msg'), err.message); }
}

// Очередь подписи (2.99): эксперт подписал, организация ещё нет — сколько ждёт и «Напомнить руководителю» (раз в сутки).
const waitedFor = (iso, now = Date.now()) => {
  const h = Math.floor((now - Date.parse(iso)) / 3600_000);
  return h < 1 ? 'меньше часа' : h < 24 ? `${h} ч` : `${Math.floor(h / 24)} дн.${h % 24 ? ` ${h % 24} ч` : ''}`;
};
const atRu = (iso) => new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
function renderSignWait(w, signOrg) {
  $('sign-wait-box').classList.toggle('hidden', !w);
  if (!w) return;
  $('sign-wait-text').textContent = `Ждёт подписи организации ${quoted(signOrg)}: ${w.files === 1 ? 'файл' : `файлов ${w.files}`} · Вы подписали ${atRu(w.since)} — ждёт ${waitedFor(w.since)}.`;
  $('sign-wait-reminded').textContent = w.reminded_at
    ? `Вы напоминали руководителю ${atRu(w.reminded_at)}${w.next_remind_at ? ` · снова — после ${atRu(w.next_remind_at)}` : ''}.`
    : 'Руководитель получил уведомление, когда Вы подписали. Если подпись задерживается — напомните (не чаще раза в сутки).';
  $('sign-remind').disabled = !w.can_remind;
}
$('sign-remind').addEventListener('click', async () => {
  $('sign-remind').disabled = true;
  try {
    const { sign_wait: w } = await api('POST', `/api/orders/${current.order.id}/sign-reminder`);
    renderSignWait(w, lastDocs?.signature_org);
    say($('doc-msg'), 'Руководителю отправлено напоминание', 'ok');
  } catch (err) { say($('doc-msg'), err.message); await loadDocs(); }
});

let lastDocs = null;

async function signAll() {
  const docs = (lastDocs?.documents ?? []).filter((d) => d.kind === 'result' && d.own !== false && !d.signatures?.expert);
  if (!docs.length) return;
  const ai = docs.filter((d) => d.ai_check).map((d) => `${d.filename}: ${aiCheckText(d.ai_check)}`);
  if (!confirm(`${unfixedText(docs.flatMap(returnsForDoc))}${ai.length ? `${ai.join('\n')}\n\n` : ''}${docs.map(swapConfirmText).find(Boolean) ?? ''}${docs.map(orderConfirmText).find(Boolean) ?? ''}${docs.map(madeConfirmText).join('')}${SIGN_CONFIRM(docs.map((d) => d.filename).join(', '))}\n\nФайлов: ${docs.length}.`)) return;
  say($('doc-msg'), 'Подписываем…', 'ok');
  try {
    for (const d of docs) await api('POST', `/api/documents/${d.id}/sign`, { confirm: true });
    await loadDocs();
    say($('doc-msg'), docs.length > 1 ? `Подписано файлов: ${docs.length}` : 'Файл подписан', 'ok');
  } catch (err) { await loadDocs(); say($('doc-msg'), err.message); }
}
$('sign-all').addEventListener('click', signAll);
document.addEventListener('ai-review-done', () => { if (current) loadDocs().catch(() => {}); });

async function signDoc(d) {
  if (!confirm(signConfirmText(d))) return;
  say($('doc-msg'), 'Подписываем…', 'ok');
  try {
    await api('POST', `/api/documents/${d.id}/sign`, { confirm: true });
    // Сначала обновить список, потом сообщение: «подписан» появляется, когда кнопки «Подписать» у файла уже нет.
    await loadDocs();
    say($('doc-msg'), 'Файл подписан', 'ok');
  } catch (err) { say($('doc-msg'), err.message); }
}

async function uploadSignature(d, file) {
  if (!confirm(signConfirmText(d))) return;
  say($('doc-msg'), 'Проверяем подпись…', 'ok');
  try {
    const { signature } = await api('POST', `/api/documents/${d.id}/signature/upload`, file, { 'content-type': 'application/octet-stream', 'x-confirm': '1' });
    await loadDocs();
    say($('doc-msg'), signature.manual_check ? 'Подпись загружена — платформа проверит её на Госуслугах' : 'Подпись проверена и добавлена', 'ok');
  } catch (err) { say($('doc-msg'), err.message); }
}

// Ручная проверка подписи сотрудником платформы: файл и подпись — на Госуслугах («Отсоединённая подпись»), итог — здесь.
const SIGN_ROLE_RU = { expert: 'эксперта', org: 'организации' };
function checkBox(d, s, checkUrl) {
  return el('div', { class: 'sig-check', 'data-role': 'sig-check', 'data-sig-role': s.role },
    el('div', { class: 'muted', text: `Проверьте подпись ${SIGN_ROLE_RU[s.role]}: скачайте файл и подпись, на Госуслугах выберите «Отсоединённая подпись» и загрузите оба. Подпись верна, если Госуслуги подтвердили её и владелец сертификата — тот, кто должен подписать.` }),
    el('a', { href: checkUrl, target: '_blank', rel: 'noopener', 'data-role': 'gosuslugi', text: 'Проверка подписи на Госуслугах' }),
    el('div', { class: 'row' },
      el('button', { 'data-action': 'sig-ok', onclick: (e) => markSignature(d, s.role, true, e.currentTarget) }, 'Подпись верна'),
      el('button', { class: 'danger', 'data-action': 'sig-bad', onclick: (e) => markSignature(d, s.role, false, e.currentTarget) }, 'Не подтвердилась')));
}
async function markSignature(d, role, ok, btn) {
  let note = '';
  if (ok && !confirm(`Подпись ${SIGN_ROLE_RU[role]} к «${d.filename}» проверена на Госуслугах и верна?`)) return;
  if (!ok) {
    note = prompt('Что не так с подписью? Исполнитель увидит это и загрузит подпись заново.') ?? '';
    if (!note.trim()) return;
  }
  btn.disabled = true;
  try {
    await api('POST', `/api/documents/${d.id}/signature/check`, { role, ok, note });
    await loadDocs();
    say($('doc-msg'), ok ? `«${d.filename}»: подписано КЭП, проверено` : `«${d.filename}»: подпись не подтвердилась — исполнитель получил уведомление`, 'ok');
  } catch (err) { btn.disabled = false; say($('doc-msg'), err.message); }
}

async function verifyDoc(d) {
  say($('doc-msg'), 'Проверяем подпись…', 'ok');
  try {
    const r = await api('POST', `/api/documents/${d.id}/signature/verify`);
    await loadDocs();
    const who = [r.signatures.expert?.signer, r.signatures.org?.org].filter(Boolean).join(' и ');
    // 2.69: файлов с подписями бывает несколько — в ответе видно, какой проверен.
    const two = r.signatures.expert && r.signatures.org;
    if (r.valid) say($('doc-msg'), `«${d.filename}»: ${two ? 'подписи верны' : 'подпись верна'} — ${who}`, 'ok');
    else say($('doc-msg'), `«${d.filename}»: подпись неверна — ${r.reason}`);
  } catch (err) { say($('doc-msg'), err.message); }
}

async function downloadSignature(d, role) {
  try {
    const { url } = await api('GET', `/api/documents/${d.id}/signature/link${role === 'org' ? '?role=org' : ''}`);
    location.assign(url);
  } catch (err) { say($('doc-msg'), err.message); }
}

async function download(d) {
  try {
    const { url } = await api('GET', `/api/documents/${d.id}/link`);
    location.assign(url);
  } catch (err) { say($('doc-msg'), err.message); }
}

async function remove(d) {
  if (!confirm(`Удалить «${d.filename}»?`)) return;
  try {
    await api('DELETE', `/api/documents/${d.id}`);
    say($('doc-msg'), 'Файл удалён', 'ok');
    await loadDocs();
  } catch (err) { say($('doc-msg'), err.message); }
}

// Прямая загрузка (2.49): облако не пропускает через ядро запрос больше 3,5 МБ — большой файл идёт прямо в
// хранилище по ссылке, ядро только выдаёт ссылку и записывает документ. С ходом загрузки в процентах.
function putWithProgress(url, file, type, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.setRequestHeader('content-type', type);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.floor((e.loaded / e.total) * 100)); };
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new Error('Хранилище не приняло файл — попробуйте ещё раз')));
    x.onerror = () => reject(new Error('Связь прервалась — загрузите файл ещё раз'));
    x.send(file);
  });
}

async function uploadFile(file, kind, msg) {
  if (!file) return;
  if (file.size > MAX_DIRECT) return say(msg, 'Файл больше 100 МБ');
  say(msg, 'Загружаем…', 'ok');
  const base = `/api/orders/${current.order.id}`;
  let doc = null;
  try {
    if (file.size > MAX_FILE) {
      const type = file.type || 'application/octet-stream';
      const meta = { filename: file.name, mime: type, size: file.size, kind };
      const got = await api('POST', `${base}/${kind === 'result' ? 'results' : 'documents'}/upload-url`, meta);
      await putWithProgress(got.upload_url, file, got.content_type, (pct) => say(msg, `Загружаем… ${pct}%`, 'ok'));
      doc = (await api('POST', `${base}/uploads/complete`, { pass: got.pass })).document;
    } else {
      // Результат работы — отдельной операцией исполнителя; остальные документы — заказчика.
      doc = (await api('POST', `${base}/${kind === 'result' ? 'results' : 'documents'}`, file, {
        'content-type': file.type || 'application/octet-stream',
        'x-file-name': encodeURIComponent(file.name),
        'x-doc-kind': kind,
      })).document;
    }
    say(msg, 'Файл добавлен', 'ok');
    await loadDocs();
    return doc;
  } catch (err) { say(msg, err.message); return null; }
}

$('file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  uploadFile(file, 'other', $('doc-msg'));
});

$('dossier-attach').addEventListener('click', async () => {
  say($('doc-msg'), 'Прикладываем…', 'ok');
  try {
    const r = await api('POST', `/api/orders/${current.order.id}/dossier`);
    say($('doc-msg'), r.documents.length ? `Приложено копий: ${r.documents.length}. Подпишите их вместе с отчётом.` : 'Все копии из досье уже приложены', 'ok');
    await loadDocs();
  } catch (err) { say($('doc-msg'), err.message); }
});

$('result-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  const doc = await uploadFile(file, 'result', $('doc-msg'));
  if (doc) askReplace(doc);
});

// Новый файл результата, пока открыт возврат руководителя, а возвращённый файл не удалён (2.251): сразу спросить, исправленная
// ли это версия. «Да, заменить» удаляет возвращённый одним нажатием — тогда подпись нового файла закрывает замечание и
// руководитель видит у него отметки (2.159). «Нет» — новый файл остаётся приложением, возвращённый подписывают заново.
function returnedStill(docId) {
  const docs = lastDocs?.documents ?? [];
  return (lastDocs?.org_returns ?? []).filter((r) => r.open && r.document_id !== docId && docs.some((x) => x.id === r.document_id)).at(-1) ?? null;
}
function askReplace(doc) {
  const r = returnedStill(doc.id);
  replacePair = r ? { doc, r } : null;
  $('replace-box').classList.toggle('hidden', !r);
  if (!r) return;
  $('replace-text').textContent = `«${doc.filename}» — исправленная версия возвращённого «${r.filename}»?`;
  $('replace-note').textContent = `«Да, заменить» удалит «${r.filename}»: подпишите «${doc.filename}» — руководитель увидит у него Ваши отметки по замечанию. Если это приложение к отчёту — «Нет», а «${r.filename}» подпишите заново.`;
}
async function replaceReturned(pair) {
  try {
    await api('DELETE', `/api/documents/${pair.r.document_id}`);
    $('replace-box').classList.add('hidden');
    replacePair = null;
    await loadDocs();
    say($('doc-msg'), `«${pair.r.filename}» удалён. Подпишите «${pair.doc.filename}».`, 'ok');
  } catch (err) { say($('doc-msg'), err.message); }
}
$('replace-yes').addEventListener('click', () => { if (replacePair) replaceReturned(replacePair); });
$('replace-no').addEventListener('click', () => { replacePair = null; $('replace-box').classList.add('hidden'); });

$('basis-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  uploadFile(file, 'basis', $('details-msg'));
});
