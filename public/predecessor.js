// «Что сделал прежний эксперт» (задача 2.112). Новому эксперту после передачи дела руководителем (2.62) — когда передали и
// что осталось в деле от прежнего: файлы результата (в сдачу не идут — нужен свой), другие файлы, черновик, фото осмотра,
// выезд помощника, аналоги; нажатие на строку открывает нужный блок. Просьба прежнего о переносе срока, если ждёт ответа
// диспетчера, — «Оставить просьбу» или «Отозвать». «Понятно, скрыть» помнится на этом телефоне для этого дела (пока нет
// нерешённой просьбы). Текст — через textContent.
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
  const e = v.extend;
  $('pred-extend').classList.toggle('hidden', !e);
  if (e) $('pred-extend-text').textContent = `Прежний эксперт ${whenRu(e.requested_at)} попросил перенести срок на ${dayRu(e.new_deadline)} (причина: ${e.reason}). Диспетчер ещё не ответил. Оставить просьбу или отозвать?`;
  $('pred-hide').classList.toggle('hidden', !!e);
}

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
