// Таблица «Характеристики объекта оценки» (2.494). Раздел черновика с specs: [строка…] (у оценки транспорта — «7. Описание
// объекта») получает таблицу: характеристика, значение и откуда оно — из заявки или с выезда помощника (данные с объекта,
// express в модуле). Строка { field } — поле заявки; { onsite } — поле с выезда (без выезда строки нет); { field, onsite } —
// с выезда, а нет его — из заявки (пробег по прибору важнее пробега со слов заказчика; разница — в скобках). Не заполнено —
// «[заполнить]», эксперт видит пропуск. Таблица вставляется при черновике ИИ и кнопкой в деле, прежняя узнаётся по строке
// заголовка и заменяется целиком; из черновика — в Word, как остальные таблицы.
import { placeTableIn } from './parts.mjs';

export const SPECS_HEAD = '| Характеристика объекта оценки | Значение | Откуда |';
const GAP = '[заполнить]';
const NUM = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

const cell = (v) => String(v ?? '').replace(/\s*\n\s*/g, '; ').replace(/\|/g, '/').trim();
const dayRu = (t) => new Date(t).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';
// «Пробег, км» → «Пробег» и единица «км»: у числа единица идёт в значение.
const split = (label) => label.split(/,\s*(?=[^,]*$)/);

function shown(f, v) {
  if (!has(v)) return null;
  if (f.type === 'select') return f.options.find((o) => o.id === v)?.name ?? null;
  if (f.type === 'number') {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    const [, unit] = split(f.label);
    return `${Math.abs(n) < 10000 ? String(n).replace('.', ',') : NUM.format(n).replace(/\s/g, ' ')}${unit ? ` ${unit}` : ''}`;
  }
  return String(v).replace(/\s+/g, ' ').trim();
}

// Строки таблицы; rows — specs раздела, fields — поля услуги, values — заявка, express — поля выезда,
// visit — последний завершённый выезд { data, finished_at } или null. Ни одного значения — null.
export function specsTable(rows, fields, values, express, visit) {
  if (!rows?.length) return null;
  const out = [];
  let any = false;
  for (const r of rows) {
    const f = r.field ? fields.find((x) => x.id === r.field) : null;
    const e = r.onsite ? (express ?? []).find((x) => x.id === r.onsite) : null;
    const fromVisit = e && visit ? shown(e, visit.data?.[e.id]) : null;
    const fromOrder = f ? shown(f, values?.[f.id]) : null;
    if (!f && !visit) continue;
    const name = r.label ?? split((f ?? e).label)[0];
    if (fromVisit) {
      const differs = fromOrder && fromOrder !== fromVisit ? ` (в заявке — ${fromOrder})` : '';
      out.push(`| ${cell(name)} | ${cell(fromVisit + differs)} | по осмотру, выезд помощника ${dayRu(visit.finished_at)} |`);
      any = true;
    } else if (fromOrder) {
      out.push(`| ${cell(name)} | ${cell(fromOrder)} | заявка |`);
      any = true;
    } else {
      out.push(`| ${cell(name)} | ${GAP} | — |`);
    }
  }
  return any ? [SPECS_HEAD, ...out] : null;
}

export const placeSpecs = (body, sections, lines) => placeTableIn(body, sections, lines, SPECS_HEAD, 'specs');

// Последний завершённый выезд помощника по делу (отменённые не в счёт).
export async function lastVisit(sql, orderId) {
  return sql.one`select data, finished_at from onsite_visits where order_id = ${orderId} and finished_at is not null
                 and cancelled_at is null order by finished_at desc limit 1`;
}
