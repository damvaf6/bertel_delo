// Черновик заключения от ИИ (задача 2.2): исполнитель готовит черновик, правит его и прикладывает файлом результата;
// диспетчер только читает; заказчику блок не показывается (и сервер ему черновик не отдаёт). Тексты — через textContent.
import { api, el, say } from '/common.js';
import { state } from '/shell.js';
import { setNext } from '/next.js';
import { loadAnalogs } from '/analogs.js';
import { loadSnippets } from '/snippets.js';
import { loadDraftDiff } from '/draftdiff.js';

const $ = (id) => document.getElementById(id);
const timeRu = (s) => new Date(s).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
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
    `${c.ref} от ${new Date(c.at).toLocaleDateString('ru-RU')}`)));
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
