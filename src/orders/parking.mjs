// Машино-место или кладовая (2.549). Машино-место с 01.01.2017 — отдельный объект недвижимости (ст. 130 ГК РФ, 315-ФЗ):
// своя выписка ЕГРН и кадастровый номер, границы — по разметке или плану. В старых паркингах права оформлены долей в праве
// на весь паркинг («1/120 доли») с местом по порядку пользования — тогда оценивается доля, а не машино-место. Кладовая —
// нежилое помещение. Для ипотеки часто оценивается вместе с квартирой в том же доме. Здесь — подсказка в деле всем, кто
// видит заявку; строка «Из заявки: …» — `facts` у «7. Описание объекта оценки».

import { placeUnder } from './ddu.mjs';
import { isAssumptions } from './retro.mjs';

const FILLED = ['parking_kind', 'parking_type', 'parking_level', 'parking_number', 'parking_right', 'parking_share', 'parking_with_flat'];
const FLATS = ['flat', 'room', 'ddu'];

export function parkingNotices(serviceId, fields = {}) {
  if (serviceId !== 'realty') return [];
  const has = (id) => fields[id] !== undefined && fields[id] !== null && String(fields[id]).trim() !== '';
  if (fields.object_type !== 'parking') {
    if (!FILLED.some(has)) return [];
    // Квартира и место в одной заявке — два объекта; при доме, доле, нежилом — скорее ошибка в «Что оцениваем».
    return FLATS.includes(fields.object_type)
      ? [{ id: 'parking_extra', text: 'Кроме квартиры в заявке машино-место или кладовая — в отчёте это два объекта: у каждого своя выписка ЕГРН, описание и стоимость, общая — суммой. Если оценивается только место — поменяйте «Что оцениваем».' }]
      : [{ id: 'parking_check', text: 'В заявке есть сведения о машино-месте или кладовой, а оценивается другой объект — проверьте «Что оцениваем».' }];
  }
  const storage = fields.parking_kind === 'storage';
  const share = fields.parking_right === 'share';
  const out = [];
  if (share) {
    const size = has('parking_share') ? ` (${String(fields.parking_share).trim()})` : '';
    out.push({ id: 'parking_share', text: `Оценивается доля в праве на паркинг${size}, а не ${storage ? 'кладовая' : 'машино-место'}: в отчёте — «доля в праве общей долевой собственности на нежилое помещение (паркинг)» с местом по порядку пользования; называть объект машино-местом без такой оговорки нельзя. Порядок пользования (соглашение или решение собрания) — в документы дела.` });
    if (!has('parking_share')) out.push({ id: 'parking_share_size', text: 'Не указан размер доли в паркинге — возьмите из выписки ЕГРН или уточните у заказчика.' });
  } else if (storage) {
    out.push({ id: 'parking_object', text: 'Кладовая — нежилое помещение: своя выписка ЕГРН и кадастровый номер, площадь — по выписке. Аналоги — кладовые, а не машино-места.' });
  } else {
    out.push({ id: 'parking_object', text: 'Машино-место — отдельный объект недвижимости (ст. 130 ГК РФ, с 2017 года): своя выписка ЕГРН и кадастровый номер, границы — по разметке или плану паркинга. Номер места, уровень и площадь — как в выписке.' });
  }
  if (!has('parking_number')) out.push({ id: 'parking_number', text: `Не указан номер ${storage ? 'кладовой' : 'места'} — уточните у заказчика: по нему сверяются выписка, план паркинга и осмотр.` });
  if (fields.parking_with_flat === 'yes') out.push({ id: 'parking_flat', text: 'Оценивается вместе с квартирой в этом доме: у каждого объекта своя выписка ЕГРН и своя стоимость, общая — суммой; банку обычно нужна стоимость каждого.' });
  return out;
}

// Черновик (2.551): строка об объекте и правах — в «Задание на оценку» (таблица задания), допущение о границах места — в раздел
// допущений. Обе узнаются по началу и заменяются; встают сразу под заголовком раздела. Только «Машино-место или кладовая».
// Площадь в строку не идёт — она по выписке ЕГРН (своя строка таблицы задания).
export const PARKING_TASK_HEAD = 'Объект оценки в паркинге:';
export const PARKING_ASSUME_HEAD = 'Границы места:';
const parking = (serviceId, fields) => serviceId === 'realty' && fields?.object_type === 'parking';
const val = (fields, id) => String(fields?.[id] ?? '').replace(/\s+/g, ' ').trim();
const TYPES = { underground: 'подземный', ground: 'наземный', multi: 'многоуровневый' };

// kind — вид стоимости из задания на оценку (2.282), если есть; иначе — рыночная стоимость.
export function parkingTaskLine(serviceId, fields = {}, kind = null) {
  if (!parking(serviceId, fields)) return null;
  const GAP = '[заполнить]';
  const storage = fields.parking_kind === 'storage';
  const share = fields.parking_right === 'share';
  const num = val(fields, 'parking_number') || GAP;
  const place = storage ? `кладовая № ${num}` : `машино-место № ${num}`;
  const where = [
    TYPES[fields.parking_type] ? `${TYPES[fields.parking_type]} паркинг` : null,
    val(fields, 'parking_level') ? `уровень ${val(fields, 'parking_level')}` : null,
  ].filter(Boolean).join(', ');
  const at = where ? ` (${where})` : '';
  const k = String(kind ?? '').trim();
  const kindText = `Вид стоимости — ${k ? `${k} (по заданию на оценку)` : 'рыночная стоимость'}.`;
  const flat = fields.parking_with_flat === 'yes'
    ? ' Оценивается вместе с квартирой в этом доме: стоимость каждого объекта определяется отдельно, общая — суммой.' : '';
  if (share) {
    const size = val(fields, 'parking_share') || GAP;
    return `${PARKING_TASK_HEAD} доля ${size} в праве общей долевой собственности на нежилое помещение (${TYPES[fields.parking_type] ? where : ['паркинг', where].filter(Boolean).join(', ')}); по порядку пользования за долей ${storage ? 'закреплена' : 'закреплено'} ${place}. Оцениваемые права — право общей долевой собственности (доля в праве), не право собственности на ${storage ? 'кладовую' : 'машино-место'} как отдельный объект. ${kindText}${flat}`;
  }
  const what = storage ? `нежилое помещение — ${place}${at}` : `${place}${at} — отдельный объект недвижимости (ст. 130 ГК РФ)`;
  return `${PARKING_TASK_HEAD} ${what}. Оцениваемые права — право собственности на ${storage ? 'нежилое помещение' : 'машино-место'}; номер, уровень и площадь — по выписке ЕГРН. ${kindText}${flat}`;
}

export function parkingAssumption(serviceId, fields = {}) {
  if (!parking(serviceId, fields)) return null;
  const storage = fields.parking_kind === 'storage';
  if (fields.parking_right === 'share') {
    return `${PARKING_ASSUME_HEAD} доля в праве на паркинг в натуре не выделена; ${storage ? 'кладовая определена' : 'место определено'} по порядку пользования (соглашению собственников или решению собрания), границы — по разметке и поэтажному плану паркинга. Обмеры оценщик не проводил; принято, что порядок пользования действует и не оспаривается.`;
  }
  return storage
    ? `${PARKING_ASSUME_HEAD} границы кладовой приняты по поэтажному плану и плану расположения помещения в выписке ЕГРН; площадь — по выписке ЕГРН. Обмеры оценщик не проводил.`
    : `${PARKING_ASSUME_HEAD} границы машино-места приняты по разметке на полу паркинга и по плану расположения места в выписке ЕГРН (поэтажному плану паркинга); площадь — по выписке ЕГРН. Обмеры оценщик не проводил; если разметка расходится с планом, верным принят план.`;
}

export const placeParkingTask = (body, sections, line) => placeUnder(body, sections, line, PARKING_TASK_HEAD, (x) => x.table === 'task');
export const placeParkingAssumption = (body, sections, line) => placeUnder(body, sections, line, PARKING_ASSUME_HEAD, (x) => isAssumptions(x.title));
