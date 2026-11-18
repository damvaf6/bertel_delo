// Жилой дом (2.529). У оценки недвижимости «Жилой дом» главное отличие от квартиры — участок под домом: дом и участок —
// единый объект (ст. 35 Земельного кодекса РФ), их оценивают вместе и показывают стоимость каждого. Заказчик в заявке пишет
// материал стен, оформлен ли участок, его кадастровый номер и площадь, газ и пригоден ли дом для зимы; здесь — подсказка в
// деле всем, кто видит заявку. О самовольной постройке и законности прав не пишем — это вопрос юриста, не оценщика.
import { placeShare } from './share.mjs';
import { egrnArea, egrnCadastral, egrnKind } from '../ai/report-checks.mjs';

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

// 2.538: выписка ЕГРН на участок в деле — номер и площадь участка в таблицу из неё (другие в заявке сверит ИИ-проверка
// house_land по строке «Из заявки: …»), иначе — по заявке.
// { cadastral, area } — номер и площадь в кв. м из выписки на участок (одно значение), иначе null.
export function landEgrnFacts(egrn) {
  const land = (egrn ?? []).filter((d) => egrnKind(d) === 'land');
  if (!land.length) return null;
  const ctx = { service: 'land' };
  const cad = egrnCadastral(land, ctx);
  const area = egrnArea(land, ctx);
  return cad || area ? { cadastral: cad?.v ?? null, area: area?.v > 0 ? area.v : null } : null;
}
const sot = (sq) => `${NUM.format(Math.round(sq) / 100).replace(/\s/g, ' ')} сот.`;
function landNote(fields, egrn) {
  const cad = String(fields.land_cadastral ?? '').trim();
  const area = Number(fields.land_area);
  const typed = Number.isFinite(area) && area > 0 ? area * 100 : null;
  if (egrn?.cadastral || egrn?.area) {
    const bits = [egrn.cadastral ? `кадастровый номер ${egrn.cadastral}` : cad ? `кадастровый номер ${cad} (по заявке)` : null,
      egrn.area ? `${NUM.format(egrn.area).replace(/\s/g, ' ')} кв. м` : typed ? `${sot(typed)} (по заявке)` : null].filter(Boolean);
    return ` (${bits.join(', ')} — по выписке ЕГРН на участок)`;
  }
  const bits = [cad ? `кадастровый номер ${cad}` : null, typed ? sot(typed) : null].filter(Boolean);
  return bits.length ? ` (${bits.join(', ')} — по заявке, сверьте с выпиской ЕГРН на участок)` : '';
}

export function houseTable(serviceId, fields = {}, egrn = null) {
  if (serviceId !== 'realty' || fields.object_type !== 'house') return null;
  const rows = [HOUSE_HEAD, `| Жилой дом, руб. | ${GAP} |`];
  const land = fields.house_land;
  if (land === 'own') {
    rows.push(`| Земельный участок под домом${landNote(fields, egrn)}, руб. | ${GAP} |`,
      `| Итого: дом и участок (единый объект, ст. 35 ЗК РФ), руб. | ${GAP} |`,
      `| Доля участка в итоговой стоимости, % | ${GAP} |`);
  } else if (land === 'lease') {
    rows.push(`| Право аренды участка под домом${landNote(fields, egrn)}, руб. | ${GAP} (если переходит вместе с домом; иначе — «не оценивается») |`,
      `| Итого: дом и право аренды участка, руб. | ${GAP} |`);
  } else if (land === 'none') {
    rows.push('| Земельный участок | не оценивается — участок под домом не оформлен |',
      `| Итого (равно стоимости дома), руб. | ${GAP} |`);
  } else {
    rows.push(`| Земельный участок под домом${landNote(fields, egrn)}, руб. | ${GAP}: оформлен ли участок — уточните у заказчика; не оформлен — «не оценивается» |`,
      `| Итого, руб. | ${GAP} |`);
  }
  return rows;
}

export function placeHouse(body, sections, lines) {
  return placeShare(body, sections, lines, 'house');
}

// Суммы из таблицы «Стоимость дома и участка» черновика (2.537, сводка руководителя): дом, участок (или право аренды), итог и
// доля участка в итоге, %. Ячейка с пропуском «[заполнить]» или без числа — null. Доля — как вписана экспертом (0 < x < 100),
// а не вписана — участок / итог по суммам таблицы. Таблицы нет — всё null.
const cellValue = (cell) => {
  const n = /(?<![\d])(\d{1,3}(?:[\s  ]\d{3})+|\d+)(?:[,.](\d+))?(?![\d/])/u.exec(String(cell ?? '').split('[')[0]);
  return n ? Number(n[1].replace(/[\s  ]/gu, '')) + (n[2] ? Number(`0.${n[2]}`) : 0) : null;
};
// { house, land, total, share } — руб., руб., руб., %.
export function houseFacts(body) {
  const out = { house: null, land: null, total: null, share: null };
  const lines = String(body ?? '').split('\n');
  const at = lines.findIndex((l) => l.trim().startsWith(HOUSE_HEAD));
  if (at < 0) return out;
  for (const line of lines.slice(at + 1)) {
    const l = line.trim();
    if (!l.startsWith('|')) break;
    const cells = l.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2 || /^[-:\s]+$/u.test(cells[0])) continue;
    const [label, value] = [cells[0], cellValue(cells.at(-1))];
    if (/^жил\S*\s+дом/iu.test(label)) out.house = value > 0 ? value : null;
    else if (/^(?:земельн\S*\s+участ|право\s+аренды)/iu.test(label)) out.land = value > 0 ? value : null;
    else if (/^итог/iu.test(label)) out.total = value > 0 ? value : null;
    else if (/^дол\S*\s+участк/iu.test(label)) out.share = value > 0 && value < 100 ? value : null;
  }
  if (out.share == null && out.land && out.total && out.land < out.total) out.share = Math.round((out.land / out.total) * 1000) / 10;
  return out;
}
