// Свои заготовки абзацев у эксперта (2.87): допущения, оговорки, формулировки выводов. Вставка — в черновик, туда, где
// стоит курсор; сохранить правку черновика человек нажимает сам. Тексты — через textContent и value.
import { api, el, say } from '/common.js';

const $ = (id) => document.getElementById(id);
const BASE = '/api/specialist/me/snippets';
let list = null;     // заготовки эксперта; null — не загружены (или человек не специалист)
let editing = null;  // id заготовки в правке
let onInsert = () => {};

// Показать блок в черновике, который можно править; afterInsert — что сделать после вставки (пересчёт пометок, копия правки).
export async function loadSnippets(show, afterInsert) {
  onInsert = afterInsert;
  const box = $('snip-box');
  if (!show) { box.classList.add('hidden'); return; }
  try {
    if (!list) render(await api('GET', BASE));
    box.classList.remove('hidden');
  } catch {
    box.classList.add('hidden');
  }
}

function render(r) {
  list = r.snippets;
  if (!$('snip-kind').options.length) $('snip-kind').replaceChildren(...r.kinds.map((k) => el('option', { value: k.id }, k.name)));
  const keep = $('snip-pick').value;
  const groups = r.kinds.map((k) => [k, list.filter((s) => s.kind === k.id)]).filter(([, items]) => items.length);
  $('snip-pick').replaceChildren(...groups.map(([k, items]) => el('optgroup', { label: k.name },
    ...items.map((s) => el('option', { value: s.id }, s.title)))));
  if (list.some((s) => s.id === keep)) $('snip-pick').value = keep;
  $('snip-use').classList.toggle('hidden', !list.length);
  preview();
}

const current = () => list?.find((s) => s.id === $('snip-pick').value) ?? null;
function preview() { $('snip-preview').textContent = current()?.body ?? ''; }
$('snip-pick').addEventListener('change', preview);

// Вставка в место курсора (на телефоне курсор остаётся там, где человек последний раз касался текста): отдельным абзацем.
$('snip-insert').addEventListener('click', () => {
  const s = current();
  if (!s) return;
  const t = $('draft-text');
  const at = t.selectionStart ?? t.value.length;
  const end = t.selectionEnd ?? at;
  const before = t.value.slice(0, at);
  const after = t.value.slice(end);
  const lead = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const tail = !after || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  t.value = before + lead + s.body + tail + after;
  const pos = (before + lead + s.body).length;
  t.focus();
  t.setSelectionRange(pos, pos);
  onInsert();
  say($('snip-msg'), `Вставлено: «${s.title}». Не забудьте сохранить правку черновика.`, 'ok');
});

$('snip-from-selection').addEventListener('click', () => {
  const t = $('draft-text');
  const sel = t.value.slice(t.selectionStart, t.selectionEnd).trim();
  if (!sel) return say($('snip-msg'), 'Сначала выделите абзац в тексте черновика');
  $('snip-body').value = sel;
  say($('snip-msg'), 'Текст взят из черновика — дайте заготовке название и сохраните', 'ok');
});

function resetForm() {
  editing = null;
  $('snip-form').reset();
  $('snip-form-title').textContent = 'Новая заготовка';
  $('snip-cancel').classList.add('hidden');
}

$('snip-edit').addEventListener('click', () => {
  const s = current();
  if (!s) return;
  editing = s.id;
  $('snip-kind').value = s.kind;
  $('snip-title').value = s.title;
  $('snip-body').value = s.body;
  $('snip-form-title').textContent = `Правка заготовки «${s.title}»`;
  $('snip-cancel').classList.remove('hidden');
  $('snip-title').focus();
});
$('snip-cancel').addEventListener('click', () => { resetForm(); say($('snip-msg'), ''); });

$('snip-remove').addEventListener('click', () => run($('snip-remove'), async () => {
  const s = current();
  if (!s || !confirm(`Убрать заготовку «${s.title}»? В делах, куда она уже вставлена, текст останется.`)) return;
  render(await api('DELETE', `${BASE}/${s.id}`));
  if (editing === s.id) resetForm();
  say($('snip-msg'), 'Заготовка убрана', 'ok');
}));

$('snip-form').addEventListener('submit', (e) => {
  e.preventDefault();
  run($('snip-save'), async () => {
    const body = { kind: $('snip-kind').value, title: $('snip-title').value, body: $('snip-body').value };
    if (!body.title.trim()) return say($('snip-msg'), 'Дайте заготовке название');
    if (!body.body.trim()) return say($('snip-msg'), 'Впишите текст заготовки или возьмите выделенное в черновике');
    const r = editing ? await api('PUT', `${BASE}/${editing}`, body) : await api('POST', BASE, body);
    const id = editing ?? r.id;
    render(r);
    $('snip-pick').value = id;
    preview();
    resetForm();
    say($('snip-msg'), 'Заготовка сохранена — её можно вставить в любое своё дело', 'ok');
  });
});

async function run(button, work) {
  button.disabled = true;
  try { await work(); } catch (err) { say($('snip-msg'), err.message); } finally { button.disabled = false; }
}
