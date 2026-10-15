// Черновик заключения от ИИ (задача 2.2): исполнитель готовит черновик, правит его и прикладывает файлом результата;
// диспетчер только читает; заказчику блок не показывается (и сервер ему черновик не отдаёт). Тексты — через textContent.
import { api, el, say } from '/common.js';
import { state } from '/shell.js';
import { setNext } from '/next.js';
import { loadAnalogs } from '/analogs.js';
import { loadSnippets } from '/snippets.js';
import { loadDraftDiff } from '/draftdiff.js';
import { emptySections } from '/draftempty.js';
import { findInDraft, swapAll, swapValue, unswapAll } from '/draftfind.js';

const $ = (id) => document.getElementById(id);
const timeRu = (s) => new Date(s).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const GAP = /\[(?:заполнить|описать)[^\]]*\]/gi;
let ctx = null;   // { order, draft, reload }

export async function loadDraft(current, reload) {
  const box = $('draft-box');
  const staff = ['dispatcher', 'admin'].includes(state.me.user.platform_role);
  const mine = !!current.executor?.is_me;
  if (!current.order.module || (!mine && !staff)) { box.classList.add('hidden'); return; }
  say($('draft-msg'), '');
  const r = await api('GET', `/api/orders/${current.order.id}/draft`);
  ctx = { order: current.order, draft: r.draft, reload };
  setNext({ draft: { exists: !!r.draft, approaches: r.approaches && r.can_edit ? r.approaches : null } });
  renderApproaches(r);
  // Исполнителю — пока дело в работе или черновик есть; служебным — только когда черновик есть.
  box.classList.toggle('hidden', !(r.can_ai || r.draft));
  if (box.classList.contains('hidden')) return;
  $('draft-ai').classList.toggle('hidden', !r.can_ai);
  $('draft-ai').textContent = r.draft ? 'Подготовить заново с помощью ИИ' : 'Подготовить черновик с помощью ИИ';
  await loadPast(r);
  $('draft-edit').classList.toggle('hidden', !r.draft);
  $('draft-actions').classList.toggle('hidden', !(r.draft && r.can_edit));
  $('draft-sources-box').classList.toggle('hidden', !(r.draft && r.can_edit && r.sections.some((s) => s.sources)));
  $('draft-word-box').classList.toggle('hidden', !(r.draft && mine));
  $('draft-text').readOnly = !r.can_edit;
  $('draft-text').value = r.draft?.body ?? '';
  // Несохранённая правка с этого телефона (ушли со страницы, не нажав «Сохранить») — восстанавливается (2.19).
  const local = r.can_edit && r.draft ? readLocal(ctx.order.id) : null;
  const restore = !!local && local.from === r.draft.id && local.body !== r.draft.body;
  if (restore) $('draft-text').value = local.body;
  else dropLocal(ctx.order.id);
  $('draft-local').classList.toggle('hidden', !restore);
  $('draft-confirm').checked = false;
  $('draft-state').textContent = stateText(r);
  countGaps();
  syncFixButtons();
  // Что изменилось между версиями (2.104).
  loadDraftDiff(ctx.order, r.draft);
  // Свои заготовки абзацев (2.87): вставка считается правкой — пометки пересчитываются, правка помнится на телефоне.
  await loadSnippets(!!(r.draft && r.can_edit), () => $('draft-text').dispatchEvent(new Event('input')));
}

// Методические разделы из своего прошлого дела той же услуги (2.65): стандарты, допущения, выбор подходов, методика.
// Остальные разделы не меняются; данные прошлого заказчика и объекта сервер вычищает — на их месте пометки «заполнить».
async function loadPast(r) {
  const box = $('draft-past');
  const p = r.can_edit && r.sections.some((s) => s.reuse) ? await api('GET', `/api/orders/${ctx.order.id}/draft/past`) : null;
  box.classList.toggle('hidden', !p?.cases.length);
  if (!p?.cases.length) return;
  $('draft-past-hint').textContent = `Возьмутся: ${p.sections.map((t) => `«${t.replace(/^\d+\.\s*/, '')}»`).join(', ')}. `
    + 'Остальные разделы не изменятся. Имена, адреса, номера и суммы прошлого дела заменятся пометками «заполнить».';
  $('draft-past-case').replaceChildren(...p.cases.map((c) => el('option', { value: c.id },
    `${c.ref} от ${new Date(c.at).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })}`)));
}

$('draft-past-take').addEventListener('click', () => run($('draft-past-take'), async () => {
  if (ctx.draft && !confirm('Заменить методические разделы черновика текстом из прошлого дела? Текущий текст останется в истории.')) return;
  if (ctx.draft && $('draft-text').value.trim() !== ctx.draft.body) await save();
  const r = await api('POST', `/api/orders/${ctx.order.id}/draft/past`, { past_id: $('draft-past-case').value, from: ctx.draft?.id ?? null });
  await loadDraft({ order: ctx.order, executor: { is_me: true } }, ctx.reload);
  const p = r.draft.inputs.past;
  say($('draft-msg'), `Взято разделов: ${p.sections.length}${p.marks ? `; данных прошлого дела убрано: ${p.marks} — заполните пометки` : ''}`, 'ok');
}));

// Подходы к оценке (2.33): отметка сохраняется сразу; черновик после смены подходов лучше подготовить заново.
function renderApproaches(r) {
  const box = $('draft-approaches');
  const a = r.approaches;
  box.classList.toggle('hidden', !a || !(r.can_edit || a.chosen));
  if (!a) return;
  $('draft-approaches-list').replaceChildren(...a.list.map((x) => {
    const id = `draft-approach-${x.id}`;
    return el('label', { class: 'row gap', for: id },
      el('input', { type: 'checkbox', id, value: x.id, ...(a.chosen?.includes(x.id) ? { checked: '' } : {}), ...(r.can_edit ? {} : { disabled: '' }), onchange: saveApproaches }),
      ` ${x.name}`);
  }));
}

async function saveApproaches() {
  const chosen = [...document.querySelectorAll('#draft-approaches-list input:checked')].map((i) => i.value);
  try {
    await api('PUT', `/api/orders/${ctx.order.id}/approaches`, { approaches: chosen });
    // Без перезагрузки страницы (эксперт остаётся на месте): черновик, аналоги и «Что дальше» пересчитываются.
    const current = { order: ctx.order, executor: { is_me: true } };
    await Promise.all([loadDraft(current, ctx.reload), loadAnalogs(current)]);
    say($('draft-msg'), ctx.draft ? 'Подходы сохранены — подготовьте черновик заново, чтобы разделы совпали' : 'Подходы сохранены', 'ok');
  } catch (e) {
    say($('draft-msg'), e.message, 'error');
  }
}

// Пометки «[заполнить…]» в тексте: сколько осталось и переход к следующей (2.19).
function countGaps() {
  const n = ($('draft-text').value.match(GAP) ?? []).length;
  $('draft-gaps').textContent = n ? `Осталось пометок: ${n}` : 'Пометок не осталось';
  $('draft-next-gap').classList.toggle('hidden', !n || $('draft-text').readOnly);
  renderEmpty();
}

// Пустые разделы перед сборкой Word (2.177): список по тексту на экране; нажатие — к разделу в тексте (выделяется пометка
// «[заполнить…]», если она там есть, иначе курсор встаёт под заголовок). Служебным, которые только читают, список не нужен.
function renderEmpty() {
  const t = $('draft-text');
  const list = t.readOnly ? [] : emptySections(t.value);
  $('draft-empty').classList.toggle('hidden', !list.length);
  if (!list.length) return $('draft-empty-list').replaceChildren();
  $('draft-empty-text').textContent = `Ещё пустые разделы: ${list.length}. Заполните их до сборки Word или уберите лишние — нажмите, чтобы перейти к разделу.`;
  $('draft-empty-list').replaceChildren(...list.map((s) => el('button', {
    type: 'button', class: 'secondary', onclick: () => toSection(s.title),
  }, s.title)));
}

function toSection(title) {
  const t = $('draft-text');
  const s = emptySections(t.value).find((x) => x.title === title);
  if (!s) return renderEmpty();
  const next = t.value.slice(s.end).search(/\n#{1,3}\s*\S/);
  const stop = next < 0 ? t.value.length : s.end + next;
  const gap = new RegExp(GAP.source, 'i').exec(t.value.slice(s.end, stop));
  const from = gap ? s.end + gap.index : Math.min(s.end + 1, t.value.length);
  t.scrollIntoView({ block: 'center' });
  t.focus();
  t.setSelectionRange(from, gap ? from + gap[0].length : from);
}
// 2.229: «Исправить в черновике» у находки ИИ-проверки по выписке ЕГРН (work.js) — только пока черновик можно править;
// 2.231 — и у находки, сверенной с заявкой или заданием на оценку.
export const canFixInDraft = () => !!ctx?.draft && !$('draft-text').readOnly && !$('draft-box').classList.contains('hidden');
function syncFixButtons() {
  for (const b of document.querySelectorAll('[data-action="egrn-draft"], [data-action="fix-draft"], [data-action="egrn-swap"], [data-action="egrn-swap-all"]')) b.classList.toggle('hidden', !canFixInDraft());
}
// Выделяет в тексте черновика значение, которое разошлось с выпиской (заявкой, заданием); в черновике его нет — false
// (правят в файле отчёта).
export function fixInDraft(g, quote) {
  const t = $('draft-text');
  const at = canFixInDraft() ? findInDraft(t.value, { bad: g.bad, quote }) : null;
  if (!at) return false;
  t.scrollIntoView({ block: 'center' });
  t.focus();
  t.setSelectionRange(at.from, at.to);
  say($('draft-msg'), `Выделено «${t.value.slice(at.from, at.to)}» — ${g.from || 'в выписке ЕГРН'}: ${g.right}. Исправьте и сохраните черновик, затем соберите Word заново.`, 'ok');
  return true;
}

// 2.232: «Заменить на значение из выписки» — одной кнопкой: значение в тексте черновика меняется на то, что в выписке ЕГРН,
// черновик сохраняется (новая версия); → { from, was, now } для «Отменить» или null (в черновике значения нет).
export async function swapInDraft(g, quote) {
  const t = $('draft-text');
  const at = canFixInDraft() ? findInDraft(t.value, { bad: g.bad, quote }) : null;
  if (!at) return null;
  const was = t.value.slice(at.from, at.to);
  const now = swapValue(g, was);
  if (!now) return null;
  await putText(t.value.slice(0, at.from) + now + t.value.slice(at.to), at.from, now.length);
  return { from: at.from, was, now };
}
// Отмена замены: на том же месте ещё стоит новое значение — возвращается прежнее; текст там уже правили — false.
export async function undoSwap(s) {
  const t = $('draft-text');
  if (!canFixInDraft() || t.value.slice(s.from, s.from + s.now.length) !== s.now) return false;
  await putText(t.value.slice(0, s.from) + s.was + t.value.slice(s.from + s.now.length), s.from, s.was.length);
  return true;
}
// 2.246: «Заменить всё по выписке» — все замены сразу, черновик сохраняется одной новой версией; → { done, missing }
// (swapAll) или null (черновик сейчас не правится).
export async function swapAllInDraft(items) {
  const t = $('draft-text');
  if (!canFixInDraft()) return null;
  const r = swapAll(t.value, items);
  if (r.done.length) await putText(r.body, r.done[0].from, r.done[0].now.length);
  return { done: r.done, missing: r.missing };
}
// Отмена всех замен одной версией; → { undone, kept } (unswapAll) или null.
export async function undoSwapAll(done) {
  const t = $('draft-text');
  if (!canFixInDraft()) return null;
  const r = unswapAll(t.value, done);
  const first = done.find((s) => r.undone.includes(s.i));
  if (first) await putText(r.body, first.from, first.was.length);
  return { undone: r.undone, kept: r.kept };
}
// Новый текст — на экран и в черновик; не сохранилось — на экране прежний текст.
async function putText(body, from, len) {
  const t = $('draft-text');
  const before = t.value;
  t.value = body;
  try { await save(); } catch (err) { t.value = before; throw err; }
  countGaps();
  t.scrollIntoView({ block: 'center' });
  t.focus();
  t.setSelectionRange(from, from + len);
}

$('draft-text').addEventListener('input', () => {
  countGaps();
  if (ctx?.draft) writeLocal(ctx.order.id, { from: ctx.draft.id, body: $('draft-text').value });
});
$('draft-next-gap').addEventListener('click', () => {
  const t = $('draft-text');
  const re = new RegExp(GAP.source, 'gi');
  re.lastIndex = t.selectionEnd || 0;
  let m = re.exec(t.value);
  if (!m) { re.lastIndex = 0; m = re.exec(t.value); }
  if (!m) return;
  t.focus();
  t.setSelectionRange(m.index, m.index + m[0].length);
});

// Только удобство на этом телефоне: хранилище браузера может быть недоступно — тогда просто без восстановления.
const KEY = (id) => `delo-draft-${id}`;
function readLocal(id) { try { return JSON.parse(localStorage.getItem(KEY(id)) || 'null'); } catch { return null; } }
function writeLocal(id, v) { try { localStorage.setItem(KEY(id), JSON.stringify(v)); } catch { /* без восстановления */ } }
function dropLocal(id) { try { localStorage.removeItem(KEY(id)); } catch { /* ничего */ } }

// 2.222: и этаж с этажностью, и адрес.
const EGRN_WHAT = {
  area: { one: 'Площадь', many: 'площади', unit: ' кв. м', join: ' и ', pick: 'верную' },
  cadastral: { one: 'Кадастровый номер', many: 'кадастровые номера', unit: '', join: ', ', pick: 'верный' },
  floor: { one: 'Этаж / этажей в доме', many: 'этаж и этажность', unit: '', join: ', ', pick: 'верные' },
  address: { one: 'Адрес', many: 'адреса', unit: '', join: '; ', pick: 'верный' },
  // 2.243: права и обременения — из выписки на объект.
  holders: { one: 'Правообладатель:', many: 'правообладатели', unit: '', join: '; ', pick: 'верного' },
  kind: { one: 'Вид права:', many: 'виды права', unit: '', join: '; ', pick: 'верный' },
  enc: { one: 'Ограничения и обременения:', many: 'обременения', unit: '', join: '; ', pick: 'верные' },
};
function egrnLine(k, e) {
  if (!e) return null;
  const w = EGRN_WHAT[k];
  if (e.values) return `В выписках ЕГРН разные ${w.many} (${e.values.join(w.join)}${w.unit}) — впишите ${w.pick} сами.`;
  // Выписка только на здание: этажа помещения в ней нет — только этажность.
  const v = e.v ?? (k === 'floor' && e.floors != null ? `этажей ${e.floors}${e.above != null ? `, надземных ${e.above}` : ''}` : null);
  if (!v) return null;
  return `${w.one} ${v}${w.unit} — как в выписке ЕГРН «${e.name}» (стр. ${e.page})${e.typed ? `; в заявке — ${e.typed}${w.unit}` : ''} — сверьте.`;
}

function stateText(r) {
  const d = r.draft;
  if (!d) {
    return 'ИИ подготовит черновик по данным заявки, документам и списку фото. Это только помощь: расчёт, выводы и описание '
      + 'фото — за Вами; заказчик черновик не увидит.';
  }
  const gaps = (d.body.match(GAP) ?? []).length;
  return [
    d.source === 'ai' ? `Черновик подготовил ИИ ${timeRu(d.at)} — проверьте каждое слово и число.`
      : d.source === 'past' ? `Методические разделы взяты из Вашего прошлого дела ${timeRu(d.at)} — проверьте, что они подходят к этому делу.`
        : `Последняя правка — ${timeRu(d.at)}.`,
    // Дата оценки из приложенного задания (2.207): откуда взята; в документах разные даты — выбрать эксперту.
    d.inputs?.value_date?.day ? `Дата оценки ${d.inputs.value_date.day} — как ${d.inputs.value_date.what} «${d.inputs.value_date.name}» (стр. ${d.inputs.value_date.page}) — сверьте.` : null,
    d.inputs?.value_date?.days ? `В приложенных документах разные даты оценки (${d.inputs.value_date.days.join(', ')}) — впишите верную сами.` : null,
    // Площадь и кадастровый номер (2.211), этаж и адрес (2.222) из выписки ЕГРН: откуда взяты; в выписках разные — выбрать эксперту.
    ...['area', 'cadastral', 'floor', 'address'].map((k) => egrnLine(k, d.inputs?.egrn?.[k])),
    // Правообладатель, вид права и обременения (2.243).
    ...['holders', 'kind', 'enc'].map((k) => egrnLine(k, d.inputs?.egrn?.rights?.[k])),
    d.inputs?.photos?.length ? `Фото в черновике: ${d.inputs.photos.length} (сами снимки ИИ не видит — опишите их).` : null,
    gaps ? `Осталось заполнить мест: ${gaps} (в квадратных скобках).` : null,
    r.can_edit ? 'Итоговый файл приложите, когда текст готов: он уйдёт на проверку вместе с результатом.' : 'Черновик видят только исполнитель и диспетчер.',
  ].filter(Boolean).join(' ');
}

async function run(button, work) {
  button.disabled = true;
  try { await work(); } catch (err) { say($('draft-msg'), err.message); } finally { button.disabled = false; }
}

$('draft-ai').addEventListener('click', () => run($('draft-ai'), async () => {
  if (ctx.draft && !confirm('Подготовить черновик заново? Текущий текст останется в истории, но на экране его заменит новый.')) return;
  say($('draft-msg'), 'ИИ готовит черновик…', 'ok');
  await api('POST', `/api/orders/${ctx.order.id}/draft/ai`, { from: ctx.draft?.id ?? null });
  await loadDraft({ order: ctx.order, executor: { is_me: true } }, ctx.reload);
  say($('draft-msg'), 'Черновик готов — проверьте и поправьте', 'ok');
}));

async function save() {
  const r = await api('PUT', `/api/orders/${ctx.order.id}/draft`, { body: $('draft-text').value, from: ctx.draft?.id ?? null });
  ctx.draft = r.draft;
  dropLocal(ctx.order.id);
  $('draft-local').classList.add('hidden');
  $('draft-state').textContent = stateText({ draft: r.draft, can_edit: true });
  loadDraftDiff(ctx.order, r.draft);
}

// Перечень использованных документов (2.95): собирается заново из дела; несохранённая правка сначала сохраняется.
$('draft-sources').addEventListener('click', () => run($('draft-sources'), async () => {
  if ($('draft-text').value.trim() !== ctx.draft.body) await save();
  const r = await api('POST', `/api/orders/${ctx.order.id}/draft/sources`, { from: ctx.draft.id });
  await loadDraft({ order: ctx.order, executor: { is_me: true } }, ctx.reload);
  say($('draft-msg'), `Перечень обновлён: документов в нём — ${r.items}`, 'ok');
}));

$('draft-save').addEventListener('click', () => run($('draft-save'), async () => {
  await save();
  say($('draft-msg'), 'Правка сохранена', 'ok');
}));

// Файл Word черновика (2.29): несохранённая правка сначала сохраняется — в файл идёт то, что на экране.
$('draft-word').addEventListener('click', () => run($('draft-word'), async () => {
  if (!$('draft-text').readOnly && $('draft-text').value.trim() !== ctx.draft.body) await save();
  location.href = `/api/orders/${ctx.order.id}/draft/docx`;
  say($('draft-msg'), 'Файл Word скачивается', 'ok');
}));

$('draft-attach').addEventListener('click', () => run($('draft-attach'), async () => {
  if (!$('draft-confirm').checked) return say($('draft-msg'), 'Отметьте, что Вы проверили текст и отвечаете за него');
  if ($('draft-text').value.trim() !== ctx.draft.body) await save();
  const { document: doc } = await api('POST', `/api/orders/${ctx.order.id}/draft/result`, { from: ctx.draft.id, confirm: true });
  await ctx.reload();
  say($('draft-msg'), `Файл «${doc.filename}» добавлен в результат работы`, 'ok');
}));
