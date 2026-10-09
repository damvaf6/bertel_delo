// Страница заявки: данные (заполнение, пока заявка «новая»), ход заявки и шаги, кто ведёт дело, документы и результат;
// проверка результата и переписка — work.js; цена, оплата, выплата и закрывающие документы — money.js.
// Поля рисуются по описанию модуля из /api/catalog — у каждой профессии свои, код страницы один.
import { api, el, say, formatPhone, formatSize, ROLE_RU, quoted } from '/common.js';
import { state, show, notFoundView } from '/shell.js';
import { loadMatch } from '/match.js';
import { loadReview, loadChat } from '/work.js';
import { loadMoney } from '/money.js';
import { loadDraft } from '/draft.js';
import { loadAnalogs } from '/analogs.js';
import { loadInspection } from '/inspect.js';
import { loadOnsite } from '/onsite.js';
import { signatureLines, uploadSignatureButton, SIGN_CONFIRM, UPLOAD_HINT } from '/sign.js';
import { setNext } from '/next.js';
import { reveal } from '/fold.js';
import { orgChat } from '/orgchat.js';
import { loadJournal } from '/journal.js';
import { loadDocRequests } from '/docreq.js';
import { loadDeadline } from '/deadline.js';
import { loadHandover } from '/handover.js';
import { loadNotes } from '/notes.js';
import { loadPredecessor } from '/predecessor.js';
import { loadRepeat } from '/repeat.js';
import { loadSimilar } from '/similar.js';

const $ = (id) => document.getElementById(id);
// До 3 МБ — обычной загрузкой через ядро; больше — прямо в хранилище (облако: запрос не больше 3,5 МБ, 2.49).
const MAX_FILE = 3 * 1024 * 1024;
const MAX_DIRECT = 100 * 1024 * 1024;
const PHOTOS_UNFOLDED = 6;
const FINAL = ['closed', 'cancelled'];
const WORK_STARTED = ['in_work', 'review'];
const DOC_KIND_RU = { basis: 'Основание', result: 'Результат работы', inspection: 'Фото осмотра' };
let current = null; // { order, access, editable, actions, history }

const dateTimeRu = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
export function dayRu(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

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
  $('done-percent').value = '';
  render();
  show('order-view', 'orders');
  setNext({ reset: true, current, step: doStep, signAll });
  loadOrgChat();
  loadJournal(current.order, current.access);
  await Promise.all([loadDocs(true), loadTransfer(), loadMatch(current, () => openOrder(id)), loadDraft(current, () => openOrder(id)), loadAnalogs(current), loadInspection(current), loadOnsite(current), loadDocRequests(current, (file, msg) => uploadFile(file, 'other', msg)), loadDeadline(current, () => openOrder(id)), loadHandover(current), loadNotes(current), loadPredecessor(current, () => openOrder(id)), loadRepeat(current, () => openOrder(id)), loadSimilar(current), loadReview(current), loadChat(current), loadMoney(current, () => openOrder(id))]);
  setNext({ loaded: true }); // разделы осмотра и черновика показаны — шаги пересчитываются, нужный сейчас блок раскрыт
  // Черновик и «Срок» уже показаны — у предупреждения «нет файла результата» (2.138) видны нужные кнопки.
  renderResultDue(lastDocs?.result_due ?? null);
  const box = { result: 'docs-box', inspect: 'inspect-box', chat: 'chat-box', docs: 'docreq-box', deadline: 'deadline-box', extend: 'deadline-box', sign: 'sign-wait-box', handover: 'handover-box', onsite: 'onsite-box', notes: 'notes-box' }[to];
  if (box && !$(box).classList.contains('hidden')) { reveal(box); $(box).scrollIntoView({ block: 'start' }); }
  // «Попросить перенос» из «Моих сроков» (2.134): причина «много дел в этот день» и новый срок — сразу в полях.
  if (to === 'extend') document.querySelector('#deadline-reason-list [data-reason="busy"]')?.click();
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
  renderOrgLine();
  $('ask-assistant').href = `#assistant=${order.id}`;
  $('details-form').classList.toggle('hidden', !current.editable);
  $('details-view').classList.toggle('hidden', current.editable);
  if (current.editable) renderForm(); else renderFacts();
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

// ——— Данные заявки: форма ———

function renderForm() {
  const { order } = current;
  serviceOptions($('d-service'));
  if (order.module) $('d-service').value = `${order.module}/${order.service}`;
  else $('d-service').value = '';
  $('d-title').value = order.title;
  renderFields(order.fields);
  $('d-deadline').value = order.deadline || '';
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

  $('reason-box').classList.toggle('hidden', !actions.some((a) => a.reason));
  // Отмена после начала работ (диспетчер): по чьей причине и какая часть работы сделана — от этого зависит возврат.
  const lateCancel = WORK_STARTED.includes(order.status) && actions.some((a) => a.to === 'cancelled');
  $('cancel-box').classList.toggle('hidden', !lateCancel);
  if (lateCancel) syncCancelBox();
  $('actions').replaceChildren(...actions.map((a) => el('button', {
    class: a.to === 'cancelled' ? 'danger' : a.to === 'matching' && order.status === 'new' ? 'wide' : 'secondary',
    'data-to': a.to,
    onclick: () => doStep(a),
  }, a.name)));

  const last = history[history.length - 1];
  $('history-details').classList.toggle('hidden', !last);
  $('history-summary').textContent = last
    ? `История: ${history.length} · последнее — ${last.to_name}, ${new Date(last.at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : '';
  $('history').replaceChildren(...history.slice().reverse().map((h) => el('li', {},
    el('div', { class: 'title', text: h.to_name }),
    el('div', { class: 'muted', text: [dateTimeRu(h.at), { dispatcher: 'диспетчер', executor: 'исполнитель' }[h.side] || 'заказчик'].join(' · ') }),
    ...(h.reason ? [el('div', { text: `Причина: ${h.reason}` })] : []))));
}

function syncCancelBox() {
  $('done-percent-box').classList.toggle('hidden', $('cancel-fault').value !== 'customer');
}
$('cancel-fault').addEventListener('change', syncCancelBox);

async function doStep(a) {
  const reason = $('reason').value.trim();
  if (a.reason && !reason) return say($('status-msg'), 'Укажите причину');
  const extra = {};
  if (a.to === 'cancelled' && WORK_STARTED.includes(current.order.status)) {
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
  lastDocs = documentsBody;
  // «Подписать все» (2.15): несколько неподписанных файлов результата — одним подтверждением.
  const unsigned = mineResults && signRequired ? documents.filter((d) => d.kind === 'result' && d.own !== false && !d.signatures?.expert) : [];
  $('sign-all').classList.toggle('hidden', unsigned.length < 2);
  $('sign-all').textContent = `Подписать все файлы результата (${unsigned.length})`;
  const docLi = (d) => {
    // Результат убирает только исполнитель, пока не сдал; документы заказчика — заказчик (основание — до отправки).
    // Фото дистанционного осмотра не удаляются никем: это свидетельство осмотра со временем и местом (2.3).
    const removable = d.kind === 'inspection' ? false
      : d.kind === 'result' ? mineResults : canChange && !(d.kind === 'basis' && order.status !== 'new');
    return el('li', { class: 'doc' },
      el('div', {},
        el('div', { class: 'name', text: d.filename }),
        el('div', { class: 'muted', text: [DOC_KIND_RU[d.kind], formatSize(d.size_bytes)].filter(Boolean).join(' · ') }),
        // После передачи дела (2.110): файл прежнего эксперта остаётся в деле, но в сдачу не идёт — подписывает и сдаёт свой.
        ...(d.kind === 'result' && d.own === false ? [el('div', { class: 'muted', 'data-role': 'former', text: 'Файл прежнего эксперта — в сдачу не идёт. Загрузите свой файл результата.' })] : [])),
      el('div', { class: 'row' },
        el('button', { class: 'secondary', 'data-action': 'download', onclick: () => download(d) }, 'Скачать'),
        ...(removable ? [el('button', { class: 'danger', 'data-action': 'delete', onclick: () => remove(d) }, 'Удалить')] : [])),
      ...(d.kind === 'result' ? signatureBlock(d, { canSign: mineResults && signRequired && d.own !== false, signOrg: documentsBody.signature_org }) : []));
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
  $('result-due-text').textContent = `${when}, а файла результата ещё нет. ${due.has_draft
    ? 'Черновик есть — соберите из него отчёт Word и загрузите файл.' : 'Загрузите файл результата или попросите перенести срок.'}`;
  $('result-due-draft').classList.toggle('hidden', !due.has_draft || $('draft-box').classList.contains('hidden'));
  $('result-due-extend').classList.toggle('hidden', $('deadline-form').classList.contains('hidden'));
}
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
function renderOrgReturns(list) {
  orgReturnsNow = list;
  $('org-returns-box').classList.toggle('hidden', !list.length);
  if (!list.length) return;
  const open = list.filter((r) => r.open);
  $('org-returns-lead').textContent = open.length
    ? 'Руководитель вернул файл с замечанием: исправьте файл (или загрузите новый), отметьте исправленные пункты и подпишите заново — руководитель увидит, что осталось, и подпишет от организации.'
    : 'Все замечания учтены. История возвратов:';
  const item = (r) => el('li', { class: r.open ? 'return open' : 'return', 'data-return': String(r.id) },
    el('div', { class: 'title', text: `${r.filename} · ${r.open ? 'исправить' : 'исправлено'}` }),
    el('div', { class: 'muted', text: [r.by, r.org, new Date(r.at).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })].filter(Boolean).join(' · ') }),
    ...(r.items?.length ? returnPoints(r) : [el('div', { class: 'comment', text: r.comment })]));
  $('org-returns').replaceChildren(...[...open].reverse().map(item), ...list.filter((r) => !r.open).reverse().map(item));
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
      el('label', { for: id, class: 'row gap' }, box, el('span', { text: `${p.n}. ${p.text}` })));
  };
  return [el('div', { class: 'muted', 'data-role': 'points-left', text: `Исправлено ${done} из ${r.items.length}` }),
    el('ul', { class: 'points' }, ...r.items.map(point))];
}

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

// Перед новой подписью: если в открытом возврате по этому файлу остались неотмеченные пункты — предупредить.
function signConfirmText(d) {
  const left = orgReturnsNow.filter((r) => r.open && r.document_id === d.id).reduce((n, r) => n + (r.left ?? 0), 0);
  const ai = aiCheckText(d.ai_check);
  return (left ? `Не отмечено исправленными пунктов замечания руководителя: ${left}. Руководитель это увидит.\n\n` : '')
    + (ai ? `${ai}\n\n` : '') + SIGN_CONFIRM(d.filename);
}

function toAiReview() {
  if ($('ai-review-box').classList.contains('hidden')) return;
  reveal('ai-review-box');
  $('ai-review-box').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Подписи УКЭП у файла результата (2.5, 2.5а): эксперт и, если он работает от организации, её руководитель. Исполнитель
// подписывает свой файл, пока дело в работе, — в кабинете или загрузив готовую подпись (программа УЦ, «Госключ»).
function signatureBlock(d, { canSign, signOrg }) {
  const { expert, org } = d.signatures ?? {};
  if (!expert && !org && !canSign) return [];
  const lines = [];
  if (expert) lines.push(...signatureLines(expert));
  else if (canSign) {
    lines.push(el('div', { class: 'sig-state', text: 'Не подписан УКЭП — без подписи на проверку не сдать' }),
      ...(d.ai_check ? [el('div', { class: 'sig-ai', 'data-sig': `ai-${d.ai_check.state}`, text: `${aiCheckText(d.ai_check)} ` },
        el('button', { class: 'link', 'data-action': 'to-ai-review', onclick: toAiReview }, 'К ИИ-проверке'))] : []),
      el('div', { class: 'row' },
        el('button', { 'data-action': 'sign', onclick: () => signDoc(d) }, 'Подписать'),
        ...uploadSignatureButton(d.filename, (file) => uploadSignature(d, file))),
      el('div', { class: 'muted', text: UPLOAD_HINT }));
  }
  if (org) lines.push(...signatureLines(org));
  else if (signOrg && canSign) lines.push(el('div', { class: 'sig-state', 'data-sig': 'org-wait', text: expert
    ? `Ждёт подписи организации ${quoted(signOrg)} — подписывает руководитель в разделе «Организации»`
    : `После Вашей подписи файл подписывает руководитель организации ${quoted(signOrg)}` }));
  if (expert || org) {
    lines.push(el('div', { class: 'row' },
      el('button', { class: 'secondary', 'data-action': 'signature', onclick: () => downloadSignature(d, 'expert') }, 'Файл подписи'),
      ...(org ? [el('button', { class: 'secondary', 'data-action': 'signature-org', onclick: () => downloadSignature(d, 'org') }, 'Подпись организации')] : []),
      el('button', { class: 'secondary', 'data-action': 'verify', onclick: () => verifyDoc(d) }, 'Проверить подпись')));
  }
  return [el('div', { class: 'sig' }, ...lines)];
}

// Очередь подписи (2.99): эксперт подписал, организация ещё нет — сколько ждёт и «Напомнить руководителю» (раз в сутки).
const waitedFor = (iso, now = Date.now()) => {
  const h = Math.floor((now - Date.parse(iso)) / 3600_000);
  return h < 1 ? 'меньше часа' : h < 24 ? `${h} ч` : `${Math.floor(h / 24)} дн.${h % 24 ? ` ${h % 24} ч` : ''}`;
};
const atRu = (iso) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
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
  if (!confirm(`${ai.length ? `${ai.join('\n')}\n\n` : ''}${SIGN_CONFIRM(docs.map((d) => d.filename).join(', '))}\n\nФайлов: ${docs.length}.`)) return;
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
    await api('POST', `/api/documents/${d.id}/signature/upload`, file, { 'content-type': 'application/octet-stream', 'x-confirm': '1' });
    await loadDocs();
    say($('doc-msg'), 'Подпись проверена и добавлена', 'ok');
  } catch (err) { say($('doc-msg'), err.message); }
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

$('result-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  uploadFile(file, 'result', $('doc-msg'));
});

$('basis-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  uploadFile(file, 'basis', $('details-msg'));
});
