// Повторная оценка того же объекта (задача 2.118). Исполнителю в деле — свои прошлые дела с тем же объектом (по кадастровому
// номеру и адресу, VIN и госномеру): что совпало, что изменилось с прошлого раза, и что можно взять — описание объекта в
// черновик, аналоги (подтвердить заново), запрос тех же документов у заказчика. «Взять из дела №…» — одной кнопкой, потом
// дело перерисовывается. «Не нужно, скрыть» помнится на этом телефоне для этого дела. Текст — через textContent.
import { api, el, say } from '/common.js';

const $ = (id) => document.getElementById(id);
const dayRu = (s) => new Date(s).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric' });
const KEY = 'delo.repeat.hidden';
let ctx = null; // { order, reload }

function hiddenSet() {
  try { return new Set(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch { return new Set(); }
}

$('repeat-hide')?.addEventListener('click', () => {
  if (!ctx) return;
  try { localStorage.setItem(KEY, JSON.stringify([...hiddenSet(), ctx.order.id].slice(-200))); } catch { /* только на этот раз */ }
  $('repeat-box').classList.add('hidden');
});

export async function loadRepeat(current, reload) {
  const box = $('repeat-box');
  say($('repeat-msg'), '');
  if (!current.executor?.is_me || current.order.status !== 'in_work' || hiddenSet().has(current.order.id)) { box.classList.add('hidden'); return; }
  ctx = { order: current.order, reload };
  try { render(await api('GET', `/api/orders/${current.order.id}/repeat`)); } catch { box.classList.add('hidden'); }
}

const check = (name, label, note) => el('label', { class: 'row gap check-line' },
  el('input', { type: 'checkbox', name, checked: '' }),
  el('span', {}, el('span', { text: label }), note ? el('span', { class: 'muted', text: ` — ${note}` }) : ''));

function item(c) {
  const same = c.fields.filter((f) => f.same).map((f) => f.label.toLowerCase());
  const form = el('form', { 'data-repeat-case': c.id, novalidate: '' },
    ...(c.sections.length ? [check('sections', 'Описание объекта в черновик', c.sections.join(', '))] : []),
    ...(c.analogs ? [check('analogs', `Аналоги: ${c.analogs}`, 'без подтверждения — сверите на новую дату')] : []),
    ...(c.docs.length ? [check('docs', 'Запросить у заказчика те же документы', c.docs.join(', '))] : []),
    el('button', { type: 'submit', class: 'secondary' }, `Взять из дела ${c.ref}`));
  form.addEventListener('submit', (e) => { e.preventDefault(); take(c, form); });
  return el('li', {},
    el('div', { class: 'title', text: `Ваше дело ${c.ref} от ${dayRu(c.created_at)}` }),
    el('div', { class: 'muted', text: `Тот же объект: совпадает ${same.join(' и ')}` }),
    ...(c.changed.length ? [el('div', { class: 'notice-warn', 'data-changed': '' },
      el('span', { text: 'Изменилось с прошлого раза: ' }),
      el('span', { text: c.changed.map((x) => `${x.label.toLowerCase()} — было ${x.past}, сейчас ${x.now ?? 'не указано'}`).join('; ') }))] : []),
    form);
}

function render(r) {
  const box = $('repeat-box');
  box.classList.toggle('hidden', !r.cases.length);
  if (!r.cases.length) return;
  $('repeat-lead').textContent = r.cases.length === 1
    ? 'Этот объект Вы уже оценивали. Можно взять из прошлого дела то, что не изменилось: данные прошлого заказчика не переносятся, места для новых данных помечены «[заполнить]».'
    : 'Этот объект Вы уже оценивали несколько раз. Выберите дело, из которого взять то, что не изменилось: данные прошлого заказчика не переносятся.';
  $('repeat-list').replaceChildren(...r.cases.map(item));
}

async function take(c, form) {
  const take = Object.fromEntries(['sections', 'analogs', 'docs'].map((k) => [k, !!form.elements[k]?.checked]));
  const btn = form.querySelector('button[type=submit]');
  if (!take.sections && !take.analogs && !take.docs) { say($('repeat-msg'), 'Отметьте, что взять из прошлого дела'); return; }
  btn.disabled = true;
  try {
    const from = take.sections ? (await api('GET', `/api/orders/${ctx.order.id}/draft`)).draft?.id ?? null : null;
    const r = await api('POST', `/api/orders/${ctx.order.id}/repeat`, { past_id: c.id, from, take });
    const t = r.taken;
    const parts = [
      t.sections.length ? `описание объекта — разделов: ${t.sections.length}${t.marks ? `, мест «заполнить»: ${t.marks}` : ''}` : null,
      t.analogs ? `аналогов: ${t.analogs} (подтвердите их)` : null,
      t.docs.length ? `запрошено у заказчика документов: ${t.docs.length}` : null,
    ].filter(Boolean);
    await ctx.reload();
    say($('repeat-msg'), `Взято из дела ${r.ref}: ${parts.join('; ')}`, 'ok');
  } catch (err) {
    say($('repeat-msg'), err.message);
  } finally { btn.disabled = false; }
}
