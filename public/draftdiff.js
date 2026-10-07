// Что изменилось между версиями черновика (2.104): эксперт выбирает прошлую версию — по разделам видно, какие абзацы
// добавлены и какие убраны с тех пор. Сравнивается сохранённый текст. Тексты — через textContent.
import { api, el, say } from '/common.js';

const $ = (id) => document.getElementById(id);
const timeRu = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const SOURCE_RU = { ai: 'ИИ', edit: 'правка', past: 'разделы из прошлого дела' };
const STATUS_RU = { added: 'новый раздел', removed: 'раздел убран' };
let order = null;
let curId = null;       // id текущей версии черновика
let loadedFor = null;   // id текущей версии, для которой загружен список

const label = (v) => `${timeRu(v.at)} — ${SOURCE_RU[v.source] ?? v.source}${v.mine ? '' : ' (не Вы)'}`;

// Показать блок, когда версий больше одной; список версий грузится при раскрытии.
export function loadDraftDiff(current, draft) {
  order = current;
  curId = draft?.id ?? null;
  const box = $('diff-box');
  box.classList.toggle('hidden', !(draft && draft.versions > 1));
  if (loadedFor !== draft?.id) { loadedFor = null; $('diff-out').replaceChildren(); say($('diff-msg'), ''); }
  if (box.open && !box.classList.contains('hidden')) versions();
}

async function versions() {
  if (loadedFor === curId) return;
  try {
    const r = await api('GET', `/api/orders/${order.id}/draft/versions`);
    const past = r.versions.filter((v) => v.id !== curId);
    $('diff-from').replaceChildren(...past.map((v, i) => el('option', { value: v.id }, `${i === 0 ? 'Предыдущая: ' : ''}${label(v)}`)));
    $('diff-cur').textContent = r.versions[0] ? `Текущая версия: ${label(r.versions[0])}.` : '';
    loadedFor = curId;
  } catch (e) {
    say($('diff-msg'), e.message);
  }
}

$('diff-box').addEventListener('toggle', () => { if ($('diff-box').open) versions(); });

$('diff-show').addEventListener('click', async () => {
  const b = $('diff-show');
  b.disabled = true;
  try {
    const r = await api('GET', `/api/orders/${order.id}/draft/diff?from=${encodeURIComponent($('diff-from').value)}`);
    render(r);
  } catch (e) {
    say($('diff-msg'), e.message);
  } finally {
    b.disabled = false;
  }
});

function render(r) {
  if (!r.sections.length) {
    say($('diff-msg'), 'Текст не изменился', 'ok');
    $('diff-out').replaceChildren();
    return;
  }
  say($('diff-msg'), `С той версии: добавлено абзацев — ${r.added}, убрано — ${r.removed}; разделов с изменениями — ${r.sections.length}`, 'ok');
  $('diff-out').replaceChildren(...r.sections.map((s) => el('div', { class: 'diff-section' },
    el('h4', {}, s.title),
    ...(s.was_title || STATUS_RU[s.status] ? [el('p', { class: 'muted' }, s.was_title ? `было: «${s.was_title}»` : STATUS_RU[s.status])] : []),
    ...s.removed.map((t) => el('p', { class: 'diff-del' }, el('span', { class: 'diff-mark' }, 'убрано '), t)),
    ...s.added.map((t) => el('p', { class: 'diff-add' }, el('span', { class: 'diff-mark' }, 'добавлено '), t)),
  )));
}
