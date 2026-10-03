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
  $('org-sign').replaceChildren(...items.map((it) => el('li', {},
    el('div', { class: 'title', text: `${it.service} · ${it.order_ref}` }),
    el('div', { class: 'muted', text: [`Эксперт: ${it.executor}`, it.deadline ? `срок ${dayRu(it.deadline)}` : null].filter(Boolean).join(' · ') }),
    el('ul', { class: 'list' }, ...it.documents.map(docItem)))));
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
