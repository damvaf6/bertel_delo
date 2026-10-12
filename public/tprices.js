// Цены и правила перевода (2а.9). Администратору в «Управлении»: действующие значения по группам (рубли, числа, да/нет),
// рядом — стартовое значение, если его меняли; сохранить; история — кто, когда, что изменилось.
import { api, el, say } from '/common.js';

const $ = (id) => document.getElementById(id);
const timeRu = (s) => `${new Date(s).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })} МСК`;
const rubText = (kop) => (kop / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 }).replace(/\s/g, ' ');
const shown = (f, v) => (f.kind === 'rub' ? `${rubText(v)} ₽` : f.kind === 'bool' ? (v ? 'да' : 'нет') : f.kind === 'factor' ? `×${String(v).replace('.', ',')}` : String(v));

let fields = [];

export async function loadTranslationPrices() {
  let settings;
  try {
    ({ settings } = await api('GET', '/api/admin/translation-settings'));
  } catch (err) { say($('tp-msg'), err.message); return; }
  render(settings);
}

function render(s) {
  fields = s.fields;
  $('tp-commission').textContent = String(s.commission_percent);
  const groups = [...new Set(fields.map((f) => f.group))];
  $('tp-fields').replaceChildren(...groups.map((g) => el('fieldset', { class: 'field' }, el('legend', { text: g }),
    ...fields.filter((f) => f.group === g).map(fieldRow))));
  $('tp-history-empty').classList.toggle('hidden', s.history.length > 0);
  $('tp-history').replaceChildren(...s.history.map((h) => el('li', { 'data-tp-change': h.id },
    el('div', { class: 'title', text: `${timeRu(h.at)}${h.by ? ` · ${h.by}` : ''}` }),
    ...h.changes.map((c) => el('div', { class: 'muted', text: `${c.title}: ${c.from} → ${c.to}` })))));
}

function fieldRow(f) {
  const id = `tp-${f.key}`;
  const hint = f.value !== f.default ? el('div', { class: 'muted', text: `стартовое: ${shown(f, f.default)}` }) : null;
  if (f.kind === 'bool') {
    const box = el('input', { type: 'checkbox', id, 'data-tp': f.key });
    box.checked = !!f.value;
    return el('div', {}, el('label', { class: 'row check-line' }, box, el('span', { text: f.title })), ...(hint ? [hint] : []));
  }
  const unit = f.kind === 'rub' ? ', ₽' : '';
  const input = el('input', { id, 'data-tp': f.key, type: 'text', inputmode: f.kind === 'int' ? 'numeric' : 'decimal', autocomplete: 'off' });
  input.value = f.kind === 'rub' ? rubText(f.value) : String(f.value).replace('.', ',');
  return el('div', { class: 'field' }, el('label', { for: id, text: `${f.title}${unit}` }), input, ...(hint ? [hint] : []));
}

// Значение из поля: рубли → копейки; запятая или точка; пробелы в числе не мешают. null — не число.
function valueOf(f, node) {
  if (f.kind === 'bool') return node.checked;
  const t = node.value.replace(/[\s ]/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return f.kind === 'rub' ? Math.round(n * 100) : n;
}

$('tprices-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const values = {};
  for (const f of fields) {
    const v = valueOf(f, $(`tp-${f.key}`));
    if (v === null) { say($('tp-msg'), `«${f.title}»: введите число`); $(`tp-${f.key}`).focus(); return; }
    values[f.key] = v;
  }
  try {
    const r = await api('PUT', '/api/admin/translation-settings', { values });
    render(r.settings);
    say($('tp-msg'), r.changes.length ? `Сохранено. Изменено: ${r.changes.map((c) => `${c.title} — ${c.to}`).join('; ')}` : 'Ничего не изменилось', 'ok');
  } catch (err) { say($('tp-msg'), err.message); }
});
