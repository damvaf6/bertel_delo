// Оценка доли (2.510). Доля в квартире или доме оценивается двумя способами: рыночная стоимость доли (дешевле части целой
// квартиры — скидка на долю) или часть стоимости всего объекта (целое × доля, без скидки; так часто ставит вопрос суд при
// разделе имущества). Заказчик выбирает способ в заявке («Если доля — как оценивать»); здесь — разбор размера доли и
// подсказка в деле всем, кто видит заявку. О правах сторон и о том, как делить, не пишем — это решает суд.
import { headKey } from '../dossier/dossier.mjs';

// «1/3», «1 / 3» → { a: 1, b: 3 }; иначе null. Доля больше целого или нулевая — не доля.
export function shareOf(raw) {
  const m = /^\s*(\d{1,3})\s*\/\s*(\d{1,4})\s*$/.exec(String(raw ?? ''));
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a > 0 && b > 0 && a < b ? { a, b } : null;
}

const COURT = ['court', 'division'];

export function shareNotices(serviceId, fields = {}) {
  if (serviceId !== 'realty') return [];
  const isShare = fields.object_type === 'share';
  const raw = String(fields.share_size ?? '').trim();
  if (!isShare) {
    return raw ? [{ id: 'share_type', text: `В заявке указан размер доли (${raw}), а оценивается не доля — проверьте «Что оцениваем».` }] : [];
  }
  const out = [];
  const s = shareOf(raw);
  if (!raw) out.push({ id: 'share_size', text: 'Оценивается доля — укажите её размер (например, 1/3): без него стоимость доли не посчитать.' });
  else if (!s) out.push({ id: 'share_size', text: `Размер доли «${raw}» не похож на долю — напишите дробью меньше целого, например 1/3.` });
  const part = s ? ` (${s.a}/${s.b})` : '';
  if (fields.share_method === 'market') {
    out.push({ id: 'share_market', text: `Оценивается рыночная стоимость доли${part}: продать долю дешевле, чем часть целого объекта, — в отчёте скидка на долю с источником (справочник, таблица).` });
  } else if (fields.share_method === 'pro_rata') {
    out.push({ id: 'share_pro_rata', text: `Оценивается часть стоимости всего объекта${part}: стоимость целого × долю, без скидки на долю. Сверьте с вопросом в определении суда или в задании на оценку.` });
  } else {
    out.push({ id: 'share_ask', text: COURT.includes(fields.purpose)
      ? 'Не указано, как оценивать долю: рыночная стоимость доли (со скидкой) или часть стоимости всего объекта (без скидки). Для суда это решает суд — уточните по определению о назначении экспертизы.'
      : 'Не указано, как оценивать долю: рыночная стоимость доли (со скидкой) или часть стоимости всего объекта (без скидки). Уточните у заказчика.' });
  }
  return out;
}

// Таблица «Расчёт стоимости доли» (2.511) — в конец раздела черновика с share: true (у оценки недвижимости — «14. Согласование
// результатов»), после весов подходов и итога: стоимость объекта целиком, размер доли, часть стоимости (целое × доля), скидка
// на долю и стоимость доли. Суммы считает эксперт — «[заполнить]»; программа знает размер доли и способ из заявки: при
// «рыночной» скидка с источником, при «части стоимости целого» скидки нет, способ не указан — пропуск «как по заданию или
// определению суда». Прежняя таблица узнаётся по строке заголовка и заменяется целиком; из черновика — в Word.
export const SHARE_HEAD = '| Расчёт стоимости доли | Значение |';
const GAP = '[заполнить]';

export function shareTable(serviceId, fields = {}) {
  if (serviceId !== 'realty' || fields.object_type !== 'share') return null;
  const s = shareOf(fields.share_size);
  const part = s ? `${s.a}/${s.b}` : 'доля';
  const rows = [
    SHARE_HEAD,
    `| Стоимость объекта целиком, руб. | ${GAP} |`,
    `| Размер доли | ${s ? part : GAP} |`,
    `| Часть стоимости объекта (целое × ${part}), руб. | ${GAP} |`,
  ];
  if (fields.share_method === 'market') {
    rows.push(`| Скидка на долю, % | ${GAP} (источник — ${GAP}) |`,
      `| Рыночная стоимость доли (часть × (1 − скидка)), руб. | ${GAP} |`);
  } else if (fields.share_method === 'pro_rata') {
    rows.push('| Скидка на долю | не применяется — оценивается часть стоимости всего объекта |',
      `| Стоимость доли (равна части стоимости объекта), руб. | ${GAP} |`);
  } else {
    rows.push(`| Скидка на долю | ${GAP}: со скидкой или без — по заданию на оценку или определению суда |`,
      `| Стоимость доли, руб. | ${GAP} |`);
  }
  return rows;
}

// Прежняя такая таблица — заменяется; иначе — в конец раздела с share (перед следующим заголовком) через пустую строку,
// чтобы не слиться с таблицей весов подходов; раздела нет — текст как есть.
export function placeShare(body, sections, lines) {
  if (!lines) return body;
  const all = body.split('\n');
  const old = all.findIndex((l) => l.trim() === SHARE_HEAD);
  if (old >= 0) {
    let end = old + 1;
    while (end < all.length && all[end].trim().startsWith('|')) end += 1;
    all.splice(old, end - old, ...lines);
    return all.join('\n');
  }
  const s = sections.find((x) => x.share);
  if (!s) return body;
  const m = [...body.matchAll(/^#{1,3}\s*(.+)$/gm)].find((h) => headKey(h[1]) === headKey(s.title));
  if (!m) return body;
  const next = body.slice(m.index + m[0].length).search(/\n#{1,3}\s/);
  const at = next < 0 ? body.length : m.index + m[0].length + next;
  const head = body.slice(0, at).replace(/\s*$/, '');
  const tail = body.slice(at);
  return `${head}\n\n${lines.join('\n')}${tail ? `\n${tail}` : '\n'}`;
}

// Скидка на долю из черновика (2.517, сводка руководителя): строка «Скидка на долю» таблицы «Расчёт стоимости доли» (или текста) —
// процент числом; «не применяется» — 0; пропуск «[заполнить]» или строки нет — null.
const DISC_LINE = /скидк\S*\s+(?:на|за)\s+(?:долю|долев\S*)|долев\S*\s+скидк\S*/iu;
export function shareDiscount(body) {
  for (const line of String(body ?? '').split('\n')) {
    const m = DISC_LINE.exec(line);
    if (!m) continue;
    const rest = line.slice(m.index + m[0].length).replace(/^\s*,?\s*%/u, '');
    if (/не\s+применя|без\s+скидк/iu.test(rest)) return 0;
    const n = /(?<![\d\[])(\d{1,2}(?:[,.]\d{1,2})?)\s*%?(?![\d/])/u.exec(rest.split('[')[0]);
    if (n) return Number(n[1].replace(',', '.'));
  }
  return null;
}
