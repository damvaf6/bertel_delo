// Подпись организации (2.5а): руководитель видит файлы результата экспертов, которые работают от его организации, и
// подписывает их от организации — в кабинете или готовой подписью с сертификатом организации. Саму заявку и заказчика
// руководитель не видит: только услугу, номер, эксперта, срок и файлы.
import { api, el, say, formatSize } from '/common.js';
import { signatureLines, uploadSignatureButton, SIGN_CONFIRM, UPLOAD_HINT } from '/sign.js';
import { dayRu } from '/order.js';
import { loadOrgCases } from '/orgcases.js';

const $ = (id) => document.getElementById(id);
let current = null;
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
  current = org;
  const { items } = await api('GET', `/api/orgs/${org.id}/signing`);
  if (remarkOrg !== org.id) {
    try { remarks = (await api('GET', `/api/orgs/${org.id}/remarks`)).remarks; remarkOrg = org.id; } catch { remarks = []; }
  }
  remarkViews.clear();
  $('org-sign-box').classList.remove('hidden');
  $('org-sign-empty').classList.toggle('hidden', items.length > 0);
  // Сначала — что ждёт подписи; подписанное — ниже, свёрнутым (разбор 03.10.2026, 2.23). «Подписать все файлы дела» — одной
  // кнопкой, если ждут несколько (2.15).
  const waiting = (it) => it.documents.some((d) => d.signatures.expert && !d.signatures.org);
  const signedAll = (it) => it.documents.every((d) => d.signatures.org);
  const head = (it) => [
    el('div', { class: 'title', text: `${it.service} · ${it.order_ref}` }),
    el('div', { class: 'muted', text: [`Эксперт: ${it.executor}`, it.deadline ? `срок ${dayRu(it.deadline)}` : null].filter(Boolean).join(' · ') }),
    // Сколько файлы ждут подписи организации (2.148).
    ...(it.waiting_since && waiting(it) ? [el('div', { class: 'sig-state warn', 'data-sig': 'since', text: `Ждёт Вашей подписи ${waitedDays(it.waiting_since)} — эксперт подписал ${new Date(it.waiting_since).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}` })] : []),
    // Эксперт напоминал о подписи (2.99) — пока файлы ждут подписи организации.
    ...(it.reminded_at && waiting(it) ? [el('div', { class: 'sig-state', 'data-sig': 'reminded', text: `Эксперт напомнил о подписи ${new Date(it.reminded_at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}` })] : [])];
  const open = items.filter((it) => !signedAll(it));
  const done = items.filter(signedAll);
  renderMany(open.filter(waiting));
  $('org-sign').replaceChildren(
    ...open.map((it) => {
      const ready = it.documents.filter((d) => d.signatures.expert && !d.signatures.org);
      return el('li', { 'data-item': it.order_ref }, ...head(it),
        ...(waiting(it) && ready.length > 1 ? [el('button', { 'data-action': 'org-sign-all', onclick: () => signAll(ready) }, `Подписать все файлы дела (${ready.length})`)] : []),
        el('ul', { class: 'list' }, ...it.documents.map((d) => docItem(d, it))),
        ...returnsBlock(it.returns ?? []));
    }),
    ...(done.length ? [el('li', { class: 'group', text: `Подписано · ${done.length}` })] : []),
    ...done.map((it) => el('li', { class: 'signed', 'data-item': it.order_ref },
      el('details', {}, el('summary', { text: `${it.service} · ${it.order_ref} · подписано` }), ...head(it).slice(1),
        el('ul', { class: 'list' }, ...it.documents.map((d) => docItem(d, null))), ...returnsBlock(it.returns ?? [])))));
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
      el('div', { class: 'muted', text: [r.by, new Date(r.at).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })].filter(Boolean).join(' · ') }),
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
  return [el('div', { class: left.length ? 'sig-state warn' : 'sig-state', 'data-role': 'points-state',
    text: `По Вашему замечанию от ${new Date(r.at).toLocaleDateString('ru-RU')}: эксперт отметил исправленными ${done} из ${r.items.length}${left.length ? ', осталось:' : ''}` }),
  ...(left.length ? [pointsList(left)] : [])];
}

// Несколько дел одним подтверждением (2.114): отмечены все, кроме дел, где по замечанию руководителя эксперт отметил не всё.
function renderMany(list) {
  const box = $('org-sign-many');
  box.classList.toggle('hidden', list.length < 2);
  if (list.length < 2) return box.replaceChildren();
  const rows = list.map((it) => {
    const ready = it.documents.filter((d) => d.signatures.expert && !d.signatures.org);
    const left = ready.reduce((n, d) => {
      const r = returnOf(d, it);
      return n + (r ? r.left : 0);
    }, 0);
    const id = `org-many-${it.order_ref.replace(/[^0-9A-Z]/gi, '')}`;
    const box = el('input', { type: 'checkbox', id, 'data-many': it.order_ref, ...(left ? {} : { checked: '' }), onchange: () => count() });
    return { it, ready, box, label: el('label', { class: 'row', for: id }, box,
      el('span', {}, el('span', { text: `${it.service} · ${it.order_ref}` }),
        el('span', { class: 'muted', text: ` — ${it.executor}${it.deadline ? `, срок ${dayRu(it.deadline)}` : ''}, файлов: ${ready.length}` }),
        ...(left ? [el('span', { class: 'sig-state warn', 'data-role': 'many-left', text: `По Вашему замечанию эксперт не отметил исправленными: ${left}. Посмотрите дело ниже.` })] : []))) };
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
  const lines = [];
  if (expert) lines.push(...signatureLines(expert));
  else lines.push(el('div', { class: 'sig-state', text: 'Эксперт ещё не подписал — подпись организации после него' }));
  if (org) lines.push(...signatureLines(org));
  else if (expert) {
    lines.push(...(it ? lastReturnState(d, it) : []), el('div', { class: 'row' },
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

// «Вернуть эксперту» (2.27): замечание обязательно; подпись эксперта снимается, эксперту — уведомление.
function returnForm(d) {
  const area = el('textarea', { id: `ret-${d.id}`, rows: '3', maxlength: '2000', 'aria-label': `Замечание эксперту по файлу ${d.filename}` });
  const box = el('div', { class: 'field hidden', 'data-return-form': d.id },
    el('label', { for: `ret-${d.id}`, text: 'Что исправить — каждый пункт с новой строки (эксперт отметит исправленные)' }), area,
    ...remarkTools(d, area),
    el('div', { class: 'row' },
      el('button', { class: 'danger', 'data-action': 'org-return-send', onclick: () => sendReturn(d, area.value) }, 'Вернуть с замечанием'),
      el('button', { class: 'secondary', onclick: () => box.classList.add('hidden') }, 'Отмена')));
  const open = el('button', { class: 'secondary', 'data-action': 'org-return', onclick: () => { box.classList.remove('hidden'); area.focus(); } }, 'Вернуть эксперту');
  return el('div', {}, el('div', { class: 'row' }, open), box);
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
