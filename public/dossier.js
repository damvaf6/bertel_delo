// Досье эксперта (2.14) в разделе «Специалист»: документы, копии, сроки. Тексты — только через textContent.
import { api, el, say, formatSize } from '/common.js';
import { dayRu } from '/order.js';

const $ = (id) => document.getElementById(id);
const MAX_FILE = 5 * 1024 * 1024;
let kinds = [];
let editing = null; // запись, которую сейчас правим (null — добавляем новую)

const STATE = { expired: 'срок истёк', soon: 'срок кончается' };
const rub = (kop) => `${(kop / 100).toLocaleString('ru-RU')} руб.`;

function details(i) {
  return [
    i.number ? (i.kind === 'sro' ? `номер в реестре ${i.number}` : `№ ${i.number}`) : null,
    i.issued_on ? `от ${dayRu(i.issued_on)}` : null,
    i.amount_kop ? `сумма ${rub(i.amount_kop)}` : null,
    i.valid_until ? `до ${dayRu(i.valid_until)}` : null,
  ].filter(Boolean).join(' · ');
}

function render(data) {
  kinds = data.kinds;
  if (!$('dossier-kind').options.length) {
    $('dossier-kind').replaceChildren(...kinds.map((k) => el('option', { value: k.id, text: k.name })));
    applyKind();
  }
  const bad = data.alerts.filter((a) => a.state === 'expired');
  const soon = data.alerts.filter((a) => a.state === 'soon');
  const alert = [bad.length ? `Истёк срок: ${bad.map((a) => a.kind_name).join(', ')} — обновите, иначе в отчёте будут неверные сведения.` : null,
    soon.length ? `Скоро кончается срок: ${soon.map((a) => `${a.kind_name} (до ${dayRu(a.valid_until)})`).join(', ')}.` : null].filter(Boolean).join(' ');
  $('dossier-alert').textContent = alert;
  $('dossier-alert').className = `msg ${alert ? 'error' : 'hidden'}`;
  $('dossier-empty').classList.toggle('hidden', data.items.length > 0);
  $('dossier-items').replaceChildren(...data.items.map((i) => {
    const fileId = `dossier-file-${i.id}`;
    const input = el('input', { id: fileId, type: 'file', class: 'visually-hidden', 'aria-label': `Копия: ${i.kind_name}`, onchange: (e) => upload(i, e) });
    return el('li', { 'data-dossier': i.id },
      el('div', { class: 'row' },
        el('span', { class: 'title', text: i.kind_name }),
        ...(i.state && STATE[i.state] ? [el('span', { class: 'badge overdue', text: STATE[i.state] })] : [])),
      el('div', { text: i.title }),
      el('div', { class: 'muted', text: details(i) }),
      el('div', { class: 'muted', text: i.file ? `Копия: ${i.file.name} (${formatSize(i.file.size_bytes)})` : 'Копия не загружена' }),
      el('div', { class: 'row' },
        el('label', { class: 'btn secondary', for: fileId, text: i.file ? 'Заменить копию' : 'Загрузить копию' }), input,
        ...(i.file ? [el('button', { type: 'button', class: 'secondary', onclick: () => download(i) }, 'Скачать')] : []),
        el('button', { type: 'button', class: 'secondary', 'data-action': 'dossier-edit', onclick: () => edit(i) }, 'Изменить'),
        el('button', { type: 'button', class: 'danger', onclick: () => remove(i) }, 'Убрать')));
  }));
}

function applyKind() {
  const k = kinds.find((x) => x.id === $('dossier-kind').value);
  if (!k) return;
  $('dossier-title-label').textContent = k.title;
  $('dossier-number-label').textContent = k.number;
  for (const box of document.querySelectorAll('[data-dossier-field]')) {
    const f = box.getAttribute('data-dossier-field');
    box.classList.toggle('hidden', !k.has.includes(f));
  }
}

function resetForm() {
  editing = null;
  $('dossier-form').reset();
  $('dossier-kind').disabled = false;
  if ($('dossier-kind').options.length) $('dossier-kind').selectedIndex = 0;
  $('dossier-form-title').textContent = 'Добавить документ';
  $('dossier-save').textContent = 'Добавить';
  $('dossier-cancel').classList.add('hidden');
  applyKind();
}

function edit(i) {
  editing = i;
  $('dossier-kind').value = i.kind;
  $('dossier-kind').disabled = true;
  applyKind();
  $('dossier-title').value = i.title;
  $('dossier-number').value = i.number ?? '';
  $('dossier-issued').value = i.issued_on ?? '';
  $('dossier-until').value = i.valid_until ?? '';
  $('dossier-amount').value = i.amount_kop ? String(i.amount_kop / 100) : '';
  $('dossier-form-title').textContent = `Изменить: ${i.kind_name}`;
  $('dossier-save').textContent = 'Сохранить';
  $('dossier-cancel').classList.remove('hidden');
  $('dossier-form').scrollIntoView({ block: 'start' });
}

export async function showDossier() {
  say($('dossier-msg'), '');
  resetForm();
  render(await api('GET', '/api/specialist/me/dossier'));
  resetForm();
}

async function upload(i, e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > MAX_FILE) return say($('dossier-msg'), 'Файл больше 5 МБ');
  say($('dossier-msg'), 'Загружаем…', 'ok');
  try {
    render(await api('POST', `/api/specialist/me/dossier/${i.id}/file`, file, {
      'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name),
    }));
    say($('dossier-msg'), 'Копия сохранена', 'ok');
  } catch (err) { say($('dossier-msg'), err.message); }
}

async function download(i) {
  try {
    const { url } = await api('GET', `/api/specialist/me/dossier/${i.id}/file`);
    location.href = url;
  } catch (err) { say($('dossier-msg'), err.message); }
}

async function remove(i) {
  if (!confirm(`Убрать из досье: ${i.kind_name}? В уже сданных отчётах копия останется.`)) return;
  try {
    render(await api('DELETE', `/api/specialist/me/dossier/${i.id}`));
    if (editing?.id === i.id) resetForm();
    say($('dossier-msg'), 'Убрано из досье', 'ok');
  } catch (err) { say($('dossier-msg'), err.message); }
}

$('dossier-kind').addEventListener('change', applyKind);
$('dossier-cancel').addEventListener('click', () => { resetForm(); say($('dossier-msg'), ''); });

$('dossier-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const k = kinds.find((x) => x.id === $('dossier-kind').value);
  const val = (id, field) => (k.has.includes(field) ? $(id).value.trim() || null : null);
  const body = {
    title: $('dossier-title').value.trim(),
    number: val('dossier-number', 'number'),
    issued_on: val('dossier-issued', 'issued_on'),
    valid_until: val('dossier-until', 'valid_until'),
    amount_rub: val('dossier-amount', 'amount_kop'),
  };
  try {
    const data = editing
      ? await api('PUT', `/api/specialist/me/dossier/${editing.id}`, body)
      : await api('POST', '/api/specialist/me/dossier', { kind: k.id, ...body });
    const was = editing;
    render(data);
    resetForm();
    say($('dossier-msg'), was ? 'Сохранено' : 'Документ добавлен — загрузите копию', 'ok');
  } catch (err) { say($('dossier-msg'), err.message); }
});
