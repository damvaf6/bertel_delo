// Жилой дом (2.529). У оценки недвижимости «Жилой дом» главное отличие от квартиры — участок под домом: дом и участок —
// единый объект (ст. 35 Земельного кодекса РФ), их оценивают вместе и показывают стоимость каждого. Заказчик в заявке пишет
// материал стен, оформлен ли участок, его кадастровый номер и площадь, газ и пригоден ли дом для зимы; здесь — подсказка в
// деле всем, кто видит заявку. О самовольной постройке и законности прав не пишем — это вопрос юриста, не оценщика.
import { placeShare } from './share.mjs';

const FILLED = ['house_walls', 'house_land', 'land_cadastral', 'land_area', 'house_gas', 'house_winter'];

export function houseNotices(serviceId, fields = {}) {
  if (serviceId !== 'realty') return [];
  const has = (id) => fields[id] !== undefined && fields[id] !== null && fields[id] !== '';
  if (fields.object_type !== 'house') {
    return FILLED.some(has)
      ? [{ id: 'house_type', text: 'В заявке есть сведения о жилом доме (участок, материал стен, газ), а оценивается не жилой дом — проверьте «Что оцениваем».' }]
      : [];
  }
  const out = [];
  if (fields.house_land === 'own') {
    out.push({ id: 'house_land_own', text: 'Участок под домом в собственности: дом и участок — единый объект (ст. 35 ЗК РФ). В отчёте оцените оба и покажите стоимость дома, участка и итог; выписка ЕГРН на участок — в документы дела.' });
    if (!has('land_cadastral')) out.push({ id: 'house_land_cad', text: 'Не указан кадастровый номер участка — уточните у заказчика или возьмите из выписки ЕГРН на участок.' });
  } else if (fields.house_land === 'lease') {
    out.push({ id: 'house_land_lease', text: 'Участок под домом в аренде: оценивается дом и, если оно переходит вместе с домом, право аренды участка. Договор аренды участка — в документы дела.' });
  } else {
    out.push({ id: 'house_land_ask', text: 'Не указано, оформлен ли участок под домом: от этого зависит, что оценивается — дом с участком или только дом. Уточните у заказчика.' });
  }
  if (fields.purpose === 'bank' && fields.house_winter === 'no') {
    out.push({ id: 'house_bank', text: 'Дом летний, а оценка для банка: многие банки берут в залог только дом для круглогодичного проживания — уточните требования банка.' });
  }
  return out;
}

// Таблица «Стоимость дома и участка» (2.531) — в конец раздела черновика с house: true (у оценки недвижимости — «14. Согласование
// результатов»), после весов подходов и итога. Участок в собственности — дом, участок и итог (дом + участок) и доля участка в
// итоге; в аренде — дом и право аренды участка (если переходит вместе с домом); не оформлен — только дом, итог равен ему; не
// указано — строка участка с пропуском «уточните». Кадастровый номер и площадь участка — из заявки, суммы — эксперт
// («[заполнить]»). Прежняя таблица узнаётся по строке заголовка и заменяется целиком (`placeShare`); из черновика — в Word.
export const HOUSE_HEAD = '| Стоимость дома и участка | Значение |';
const GAP = '[заполнить]';
const NUM = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

function landNote(fields) {
  const cad = String(fields.land_cadastral ?? '').trim();
  const area = Number(fields.land_area);
  const bits = [cad ? `кадастровый номер ${cad}` : null,
    Number.isFinite(area) && area > 0 ? `${NUM.format(area).replace(/\s/g, ' ')} сот.` : null].filter(Boolean);
  return bits.length ? ` (${bits.join(', ')} — по заявке, сверьте с выпиской ЕГРН на участок)` : '';
}

export function houseTable(serviceId, fields = {}) {
  if (serviceId !== 'realty' || fields.object_type !== 'house') return null;
  const rows = [HOUSE_HEAD, `| Жилой дом, руб. | ${GAP} |`];
  const land = fields.house_land;
  if (land === 'own') {
    rows.push(`| Земельный участок под домом${landNote(fields)}, руб. | ${GAP} |`,
      `| Итого: дом и участок (единый объект, ст. 35 ЗК РФ), руб. | ${GAP} |`,
      `| Доля участка в итоговой стоимости, % | ${GAP} |`);
  } else if (land === 'lease') {
    rows.push(`| Право аренды участка под домом${landNote(fields)}, руб. | ${GAP} (если переходит вместе с домом; иначе — «не оценивается») |`,
      `| Итого: дом и право аренды участка, руб. | ${GAP} |`);
  } else if (land === 'none') {
    rows.push('| Земельный участок | не оценивается — участок под домом не оформлен |',
      `| Итого (равно стоимости дома), руб. | ${GAP} |`);
  } else {
    rows.push(`| Земельный участок под домом${landNote(fields)}, руб. | ${GAP}: оформлен ли участок — уточните у заказчика; не оформлен — «не оценивается» |`,
      `| Итого, руб. | ${GAP} |`);
  }
  return rows;
}

export function placeHouse(body, sections, lines) {
  return placeShare(body, sections, lines, 'house');
}
