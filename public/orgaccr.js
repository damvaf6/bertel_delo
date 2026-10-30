// Аккредитации организации в банках (2.451): руководитель вносит банк, решение, срок и копию; сотрудники видят и скачивают.
// Тексты — только через textContent.
import { api, el, say, formatSize } from '/common.js';
import { dayRu } from '/order.js';

const $ = (id) => document.getElementById(id);
const MAX_FILE = 3 * 1024 * 1024; // облако: запрос не больше 3,5 МБ (2.49)
const STATE = { expired: 'срок истёк', soon: 'срок кончается' };
let org = null;
let editing = null;

export async function loadOrgAccreditations(current) {
  org = current;
  const box = $('org-accr-box');
  say($('org-accr-msg'), '');
  if (!org.my_role) { box.classList.add('hidden'); return; }
  resetForm();
  render(await api('GET', `/api/orgs/${org.id}/accreditations`));
  box.classList.remove('hidden');
}

function details(i) {
  return [
    i.number ? `№ ${i.number}` : null,
    i.issued_on ? `решение от ${dayRu(i.issued_on)}` : null,
    i.valid_until ? `до ${dayRu(i.valid_until)}` : 'без срока',
  ].filter(Boolean).join(' · ');
}

function render(r) {
  if (!$('org-accr-bank').options.length) {
    $('org-accr-bank').replaceChildren(...r.banks.map((b) => el('option', { value: b.id, text: b.name })));
    applyBank();
  }
  $('org-accr-form').classList.toggle('hidden', !r.manage);
  $('org-accr-empty').classList.toggle('hidden', r.items.length > 0);
  $('org-accr-items').replaceChildren(...r.items.map((i) => {
    const fileId = `org-accr-file-${i.id}`;
    return el('li', { 'data-accr': i.id },
      el('div', { class: 'row' },
        el('span', { class: 'title', text: i.title }),
        ...(STATE[i.state] ? [el('span', { class: 'badge overdue', text: STATE[i.state] })] : [])),
      el('div', { class: 'muted', text: details(i) }),
      el('div', { class: 'muted', text: i.file ? `Копия: ${i.file.name} (${formatSize(i.file.size_bytes)})` : 'Копия не загружена' }),
      el('div', { class: 'row' },
        ...(r.manage ? [el('label', { class: 'btn secondary', for: fileId, text: i.file ? 'Заменить копию' : 'Загрузить копию' }),
          el('input', { id: fileId, type: 'file', class: 'visually-hidden', 'aria-label': `Копия: ${i.title}`, onchange: (e) => upload(i, e) })] : []),
        ...(i.file ? [el('button', { type: 'button', class: 'secondary', onclick: () => download(i) }, 'Скачать')] : []),
        ...(r.manage ? [el('button', { type: 'button', class: 'secondary', onclick: () => edit(i) }, 'Изменить'),
          el('button', { type: 'button', class: 'danger', onclick: () => remove(i) }, 'Убрать')] : [])));
  }));
}

function applyBank() {
  $('org-accr-title-box').classList.toggle('hidden', $('org-accr-bank').value !== 'other');
}

function resetForm() {
  editing = null;
  $('org-accr-form').reset();
  $('org-accr-form-title').textContent = 'Добавить аккредитацию';
  $('org-accr-save').textContent = 'Добавить';
  $('org-accr-cancel').classList.add('hidden');
  applyBank();
}

function edit(i) {
  editing = i;
  $('org-accr-bank').value = i.bank;
  $('org-accr-title').value = i.bank === 'other' ? i.title : '';
  $('org-accr-number').value = i.number ?? '';
  $('org-accr-issued').value = i.issued_on ?? '';
  $('org-accr-until').value = i.valid_until ?? '';
  applyBank();
  $('org-accr-form-title').textContent = `Изменить: ${i.title}`;
  $('org-accr-save').textContent = 'Сохранить';
  $('org-accr-cancel').classList.remove('hidden');
  $('org-accr-form').scrollIntoView({ block: 'start' });
}

async function upload(i, e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > MAX_FILE) return say($('org-accr-msg'), 'Файл больше 3 МБ — сохраните скан с меньшим разрешением');
  say($('org-accr-msg'), 'Загружаем…', 'ok');
  try {
    render(await api('POST', `/api/orgs/${org.id}/accreditations/${i.id}/file`, file, {
      'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name),
    }));
    say($('org-accr-msg'), 'Копия сохранена', 'ok');
  } catch (err) { say($('org-accr-msg'), err.message); }
}

async function download(i) {
  try {
    const { url } = await api('GET', `/api/orgs/${org.id}/accreditations/${i.id}/file`);
    location.href = url;
  } catch (err) { say($('org-accr-msg'), err.message); }
}

async function remove(i) {
  if (!confirm(`Убрать аккредитацию: ${i.title}?`)) return;
  try {
    render(await api('DELETE', `/api/orgs/${org.id}/accreditations/${i.id}`));
    if (editing?.id === i.id) resetForm();
    say($('org-accr-msg'), 'Аккредитация убрана', 'ok');
  } catch (err) { say($('org-accr-msg'), err.message); }
}

$('org-accr-bank').addEventListener('change', applyBank);
$('org-accr-cancel').addEventListener('click', () => { resetForm(); say($('org-accr-msg'), ''); });

$('org-accr-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = (id) => $(id).value.trim() || null;
  const body = { bank: $('org-accr-bank').value, title: v('org-accr-title'), number: v('org-accr-number'),
    issued_on: v('org-accr-issued'), valid_until: v('org-accr-until') };
  try {
    const was = editing;
    const data = was
      ? await api('PUT', `/api/orgs/${org.id}/accreditations/${was.id}`, body)
      : await api('POST', `/api/orgs/${org.id}/accreditations`, body);
    resetForm();
    render(data);
    say($('org-accr-msg'), was ? 'Сохранено' : 'Аккредитация добавлена — загрузите копию решения банка', 'ok');
  } catch (err) { say($('org-accr-msg'), err.message); }
});
