// Страница заявки: данные (заполнение, пока заявка «новая»), ход заявки и шаги, кто ведёт дело, документы и результат;
// проверка результата и переписка — work.js; цена, оплата, выплата и закрывающие документы — money.js.
// Поля рисуются по описанию модуля из /api/catalog — у каждой профессии свои, код страницы один.
import { api, el, say, formatPhone, formatSize, ROLE_RU } from '/common.js';
import { state, show, notFoundView } from '/shell.js';
import { loadMatch } from '/match.js';
import { loadReview, loadChat } from '/work.js';
import { loadMoney } from '/money.js';
import { loadDraft } from '/draft.js';
import { loadInspection } from '/inspect.js';
import { loadOnsite } from '/onsite.js';
import { signatureLines, uploadSignatureButton, SIGN_CONFIRM, UPLOAD_HINT } from '/sign.js';
import { setNext } from '/next.js';
import { orgChat } from '/orgchat.js';

const $ = (id) => document.getElementById(id);
const MAX_FILE = 5 * 1024 * 1024;
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

export async function openOrder(id) {
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
  await Promise.all([loadDocs(), loadTransfer(), loadMatch(current, () => openOrder(id)), loadDraft(current, () => openOrder(id)), loadInspection(current), loadOnsite(current), loadReview(current), loadChat(current), loadMoney(current, () => openOrder(id))]);
  setNext({}); // разделы осмотра и черновика показаны — шаги пересчитываются
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
    pairs.push([f.label, f.type === 'select' ? (f.options.find((o) => o.id === v)?.name ?? v) : String(v)]);
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

function renderProgress() {
  const { order, actions, history } = current;
  const flow = state.catalog.statuses.filter((s) => s.id !== 'cancelled');
  const at = flow.findIndex((s) => s.id === order.status);
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

async function loadDocs() {
  const { order, access } = current;
  const canChange = access !== 'read' && !FINAL.includes(order.status);
  const documentsBody = await api('GET', `/api/orders/${order.id}/documents`);
  const { documents, results_hidden: resultsHidden } = documentsBody;
  const mineResults = current.executor?.is_me && order.status === 'in_work';
  const signRequired = !!documentsBody.signature_required;
  $('result-sign-note').classList.toggle('hidden', !signRequired);
  lastDocs = documentsBody;
  // «Подписать все» (2.15): несколько неподписанных файлов результата — одним подтверждением.
  const unsigned = mineResults && signRequired ? documents.filter((d) => d.kind === 'result' && !d.signatures?.expert) : [];
  $('sign-all').classList.toggle('hidden', unsigned.length < 2);
  $('sign-all').textContent = `Подписать все файлы результата (${unsigned.length})`;
  $('docs').replaceChildren(...documents.map((d) => {
    // Результат убирает только исполнитель, пока не сдал; документы заказчика — заказчик (основание — до отправки).
    // Фото дистанционного осмотра не удаляются никем: это свидетельство осмотра со временем и местом (2.3).
    const removable = d.kind === 'inspection' ? false
      : d.kind === 'result' ? mineResults : canChange && !(d.kind === 'basis' && order.status !== 'new');
    return el('li', { class: 'doc' },
      el('div', {},
        el('div', { class: 'name', text: d.filename }),
        el('div', { class: 'muted', text: [DOC_KIND_RU[d.kind], formatSize(d.size_bytes)].filter(Boolean).join(' · ') })),
      el('div', { class: 'row' },
        el('button', { class: 'secondary', 'data-action': 'download', onclick: () => download(d) }, 'Скачать'),
        ...(removable ? [el('button', { class: 'danger', 'data-action': 'delete', onclick: () => remove(d) }, 'Удалить')] : [])),
      ...(d.kind === 'result' ? signatureBlock(d, { canSign: mineResults && signRequired, signOrg: documentsBody.signature_org }) : []));
  }));
  $('docs-empty').classList.toggle('hidden', documents.length > 0);
  $('results-later').textContent = 'Результат работы появится здесь после проверки.';
  $('results-later').classList.toggle('hidden', !(resultsHidden && ['in_work', 'review'].includes(order.status)));
  renderOrgReturns(documentsBody.org_returns ?? []);
  setNext({ docs: documentsBody });
  const basis = documents.filter((d) => d.kind === 'basis');
  $('basis-file-state').textContent = basis.length ? `Приложено: ${basis.map((d) => d.filename).join(', ')}` : 'Файл определения ещё не приложен';
}

// Внутренняя переписка с руководителем организации (2.28) — только самому исполнителю, если он работает от организации.
function loadOrgChat() {
  const org = current.org_chat;
  $('org-chat-box').classList.toggle('hidden', !org);
  if (!org) return $('org-chat').replaceChildren();
  $('org-chat-lead').textContent = `Видите только Вы и руководитель организации «${org}». Заказчик и диспетчер эту переписку не видят.`;
  orgChat($('org-chat'), current.order.id);
}

// Замечания руководителя организации (2.27): возвраты файла до подписи организации — видит только сам исполнитель.
// Открытые — сверху; закрытые (файл подписан заново) — ниже, как история.
function renderOrgReturns(list) {
  $('org-returns-box').classList.toggle('hidden', !list.length);
  if (!list.length) return;
  const open = list.filter((r) => r.open);
  $('org-returns-lead').textContent = open.length
    ? 'Руководитель вернул файл с замечанием: исправьте файл (или загрузите новый) и подпишите заново — после этого руководитель подпишет от организации.'
    : 'Все замечания учтены. История возвратов:';
  const item = (r) => el('li', { class: r.open ? 'return open' : 'return', 'data-return': String(r.id) },
    el('div', { class: 'title', text: `${r.filename} · ${r.open ? 'исправить' : 'исправлено'}` }),
    el('div', { class: 'muted', text: [r.by, r.org, new Date(r.at).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })].filter(Boolean).join(' · ') }),
    el('div', { class: 'comment', text: r.comment }));
  $('org-returns').replaceChildren(...[...open].reverse().map(item), ...list.filter((r) => !r.open).reverse().map(item));
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
      el('div', { class: 'row' },
        el('button', { 'data-action': 'sign', onclick: () => signDoc(d) }, 'Подписать'),
        ...uploadSignatureButton(d.filename, (file) => uploadSignature(d, file))),
      el('div', { class: 'muted', text: UPLOAD_HINT }));
  }
  if (org) lines.push(...signatureLines(org));
  else if (signOrg && canSign) lines.push(el('div', { class: 'sig-state', 'data-sig': 'org-wait', text: expert
    ? `Ждёт подписи организации «${signOrg}» — подписывает руководитель в разделе «Организации»`
    : `После Вашей подписи файл подписывает руководитель организации «${signOrg}»` }));
  if (expert || org) {
    lines.push(el('div', { class: 'row' },
      el('button', { class: 'secondary', 'data-action': 'signature', onclick: () => downloadSignature(d, 'expert') }, 'Файл подписи'),
      ...(org ? [el('button', { class: 'secondary', 'data-action': 'signature-org', onclick: () => downloadSignature(d, 'org') }, 'Подпись организации')] : []),
      el('button', { class: 'secondary', 'data-action': 'verify', onclick: () => verifyDoc(d) }, 'Проверить подпись')));
  }
  return [el('div', { class: 'sig' }, ...lines)];
}

let lastDocs = null;

async function signAll() {
  const docs = (lastDocs?.documents ?? []).filter((d) => d.kind === 'result' && !d.signatures?.expert);
  if (!docs.length) return;
  if (!confirm(`${SIGN_CONFIRM(docs.map((d) => d.filename).join(', '))}\n\nФайлов: ${docs.length}.`)) return;
  say($('doc-msg'), 'Подписываем…', 'ok');
  try {
    for (const d of docs) await api('POST', `/api/documents/${d.id}/sign`, { confirm: true });
    await loadDocs();
    say($('doc-msg'), docs.length > 1 ? `Подписано файлов: ${docs.length}` : 'Файл подписан', 'ok');
  } catch (err) { await loadDocs(); say($('doc-msg'), err.message); }
}
$('sign-all').addEventListener('click', signAll);

async function signDoc(d) {
  if (!confirm(SIGN_CONFIRM(d.filename))) return;
  say($('doc-msg'), 'Подписываем…', 'ok');
  try {
    await api('POST', `/api/documents/${d.id}/sign`, { confirm: true });
    // Сначала обновить список, потом сообщение: «подписан» появляется, когда кнопки «Подписать» у файла уже нет.
    await loadDocs();
    say($('doc-msg'), 'Файл подписан', 'ok');
  } catch (err) { say($('doc-msg'), err.message); }
}

async function uploadSignature(d, file) {
  if (!confirm(SIGN_CONFIRM(d.filename))) return;
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
    if (r.valid) say($('doc-msg'), `Подпись верна: ${who}`, 'ok');
    else say($('doc-msg'), `Подпись неверна — ${r.reason}`);
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

async function uploadFile(file, kind, msg) {
  if (!file) return;
  if (file.size > MAX_FILE) return say(msg, 'Файл больше 5 МБ');
  say(msg, 'Загружаем…', 'ok');
  try {
    // Результат работы — отдельной операцией исполнителя; остальные документы — заказчика.
    await api('POST', `/api/orders/${current.order.id}/${kind === 'result' ? 'results' : 'documents'}`, file, {
      'content-type': file.type || 'application/octet-stream',
      'x-file-name': encodeURIComponent(file.name),
      'x-doc-kind': kind,
    });
    say(msg, 'Файл добавлен', 'ok');
    await loadDocs();
  } catch (err) { say(msg, err.message); }
}

$('file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  uploadFile(file, 'other', $('doc-msg'));
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
