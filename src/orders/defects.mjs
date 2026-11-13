// Недостатки товара (2.482, товароведческая экспертиза). Эксперт ведёт в деле таблицу: недостаток, где и какой размер,
// характер (производственный, эксплуатационный, не установлен, не подтвердился — defects.natures в модуле), признаки и
// номера фото осмотра. Таблица — в раздел черновика с пометкой defects (у товара — «5. Исследование»): при подготовке
// черновика ИИ — программой, в деле — кнопкой; прежняя таблица узнаётся по строке заголовка и заменяется целиком. Из
// черновика — в Word, как остальные таблицы. Характер — факт исследования, без выводов о праве.
import { placeTableIn, photoNos, photosText } from './parts.mjs';

export const DEFECTS_HEAD = '| № | Недостаток | Где и размер | Характер | Признаки | Фото осмотра |';
export const DEFECT_MAX = 200;
export const PLACE_MAX = 300;
export const SIGNS_MAX = 600;
export const DEFECTS_MAX = 40;

const cell = (v) => String(v ?? '').replace(/\s*\n\s*/g, '; ').replace(/\|/g, '/').trim();

// Строки таблицы для черновика; недостатков нет — null. photoNo: id документа → номер фото в деле.
export function defectsTable(list, natures, photoNo) {
  if (!list.length) return null;
  const nature = (id) => natures.find((a) => a.id === id)?.name ?? id;
  return [
    DEFECTS_HEAD,
    ...list.map((d, i) => `| ${i + 1} | ${cell(d.defect)} | ${cell(d.place)} | ${cell(nature(d.nature))} | ${cell(d.signs) || '—'} | ${photosText(photoNos(d, photoNo))} |`),
  ];
}

export const placeDefects = (body, sections, lines) => placeTableIn(body, sections, lines, DEFECTS_HEAD, 'defects');

// Сравнение названий недостатков: регистр, «ё», знаки и лишние пробелы не важны; одно содержит другое — тот же.
const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const sameDefect = (a, b) => { const x = norm(a), y = norm(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };

// Недостатки из заявки (поле defects, каждый с новой строки), которых ещё нет в таблице.
export function claimedLeft(fieldText, list) {
  const lines = String(fieldText ?? '').split('\n').map((l) => l.replace(/^[\s\-–—•*\d.)]+/, '').trim()).filter(Boolean);
  const out = [];
  for (const l of lines) if (!list.some((d) => sameDefect(d.defect, l)) && !out.some((x) => sameDefect(x, l))) out.push(l.slice(0, DEFECT_MAX));
  return out;
}

export async function loadDefects(sql, orderId) {
  return sql`select id, defect, place, nature, signs, photo_ids, created_at, updated_at from goods_defects where order_id = ${orderId} order by id`;
}
