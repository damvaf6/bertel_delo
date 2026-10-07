// Что изменилось между версиями черновика (2.104): по разделам — какие абзацы добавлены и какие убраны. Абзац — непустая
// строка текста (так эксперт и правит: строка за строкой); раздел — заголовок «## …» и всё до следующего, текст до первого
// заголовка — «Начало текста». Разделы сопоставляются по заголовку без номера и регистра (как при переносе из прошлого
// дела, 2.65): перенумерованный раздел («3. Описание» → «4. Описание») — тот же, с отметкой прежнего заголовка.
import { headKey } from '../dossier/dossier.mjs';

const START = 'Начало текста';
const LINES_MAX = 3000;   // больше строк в разделе не бывает (черновик — до 50 000 знаков); защита от лишней работы

function sections(body) {
  const out = [];
  let cur = { key: '', title: START, lines: [] };
  for (const raw of String(body ?? '').split('\n')) {
    const h = raw.match(/^#{1,3}\s*(.+)$/);
    if (h) {
      if (cur.lines.length || cur.key) out.push(cur);
      cur = { key: headKey(h[1].replace(/^\d+(?:\.\d+)*\.?\s*/, '')) || headKey(h[1]), title: h[1].trim(), lines: [] };
      continue;
    }
    const t = raw.replace(/\s+/g, ' ').trim();
    if (t) cur.lines.push(t);
  }
  if (cur.lines.length || cur.key) out.push(cur);
  return out;
}

// Добавленные и убранные строки по наибольшей общей последовательности: переставленный абзац — убран и добавлен.
function lineDiff(a, b) {
  a = a.slice(0, LINES_MAX);
  b = b.slice(0, LINES_MAX);
  const n = a.length;
  const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const added = [];
  const removed = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i += 1; j += 1; } else if (L[i + 1][j] >= L[i][j + 1]) removed.push(a[i++]); else added.push(b[j++]);
  }
  while (i < n) removed.push(a[i++]);
  while (j < m) added.push(b[j++]);
  return { added, removed };
}

// Разница «было» → «стало». Разделы — в порядке новой версии, убранные целиком — в конце. Без изменений — не показываются.
export function draftDiff(before, after) {
  const was = sections(before);
  const now = sections(after);
  const old = new Map();
  for (const s of was) if (!old.has(s.key)) old.set(s.key, s);
  const seen = new Set();
  const out = [];
  for (const s of now) {
    const prev = seen.has(s.key) ? null : old.get(s.key);
    seen.add(s.key);
    const d = lineDiff(prev?.lines ?? [], s.lines);
    const status = !prev ? 'added' : prev.title !== s.title ? 'renamed' : 'changed';
    if (status === 'changed' && !d.added.length && !d.removed.length) continue;
    out.push({ title: s.title, was_title: status === 'renamed' ? prev.title : null, status, ...d });
  }
  for (const s of was) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    out.push({ title: s.title, was_title: null, status: 'removed', added: [], removed: s.lines });
  }
  return {
    sections: out,
    added: out.reduce((n, s) => n + s.added.length, 0),
    removed: out.reduce((n, s) => n + s.removed.length, 0),
  };
}
