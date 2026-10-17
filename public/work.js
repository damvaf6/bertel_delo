// Работа по делу (задача 1.5): проверка результата по правилам и переписка по заявке. Тексты — только через textContent.
import { api, el, say } from '/common.js';
import { setNext } from '/next.js';
import { canFixInDraft, fixInDraft, rebuildWord, swapAllInDraft, swapInDraft, undoSwap, undoSwapAll } from '/draft.js';
import { findInDraft, swapValue } from '/draftfind.js';

const $ = (id) => document.getElementById(id);
const SIDE_RU = { customer: 'Заказчик', executor: 'Исполнитель', dispatcher: 'Диспетчер' };
const VERDICT_RU = { ok: 'В порядке', issue: 'Замечание' };
const timeRu = (s) => new Date(s).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
let orderRef = null;
// 2.246: находки по выписке ЕГРН, которые можно заменить одной кнопкой (egrnSwap), — для «Заменить всё по выписке».
let swaps = [];
let swapsReady = false;
// 2.258: для подсказки в окне подписи — сколько замен по выписке ещё можно сделать в тексте черновика (left) и сколько
// уже сделано (done); null — ИИ-проверка ещё не показана или черновик сейчас не правится.
export function egrnSwapState() {
  if (!swapsReady || !canFixInDraft()) return null;
  const body = $('draft-text').value;
  const open = swaps.filter((s) => !s.swapped());
  return { left: open.filter((s) => findInDraft(body, { bad: s.g.bad, quote: s.quote })).length, done: swaps.length - open.length };
}
const swapped = () => document.dispatchEvent(new CustomEvent('egrn-swapped'));
// 2.262: пункт замечания руководителя из расхождения с выпиской ЕГРН ({ rule, right }) — та же находка в ИИ-проверке, что
// можно заменить одной кнопкой: { state: 'open' | 'done' | 'missing', was, now, swap() } или null (находки нет).
const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
export function egrnSwapFor(link) {
  if (!swapsReady || !canFixInDraft() || !link?.rule) return null;
  const same = swaps.filter((s) => s.rule === link.rule);
  const s = link.right ? same.find((x) => norm(x.g.right) === norm(link.right)) : same.length === 1 ? same[0] : null;
  if (!s) return null;
  const d = s.result();
  if (d) return { state: 'done', ...d };
  if (s.swapped()) return { state: 'done', was: s.g.bad, now: s.g.right };
  if (!findInDraft($('draft-text').value, { bad: s.g.bad, quote: s.quote })) return { state: 'missing', was: s.g.bad, now: s.g.right };
  return { state: 'open', was: s.g.bad, now: s.g.right, swap: () => s.swap() };
}

// ——— Проверка результата ———

const AI_SIDE_RU = { executor: 'исполнитель перед сдачей', dispatcher: 'диспетчер' };

export async function loadReview(current) {
  const box = $('review-box');
  const { order } = current;
  say($('review-msg'), '');
  const r = await api('GET', `/api/orders/${order.id}/review`);
  setNext({ review: r });
  // Заказчику — только итог после выдачи; исполнителю и служебным — отметки по правилам, когда результат сдавали,
  // и подсказки ИИ (исполнитель может проверить результат с помощью ИИ ещё до сдачи).
  const on = (r.round > 0 && (r.details || ['done', 'closed'].includes(order.status))) || (r.details && (r.can_ai || !!r.ai));
  box.classList.toggle('hidden', !on);
  if (!on) return;
  const s = r.summary;
  let summary;
  if (r.round === 0) summary = 'Перед сдачей можно проверить результат с помощью ИИ по тем же правилам, что и при проверке.';
  else if (s.unchecked === 0 && s.issues === 0) summary = `Результат проверен: все правила (${s.total}) в порядке.`;
  else summary = `Круг проверки ${r.round}. В порядке: ${s.ok} из ${s.total}${s.issues ? `, замечаний: ${s.issues}` : ''}${s.unchecked ? `, не проверено: ${s.unchecked}` : ''}.`;
  $('review-summary').textContent = summary;
  // Вычитка (2а.7): почему нужна — исполнителю и служебным.
  $('review-proofread').textContent = r.details && r.proofread ? `Вычитка ${r.proofread.name}: прочитайте текст целиком и отметьте правило «Вычитка».` : '';
  $('review-proofread').classList.toggle('hidden', !(r.details && r.proofread));
  $('ai-review-box').classList.toggle('hidden', !r.details || (!r.can_ai && !r.ai));
  $('ai-review-run').classList.toggle('hidden', !r.can_ai);
  $('ai-review-run').onclick = () => runAi(order);
  $('ai-review-state').textContent = r.ai ? aiState(r.ai) : 'ИИ-проверка ещё не запускалась.';
  if (!r.details) { $('review-checks').replaceChildren(); $('review-rest-ok').classList.add('hidden'); return; }
  const hints = new Map((r.ai?.items ?? []).map((i) => [i.id, i]));
  // Короче на телефоне (2.191): вверху — «Посмотрите: N» с названиями правил, нажатие ведёт к правилу. Тому, кто не
  // ставит отметки (исполнитель), правила, где у ИИ нет замечаний и находок, — одной свёрнутой строкой.
  prevBox(r);
  recheckBox(order, r);
  const look = r.checks.filter((c) => hints.get(c.id)?.hint === 'attention');
  $('ai-review-look').classList.toggle('hidden', look.length === 0);
  $('ai-review-look').replaceChildren(...(look.length ? [el('span', { text: `Посмотрите: ${look.length} — ` }),
    ...look.map((c) => el('button', { type: 'button', class: 'link', 'data-look': c.id, 'aria-label': c.title, onclick: () => toRule(c.id) }, short(c.title)))] : []));
  const quiet = (c) => { const h = hints.get(c.id); return h?.hint === 'ok' && !h.found?.length && !h.marks?.length && !c.note && c.verdict !== 'issue'; };
  const fold = !r.can_mark && r.checks.filter(quiet).length > 1;
  swaps = [];
  swapsReady = false;
  const items = r.checks.filter((c) => !fold || !quiet(c)).map((c) => checkItem(order, r, c, hints.get(c.id)));
  if (fold) {
    const q = r.checks.filter(quiet);
    items.push(el('li', { class: 'ai-quiet' }, el('details', { class: 'ai-quiet' },
      el('summary', { text: `ИИ без замечаний: ${q.length} — ${q.map((c) => short(c.title)).join(', ')}` }),
      el('ul', { class: 'list' }, ...q.map((c) => checkItem(order, r, c, hints.get(c.id)))))));
  }
  $('review-checks').replaceChildren(...items);
  swapAllBox();
  swapsReady = true;
  document.dispatchEvent(new CustomEvent('egrn-swaps-ready'));
  // «Остальное в порядке» (разбор 03.10.2026, 2.18): правила без отметки, где у ИИ нет замечаний и находок, — одной
  // кнопкой. Правила с подсказкой «посмотрите» человек отмечает сам.
  const rest = r.can_mark ? r.checks.filter((c) => !c.verdict && r.ai && hints.get(c.id)?.hint === 'ok') : [];
  $('review-rest-ok').classList.toggle('hidden', rest.length === 0);
  $('review-rest-ok').textContent = `Остальное в порядке (${rest.length}: где у ИИ нет замечаний)`;
  $('review-rest-ok').onclick = async () => {
    if (!confirm(`Отметить «В порядке» правила, где у ИИ нет замечаний: ${rest.length}? Вы проверили их сами.`)) return;
    $('review-rest-ok').disabled = true;
    try {
      for (const c of rest) await api('PUT', `/api/orders/${order.id}/review/${c.id}`, { verdict: 'ok', round: r.round });
      await loadReview({ order });
      say($('review-msg'), `Отмечено «В порядке»: ${rest.length}`, 'ok');
    } catch (err) { await loadReview({ order }); say($('review-msg'), err.message); } finally { $('review-rest-ok').disabled = false; }
  };
  // Для возврата на доработку причина собирается из замечаний (диспетчер может её поправить).
  const issues = r.checks.filter((c) => c.verdict === 'issue');
  if (r.can_mark && issues.length && !$('reason').value.trim()) {
    $('reason').value = issues.map((c) => `${c.title}: ${c.note}`).join('; ').slice(0, 1000);
  }
}

// 2.246: «Заменить всё по выписке» — все находки по выписке ЕГРН, которые можно заменить (кроме уже заменённых по одной), —
// одной кнопкой, черновик сохраняется одной версией; под кнопкой — что было и что стало, и «Отменить всё». Кнопка — пока
// черновик правится и таких находок хотя бы две (одну заменяют её собственной кнопкой).
function swapAllBox() {
  const box = $('ai-swap-all');
  const list = swaps;
  let last = null;
  const btn = el('button', { class: `secondary${canFixInDraft() ? '' : ' hidden'}`, type: 'button', 'data-action': 'egrn-swap-all' }, `Заменить всё по выписке (${list.length})`);
  const what = el('p', { class: 'muted hidden', 'data-role': 'egrn-swap-all-what' });
  const lines = el('ul', { class: 'ai-swap-all-list hidden', 'data-role': 'egrn-swap-all-list' });
  const undo = el('button', { class: 'link hidden', type: 'button', 'data-action': 'egrn-unswap-all' }, 'Отменить всё');
  const rebuild = rebuildBox();
  btn.onclick = async () => {
    const todo = list.filter((s) => !s.swapped());
    btn.disabled = true;
    try {
      const r = await swapAllInDraft(todo);
      if (!r) { btn.disabled = false; return; }
      for (const i of r.missing) todo[i].missed();
      last = r.done.length ? { todo, done: r.done } : null;
      for (const d of r.done) todo[d.i].bulk(d);
      const miss = r.missing.length ? ` Нет в тексте черновика: ${r.missing.length} — исправьте в файле отчёта.` : '';
      what.textContent = r.done.length
        ? `Заменено по выписке ЕГРН: ${r.done.length}. Черновик сохранён; соберите Word заново.${miss}`
        : `В тексте черновика этих значений нет — исправьте в файле отчёта.`;
      lines.replaceChildren(...r.done.map((d) => el('li', { text: `«${d.was}» → «${d.now}»` })));
      what.classList.remove('hidden');
      lines.classList.toggle('hidden', !r.done.length);
      undo.classList.toggle('hidden', !r.done.length);
      if (!r.done.length) btn.disabled = false;
      else { rebuild.show(); swapped(); }
    } catch (err) { btn.disabled = false; say($('review-msg'), err.message); }
  };
  undo.onclick = async () => {
    if (!last) return;
    try {
      const r = await undoSwapAll(last.done);
      if (!r) return;
      for (const i of r.undone) last.todo[i].unbulk();
      what.textContent = r.kept.length
        ? `Отменено: ${r.undone.length}. Где текст уже правили (${r.kept.length}), верните прежнее значение сами, если нужно.`
        : `Замены отменены: в черновике снова прежние значения (${r.undone.length}). Черновик сохранён.`;
      lines.classList.add('hidden');
      undo.classList.add('hidden');
      rebuild.hide();
      btn.disabled = false;
      last = null;
      swapped();
    } catch (err) { say($('review-msg'), err.message); }
  };
  box.classList.toggle('hidden', list.length < 2);
  box.replaceChildren(...(list.length < 2 ? [] : [btn, what, lines, undo, rebuild.box]));
}

// 2.268: «Собрать Word заново» — рядом с заменой по выписке ЕГРН (всё сразу или одна находка): черновик сразу собирается в
// файл результата, без перехода к черновику. Под кнопкой — какой файл собран; дальше order.js спросит, исправленная ли это
// версия возвращённого файла (2.251). Кнопка видна, пока замена не отменена.
function rebuildBox() {
  const note = el('p', { class: 'muted hidden', 'data-role': 'egrn-rebuild-done' });
  const btn = el('button', { class: 'secondary', type: 'button', 'data-action': 'egrn-rebuild' }, 'Собрать Word заново');
  btn.onclick = async () => {
    if (!confirm('Собрать Word из черновика и приложить его файлом результата? Вы проверили текст и отвечаете за него.')) return;
    btn.disabled = true;
    try {
      const doc = await rebuildWord();
      if (!doc) { note.textContent = 'Черновик сейчас не правится — соберите Word в блоке «Черновик».'; note.classList.remove('hidden'); return; }
      note.textContent = `Собран «${doc.filename}» — приложен к результату. Подпишите его; прежний файл отчёта, собранный до замены, удалите.`;
      note.classList.remove('hidden');
      document.dispatchEvent(new CustomEvent('draft-rebuilt', { detail: doc }));
    } catch (err) { say($('review-msg'), err.message); } finally { btn.disabled = false; }
  };
  const box = el('div', { class: 'ai-rebuild hidden', 'data-role': 'egrn-rebuild' }, el('div', { class: 'row' }, btn), note);
  return {
    box,
    show: () => box.classList.remove('hidden'),
    hide: () => { box.classList.add('hidden'); note.classList.add('hidden'); },
  };
}

// Что изменилось с ИИ-проверки прежней версии файла (2.206): ушло, осталось, появилось — по правилам, нажатие ведёт к правилу.
function prevBox(r) {
  const p = r.ai?.prev;
  const box = $('ai-review-prev');
  box.classList.toggle('hidden', !p);
  if (!p) { box.replaceChildren(); return; }
  const title = new Map(r.checks.map((c) => [c.id, c.title]));
  const row = (cls, label, ids) => el('p', { class: `ai-prev-row ${cls}`, 'data-prev': cls },
    el('span', { text: `${label}: ${ids.length} — ` }),
    ...ids.flatMap((id, i) => [...(i ? [el('span', { text: ', ' })] : []),
      el('button', { type: 'button', class: 'link', 'data-look': id, onclick: () => toRule(id) }, short(title.get(id) ?? id))]));
  box.replaceChildren(
    el('p', { class: 'ai-prev-head', text: `С прошлой ИИ-проверки (${p.files.join(', ') || 'прежняя версия'}, ${timeRu(p.at)}):` }),
    ...(p.gone.length ? [row('gone', 'Исправлено', p.gone)] : []),
    ...(p.kept.length ? [row('kept', 'Осталось', p.kept)] : []),
    ...(p.fresh.length ? [row('fresh', 'Новое', p.fresh)] : []),
    ...(!p.kept.length && !p.fresh.length ? [el('p', { class: 'ai-prev-row gone', text: 'Всё, на что ИИ указывал в прежней версии, ушло.' })] : []));
}

// Пришли запрошенные документы после ИИ-проверки (2.248): проверка их не видела — «Проверить заново» здесь же.
function recheckBox(order, r) {
  const x = r.ai?.recheck;
  const box = $('ai-review-recheck');
  const on = !!x && r.can_ai;
  box.classList.toggle('hidden', !on);
  if (!on) { box.replaceChildren(); return; }
  box.replaceChildren(
    el('p', { class: 'ai-recheck-head', text: `После ИИ-проверки пришли запрошенные документы: ${x.docs.map((d) => `${d.title} («${d.filename}», ${timeRu(d.at)})`).join(', ')}.` }),
    el('p', { class: 'muted', text: x.egrn ? 'ИИ ещё не сверял отчёт с новой выпиской ЕГРН — проверьте заново.' : 'ИИ их ещё не видел — проверьте заново.' }),
    el('button', { type: 'button', class: 'secondary', 'data-action': 'ai-recheck', onclick: () => runAi(order) }, 'Проверить заново'));
}

// Название правила до двоеточия — для сводок в строку (2.191).
const short = (t) => t.split(':')[0];

// К правилу из сводки «Посмотрите» (2.191): прокрутить и подсветить.
function toRule(id) {
  const li = document.querySelector(`#review-checks li[data-check="${CSS.escape(id)}"]`);
  if (!li) return;
  li.scrollIntoView({ behavior: 'smooth', block: 'start' });
  li.classList.add('flash');
  setTimeout(() => li.classList.remove('flash'), 2000);
}

// 2.229, 2.231: «Исправить в черновике» — к месту в тексте черновика, где стоит значение, разошедшееся с выпиской ЕГРН,
// заявкой или заданием на оценку (кнопка — только пока черновик правится).
function draftFix(g, quote, action) {
  const from = g.from || 'в выписке';
  const miss = el('p', { class: 'muted hidden', 'data-role': `${action}-miss` });
  const btn = el('button', { class: `secondary${canFixInDraft() ? '' : ' hidden'}`, type: 'button', 'data-action': action, onclick: () => {
    const ok = fixInDraft(g, quote);
    miss.classList.toggle('hidden', ok);
    miss.textContent = ok ? '' : `В тексте черновика «${g.bad}» нет — исправьте в файле отчёта (${from}: ${g.right}).`;
  } }, 'Исправить в черновике');
  return { btn, miss };
}
// Находка сверена с заявкой или заданием на оценку (2.231): своей строки выписки нет — только кнопка к черновику.
// 2.274: дата оценки из задания (письма, определения суда) — и «Заменить на значение из задания» с отменой.
function mineFix(g, quote) {
  const { btn, miss } = draftFix(g, quote, 'fix-draft');
  const swap = assignmentSwap(g, quote, miss);
  return [el('div', { class: 'row' }, btn, ...(swap ? [swap.btn] : [])), miss, ...(swap ? [swap.done, swap.rebuild] : [])];
}
const SOURCE_FROM = [[/^в задании/u, 'из задания'], [/^в письме/u, 'из письма'], [/^в определении/u, 'из определения']];
function assignmentSwap(g, quote, miss) {
  const dated = /^\d{2}\.\d{2}\.\d{4}$/;
  const src = SOURCE_FROM.find(([re]) => re.test(g.from ?? ''))?.[1];
  if (!src || !dated.test(g.bad ?? '') || !dated.test(g.right ?? '') || !swapValue(g)) return null;
  const what = el('span', { 'data-role': 'fix-swap-what' });
  const rebuild = rebuildBox();
  let last = null;
  const undo = el('button', { class: 'link', type: 'button', 'data-action': 'fix-unswap', onclick: async () => {
    try {
      const ok = last && await undoSwap(last);
      if (!ok) { what.textContent = `Текст на этом месте уже правили — верните «${last?.was ?? g.bad}» сами, если нужно.`; undo.classList.add('hidden'); return; }
      what.textContent = `Замена отменена: снова «${last.was}». Черновик сохранён.`;
      undo.classList.add('hidden');
      rebuild.hide();
      btn.disabled = false;
      last = null;
    } catch (err) { say($('review-msg'), err.message); }
  } }, 'Отменить');
  const done = el('p', { class: 'egrn-swap hidden', 'data-role': 'fix-swap-done' }, what, ' ', undo);
  const btn = el('button', { class: `secondary${canFixInDraft() ? '' : ' hidden'}`, type: 'button', 'data-action': 'fix-swap', onclick: async () => {
    btn.disabled = true;
    try {
      last = await swapInDraft(g, quote);
      miss.classList.toggle('hidden', !!last);
      miss.textContent = last ? '' : `В тексте черновика «${g.bad}» нет — исправьте в файле отчёта (${g.from}: ${g.right}).`;
      done.classList.toggle('hidden', !last);
      if (!last) { btn.disabled = false; return; }
      what.textContent = `Было «${last.was}» — стало «${last.now}», как ${g.from}. Черновик сохранён; соберите Word заново.`;
      undo.classList.remove('hidden');
      rebuild.show();
    } catch (err) { btn.disabled = false; say($('review-msg'), err.message); }
  } }, `Заменить на значение ${src}`);
  return { btn, done, rebuild: rebuild.box };
}

// 2.232: «Заменить на значение из выписки» — одной кнопкой, черновик сохраняется; под кнопкой — что было и что стало, и
// «Отменить» (вернуть прежнее значение). Год из нескольких выписок и материал стен словом — без этой кнопки (swapValue).
function egrnSwap(g, quote, miss, rule) {
  const what = el('span', { 'data-role': 'egrn-swap-what' });
  let last = null;
  let bulked = null;
  const rebuild = rebuildBox();
  const undo = el('button', { class: 'link', type: 'button', 'data-action': 'egrn-unswap', onclick: async () => {
    try {
      const ok = last && await undoSwap(last);
      if (!ok) { what.textContent = `Текст на этом месте уже правили — верните «${last?.was ?? g.bad}» сами, если нужно.`; undo.classList.add('hidden'); return; }
      what.textContent = `Замена отменена: снова «${last.was}». Черновик сохранён.`;
      undo.classList.add('hidden');
      rebuild.hide();
      btn.disabled = false;
      last = null;
      swapped();
    } catch (err) { say($('review-msg'), err.message); }
  } }, 'Отменить');
  const done = el('p', { class: 'egrn-swap hidden', 'data-role': 'egrn-swap-done' }, what, ' ', undo);
  // 2.246: заменено вместе со всеми — отменяется кнопкой «Отменить всё».
  swaps.push({
    g, quote, rule,
    swapped: () => !!last || btn.disabled,
    // 2.262: что заменено (своей кнопкой или вместе со всеми) и замена той же кнопкой — из замечания руководителя.
    result: () => (last ? { was: last.was, now: last.now } : bulked ? { was: bulked.was, now: bulked.now } : null),
    swap: () => { btn.click(); },
    missed: () => { miss.textContent = `В тексте черновика «${g.bad}» нет — исправьте в файле отчёта (в выписке: ${g.right}).`; miss.classList.remove('hidden'); },
    bulk: (d) => {
      bulked = d;
      btn.disabled = true;
      miss.classList.add('hidden');
      what.textContent = `Было «${d.was}» — стало «${d.now}», как в выписке ЕГРН (заменено вместе со всеми).`;
      undo.classList.add('hidden');
      rebuild.hide();
      done.classList.remove('hidden');
    },
    unbulk: () => { bulked = null; btn.disabled = false; done.classList.add('hidden'); },
  });
  const btn = el('button', { class: `secondary${canFixInDraft() ? '' : ' hidden'}`, type: 'button', 'data-action': 'egrn-swap', onclick: async () => {
    btn.disabled = true;
    try {
      last = await swapInDraft(g, quote);
      miss.classList.toggle('hidden', !!last);
      miss.textContent = last ? '' : `В тексте черновика «${g.bad}» нет — исправьте в файле отчёта (в выписке: ${g.right}).`;
      done.classList.toggle('hidden', !last);
      if (!last) { btn.disabled = false; return; }
      what.textContent = `Было «${last.was}» — стало «${last.now}», как в выписке ЕГРН. Черновик сохранён; соберите Word заново.`;
      undo.classList.remove('hidden');
      rebuild.show();
      swapped();
    } catch (err) { btn.disabled = false; say($('review-msg'), err.message); }
  } }, 'Заменить на значение из выписки');
  return { btn, done, rebuild: rebuild.box };
}

// 2.218: находка по выписке ЕГРН — одной кнопкой строка из выписки, с которой сверяли, и сам файл выписки на этой странице.
// 2.240: «Исправить в черновике» и «Заменить на значение из выписки» — видны сразу, как у находок по заявке и заданию
// (раньше — только после «Выписка ЕГРН, стр. N»).
function egrnPlace(g, quote, rule) {
  const { btn: fixBtn, miss } = g.bad ? draftFix(g, quote, 'egrn-draft') : { btn: null, miss: el('p', { class: 'hidden' }) };
  const swap = g.bad && swapValue(g) ? egrnSwap(g, quote, miss, rule) : { btn: null, done: null, rebuild: null };
  const fix = [fixBtn, swap.btn].filter(Boolean);
  const box = el('div', { class: 'ai-egrn hidden', 'data-role': 'egrn-place' },
    el('span', { class: 'ai-mark-where', text: `${g.file}, ${g.where}: ` }),
    el('q', { text: g.quote || 'строка не найдена — откройте файл' }),
    el('div', { class: 'row' }, el('button', { class: 'secondary', type: 'button', 'data-action': 'egrn-file', onclick: () => openEgrn(g) }, 'Открыть файл выписки')));
  const btn = el('button', { class: 'link', type: 'button', 'data-action': 'egrn', 'aria-expanded': 'false', onclick: () => {
    const open = box.classList.toggle('hidden') === false;
    btn.setAttribute('aria-expanded', String(open));
    if (open) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } }, `Выписка ЕГРН, ${g.where}`);
  return [el('br'), btn, box, ...(fix.length ? [el('div', { class: 'row' }, ...fix)] : []), miss, ...(swap.done ? [swap.done, swap.rebuild] : [])];
}
async function openEgrn(g) {
  try {
    const { url } = await api('GET', `/api/documents/${g.doc_id}/link`);
    // PDF открывается сразу на нужной странице; другие файлы — как есть.
    location.assign(/\.pdf$/i.test(g.file) ? `${url}#page=${g.where.replace(/\D/g, '')}` : url);
  } catch (err) { say($('review-msg'), err.status === 404 ? 'Выписки уже нет в деле' : err.message); }
}

function aiState(ai) {
  const unread = ai.files.filter((f) => !f.read).map((f) => f.name);
  const attention = ai.items.filter((i) => i.hint === 'attention').length;
  return [
    `ИИ-проверка: запускал ${AI_SIDE_RU[ai.side]}, ${timeRu(ai.at)}.`,
    ai.model === 'auto' ? 'Модель ИИ не ответила — показаны только автоматические находки, остальное посмотрите сами.' : null,
    attention ? null : 'Замечаний ИИ не видит.', // что посмотреть — строкой «Посмотрите» ниже (2.191)
    unread.length ? `Не прочитаны (ИИ читает PDF, Word и текст; эти посмотрите сами): ${unread.join(', ')}.` : null,
    ai.files.some((f) => f.truncated) ? `Прочитано не до конца (длинный текст): ${ai.files.filter((f) => f.truncated).map((f) => f.name).join(', ')}.` : null,
    'Это подсказка: решение и отметки — за человеком.',
  ].filter(Boolean).join(' ');
}

async function runAi(order) {
  $('ai-review-run').disabled = true;
  say($('review-msg'), 'ИИ проверяет результат…', 'ok');
  try {
    await api('POST', `/api/orders/${order.id}/review/ai`);
    await loadReview({ order });
    // Напоминание у подписи (2.136) зависит от ИИ-проверки — список файлов обновляется.
    document.dispatchEvent(new CustomEvent('ai-review-done'));
    say($('review-msg'), 'ИИ-проверка готова', 'ok');
  } catch (err) { say($('review-msg'), err.message); } finally { $('ai-review-run').disabled = false; }
}

function checkItem(order, r, c, hint) {
  const li = el('li', { 'data-check': c.id },
    el('div', { class: 'title', text: c.title }),
    ...(r.round > 0 ? [el('div', { class: `verdict ${c.verdict || 'none'}`, text: VERDICT_RU[c.verdict] || 'Не проверено' })] : []),
    ...(c.note ? [el('p', { class: 'check-note', text: c.note })] : []),
    ...(hint ? [el('p', { class: `ai-hint ${hint.hint}`, text: hint.hint === 'ok' ? `ИИ: ${hint.note || 'замечаний не видно'}` : `ИИ: посмотрите — ${hint.note}` })] : []),
    // Автоматические находки по всему тексту отчёта: что не так, файл, страница и строка из отчёта.
    ...(hint?.found?.length ? [el('ul', { class: 'ai-marks ai-found' }, ...hint.found.map((f) => el('li', {},
      el('span', { class: 'ai-mark-where', text: `${f.file}, ${f.where}: ` }),
      el('span', { text: f.text }),
      ...(f.quote ? [el('br'), el('q', { text: f.quote })] : []),
      ...(f.egrn ? egrnPlace(f.egrn, f.quote, c.id) : []),
      ...(f.fix ? mineFix(f.fix, f.quote) : []))))] : []),
    // Отмеченные места: цитата из отчёта, файл и страница — сервер показывает только найденные в тексте цитаты.
    ...(hint?.marks?.length ? [el('ul', { class: 'ai-marks' }, ...hint.marks.map((m) => el('li', {},
      el('span', { class: 'ai-mark-where', text: `${m.file}, ${m.where}: ` }),
      el('q', { text: m.quote }))))] : []));
  if (!r.can_mark) return li;
  const note = el('input', { type: 'text', maxlength: '1000', 'aria-label': `Замечание: ${c.title}`, placeholder: 'Что не так (для замечания)' });
  note.value = c.verdict === 'issue' ? c.note || '' : '';
  const send = async (verdict) => {
    try {
      await api('PUT', `/api/orders/${order.id}/review/${c.id}`, { verdict, note: verdict === 'issue' ? note.value : undefined, round: r.round });
      await loadReview({ order });
      say($('review-msg'), 'Отметка сохранена', 'ok');
    } catch (err) { say($('review-msg'), err.message); }
  };
  li.append(el('div', { class: 'check-form' }, note,
    el('div', { class: 'row' },
      el('button', { class: 'secondary', type: 'button', 'data-action': 'ok', onclick: () => send('ok') }, 'В порядке'),
      el('button', { class: 'danger', type: 'button', 'data-action': 'issue', onclick: () => send('issue') }, 'Замечание'))));
  return li;
}

// ——— Переписка ———

export async function loadChat(current) {
  orderRef = current.order;
  say($('chat-msg'), '');
  const { messages, can_write: canWrite, phrases = [] } = await api('GET', `/api/orders/${current.order.id}/messages`);
  $('messages').replaceChildren(...messages.map((m) => el('li', { class: m.mine ? 'mine' : '' },
    el('div', { class: 'who', text: [m.mine ? 'Вы' : SIDE_RU[m.side], m.author_name && !m.mine ? m.author_name : null, timeRu(m.at)].filter(Boolean).join(' · ') }),
    el('div', { class: 'body', text: m.body }))));
  $('messages-empty').classList.toggle('hidden', messages.length > 0);
  setNext({ chat: { count: messages.length } });
  $('message-form').classList.toggle('hidden', !canWrite);
  // Готовые фразы (2.84): нажатие подставляет текст в поле (к уже написанному — с новой строки, без второго
  // «Здравствуйте!»); отправляет человек. Текст берётся свежим: документы могли запросить или прислать после открытия дела.
  $('message-phrases').classList.toggle('hidden', phrases.length === 0);
  $('message-phrase-list').replaceChildren(...phrases.map((p) => el('button', {
    class: 'secondary', type: 'button', 'data-phrase': p.id,
    onclick: async () => {
      let t = p.text;
      try { t = (await api('GET', `/api/orders/${orderRef.id}/messages`)).phrases?.find((x) => x.id === p.id)?.text ?? t; } catch { /* остаётся прежний текст */ }
      const box = $('message-text');
      const had = box.value.trim();
      box.value = had ? `${had}\n\n${t.replace(/^Здравствуйте! /, '')}` : t;
      box.rows = 8; // весь текст на виду — его поправляют перед отправкой
      box.focus();
      say($('chat-msg'), 'Текст в поле сообщения — поправьте его и отправьте', 'ok');
    },
  }, p.title)));
}

$('message-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = $('message-text').value.trim();
  if (!body) return say($('chat-msg'), 'Напишите сообщение');
  $('message-send').disabled = true;
  try {
    await api('POST', `/api/orders/${orderRef.id}/messages`, { body });
    $('message-text').value = '';
    await loadChat({ order: orderRef });
    say($('chat-msg'), 'Сообщение отправлено', 'ok');
  } catch (err) { say($('chat-msg'), err.message); } finally { $('message-send').disabled = false; }
});
