// Повреждённые детали (2.471, «Ущерб автомобилю после ДТП»). Эксперт ведёт в деле таблицу: деталь, повреждение, ремонтное
// воздействие (замена, ремонт, окраска — parts.actions в модуле) и номера фото осмотра. Таблица — в раздел черновика с
// пометкой parts (у ДТП — «5. Исследование повреждений»): при подготовке черновика ИИ — программой, в деле — кнопкой;
// прежняя таблица узнаётся по строке заголовка и заменяется целиком. Из черновика таблица попадает в Word, как остальные.
import { headKey } from '../dossier/dossier.mjs';

export const PARTS_HEAD = '| № | Деталь | Повреждение | Ремонтное воздействие | Фото осмотра |';
export const PART_MAX = 120;
export const DAMAGE_MAX = 300;
export const PARTS_MAX = 60;

// Значение в ячейке — одной строкой и без «|».
const cell = (v) => String(v ?? '').replace(/\s*\n\s*/g, '; ').replace(/\|/g, '/').trim();

// Номера фото → «Фото 3, 5, 7»; фото удалили — его просто нет; ни одного — «нет фото».
export const photosText = (nos) => (nos.length ? `Фото ${nos.join(', ')}` : 'нет фото');

// Строки таблицы для черновика; деталей нет — null. photoNo: id документа → номер фото в деле.
export function partsTable(list, actions, photoNo) {
  if (!list.length) return null;
  const actionName = (id) => actions.find((a) => a.id === id)?.name ?? id;
  return [
    PARTS_HEAD,
    ...list.map((p, i) => `| ${i + 1} | ${cell(p.part)} | ${cell(p.damage)} | ${cell(p.actions.map(actionName).join(', '))} | ${photosText(photoNos(p, photoNo))} |`),
  ];
}

export const photoNos = (p, photoNo) => (p.photo_ids ?? []).map((id) => photoNo.get(String(id))).filter(Boolean).sort((a, b) => a - b);

// Таблицу — в раздел с parts: прежняя таблица (строка-заголовок и строки «| … |» под ней) заменяется, иначе встаёт сразу
// под заголовком раздела.
export const placeParts = (body, sections, lines) => placeTableIn(body, sections, lines, PARTS_HEAD, 'parts');

// Общая вставка таблицы из дела в раздел черновика с пометкой flag (parts — детали ДТП, defects — недостатки товара, 2.482):
// прежняя таблица с той же строкой-заголовком заменяется целиком, иначе встаёт сразу под заголовком раздела.
export function placeTableIn(body, sections, lines, head, flag) {
  if (!lines) return body;
  const all = body.split('\n');
  const old = all.findIndex((l) => l.trim() === head);
  if (old >= 0) {
    let end = old + 1;
    while (end < all.length && all[end].trim().startsWith('|')) end += 1;
    all.splice(old, end - old, ...lines);
    return all.join('\n');
  }
  const s = sections.find((x) => x[flag]);
  if (!s) return body;
  const m = [...body.matchAll(/^#{1,3}\s*(.+)$/gm)].find((h) => headKey(h[1]) === headKey(s.title));
  if (!m) return body;
  const at = m.index + m[0].length;
  return `${body.slice(0, at)}\n${lines.join('\n')}${body.slice(at)}`;
}

export async function loadParts(sql, orderId) {
  return sql`select id, part, damage, actions, photo_ids, created_at, updated_at from damaged_parts where order_id = ${orderId} order by id`;
}
