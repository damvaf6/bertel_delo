// Страница дела у исполнителя короче (2.101): блоки дела свёрнуты в строку-заголовок с состоянием («получено 2 из 3»,
// «фото: 7»), раскрыт тот, что нужен сейчас. Раскрыть или свернуть — нажатием на заголовок; выбор помнится, пока открыто
// то же дело, а раскрытый сам блок не сворачивается, когда шаг сделан. Переход из «Сегодня», уведомлений и «Что дальше»
// раскрывает свой блок. Остальным (заказчик, диспетчер, руководитель) страница прежняя. Текст — через textContent.
import { el } from '/common.js';

const $ = (id) => document.getElementById(id);
export const FOLD_BOXES = ['deadline-box', 'docreq-box', 'docs-box', 'inspect-box', 'onsite-box', 'analogs-box', 'draft-box', 'review-box', 'chat-box'];
let orderId = null;
const chosen = new Map(); // блок → раскрыт ли (выбор человека или уже раскрытый сам)

function bar(box) {
  let b = box.querySelector(':scope > .fold-bar');
  if (b) return b;
  const id = box.id;
  b = el('div', { class: 'fold-bar' },
    el('span', { class: 'fold-note muted' }),
    el('button', { type: 'button', class: 'link fold-toggle', 'data-fold': id, 'aria-controls': id, 'aria-expanded': 'true', onclick: () => toggle(id) }, 'Свернуть'));
  box.querySelector(':scope > h2').after(b);
  box.querySelector(':scope > h2').addEventListener('click', () => { if (box.classList.contains('foldable')) toggle(id); });
  return b;
}

function paint(box, open) {
  box.classList.toggle('folded', !open);
  const t = bar(box).querySelector('.fold-toggle');
  t.textContent = open ? 'Свернуть' : 'Развернуть';
  t.setAttribute('aria-expanded', String(open));
}

function toggle(id) {
  const box = $(id);
  const open = box.classList.contains('folded');
  chosen.set(id, open);
  paint(box, open);
}

// enabled — страница исполнителя; now — блок, нужный сейчас (раскрывается сам один раз); notes — состояние у заголовка.
export function applyFolds({ enabled, order, now = null, notes = {} }) {
  if (order !== orderId) { orderId = order; chosen.clear(); }
  for (const id of FOLD_BOXES) {
    const box = $(id);
    if (!box) continue;
    if (!enabled) {
      box.classList.remove('foldable', 'folded');
      box.querySelector(':scope > .fold-bar')?.classList.add('hidden');
      continue;
    }
    box.classList.add('foldable');
    const b = bar(box);
    b.classList.remove('hidden');
    b.querySelector('.fold-note').textContent = notes[id] || '';
    if (id === now && !chosen.has(id)) chosen.set(id, true);
    paint(box, !!chosen.get(id));
  }
}

// Раскрыть блок, в котором лежит элемент (переход к разделу дела).
export function reveal(id) {
  const box = $(id)?.closest('.foldable');
  if (!box) return;
  chosen.set(box.id, true);
  paint(box, true);
}
