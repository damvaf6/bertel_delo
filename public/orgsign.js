// Подпись организации (2.5а): руководитель видит файлы результата экспертов, которые работают от его организации, и
// подписывает их от организации — в кабинете или готовой подписью с сертификатом организации. Саму заявку и заказчика
// руководитель не видит: только услугу, номер, эксперта, срок и файлы.
import { api, el, say, formatSize } from '/common.js';
import { signatureLines, uploadSignatureButton, SIGN_CONFIRM, UPLOAD_HINT } from '/sign.js';
import { dayRu } from '/order.js';

const $ = (id) => document.getElementById(id);
let current = null;

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
    el('div', { class: 'muted', text: [`Эксперт: ${it.executor}`, it.deadline ? `срок ${dayRu(it.deadline)}` : null].filter(Boolean).join(' · ') })];
  const open = items.filter((it) => !signedAll(it));
  const done = items.filter(signedAll);
  $('org-sign').replaceChildren(
    ...open.map((it) => {
      const ready = it.documents.filter((d) => d.signatures.expert && !d.signatures.org);
      return el('li', { 'data-item': it.order_ref }, ...head(it),
        ...(waiting(it) && ready.length > 1 ? [el('button', { 'data-action': 'org-sign-all', onclick: () => signAll(ready) }, `Подписать все файлы дела (${ready.length})`)] : []),
        el('ul', { class: 'list' }, ...it.documents.map(docItem)));
    }),
    ...(done.length ? [el('li', { class: 'group', text: `Подписано · ${done.length}` })] : []),
    ...done.map((it) => el('li', { class: 'signed', 'data-item': it.order_ref },
      el('details', {}, el('summary', { text: `${it.service} · ${it.order_ref} · подписано` }), ...head(it).slice(1),
        el('ul', { class: 'list' }, ...it.documents.map(docItem))))));
}

async function signAll(docs) {
  if (!confirm(`${SIGN_CONFIRM(docs.map((d) => d.filename).join(', '))}\n\nФайлов: ${docs.length}.`)) return;
  say($('org-sign-msg'), 'Подписываем…', 'ok');
  try {
    for (const d of docs) await api('POST', `/api/org-documents/${d.id}/sign`, { confirm: true });
    await loadOrgSign(current);
    say($('org-sign-msg'), `Подписано от организации файлов: ${docs.length}`, 'ok');
  } catch (err) { await loadOrgSign(current); say($('org-sign-msg'), err.message); }
}

function docItem(d) {
  const { expert, org } = d.signatures;
  const lines = [];
  if (expert) lines.push(...signatureLines(expert));
  else lines.push(el('div', { class: 'sig-state', text: 'Эксперт ещё не подписал — подпись организации после него' }));
  if (org) lines.push(...signatureLines(org));
  else if (expert) {
    lines.push(el('div', { class: 'row' },
      el('button', { 'data-action': 'org-sign', onclick: () => sign(d) }, 'Подписать от организации'),
      ...uploadSignatureButton(d.filename, (file) => upload(d, file))),
    el('div', { class: 'muted', text: `${UPLOAD_HINT} Нужен сертификат организации.` }));
  }
  return el('li', { class: 'doc', 'data-doc': d.id },
    el('div', {},
      el('div', { class: 'name', text: d.filename }),
      el('div', { class: 'muted', text: formatSize(d.size_bytes) })),
    el('div', { class: 'row' }, el('button', { class: 'secondary', 'data-action': 'download', onclick: () => download(d) }, 'Скачать')),
    el('div', { class: 'sig' }, ...lines));
}

async function sign(d) {
  if (!confirm(SIGN_CONFIRM(d.filename))) return;
  say($('org-sign-msg'), 'Подписываем…', 'ok');
  try {
    await api('POST', `/api/org-documents/${d.id}/sign`, { confirm: true });
    await loadOrgSign(current);
    say($('org-sign-msg'), 'Файл подписан от организации', 'ok');
  } catch (err) { say($('org-sign-msg'), err.message); }
}

async function upload(d, file) {
  if (!confirm(SIGN_CONFIRM(d.filename))) return;
  say($('org-sign-msg'), 'Проверяем подпись…', 'ok');
  try {
    await api('POST', `/api/org-documents/${d.id}/signature/upload`, file, { 'content-type': 'application/octet-stream', 'x-confirm': '1' });
    await loadOrgSign(current);
    say($('org-sign-msg'), 'Подпись организации проверена и добавлена', 'ok');
  } catch (err) { say($('org-sign-msg'), err.message); }
}

async function download(d) {
  try {
    const { url } = await api('GET', `/api/org-documents/${d.id}/link`);
    location.assign(url);
  } catch (err) { say($('org-sign-msg'), err.message); }
}
