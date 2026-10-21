// Подпись организации (2.5а): руководитель видит файлы результата экспертов, которые работают от его организации, и
// подписывает их от организации — в кабинете или готовой подписью с сертификатом организации. Саму заявку и заказчика
// руководитель не видит: только услугу, номер, эксперта, срок и файлы.
import { api, el, say, formatSize } from '/common.js';
import { signatureLines, uploadSignatureButton, SIGN_CONFIRM, UPLOAD_HINT, SIGN_HOWTO, memo } from '/sign.js';
import { dayRu } from '/order.js';
import { loadOrgCases } from '/orgcases.js';
import { taskDueSignClass, taskDueSignText, taskMovedText } from '/today.js';

const $ = (id) => document.getElementById(id);
let current = null;
// Отбор дел на подпись по ИИ-проверке эксперта (2.193): файлы, ждущие подписи организации, без ИИ-проверки этой версии или
// с оставшимися «посмотрите»; 2.205 — по замечанию руководителя эксперт отметил исправленными не все пункты.
const SIGN_FILTERS = [
  { id: 'left', text: 'Отмечены не все пункты замечания', test: (d, it) => (returnOf(d, it)?.left ?? 0) > 0 },
  { id: 'noai', text: 'Без ИИ-проверки этой версии', test: (d) => d.ai_check?.state === 'none' },
  { id: 'look', text: 'Есть «посмотрите»', test: (d) => d.ai_check?.state === 'attention' },
  // 2.263: в черновике заменены расхождения с выпиской, а подписан файл, собранный до замены.
  { id: 'swapped', text: 'Файл собран до замены по выписке', test: (d) => (d.ai_check?.swapped?.length ?? 0) > 0 },
  // 2.276: в ИИ-проверке эксперта остались расхождения с заявкой или заданием на оценку (2.269).
  { id: 'order', text: 'Есть расхождения с заявкой или заданием на оценку', test: (d) => (d.ai_check?.order?.length ?? 0) > 0 },
];
let signFilter = null;
// Из утренней сводки (2.286): сразу с отбором — подпись организации откроется уже отобранной.
export function pickSignFilter(id) {
  if (!SIGN_FILTERS.some((f) => f.id === id)) return;
  signFilter = id;
  renderSign();
}
let signItems = [];
let manualSign = false; // ручная проверка подписи: от организации — только загрузкой файла подписи
// «2 дн.», «5 ч», «меньше часа» (2.148).
const waitedDays = (iso) => {
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
  return h < 1 ? 'меньше часа' : h < 24 ? `${h} ч` : `${Math.floor(h / 24)} дн.`;
};
let remarks = [];           // свои заготовки замечаний руководителя (2.103)
let remarkOrg = null;       // организация, для которой они загружены
const remarkViews = new Set(); // открытые формы возврата — перерисовать после изменения заготовок
// После подписи или возврата меняются и «Дела экспертов» (что ждёт подписи — 2.36).
const refresh = () => Promise.all([loadOrgSign(current), loadOrgCases(current)]);

export async function loadOrgSign(org) {
  if (current?.id !== org.id) signFilter = null;
  current = org;
  const got = await api('GET', `/api/orgs/${org.id}/signing`);
  signItems = got.items;
  // Ручная проверка (задача штаба 3f817197-…-81ac): от организации — только загрузкой файла подписи.
  manualSign = got.sign_mode === 'manual';
  if (remarkOrg !== org.id) {
    try { remarks = (await api('GET', `/api/orgs/${org.id}/remarks`)).remarks; remarkOrg = org.id; } catch { remarks = []; }
  }
  renderSign();
}

function renderSign() {
  const all = signItems;
  remarkViews.clear();
  $('org-sign-box').classList.remove('hidden');
  $('org-sign-empty').classList.toggle('hidden', all.length > 0);
  // Сначала — что ждёт подписи; подписанное — ниже, свёрнутым (разбор 03.10.2026, 2.23). «Подписать все файлы дела» — одной
  // кнопкой, если ждут несколько (2.15).
  const waiting = (it) => it.documents.some((d) => d.signatures.expert && !d.signatures.org);
  const signedAll = (it) => it.documents.every((d) => d.signatures.org);
  const head = (it) => [
    el('div', { class: 'title', text: `${it.service} · ${it.order_ref}` }),
    el('div', { class: 'muted', text: [`Эксперт: ${it.executor}`, it.deadline ? `срок ${dayRu(it.deadline)}` : null].filter(Boolean).join(' · ') }),
    // Сколько файлы ждут подписи организации (2.148).
    ...(it.waiting_since && waiting(it) ? [el('div', { class: 'sig-state warn', 'data-sig': 'since', text: `Ждёт Вашей подписи ${waitedDays(it.waiting_since)} — эксперт подписал ${new Date(it.waiting_since).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}` })] : []),
    // Срок по заданию на оценку прошёл или сегодня (2.308) — красным, как в «Сегодня».
    ...(it.task_due && !it.task_moved && waiting(it) ? [el('div', { class: taskDueSignClass(it.task_due), 'data-sig': 'task-due', text: taskDueSignText(it.task_due) })] : []),
    // 2.334: перенос согласован позже срока по заданию на оценку, а письма банка о переносе нет (как в «Делах экспертов», 2.332):
    // до подписи — банк ждёт отчёт к прежнему дню. Подпись не держит.
    ...(it.task_moved && waiting(it) ? [el('div', { class: 'overdue', 'data-sig': 'task-moved', text: `До подписи: ${taskMovedText(it.task_moved)}` })] : []),
    // Эксперт напоминал о подписи (2.99) — пока файлы ждут подписи организации.
    ...(it.reminded_at && waiting(it) ? [el('div', { class: 'sig-state', 'data-sig': 'reminded', text: `Эксперт напомнил о подписи ${new Date(it.reminded_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}` })] : [])];
  // 2.352: срок по письму о переносе прошёл, сегодня или завтра, а файлы ждут подписи — такие дела первыми, ближайший срок
  // первым (строка срока — красным).
  const letterDay = (it) => (!waiting(it) ? null
    : it.task_due?.letter && !it.task_due.moved ? it.task_due.day
    : it.task_moved?.letter_due && it.task_moved.letter_due.days_left <= 1 ? it.task_moved.day : null);
  const hotFirst = (list) => [...list.filter(letterDay).sort((a, b) => letterDay(a).localeCompare(letterDay(b))), ...list.filter((it) => !letterDay(it))];
  const readyOf = (it) => it.documents.filter((d) => d.signatures.expert && !d.signatures.org);
  const fits = (f, it) => readyOf(it).some((d) => f.test(d, it));
  const counts = new Map(SIGN_FILTERS.map((f) => [f.id, all.filter((it) => fits(f, it)).length]));
  if (signFilter && !counts.get(signFilter)) signFilter = null;
  const chosen = SIGN_FILTERS.find((f) => f.id === signFilter);
  renderFilter(counts, all.filter((it) => readyOf(it).length).length);
  // В отборе — только дела, где такой файл ждёт подписи; подписанные скрыты.
  const items = chosen ? all.filter((it) => fits(chosen, it)) : all;
  const open = hotFirst(items.filter((it) => !signedAll(it)));
  const done = chosen ? [] : items.filter(signedAll);
  renderMany(open.filter(waiting));
  $('org-sign').replaceChildren(
    ...open.map((it) => {
      const ready = it.documents.filter((d) => d.signatures.expert && !d.signatures.org);
      return el('li', { 'data-item': it.order_ref, ...(letterDay(it) ? { class: 'hot', 'data-hot': 'letter' } : {}) }, ...head(it),
        ...(!manualSign && waiting(it) && ready.length > 1 ? [el('button', { 'data-action': 'org-sign-all', onclick: () => signAll(ready) }, `Подписать все файлы дела (${ready.length})`)] : []),
        el('ul', { class: 'list' }, ...it.documents.map((d) => docItem(d, it))),
        ...returnsBlock(it.returns ?? []));
    }),
    ...(done.length ? [el('li', { class: 'group', text: `Подписано · ${done.length}` })] : []),
    ...done.map((it) => el('li', { class: 'signed', 'data-item': it.order_ref },
      el('details', {}, el('summary', { text: `${it.service} · ${it.order_ref} · подписано` }), ...head(it).slice(1),
        el('ul', { class: 'list' }, ...it.documents.map((d) => docItem(d, null))), ...returnsBlock(it.returns ?? [])))));
}

function renderFilter(counts, waiting) {
  const box = $('org-sign-filter');
  const used = SIGN_FILTERS.filter((f) => counts.get(f.id));
  box.classList.toggle('hidden', !used.length);
  const chip = (id, text) => el('button', { type: 'button', class: 'secondary', 'data-sign-filter': id ?? 'all',
    'aria-pressed': String(signFilter === id), onclick: () => { signFilter = id; renderSign(); } }, text);
  box.replaceChildren(...(used.length ? [chip(null, `Все ждут подписи · ${waiting}`), ...used.map((f) => chip(f.id, `${f.text} · ${counts.get(f.id)}`))] : []));
}

// История возвратов эксперту (2.27): что и когда вернули, исправил ли эксперт (подписал заново); по пунктам (2.93) — что
// эксперт отметил исправленным.
function returnsBlock(list) {
  if (!list.length) return [];
  const opened = list.filter((r) => r.open);
  const progress = opened.filter((r) => r.items?.length).map((r) => `исправлено ${r.items.length - r.left} из ${r.items.length}`);
  return [el('details', { class: 'returns', 'data-returns': String(list.length) },
    el('summary', { text: `Возвраты эксперту · ${list.length}${opened.length ? ` · ждём исправления${progress.length ? ` (${progress.join(', ')})` : ''}` : ''}` }),
    el('ul', { class: 'list' }, ...[...list].reverse().map((r) => el('li', { class: 'return', 'data-return': String(r.id) },
      el('div', { class: 'title', text: `${r.filename} · ${r.open ? 'ждём исправления' : 'эксперт подписал заново'}` }),
      el('div', { class: 'muted', text: [r.by, new Date(r.at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' })].filter(Boolean).join(' · ') }),
      ...(r.items?.length ? [pointsList(r.items)] : [el('div', { class: 'comment', text: r.comment })])))))];
}

const pointsList = (items) => el('ul', { class: 'points' }, ...items.map((p) => el('li', { class: p.fixed ? 'point fixed' : 'point', 'data-point': String(p.n) },
  el('span', { text: `${p.n}. ${p.text}` }), el('span', { class: 'muted', text: p.fixed ? ' — исправлено' : ' — не отмечено' }))));

// Последний возврат с пунктами, к которому относится файл (2.159): возвращён сам файл или — если возвращённый удалён — это
// новая версия, загруженная после возврата.
function returnOf(d, it) {
  const alive = new Set(it.documents.map((x) => x.id));
  return [...(it.returns ?? [])].reverse().find((x) => x.items?.length && (x.document_id === d.id
    || (!alive.has(x.document_id) && Date.parse(d.created_at) > Date.parse(x.at))));
}

// До подписи от организации (2.93): по последнему возврату этого файла — что эксперт отметил исправленным, что осталось.
function lastReturnState(d, it) {
  const r = returnOf(d, it);
  if (!r) return [];
  const done = r.items.length - r.left;
  const left = r.items.filter((p) => !p.fixed);
  const egrn = r.items.filter((p) => p.egrn);
  const head = el('div', { class: left.length ? 'sig-state warn' : 'sig-state', 'data-role': 'points-state',
    text: `По Вашему замечанию от ${new Date(r.at).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })}: эксперт отметил исправленными ${done} из ${r.items.length}${left.length ? ', осталось:' : ''}` });
  // 2.271: пункты из расхождений с заявкой и заданием на оценку — так же, своей строкой.
  const order = r.items.filter((p) => p.order);
  if (!egrn.length && !order.length) return [head, ...(left.length ? [pointsList(left)] : [])];
  // 2.247: есть пункты из расхождений с выпиской ЕГРН — каждый пункт целиком: отметка эксперта и что показала новая ИИ-проверка.
  const sum = (list, key, title, role) => {
    if (!list.length) return [];
    const kept = list.filter((p) => p[key] === 'kept').length;
    const gone = list.filter((p) => p[key] === 'gone').length;
    const none = list.length - kept - gone;
    return [el('div', { class: kept || none ? 'sig-state warn' : 'sig-state', 'data-role': role,
      text: `${title} по новой ИИ-проверке эксперта: ${[gone ? `ушли — ${gone}` : '', kept ? `остались — ${kept}` : '',
        none ? `не проверены после возврата — ${none}` : ''].filter(Boolean).join(', ')}` })];
  };
  const st = (p) => p.egrn ?? p.order;
  head.textContent = head.textContent.replace(/, осталось:$/, '');
  return [head,
    ...sum(egrn, 'egrn', 'Расхождения с выпиской ЕГРН', 'points-egrn'),
    ...sum(order, 'order', 'Расхождения с заявкой и заданием на оценку', 'points-order'),
    el('ul', { class: 'points' }, ...r.items.map((p) => el('li', { class: st(p) === 'kept' || !p.fixed ? 'point' : 'point fixed', 'data-point': String(p.n),
      ...(p.egrn ? { 'data-egrn': p.egrn } : {}), ...(p.order ? { 'data-order': p.order } : {}) },
      el('span', { text: `${p.n}. ${p.text}` }),
      el('span', { class: 'muted', text: ` — ${p.fixed ? 'отмечено исправленным' : 'не отмечено'}${st(p) ? ` · ${EGRN_STATE[st(p)]}` : ''}` }))))];
}
const EGRN_STATE = {
  gone: 'в новой ИИ-проверке расхождения нет',
  kept: 'в новой ИИ-проверке расхождение осталось',
  none: 'ИИ-проверку после возврата эксперт не запускал',
};

// ИИ-проверка эксперта перед подписью организации (2.186): запускал ли эксперт её для этой версии файла и что в ней осталось
// «посмотрите». Подсказка — подписать можно и так.
const when = (iso) => new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
function aiCheckText(c) {
  if (c.state === 'none') return c.other
    ? 'Эксперт не запускал ИИ-проверку этой версии файла (проверял прежнюю).'
    : 'Эксперт не запускал ИИ-проверку этого файла.';
  if (c.state === 'ok') return `Эксперт проверил файл ИИ-проверкой ${when(c.at)} — пунктов «посмотрите» нет.`;
  return `В ИИ-проверке эксперта (${when(c.at)}) осталось «посмотрите»: ${c.count} — ${c.titles.join('; ')}${c.count > c.titles.length ? '; …' : ''}.`;
}
// 2.225: расхождения отчёта с выпиской ЕГРН из ИИ-проверки эксперта — одной строкой (площадь, кадастровый номер, этаж, адрес).
const egrnLine = (c) => (c?.egrn?.length
  ? [el('div', { class: 'sig-state warn', 'data-role': 'ai-egrn',
    text: `Расхождения с выпиской ЕГРН (${c.egrn.length}): ${c.egrn.slice(0, 3).join('; ')}${c.egrn.length > 3 ? '; …' : ''}.` })]
  : []);
// 2.269: расхождения с заявкой и заданием на оценку — так же одной строкой.
const orderLine = (c) => (c?.order?.length
  ? [el('div', { class: 'sig-state warn', 'data-role': 'ai-order',
    text: `Расхождения с ${orderWith(c)} (${c.order.length}): ${c.order.slice(0, 3).map((x) => x.text).join('; ')}${c.order.length > 3 ? '; …' : ''}.` })]
  : []);
const aiCheckLine = (d) => (d.ai_check
  ? [el('div', { class: d.ai_check.state === 'ok' ? 'sig-state' : 'sig-state warn', 'data-role': 'ai-check', 'data-ai': d.ai_check.state, text: aiCheckText(d.ai_check) }),
    ...egrnLine(d.ai_check), ...orderLine(d.ai_check), ...swappedLine(d)]
  : []);
// 2.263: эксперт заменил расхождения с выпиской в черновике (2.232, 2.246) уже после того, как загрузил этот файл, — значит,
// подписан файл, собранный до замены: в нём прежние значения. Подписать можно и так; «Вернуть: собрать Word заново» —
// форма возврата с готовым пунктом.
const SWAP_POINT = 'Расхождения с выпиской ЕГРН Вы заменили в черновике, а подписали файл, собранный до замены, — соберите Word заново из черновика, загрузите и подпишите новый файл, а этот удалите';
function swappedLine(d) {
  const list = d.ai_check?.swapped ?? [];
  if (!list.length) return [];
  return [el('div', { class: 'sig-state warn', 'data-role': 'ai-swapped' },
    el('div', { text: `Эксперт заменил в черновике по выписке ЕГРН ${when(d.ai_check.draft_at)}: ${list.slice(0, 3).join('; ')}${list.length > 3 ? '; …' : ''}. Этот файл загружен ${when(d.created_at)} — до замены, в нём прежние значения.` }),
    el('div', { class: 'muted', text: 'Попросите эксперта собрать Word заново из черновика и подписать новый файл. Подписать можно и так.' }),
    el('div', { class: 'row' }, el('button', { class: 'secondary', type: 'button', 'data-action': 'org-return-swapped', onclick: () => returnSwapped(d) }, 'Вернуть: собрать Word заново')))];
}
function returnSwapped(d) {
  const box = document.querySelector(`[data-return-form="${d.id}"]`);
  const area = document.getElementById(`ret-${d.id}`);
  if (!box || !area) return;
  if (!area.value.includes(SWAP_POINT)) { area.value = area.value.trim() ? `${area.value.trim()}\n${SWAP_POINT}` : SWAP_POINT; fitRows(area); }
  box.classList.remove('hidden');
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  area.focus();
}

// Несколько дел одним подтверждением (2.114): отмечены все, кроме дел, где по замечанию руководителя эксперт отметил не всё.
function renderMany(list) {
  const box = $('org-sign-many');
  box.classList.toggle('hidden', list.length < 2 || manualSign);
  if (list.length < 2 || manualSign) return box.replaceChildren();
  const rows = list.map((it) => {
    const ready = it.documents.filter((d) => d.signatures.expert && !d.signatures.org);
    const left = ready.reduce((n, d) => {
      const r = returnOf(d, it);
      return n + (r ? r.left : 0);
    }, 0);
    // 2.186: сколько файлов дела без ИИ-проверки эксперта или с пунктами «посмотрите».
    const noAi = ready.filter((d) => d.ai_check?.state === 'none').length;
    const look = ready.filter((d) => d.ai_check?.state === 'attention').length;
    const old = ready.filter((d) => d.ai_check?.swapped?.length).length;
    const ord = ready.filter((d) => d.ai_check?.order?.length).length;
    const ai = [noAi ? `без ИИ-проверки: ${noAi}` : null, look ? `в ИИ-проверке есть «посмотрите»: ${look}` : null,
      old ? `собраны до замены по выписке в черновике: ${old}` : null,
      ord ? `с расхождениями с заявкой или заданием на оценку: ${ord}` : null].filter(Boolean);
    const id = `org-many-${it.order_ref.replace(/[^0-9A-Z]/gi, '')}`;
    const box = el('input', { type: 'checkbox', id, 'data-many': it.order_ref, ...(left ? {} : { checked: '' }), onchange: () => count() });
    return { it, ready, box, label: el('label', { class: 'row', for: id }, box,
      el('span', {}, el('span', { text: `${it.service} · ${it.order_ref}` }),
        el('span', { class: 'muted', text: ` — ${it.executor}${it.deadline ? `, срок ${dayRu(it.deadline)}` : ''}, файлов: ${ready.length}` }),
        ...(left ? [el('span', { class: 'sig-state warn', 'data-role': 'many-left', text: `По Вашему замечанию эксперт не отметил исправленными: ${left}. Посмотрите дело ниже.` })] : []),
        ...(ai.length ? [el('span', { class: 'muted', 'data-role': 'many-ai', text: ` Файлы — ${ai.join(', ')}.` })] : []))) };
  });
  const btn = el('button', { 'data-action': 'org-sign-many', onclick: () => {
    const chosen = rows.filter((r) => r.box.checked);
    if (chosen.length) signMany(chosen.map((r) => ({ ref: r.it.order_ref, docs: r.ready })));
  } });
  const count = () => {
    const chosen = rows.filter((r) => r.box.checked);
    const files = chosen.reduce((n, r) => n + r.ready.length, 0);
    btn.textContent = chosen.length ? `Подписать отмеченные: дел ${chosen.length}, файлов ${files}` : 'Отметьте дела, которые подписать';
    btn.disabled = !chosen.length;
  };
  count();
  box.replaceChildren(el('details', { class: 'many', open: '' },
    el('summary', { text: `Подписать несколько дел сразу · ждут подписи ${list.length}` }),
    el('p', { class: 'muted', text: 'Отметьте дела, которые Вы проверили, — все их файлы подпишутся от организации одним подтверждением.' }),
    el('div', { class: 'many-list' }, ...rows.map((r) => r.label)), el('div', { class: 'row gap' }, btn)));
}

async function signMany(cases) {
  const docs = cases.flatMap((c) => c.docs);
  const names = cases.map((c) => `${c.ref}: ${c.docs.map((d) => d.filename).join(', ')}`).join('; ');
  if (!confirm(`${SIGN_CONFIRM(names)}\n\nДел: ${cases.length}, файлов: ${docs.length}.`)) return;
  say($('org-sign-msg'), 'Подписываем…', 'ok');
  const failed = [];
  for (const d of docs) {
    try { await api('POST', `/api/org-documents/${d.id}/sign`, { confirm: true }); }
    catch (err) { failed.push({ name: d.filename, why: err.message }); }
  }
  await refresh();
  if (!failed.length) return say($('org-sign-msg'), `Подписано от организации: дел ${cases.length}, файлов ${docs.length}`, 'ok');
  // Одна причина на все файлы (например, нет имени в профиле) — одной строкой, а не по каждому файлу.
  const whys = [...new Set(failed.map((f) => f.why))];
  say($('org-sign-msg'), `Подписано файлов: ${docs.length - failed.length} из ${docs.length}. `
    + whys.map((w) => `${w} (${failed.filter((f) => f.why === w).map((f) => f.name).join(', ')})`).join('; '));
}

async function signAll(docs) {
  if (!confirm(`${SIGN_CONFIRM(docs.map((d) => d.filename).join(', '))}\n\nФайлов: ${docs.length}.`)) return;
  say($('org-sign-msg'), 'Подписываем…', 'ok');
  try {
    for (const d of docs) await api('POST', `/api/org-documents/${d.id}/sign`, { confirm: true });
    await refresh();
    say($('org-sign-msg'), `Подписано от организации файлов: ${docs.length}`, 'ok');
  } catch (err) { await refresh(); say($('org-sign-msg'), err.message); }
}

function docItem(d, it) {
  const { expert, org } = d.signatures;
  const lines = [...(it ? besideReturned(d, it) : [])];
  if (expert) lines.push(...signatureLines(expert));
  else lines.push(el('div', { class: 'sig-state', text: 'Эксперт ещё не подписал — подпись организации после него' }));
  if (org) lines.push(...signatureLines(org));
  if (expert?.manual_check === 'bad') lines.push(el('div', { class: 'muted', text: 'Подпись организации — после того как эксперт загрузит подпись заново.' }));
  else if (expert && manualSign && (!org || org.manual_check === 'bad')) {
    lines.push(...(it ? lastReturnState(d, it) : []), ...aiCheckLine(d), el('div', { class: 'row' },
      ...uploadSignatureButton(d.filename, (file) => upload(d, file), 'Загрузить подпись организации (.sig)')),
    el('div', { class: 'muted', text: 'Подпишите этот файл КЭП организации (руководителя) своей программой и загрузите файл подписи .sig. Платформа проверит подпись на Госуслугах.' }),
    memo('Как подписать файл КЭП', SIGN_HOWTO, 'sign-howto'),
    ...(org ? [] : [returnForm(d)]));
  } else if (expert && !org) {
    lines.push(...(it ? lastReturnState(d, it) : []), ...aiCheckLine(d), el('div', { class: 'row' },
      el('button', { 'data-action': 'org-sign', onclick: () => sign(d) }, 'Подписать от организации'),
      ...uploadSignatureButton(d.filename, (file) => upload(d, file))),
    el('div', { class: 'muted', text: `${UPLOAD_HINT} Нужен сертификат организации.` }),
    returnForm(d));
  }
  return el('li', { class: 'doc', 'data-doc': d.id },
    el('div', {},
      el('div', { class: 'name', text: d.filename }),
      el('div', { class: 'muted', text: formatSize(d.size_bytes) })),
    el('div', { class: 'row' }, el('button', { class: 'secondary', 'data-action': 'download', onclick: () => download(d) }, 'Скачать')),
    el('div', { class: 'sig' }, ...lines));
}

// Возвращённый файл не удалён, а после возврата эксперт загрузил другой (2.252; у эксперта — 2.250, 2.251): замечание открыто,
// отметок эксперта у нового файла нет. Это может быть и исправленная версия, и приложение — пометка у обоих файлов, без вывода.
const dayMonth = (iso) => new Date(iso).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' });
function besideReturned(d, it) {
  const open = (it.returns ?? []).filter((r) => r.open);
  const alive = new Map(it.documents.map((x) => [x.id, x]));
  const after = (r) => it.documents.filter((x) => x.id !== r.document_id && Date.parse(x.created_at) > Date.parse(r.at));
  const mine = [...open].reverse().find((r) => r.document_id === d.id);
  if (mine) {
    const fresh = after(mine);
    if (!fresh.length) return [];
    const n = fresh.at(-1);
    return [el('div', { class: 'sig-state warn', 'data-role': 'beside-new' },
      el('span', { text: `Эксперт загрузил новый файл «${n.filename}» ${dayMonth(n.created_at)}, а этот, возвращённый, не удалил${fresh.length > 1 ? ` (новых файлов: ${fresh.length})` : ''} — замечание пока открыто. Если «${n.filename}» — исправленная версия, эксперт удалит этот файл, и у нового Вы увидите его отметки по пунктам; если приложение — эксперт подпишет этот файл заново. ` }),
      el('button', { class: 'link', 'data-action': 'to-beside-new', onclick: () => toOrgDoc(n.id) }, 'К новому файлу'))];
  }
  const r = [...open].reverse().find((x) => alive.has(x.document_id) && after(x).some((y) => y.id === d.id));
  if (!r) return [];
  return [el('div', { class: 'sig-state', 'data-role': 'beside-returned' },
    el('span', { text: `Загружен после Вашего возврата; возвращённый «${r.filename}» эксперт не удалил. ` }),
    el('button', { class: 'link', 'data-action': 'to-beside-returned', onclick: () => toOrgDoc(r.document_id) }, 'К возвращённому файлу'))];
}
function toOrgDoc(id) {
  document.querySelector(`#org-sign li.doc[data-doc="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// «Вернуть эксперту» (2.27): замечание обязательно; подпись эксперта снимается, эксперту — уведомление.
function returnForm(d) {
  const area = el('textarea', { id: `ret-${d.id}`, rows: '3', maxlength: '2000', 'aria-label': `Замечание эксперту по файлу ${d.filename}` });
  const box = el('div', { class: 'field hidden', 'data-return-form': d.id },
    el('label', { for: `ret-${d.id}`, text: 'Что исправить — каждый пункт с новой строки (эксперт отметит исправленные)' }), area,
    ...egrnTools(d, area),
    ...orderTools(d, area),
    ...remarkTools(d, area),
    el('div', { class: 'row' },
      el('button', { class: 'danger', 'data-action': 'org-return-send', onclick: () => sendReturn(d, area.value) }, 'Вернуть с замечанием'),
      el('button', { class: 'secondary', onclick: () => box.classList.add('hidden') }, 'Отмена')));
  // 2.236: есть расхождения с выпиской ЕГРН из ИИ-проверки эксперта — при первом открытии они уже в замечании пунктами;
  // 2.269: и расхождения с заявкой и заданием на оценку; прогон 2.270: файл собран до замены по выписке (2.263) — и пункт
  // «соберите Word заново», как у кнопки «Вернуть: собрать Word заново».
  const open = el('button', { class: 'secondary', 'data-action': 'org-return', onclick: () => {
    const first = [...aiPoints(d), ...(d.ai_check?.swapped?.length ? [SWAP_POINT] : [])].slice(0, 30);
    if (!area.value.trim() && first.length) { area.value = first.join('\n'); fitRows(area); }
    box.classList.remove('hidden');
    area.focus();
  } }, 'Вернуть эксперту');
  return el('div', {}, el('div', { class: 'row' }, open), box);
}

// Расхождения отчёта с выпиской ЕГРН (2.225) пунктами замечания (2.236): подставляются при открытии формы, их можно править
// и убирать; кнопка возвращает недостающие. Не больше пунктов, чем принимает возврат.
// Находка уже говорит, что сделать («…: укажите его в разделе о правах», 2.242), — без второго указания (прогон 2.250).
const egrnPoints = (d) => (d.ai_check?.egrn ?? []).slice(0, 30).map((t) => t.replace(/[.\s]+$/, ''))
  .map((t) => (/:\s*укажите\s/.test(t) ? t : `${t} — исправьте по выписке`));
// Подставленные пункты видны целиком (каждый на телефоне — в две-три строки), но поле не выше 12 строк.
const fitRows = (area) => { area.rows = Math.min(12, Math.max(3, area.value.split('\n').length * 3)); };
function egrnTools(d, area) {
  const points = egrnPoints(d);
  return pointTools(area, points, { role: 'egrn-points-hint', action: 'org-return-egrn', label: 'Подставить расхождения с выпиской ЕГРН',
    hint: `Расхождения с выпиской ЕГРН из ИИ-проверки эксперта (${points.length}) подставлены пунктами — поправьте или уберите лишнее.`,
    all: 'Все расхождения с выпиской уже в замечании' });
}

// 2.269: находки ИИ-проверки эксперта, сверенные с заявкой и заданием на оценку (а не с выпиской), — тоже пунктами:
// «… — исправьте, как в заявке» (дата составления против срока из задания — своим `todo`, прогон 2.320). Вместе с расхождениями с выпиской — не больше пунктов, чем принимает возврат.
const orderPoints = (d) => (d.ai_check?.order ?? []).slice(0, 30)
  .map((x) => `${x.text.replace(/[.\s]+$/, '')} — ${x.todo ?? `исправьте, как ${x.from || 'в заявке'}`}`);
const aiPoints = (d) => [...egrnPoints(d), ...orderPoints(d)].slice(0, 30);
// С чем сверено: «с заявкой», «с заданием на оценку», «с заявкой и заданием на оценку» (письмо заказчика, определение суда).
const WITH = { 'в заявке': 'заявкой', 'в задании на оценку': 'заданием на оценку', 'в письме заказчика': 'письмом заказчика', 'в определении суда': 'определением суда' };
const orderWith = (c) => {
  const w = [...new Set((c?.order ?? []).map((x) => WITH[x.from] ?? 'документами дела'))];
  return w.length > 1 ? `${w.slice(0, -1).join(', ')} и ${w.at(-1)}` : w[0];
};
function orderTools(d, area) {
  const points = orderPoints(d);
  return pointTools(area, points, { role: 'order-points-hint', action: 'org-return-order', label: `Подставить расхождения с ${orderWith(d.ai_check)}`,
    hint: `Расхождения с ${orderWith(d.ai_check)} из ИИ-проверки эксперта (${points.length}) подставлены пунктами — поправьте или уберите лишнее.`,
    all: `Все расхождения с ${orderWith(d.ai_check)} уже в замечании` });
}
function pointTools(area, points, { role, action, label, hint, all }) {
  if (!points.length) return [];
  return [el('div', { class: 'muted', 'data-role': role, text: hint }),
    el('div', { class: 'row' }, el('button', { type: 'button', class: 'secondary', 'data-action': action, onclick: () => {
      const have = area.value.split(/\r?\n/).map((l) => l.trim());
      const add = points.filter((p) => !have.includes(p));
      if (!add.length) return say($('org-sign-msg'), all);
      area.value = area.value.replace(/\s+$/, '') + (area.value.trim() ? '\n' : '') + add.join('\n');
      fitRows(area);
      area.focus();
      say($('org-sign-msg'), '');
    } }, label))];
}

// Свои заготовки замечаний (2.103): частый пункт — одной кнопкой в замечание; пункты из замечания — «Запомнить» один раз.
function remarkTools(d, area) {
  const chips = el('div', { class: 'chips remarks', 'data-remarks': d.id });
  const list = el('ul', { class: 'list' });
  const sum = el('summary');
  const hint = el('div', { class: 'muted' });
  const draw = () => {
    chips.replaceChildren(...remarks.map((r) => el('button', { type: 'button', 'data-remark': r.id, onclick: () => addLine(area, r.text) }, `+ ${r.text}`)));
    hint.textContent = remarks.length ? 'Нажмите заготовку — она добавится в замечание новой строкой.'
      : 'Частые пункты можно запомнить кнопкой ниже — потом вставлять одной кнопкой.';
    sum.textContent = `Мои заготовки замечаний · ${remarks.length}`;
    list.replaceChildren(...remarks.map((r) => el('li', { 'data-remark-item': r.id }, el('span', { text: r.text }),
      el('button', { type: 'button', class: 'secondary', 'data-action': 'org-remark-remove', onclick: () => removeRemark(r) }, 'Убрать'))));
  };
  remarkViews.add(draw);
  draw();
  return [hint, chips,
    el('div', { class: 'row' }, el('button', { type: 'button', class: 'secondary', 'data-action': 'org-remark-save', onclick: () => saveRemarks(area.value) }, 'Запомнить пункты как заготовки')),
    el('details', { class: 'remarks-own' }, sum, list)];
}

function addLine(area, line) {
  const lines = area.value.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(line)) return say($('org-sign-msg'), 'Этот пункт уже есть в замечании');
  area.value = area.value.replace(/\s+$/, '') + (area.value.trim() ? '\n' : '') + line;
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  say($('org-sign-msg'), '');
}

const redraw = () => remarkViews.forEach((draw) => draw());

async function saveRemarks(value) {
  const lines = String(value).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return say($('org-sign-msg'), 'Напишите пункты замечания — каждый с новой строки, потом нажмите «Запомнить»');
  try {
    let added = 0;
    for (const t of lines) {
      const r = await api('POST', `/api/orgs/${current.id}/remarks`, { text: t });
      remarks = r.remarks;
      if (r.added) added += 1;
    }
    redraw();
    say($('org-sign-msg'), added ? `Запомнено заготовок: ${added}` : 'Эти пункты уже есть в заготовках', 'ok');
  } catch (err) { redraw(); say($('org-sign-msg'), err.message); }
}

async function removeRemark(r) {
  if (!confirm(`Убрать заготовку «${r.text}»? В уже отправленных замечаниях текст останется.`)) return;
  try {
    remarks = (await api('DELETE', `/api/orgs/${current.id}/remarks/${r.id}`)).remarks;
    redraw();
    say($('org-sign-msg'), 'Заготовка убрана', 'ok');
  } catch (err) { say($('org-sign-msg'), err.message); }
}

async function sendReturn(d, comment) {
  if (!String(comment).trim()) return say($('org-sign-msg'), 'Напишите замечание — что эксперту исправить');
  try {
    await api('POST', `/api/org-documents/${d.id}/return`, { comment });
    await refresh();
    say($('org-sign-msg'), 'Файл возвращён эксперту с замечанием — его подпись снята', 'ok');
  } catch (err) { say($('org-sign-msg'), err.message); }
}

async function sign(d) {
  if (!confirm(SIGN_CONFIRM(d.filename))) return;
  say($('org-sign-msg'), 'Подписываем…', 'ok');
  try {
    await api('POST', `/api/org-documents/${d.id}/sign`, { confirm: true });
    await refresh();
    say($('org-sign-msg'), 'Файл подписан от организации', 'ok');
  } catch (err) { say($('org-sign-msg'), err.message); }
}

async function upload(d, file) {
  if (!confirm(SIGN_CONFIRM(d.filename))) return;
  say($('org-sign-msg'), 'Проверяем подпись…', 'ok');
  try {
    await api('POST', `/api/org-documents/${d.id}/signature/upload`, file, { 'content-type': 'application/octet-stream', 'x-confirm': '1' });
    await refresh();
    say($('org-sign-msg'), 'Подпись организации проверена и добавлена', 'ok');
  } catch (err) { say($('org-sign-msg'), err.message); }
}

async function download(d) {
  try {
    const { url } = await api('GET', `/api/org-documents/${d.id}/link`);
    location.assign(url);
  } catch (err) { say($('org-sign-msg'), err.message); }
}
