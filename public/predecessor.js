// «Что сделал прежний эксперт» (задача 2.112). Новому эксперту после передачи дела руководителем (2.62) — когда передали и
// что осталось в деле от прежнего: файлы результата (в сдачу не идут — нужен свой), другие файлы, черновик, фото осмотра,
// выезд помощника, аналоги; нажатие на строку открывает нужный блок. Просьба прежнего о переносе срока, если ждёт ответа
// диспетчера, — «Оставить просьбу» или «Отозвать». «Понятно, скрыть» помнится на этом телефоне для этого дела (пока нет
// нерешённой просьбы). Задание на оценку в деле (2.328) — срок по нему и что из задания уже в черновике; письмо о переносе срока и просил ли
// прежний эксперт письмо с новым сроком (2.356). Текст — через textContent.
import { api, el, say } from '/common.js';
import { reveal } from '/fold.js';

const $ = (id) => document.getElementById(id);
const whenRu = (s) => new Date(s).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const dayRu = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' });
const KEY = 'delo.pred.hidden';
let ctx = null; // { order, view, reload }

function hiddenSet() {
  try { return new Set(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch { return new Set(); }
}

export async function loadPredecessor(current, reload) {
  const box = $('pred-box');
  say($('pred-msg'), '');
  if (!current.executor?.is_me || current.order.status !== 'in_work') { box.classList.add('hidden'); return; }
  ctx = { order: current.order, view: null, reload };
  try { render(await api('GET', `/api/orders/${current.order.id}/predecessor`)); } catch { box.classList.add('hidden'); }
}

const go = (id) => () => { if ($(id)?.classList.contains('hidden')) return; reveal(id); $(id).scrollIntoView({ behavior: 'smooth', block: 'start' }); };

function row(title, note, box) {
  return el('li', {}, el('button', { type: 'button', class: 'link', onclick: go(box) },
    el('span', {}, el('span', { class: 'title', text: title }), note ? el('span', { class: 'muted', text: ` — ${note}` }) : '')));
}

function render(v) {
  const box = $('pred-box');
  ctx.view = v;
  const hidden = v.transferred && !v.extend && hiddenSet().has(ctx.order.id);
  box.classList.toggle('hidden', !v.transferred || hidden);
  if (box.classList.contains('hidden')) return;
  $('pred-lead').textContent = `Руководитель передал Вам дело ${whenRu(v.at)}. Раньше его вёл эксперт ${v.from}. Всё, что он сделал, осталось в деле:`;
  const items = [];
  if (v.results) items.push(row(`Файлы результата: ${v.results}`, 'в сдачу не идут: загрузите свой отчёт и подпишите', 'docs-box'));
  if (v.files) items.push(row(`Другие файлы: ${v.files}`, 'в «Документах»', 'docs-box'));
  if (v.drafts) items.push(row(`Черновик: версий ${v.drafts}`, `последняя ${whenRu(v.draft_at)} — можно продолжить с неё`, 'draft-box'));
  if (v.photos) items.push(row(`Фото осмотра: ${v.photos}`, 'новая ссылка на осмотр — по желанию', 'inspect-box'));
  if (v.visits_done) items.push(row(`Выезд помощника: проведён${v.visits_done > 1 ? ` (${v.visits_done})` : ''}`, 'данные с объекта — в блоке выезда', 'onsite-box'));
  if (v.visits_cancelled) items.push(row('Выезд помощника отменён при передаче', 'назначить заново — по желанию', 'onsite-box'));
  if (v.analogs) items.push(row(`Аналоги: ${v.analogs}`, `подтверждено ${v.analogs_confirmed} из ${v.analogs}`, 'analogs-box'));
  if (!items.length) items.push(el('li', { class: 'muted', text: 'Файлов, черновика, фото и аналогов прежний эксперт не оставил.' }));
  $('pred-list').replaceChildren(...items);
  renderTask(v.task);
  const e = v.extend;
  $('pred-extend').classList.toggle('hidden', !e);
  if (e) $('pred-extend-text').textContent = `Прежний эксперт ${whenRu(e.requested_at)} попросил перенести срок на ${dayRu(e.new_deadline)} (причина: ${e.reason}). Диспетчер ещё не ответил. Оставить просьбу или отозвать?`;
  $('pred-hide').classList.toggle('hidden', !!e);
}

// 2.328: задание на оценку в деле — срок по нему, если раньше срока дела, и что из задания уже в таблице задания черновика.
function renderTask(t) {
  $('pred-task').classList.toggle('hidden', !t);
  if (!t) return;
  $('pred-task-lead').textContent = `Задание на оценку: ${t.files.map((f) => `«${f.name}»`).join(', ')}`;
  const due = $('pred-task-due');
  due.classList.toggle('hidden', !t.due);
  if (t.due) {
    due.className = t.due.hot ? 'overdue' : 'muted';
    due.textContent = t.letter
      ? `Сдать по письму о переносе — к ${dayRu(t.due.day)}${t.due.overdue ? ', срок прошёл' : ''} (срок дела позже)`
      : `Сдать ${t.due.by} — к ${dayRu(t.due.day)}${t.due.overdue ? ', срок прошёл' : ''} (срок дела позже; «${t.due.name}», стр. ${t.due.page})`;
  }
  // 2.356: письмо о переносе срока и просьба письма у заказчика.
  const l = t.letter;
  $('pred-task-letter').classList.toggle('hidden', !l);
  if (l) {
    $('pred-task-letter').className = l.short ? 'overdue' : 'muted';
    $('pred-task-letter').textContent = `Письмо о переносе: «${l.name}», стр. ${l.page} — срок ${l.was ? `перенесён с ${dayRu(l.was)} ` : ''}на ${dayRu(l.day)}`
      + (l.short ? '. Срок в письме раньше срока дела: сдайте к нему или попросите письмо с новым сроком' : '');
  }
  const a = t.ask;
  $('pred-task-ask-text').classList.toggle('hidden', !a);
  if (a) {
    $('pred-task-ask-text').textContent = `${a.by_prev ? 'Прежний эксперт' : 'Вы'} ${whenRu(a.at)} попросил${a.by_prev ? '' : 'и'} у заказчика письмо о переносе срока — `
      + (a.came_at ? `пришло ${whenRu(a.came_at)}` : 'ещё не пришло');
  }
  $('pred-task-ask').classList.toggle('hidden', !t.can_ask);
  const note = !t.draft ? 'Черновика нет — подготовьте его: дату оценки, вид стоимости и другое из задания программа возьмёт сама.'
    : !t.items ? 'В черновике нет таблицы задания — сверить с заданием не с чем.'
    : !t.items.length ? 'Из задания в черновик брать нечего.' : '';
  $('pred-task-note').textContent = note;
  $('pred-task-note').classList.toggle('hidden', !note);
  const name = (i) => (i.what === 'due' ? 'Срок отчёта' : i.label);
  const ok = (t.items ?? []).filter((i) => i.ok);
  const bad = (t.items ?? []).filter((i) => !i.ok);
  const rows = [];
  if (ok.length) rows.push(el('li', { class: 'muted', text: `Уже в черновике: ${ok.map(name).join(', ')}` }));
  for (const i of bad) {
    rows.push(el('li', { class: 'overdue', text: `${name(i)}: по заданию — «${i.v}», в черновике — ${i.was ? `«${i.was}»` : 'нет'}` }));
  }
  $('pred-task-list').replaceChildren(...rows);
  $('pred-task-draft').classList.toggle('hidden', !bad.length);
}
$('pred-task-draft').addEventListener('click', go('draft-box'));
$('pred-task-ask').addEventListener('click', async () => {
  const btn = $('pred-task-ask');
  btn.disabled = true;
  try {
    await api('POST', `/api/orders/${ctx.order.id}/doc-requests`, { task_move: true });
    await ctx.reload();
    say($('pred-msg'), 'Письмо с новым сроком попросили у заказчика — ему отправлено уведомление', 'ok');
  } catch (err) { say($('pred-msg'), err.message); }
  btn.disabled = false;
});
$('pred-task-open').addEventListener('click', go('task-box'));

$('pred-keep').addEventListener('click', async () => {
  const e = ctx?.view?.extend;
  if (!e) return;
  try {
    render(await api('POST', `/api/orders/${ctx.order.id}/predecessor/extend/${e.id}/keep`, {}));
    say($('pred-msg'), 'Просьба осталась — ответ диспетчера придёт Вам. Отозвать её можно в блоке «Срок».', 'ok');
  } catch (err) { say($('pred-msg'), err.message); }
});
$('pred-withdraw').addEventListener('click', async () => {
  const e = ctx?.view?.extend;
  if (!e) return;
  try {
    await api('DELETE', `/api/orders/${ctx.order.id}/deadline-requests/${e.id}`);
    await ctx.reload?.(); // срок и блок «Срок» — заново
    say($('pred-msg'), 'Просьба отозвана — срок прежний. Попросить свой перенос можно в блоке «Срок».', 'ok');
  } catch (err) { say($('pred-msg'), err.message); }
});
$('pred-hide').addEventListener('click', () => {
  const s = hiddenSet();
  s.add(ctx.order.id);
  try { localStorage.setItem(KEY, JSON.stringify([...s].slice(-200))); } catch { /* только на этот раз */ }
  $('pred-box').classList.add('hidden');
});
