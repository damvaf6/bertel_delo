// Сверка с актом и расчётом страховой (2.475, «Ущерб автомобилю после ДТП»). Эксперт вносит детали из акта осмотра
// страховой и её сумму, свою сумму на той же основе (с учётом износа или без); программа сравнивает детали страховой с
// таблицей повреждённых деталей дела (src/orders/parts.mjs): совпадает, добавлено экспертом, исключено экспертом — и
// считает разницу. Строка-итог и таблица — в раздел черновика с parts (у ДТП — «5. Исследование повреждений»), под таблицей
// повреждённых деталей; прежний блок узнаётся по началу строки-итога и заменяется целиком. Из черновика — в Word.
import { headKey } from '../dossier/dossier.mjs';
import { partIn } from '../ai/report-checks.mjs';
import { PARTS_HEAD } from './parts.mjs';

export const INS_LEAD = 'Сравнение с расчётом страховой';
export const INS_HEAD = '| № | Деталь | У страховой | У эксперта | Итог |';
export const INS_PART_MAX = 120;
export const INS_PARTS_MAX = 60;
export const BASIS_MAX = 200;
export const WEAR = { with: 'с учётом износа', without: 'без учёта износа' };

const cell = (v) => String(v ?? '').replace(/\s*\n\s*/g, '; ').replace(/\|/g, '/').trim();
// Одна и та же деталь: все слова одного названия есть в другом (падежи, порядок и «лев.»/«левая» не важны).
export const samePart = (a, b) => partIn(a, b) || partIn(b, a);

// Копейки → «123 456 руб.» или «123 456,50 руб.»; пробел обычный — так и в Word.
export function rubText(kop) {
  const r = String(Math.floor(Math.abs(kop) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const k = Math.abs(kop) % 100;
  return `${kop < 0 ? '−' : ''}${r}${k ? `,${String(k).padStart(2, '0')}` : ''} руб.`;
}
// «123 456,78», «123456.5», «123 456 руб.» → копейки; не сумма — null.
export function parseRub(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : null;
  const s = String(v ?? '').replace(/руб\.?|₽|р\.$/giu, '').replace(/[\s  ]/g, '').replace(',', '.');
  if (!/^\d{1,11}(?:\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

// Детали страховой «каждая с новой строки» (или через «;») → список без пустых и повторов.
export function insurerParts(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\n;]+/);
  const out = [];
  for (const x of list) {
    const v = String(x ?? '').replace(/^\s*\d{1,3}[.)]\s*/, '').trim();
    if (v && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out;
}

// calc — строка insurer_calcs, ours — названия деталей из таблицы дела. → { rows, both, added, excluded, diff_kop }.
export function compareInsurer(calc, ours) {
  const theirs = calc.parts ?? [];
  const used = new Set();
  const rows = [];
  for (const part of ours) {
    const i = theirs.findIndex((t, k) => !used.has(k) && samePart(part, t));
    if (i >= 0) { used.add(i); rows.push({ part, insurer: theirs[i], kind: 'both' }); } else rows.push({ part, insurer: null, kind: 'added' });
  }
  theirs.forEach((t, k) => { if (!used.has(k)) rows.push({ part: t, insurer: t, kind: 'excluded' }); });
  const count = (kind) => rows.filter((r) => r.kind === kind).length;
  return {
    rows, both: count('both'), added: count('added'), excluded: count('excluded'),
    diff_kop: calc.own_kop == null ? null : Number(calc.own_kop) - Number(calc.insurer_kop),
  };
}

const KIND_TEXT = { both: 'совпадает', added: 'добавлено экспертом', excluded: 'исключено экспертом' };
const signed = (kop) => (kop > 0 ? `+${rubText(kop)}` : rubText(kop));

// Строка-итог для черновика и экрана.
export function insurerLine(calc, cmp) {
  const basis = calc.basis ? ` (${cell(calc.basis)})` : '';
  const own = calc.own_kop == null ? '[заполнить]' : rubText(Number(calc.own_kop));
  const diff = cmp.diff_kop == null ? '' : `, разница — ${signed(cmp.diff_kop)}`;
  return `${INS_LEAD}${basis}: деталей совпадает — ${cmp.both}, добавлено экспертом — ${cmp.added}, исключено экспертом — ${cmp.excluded}. `
    + `Сумма ${WEAR[calc.wear]}: у страховой — ${rubText(Number(calc.insurer_kop))}, по расчёту эксперта — ${own}${diff}`.replace(/(?<!\.)$/, '.');
}

// Блок для черновика: строка-итог, пустая строка, таблица. Сверки нет — null.
export function insurerBlock(calc, ours) {
  if (!calc) return null;
  const cmp = compareInsurer(calc, ours);
  const lines = [insurerLine(calc, cmp)];
  if (cmp.rows.length) {
    lines.push('', INS_HEAD, ...cmp.rows.map((r, i) => {
      const name = r.kind === 'both' && r.insurer.toLowerCase() !== r.part.toLowerCase() ? `${r.part} (у страховой — «${r.insurer}»)` : r.part;
      return `| ${i + 1} | ${cell(name)} | ${r.kind === 'added' ? 'нет' : 'есть'} | ${r.kind === 'excluded' ? 'нет' : 'есть'} | ${KIND_TEXT[r.kind]} |`;
    }));
  }
  return lines;
}

// Конец прежнего блока: строка-итог, затем пустые строки и строки таблицы «| … |» (только если таблица — наша).
function blockEnd(all, start) {
  let end = start + 1;
  let k = end;
  while (k < all.length && !all[k].trim()) k += 1;
  if (k < all.length && all[k].trim() === INS_HEAD) {
    end = k + 1;
    while (end < all.length && all[end].trim().startsWith('|')) end += 1;
  }
  return end;
}

// Блок — в раздел с parts: прежний заменяется; иначе — под таблицей повреждённых деталей, нет её — под заголовком раздела.
export function placeInsurer(body, sections, lines) {
  if (!lines) return body;
  const all = body.split('\n');
  const old = all.findIndex((l) => l.startsWith(INS_LEAD));
  if (old >= 0) {
    all.splice(old, blockEnd(all, old) - old, ...lines);
    return all.join('\n');
  }
  const table = all.findIndex((l) => l.trim() === PARTS_HEAD);
  if (table >= 0) {
    let end = table + 1;
    while (end < all.length && all[end].trim().startsWith('|')) end += 1;
    all.splice(end, 0, '', ...lines);
    return all.join('\n');
  }
  const s = sections.find((x) => x.parts);
  if (!s) return body;
  const m = [...body.matchAll(/^#{1,3}\s*(.+)$/gm)].find((h) => headKey(h[1]) === headKey(s.title));
  if (!m) return body;
  const at = m.index + m[0].length;
  return `${body.slice(0, at)}\n${lines.join('\n')}${body.slice(at)}`;
}

export async function loadInsurer(sql, orderId) {
  return sql.one`select order_id, basis, wear, insurer_kop, own_kop, parts, updated_at from insurer_calcs where order_id = ${orderId}`;
}
