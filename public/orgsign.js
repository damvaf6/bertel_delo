// Подпись организации (2.5а): руководитель видит файлы результата экспертов, которые работают от его организации, и
// подписывает их от организации — в кабинете или готовой подписью с сертификатом организации. Саму заявку и заказчика
// руководитель не видит: только услугу, номер, эксперта, срок и файлы.
import { api, el, say, formatSize } from '/common.js';
import { signatureLines, uploadSignatureButton, SIGN_CONFIRM, UPLOAD_HINT } from '/sign.js';
import { dayRu } from '/order.js';
import { loadOrgCases } from '/orgcases.js';

const $ = (id) => document.getElementById(id);
let current = null;
// После подписи или возврата меняются и «Дела экспертов» (что ждёт подписи — 2.36).
const refresh = () => Promise.all([loadOrgSign(current), loadOrgCases(current)]);

export async function loadOrgSign(org) {
  current = org;
  const { items } = await api('GET', `/api/orgs/${org.id}/signing`);
  $('org-sign-box').classList.remove('hidden');
  $('org-sign-empty').classList.toggle('hidden', items.length > 0);
  // Сначала — что ждёт подписи; подписанное — ниже, свёрнутым (разбор 03.10.2026, 2.23). «Подписать все файлы дела» — одной
  // кнопкой, если ждут несколько (2.15).
  const waiting = (it) => it.documents.some((d) => d.signatures.expert && !d.signatures.org);
  const signedAll = (it) => it.documents.every((d) => d.signatures.org);
  const head = (it) => [
    el('div', { class: 'title', text: `${it.service} · ${it.order_ref}` }),
    el('div', { class: 'muted', text: [`Эксперт: ${it.executor}`, it.deadline ? `срок ${dayRu(it.deadline)}` : null].filter(Boolean).join(' · ') }),
    // Эксперт напоминал о подписи (2.99) — пока файлы ждут подписи организации.
    ...(it.reminded_at && waiting(it) ? [el('div', { class: 'sig-state', 'data-sig': 'reminded', text: `Эксперт напомнил о подписи ${new Date(it.reminded_at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}` })] : [])];
  const open = items.filter((it) => !signedAll(it));
  const done = items.filter(signedAll);
  $('org-sign').replaceChildren(
    ...open.map((it) => {
      const ready = it.documents.filter((d) => d.signatures.expert && !d.signatures.org);
      return el('li', { 'data-item': it.order_ref }, ...head(it),
        ...(waiting(it) && ready.length > 1 ? [el('button', { 'data-action': 'org-sign-all', onclick: () => signAll(ready) }, `Подписать все файлы дела (${ready.length})`)] : []),
        el('ul', { class: 'list' }, ...it.documents.map((d) => docItem(d, it.returns ?? []))),
        ...returnsBlock(it.returns ?? []));
    }),
    ...(done.length ? [el('li', { class: 'group', text: `Подписано · ${done.length}` })] : []),
    ...done.map((it) => el('li', { class: 'signed', 'data-item': it.order_ref },
      el('details', {}, el('summary', { text: `${it.service} · ${it.order_ref} · подписано` }), ...head(it).slice(1),
        el('ul', { class: 'list' }, ...it.documents.map((d) => docItem(d, []))), ...returnsBlock(it.returns ?? [])))));
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

// До подписи от организации (2.93): по последнему возврату этого файла — что эксперт отметил исправленным, что осталось.
function lastReturnState(d, returns) {
  const r = [...returns].reverse().find((x) => x.document_id === d.id && x.items?.length);
  if (!r) return [];
  const done = r.items.length - r.left;
  const left = r.items.filter((p) => !p.fixed);
  return [el('div', { class: left.length ? 'sig-state warn' : 'sig-state', 'data-role': 'points-state',
    text: `По Вашему замечанию от ${new Date(r.at).toLocaleDateString('ru-RU')}: эксперт отметил исправленными ${done} из ${r.items.length}${left.length ? ', осталось:' : ''}` }),
  ...(left.length ? [pointsList(left)] : [])];
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

function docItem(d, returns) {
  const { expert, org } = d.signatures;
  const lines = [];
  if (expert) lines.push(...signatureLines(expert));
  else lines.push(el('div', { class: 'sig-state', text: 'Эксперт ещё не подписал — подпись организации после него' }));
  if (org) lines.push(...signatureLines(org));
  else if (expert) {
    lines.push(...lastReturnState(d, returns), el('div', { class: 'row' },
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
    el('div', { class: 'row' },
      el('button', { class: 'danger', 'data-action': 'org-return-send', onclick: () => sendReturn(d, area.value) }, 'Вернуть с замечанием'),
      el('button', { class: 'secondary', onclick: () => box.classList.add('hidden') }, 'Отмена')));
  const open = el('button', { class: 'secondary', 'data-action': 'org-return', onclick: () => { box.classList.remove('hidden'); area.focus(); } }, 'Вернуть эксперту');
  return el('div', {}, el('div', { class: 'row' }, open), box);
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
