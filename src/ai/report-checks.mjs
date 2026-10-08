// Автоматические находки в отчёте (решение Дамира 03.10.2026: ИИ-проверка должна ловить ошибки вроде найденных в
// настоящих отчётах об оценке транспорта). Это не модель ИИ, а простые правила по всему тексту отчёта, страница за
// страницей: они видят весь отчёт, даже когда модели уходит только его часть, и всегда отвечают одинаково.
// Находка — подсказка человеку (место и страница), не вердикт: отметки ставит человек.
// Какие правила к какой проверке относятся — данными в модуле (`checks[].auto`); здесь — только сами правила.
//   runAutoChecks(names, docs, ctx) → { [имя правила]: [{ text, file, where, quote }] }
// docs — [{ name, kind, pages }] (src/ai/extract.mjs); ctx — { fields } заявки, { basis: { kind, number } } (2.38), { analogs } — подтверждённые аналоги дела (2.75),
// { inspectionDays } — дни получения фото осмотра (2.88) и
// { dossier: { items, today } } исполнителя (2.14).

import { adjusted, cleanUrl } from '../analogs/analogs.mjs';

const MAX_PER_RULE = 5;

// ——— Служебные строки Word: поле не обновилось или ссылка потеряна ———
const WORD_FIELD = /(?:Ошибка!\s*(?:Закладка не определена|Источник ссылки не найден|Объект не может быть создан(?: из кодов полей редактирования)?|Недопустимый объект гиперссылки|Не указана последовательность|Неизвестный аргумент ключа|Элементы указателя не найдены|Элементы оглавления не найдены)|Error!\s*(?:Bookmark not defined|Reference source not found|No table of contents entries found))\.?/giu;

function wordFields(doc) {
  const out = [];
  eachPage(doc, (page, i) => {
    for (const m of page.matchAll(WORD_FIELD)) {
      out.push({ page: i, quote: lineAround(page, m.index), text: `Служебная строка Word «${clean(m[0])}» — поле или ссылка не обновились` });
    }
  });
  return out;
}

// ——— Нумерация разделов: пропуск (после 13 сразу 15) ———
// Разделы берутся из оглавления (строки с отточием и номером страницы); если оглавления нет — из заголовков прописными.
// Длинное название в оглавлении переносится: номер — на первой строке, отточие и страница — на последней.
const TOC_START = /^\s*(\d{1,2}(?:\.\d{1,2})*)\.?(?:\s|$)(?![\d.])/;
const TOC_END = /(?:\.{4,}|…{2,})\s*(?:\d{1,3}|ошибка!.*)?\s*$|\s(?:\d{1,3}|ошибка!.*)$/iu;
const HEADING = /^\s*(\d{1,2})\.\s+[А-ЯЁA-Z][А-ЯЁA-Z0-9 ,.«»"()\-–—]{8,}$/u;

export function tocEntries(page) {
  const lines = page.split('\n');
  const out = [];
  for (let k = 0; k < lines.length; k += 1) {
    const m = lines[k].match(TOC_START);
    if (!m) continue;
    let text = lines[k];
    let j = k;
    while (!/(?:\.{4,}|…{2,})/.test(text) && j < k + 3 && j + 1 < lines.length && !TOC_START.test(lines[j + 1])) { j += 1; text += ` ${lines[j]}`; }
    if (/(?:\.{4,}|…{2,})/.test(text) && TOC_END.test(text)) {
      out.push({ num: m[1], top: Number(m[1].split('.')[0]), sub: m[1].includes('.'), text: clean(text), line: clean(lines[k]) });
      k = j;
    }
  }
  return out;
}

function sectionGaps(doc) {
  const fromToc = [];
  const fromHeads = [];
  eachPage(doc, (page, i) => {
    for (const e of tocEntries(page)) if (!e.sub) fromToc.push({ n: e.top, page: i, quote: e.line.slice(0, 120) });
    for (const line of page.split('\n')) {
      const m = line.match(HEADING);
      if (m) fromHeads.push({ n: Number(m[1]), page: i, quote: clean(line).slice(0, 120) });
    }
  });
  const list = fromToc.length >= 4 ? fromToc : fromHeads;
  const nums = [...new Set(list.map((x) => x.n))].sort((a, b) => a - b);
  if (nums.length < 4 || nums[0] > 2) return [];
  const out = [];
  for (let k = 1; k < nums.length; k += 1) {
    const prev = nums[k - 1];
    const next = nums[k];
    if (next - prev < 2 || next - prev > 3) continue; // большой скачок — скорее не раздел, а число в тексте
    const at = list.find((x) => x.n === next);
    const missing = Array.from({ length: next - prev - 1 }, (_, j) => prev + 1 + j).join(', ');
    out.push({ page: at.page, quote: at.quote, text: `Нумерация разделов: после раздела ${prev} сразу ${next} — раздела ${missing} нет${list === fromToc ? ' (по оглавлению)' : ''}` });
  }
  return out;
}

// ——— Год выпуска транспорта: один и тот же везде, совпадает с VIN ———
const VIN = /\b([A-HJ-NPR-Z0-9]{17})\b/g;
const YEAR_NEAR = /(?:(19[5-9]\d|20[0-4]\d)\s*(?:г\.?\s*в\.?|года?\s+выпуска|г\.\s*выпуска)|(?:год\s+(?:выпуска|изготовления)|г\.\s*в\.)\s*[:\-–—]?\s*(19[5-9]\d|20[0-4]\d))/giu;
const VIN_YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY';

// 10-й знак VIN → возможные годы (цикл 30 лет); цифры 1–9 — 2001–2009.
export function vinYears(vin) {
  const c = String(vin || '').toUpperCase()[9];
  if (!c) return [];
  if (/[1-9]/.test(c)) return [2000 + Number(c), 2030 + Number(c)];
  const i = VIN_YEAR_CODES.indexOf(c);
  return i < 0 ? [] : [1980 + i, 2010 + i];
}

function yearsIn(text) {
  return [...text.matchAll(YEAR_NEAR)].map((m) => ({ year: Number(m[1] || m[2]), index: m.index, raw: m[0] }));
}

function vehicleYears(docs) {
  // Все VIN в отчёте; у каждого — годы, стоящие рядом (в той же строке или чуть раньше).
  const vins = new Map();
  const allYears = [];
  for (const doc of docs) {
    eachPage(doc, (page, i) => {
      for (const y of yearsIn(page)) allYears.push({ ...y, doc, page: i, quote: lineAround(page, y.index) });
      for (const m of page.matchAll(VIN)) {
        const vin = m[1];
        if (!/[A-Z]/.test(vin) || !/\d/.test(vin)) continue;
        // Год — в той же строке до VIN; если там нет — в предыдущей строке, если в ней нет другого VIN.
        const lineStart = page.lastIndexOf('\n', m.index - 1) + 1;
        let from = lineStart;
        if (!yearsIn(page.slice(lineStart, m.index)).length && lineStart > 0) {
          const prevStart = page.lastIndexOf('\n', lineStart - 2) + 1;
          if (!/[A-HJ-NPR-Z0-9]{17}/.test(page.slice(prevStart, lineStart))) from = prevStart;
        }
        const near = page.slice(from, m.index);
        const rec = vins.get(vin) ?? { vin, years: [] };
        for (const y of yearsIn(near)) rec.years.push({ year: y.year, doc, page: i, quote: lineAround(page, from + y.index) });
        vins.set(vin, rec);
      }
    });
  }
  const yearOut = [];
  const vinOut = [];
  // Один объект — сверяем все годы выпуска в отчёте; несколько — годы рядом с каждым VIN.
  const groups = vins.size <= 1
    ? [{ vin: [...vins.keys()][0] ?? null, years: allYears.map((y) => ({ year: y.year, doc: y.doc, page: y.page, quote: y.quote })) }]
    : [...vins.values()];
  for (const g of groups) {
    const counts = new Map();
    for (const y of g.years) counts.set(y.year, (counts.get(y.year) ?? 0) + 1);
    if (counts.size > 1) {
      const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const odd = g.years.filter((y) => y.year !== main);
      const seen = new Set();
      for (const y of odd) {
        const key = `${y.doc.name}:${y.page}:${y.year}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const vinNote = g.vin && vinYears(g.vin).includes(main) ? `; по VIN тоже ${main}` : '';
        yearOut.push({ doc: y.doc, page: y.page, quote: y.quote, text: `Год выпуска не совпадает: здесь ${y.year}, а в остальных местах ${main}${vinNote}${g.vin && vins.size > 1 ? ` (VIN …${g.vin.slice(-6)})` : ''}` });
      }
    }
    // Сверка с VIN: 10-й знак кодирует модельный год (у некоторых производителей — не кодирует, поэтому это подсказка).
    if (g.vin && counts.size) {
      const stated = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const cand = vinYears(g.vin);
      if (cand.length) {
        const byVin = cand.reduce((a, b) => (Math.abs(b - stated) < Math.abs(a - stated) ? b : a));
        // Разница больше 5 лет — скорее год в VIN не кодируется (так у части европейских производителей): молчим.
        if (byVin !== stated && Math.abs(byVin - stated) <= 5) {
          const where = g.years.find((y) => y.year === stated);
          vinOut.push({
            doc: where.doc, page: where.page, quote: where.quote,
            text: Math.abs(byVin - stated) === 1
              ? `Год выпуска ${stated}, а 10-й знак VIN «${g.vin[9]}» означает модельный ${byVin} год — так бывает, но в отчёте стоит пояснить`
              : `Год выпуска ${stated} не сходится с VIN: 10-й знак «${g.vin[9]}» означает ${byVin} год — проверьте по ПТС`,
          });
        }
      }
    }
  }
  return { vehicle_year: yearOut, vin_year: vinOut };
}

// ——— Сумма цифрами и прописью ———
const UNITS = { ноль: 0, один: 1, одна: 1, одно: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15, шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19, двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90, сто: 100, двести: 200, триста: 300, четыреста: 400, пятьсот: 500, шестьсот: 600, семьсот: 700, восемьсот: 800, девятьсот: 900 };
const SCALES = [[/^миллиард/, 1e9], [/^миллион/, 1e6], [/^тысяч/, 1e3]];

// «Девять миллионов семьсот тысяч» → 9700000; незнакомое слово → null.
export function wordsToNumber(words) {
  let total = 0;
  let group = 0;
  let any = false;
  for (const w of String(words).toLowerCase().replace(/ё/g, 'е').split(/[\s-]+/).filter(Boolean)) {
    if (w in UNITS) { group += UNITS[w]; any = true; continue; }
    const scale = SCALES.find(([re]) => re.test(w));
    if (scale) { total += (group || 1) * scale[1]; group = 0; any = true; continue; }
    if (/^(?:рубл|руб\.?$|копе|коп\.?$|целых$|и$)/.test(w)) continue;
    return null;
  }
  return any ? total + group : null;
}

const SUM_WORDS = /(\d{1,3}(?:[  .]\d{3})+|\d{4,})(?:[,.]\d{1,2})?\s*(?:\(?\s*руб(?:\.|лей)?\s*\)?)?\s*=?\s*\(\s*([А-Яа-яЁё][А-Яа-яЁё\s-]{3,}?)\s*\)\s*(?:руб|рубл)/gu;

function sumWords(doc) {
  const out = [];
  eachPage(doc, (page, i) => {
    for (const m of page.replace(/\n/g, ' ').matchAll(SUM_WORDS)) {
      const num = Number(m[1].replace(/[  .]/g, ''));
      const said = wordsToNumber(m[2]);
      if (said === null || !num) continue;
      if (said !== num) out.push({ page: i, quote: clean(m[0]).slice(0, 160), text: `Сумма цифрами ${fmt(num)} не совпадает с суммой прописью (${fmt(said)})` });
    }
  });
  return out;
}

// ——— Округление итога: результат подхода с весом 1 → итоговая величина ———
// Строка итоговой таблицы: «… 3 148 760,14  1,0  3 000 000,00» — расхождение больше 2% стоит пояснить.
const ROUND_ROW = /(\d{1,3}(?:[  ]\d{3}){1,3},\d{2})\s+1[,.]0{1,2}\s+(\d{1,3}(?:[  ]\d{3}){1,3}(?:,00)?)(?!\s*\d)/gu;

function rounding(doc) {
  const out = [];
  eachPage(doc, (page, i) => {
    for (const m of page.replace(/\n/g, ' ').matchAll(ROUND_ROW)) {
      const calc = Number(m[1].replace(/[  ]/g, '').replace(',', '.'));
      const fin = Number(m[2].replace(/[  ]/g, '').replace(',', '.'));
      if (!calc || !fin) continue;
      const diff = (fin - calc) / calc;
      if (Math.abs(diff) > 0.02) {
        out.push({ page: i, quote: clean(m[0]), text: `Итог ${fmt(fin)} отличается от расчёта ${fmt(Math.round(calc))} на ${(diff * 100).toFixed(1).replace('.', ',')}% — проверьте правило округления` });
      }
    }
  });
  return out;
}

// ——— Подход в оглавлении есть, а в тексте он «не применялся» ———
const APPROACH = { сравнительн: 'сравнительный', затратн: 'затратный', доходн: 'доходный' };
const REFUSED = [
  /(?:отсутствует возможность применить|невозможно применить|не представляется возможным применить|отказ(?:ался|ывается)? от(?: применения)?|не применял(?:ся|ась|и)?|не использовал(?:ся|ись)?)\s+(сравнительн|затратн|доходн)/giu,
  /(сравнительн|затратн|доходн)\S*\s+подход\S*\s+(?:не\s+применял|не\s+использовал|не\s+применим)/giu,
];

function approachesToc(doc) {
  const text = (doc.pages ?? []).join('\n');
  const refused = new Map();
  for (const re of REFUSED) for (const m of text.matchAll(re)) refused.set(m[1].toLowerCase(), m[0]);
  const out = [];
  eachPage(doc, (page, i) => {
    for (const e of tocEntries(page)) {
      for (const [stem, name] of Object.entries(APPROACH)) {
        if (refused.has(stem) && new RegExp(stem, 'iu').test(e.text)) {
          out.push({ page: i, quote: e.line.slice(0, 140), text: `В оглавлении есть раздел ${e.num} про ${name} подход, а в тексте сказано, что он не применялся` });
        }
      }
    }
  });
  return out;
}

// ——— Остатки чужого шаблона: недвижимость и земля в отчёте о транспорте или вещах ———
const LEFTOVER = /(?:объект\S*\s+недвижим\S*|недвижим\S*\s+имуществ\S*|земельн\S*\s+участ\S*|Земельн\S*\s+кодекс\S*)/giu;

// В отчёте о недвижимости и земле (2.43) — наоборот: машина, VIN, пробег, ПТС — остаток отчёта о транспорте.
const LEFTOVER_VEHICLE = /(?:(?<![A-Za-z])VIN(?![A-Za-z])|пробег\S*|транспортн\S*\s+средств\S*|автомобил\S*|(?<![А-ЯЁа-яё])ПТС(?![А-ЯЁа-яё])|госномер\S*)/giu;
const REALTY_SERVICES = ['realty', 'land'];

function templateLeftovers(doc, ctx = {}) {
  const realty = REALTY_SERVICES.includes(ctx.service);
  const re = realty ? LEFTOVER_VEHICLE : LEFTOVER;
  const what = realty ? (ctx.service === 'land' ? 'земельного участка' : 'недвижимости') : 'движимом имуществе';
  const out = [];
  eachPage(doc, (page, i) => {
    for (const m of page.matchAll(re)) out.push({ page: i, quote: lineAround(page, m.index), text: `«${clean(m[0])}» в отчёте ${realty ? 'об оценке' : 'о'} ${what} — возможно, остаток шаблона другого отчёта` });
  });
  return out;
}

// Кадастровый номер в отчёте — как в заявке (2.43): другой номер рядом со словом «кадастровый» — данные другого объекта.
const CADASTRAL_RE = /\b\d{2}:\d{2}:\d{6,7}:\d{1,7}\b/g;
function cadastralMatch(doc, ctx) {
  const mine = String(ctx.fields?.cadastral ?? '').trim();
  if (!/^\d{2}:\d{2}:\d{6,7}:\d+$/.test(mine)) return [];
  const out = [];
  const seen = new Set();
  eachPage(doc, (page, i) => {
    for (const m of page.matchAll(CADASTRAL_RE)) {
      const v = m[0];
      if (v === mine || seen.has(v)) continue;
      // Номера аналогов и кадастрового квартала стоят без слов «кадастровый номер объекта» — их не трогаем.
      if (!/кадастров\S*\s+(?:номер|№)/iu.test(page.slice(Math.max(0, m.index - 60), m.index))) continue;
      if (/аналог/iu.test(lineAround(page, m.index))) continue;
      seen.add(v);
      out.push({ page: i, quote: lineAround(page, m.index), text: `Кадастровый номер ${v} не совпадает с номером из заявки (${mine}) — проверьте, нет ли данных другого объекта` });
    }
  });
  return out;
}

// ——— 2.94: адрес объекта — как в заявке и одинаков по всему отчёту (титул, задание, описание, выводы) ———
// Адрес берём только после слов «адрес объекта», «местоположение», «по адресу» и не в строках про аналоги, оценщика,
// организацию, заказчика, регистрацию. Сверяем по частям: населённый пункт, улица, дом, корпус, строение, квартира,
// помещение, участок. Части, которой нет в одном из адресов, не сверяем. Нет части в заявке — сверяем с первым
// адресом в отчёте.
const ADDR_AT = /(?:адрес\S*\s*(?:\([^)\n]{0,30}\)\s*)?(?:объект\S*|местонахожд\S*|местоположен\S*|квартир\S*|помещени\S*|участк\S*|(?<![а-яё])дом\S*|здани\S*|имуществ\S*|оцениваем\S*|исследуем\S*)(?:\s+(?:оценки|экспертизы|исследования|недвижимости))?|(?:местоположени\S*|местонахождени\S*)\s*(?:\([^)\n]{0,20}\)\s*)?(?:(?:объект|участк|квартир|помещени|здани|имуществ)\S*(?:\s+(?:оценки|экспертизы|исследования))?)?|(?<![а-яё])по\s+адресу)\s*[:\-–—]?\s*/giu;
const ADDR_OTHER = /зарегистр|прожива|юридическ|почтов|организац|обществ|(?<![А-ЯЁ])ООО(?![А-ЯЁ])|оценщик|заказчик|исполнител|офис|(?<![а-яё])СРО(?![а-яё])|суд/iu;
const ADDR_OBJECT = /объект|квартир|комнат|помещени|участ|здани|строени|имуществ|недвижим|(?<![а-яё])дом/iu;
// Конец адреса: дальше идут кадастровый номер, площадь, этаж, собственник или новое предложение.
const ADDR_END = /\s(?:с|со)\s+(?=кадастр|общ|площ)|кадастр|площад|общей|этаж|принадлеж|собственн|[;()]|\s[—–]\s|(?<=[а-яё]{4}|\d)\.\s+(?=[А-ЯЁA-Z])/iu;
const ADDR_PART = {
  house: /(?<![а-я])(?:д|дом|вл|владение)\.?\s*№?\s*(\d+[а-я]?(?:\/\d+[а-я]?)?)(?![\d])/u,
  korpus: /(?<![а-я])(?:корп|корпус|к)\.?\s*(\d+[а-я]?)(?!\d)/u,
  str: /(?<![а-я])(?:стр|строение)\.?\s*(\d+[а-я]?)(?!\d)/u,
  flat: /(?<![а-я])(?:кв|квартира)\.?\s*№?\s*(\d+[а-я]?)(?![\d,.]\d)/u,
  room: /(?<![а-я])(?:пом|помещение)\.?\s*№?\s*(\d+[а-я]?)(?!\d)/u,
  plot: /(?<![а-я])(?:уч|участок)\.?\s*№?\s*(\d+[а-я]?)(?!\d)/u,
};
const SETTLEMENT = /(?<![а-я])(?:(?:г|д|с|п)\.|(?:город|дер|деревня|село|пос|поселок|рп|пгт|снт|днп|кп|станица|хутор)(?![а-я])\.?)\s*([а-я][а-я-]+(?:\s+[а-я][а-я-]+)?)/u;
const STREET_TYPE = /(?<![а-я])(?:улица|ул|проспект|пр-кт|пр-т|просп|переулок|пер|шоссе|ш|бульвар|б-р|бул|набережная|наб|проезд|пр-д|площадь|пл|тупик|туп|аллея|линия|мкр|микрорайон)(?![а-я-])\.?/u;
const ADDR_NAMES = { settlement: 'другой населённый пункт', street: 'другая улица', house: 'дом', korpus: 'корпус', str: 'строение', flat: 'квартира', room: 'помещение', plot: 'участок' };
const stems = (s) => (s.match(/[а-я]{3,}/gu) ?? []).map((w) => w.slice(0, 5));
export function parseAddress(text) {
  const t = String(text ?? '').toLowerCase().replace(/ё/g, 'е');
  const out = {};
  for (const [k, re] of Object.entries(ADDR_PART)) { const m = t.match(re); if (m) out[k] = m[1]; }
  const town = t.match(SETTLEMENT);
  if (town) out.settlement = stems(town[1].split(/\s+(?:ул|улица|д|дом|пер|пр|ш|уч)(?![а-я])/u)[0]);
  const segs = t.split(',').map((s) => s.trim());
  const at = segs.findIndex((s) => STREET_TYPE.test(s));
  if (at >= 0) {
    // Из части с улицей убираем тип улицы и номера дома, корпуса и квартиры, если они без запятой.
    let seg = segs[at].replace(STREET_TYPE, ' ');
    for (const re of Object.values(ADDR_PART)) seg = seg.replace(re, ' ');
    const tail = seg.match(/\s(\d+[а-я]?(?:\/\d+[а-я]?)?)\s*$/u);
    if (tail && !out.house) out.house = tail[1];
    if (!out.house && /^№?\s*\d+[а-я]?(?:\/\d+[а-я]?)?$/u.test(segs[at + 1] ?? '')) out.house = segs[at + 1].replace(/[№\s]/g, '');
    const st = stems(seg.replace(/\s\d+[а-я]?(?:\/\d+[а-я]?)?\s*$/u, ''));
    if (st.length) out.street = st;
  }
  return out;
}
const sameWords = (a, b) => a.every((w) => b.includes(w)) || b.every((w) => a.includes(w));
function addressMatch(doc, ctx) {
  const mineText = clean(ctx.fields?.address);
  const mine = parseAddress(mineText);
  if (!mineText) return [];
  const first = {}; // часть, которой нет в заявке, → { value, page }
  const out = [];
  const seen = new Set();
  eachPage(doc, (page, i) => {
    for (const m of page.matchAll(ADDR_AT)) {
      const start = page.lastIndexOf('\n', m.index) + 1;
      const before = page.slice(Math.max(start, m.index - 60), m.index);
      if (ADDR_OTHER.test(before) && !ADDR_OBJECT.test(before)) continue;
      if (/аналог/iu.test(lineAround(page, m.index))) continue;
      const from = m.index + m[0].length;
      let end = page.indexOf('\n', from);
      if (end < 0) end = page.length;
      // Адрес, перенесённый на следующую строку после запятой или дефиса.
      if (/[,-]\s*$/.test(page.slice(from, end))) { const e2 = page.indexOf('\n', end + 1); end = e2 < 0 ? page.length : e2; }
      let text = page.slice(from, end).replace(/\n/g, ' ');
      const cut = text.search(ADDR_END);
      if (cut >= 0) text = text.slice(0, cut);
      text = clean(text).replace(/[,.\s]+$/, '').slice(0, 200);
      const got = parseAddress(text);
      if (!got.house && !got.flat && !got.plot && !got.room) continue;
      const key = JSON.stringify(got);
      if (seen.has(key)) continue;
      seen.add(key);
      const diff = [];
      let againstMine = false;
      for (const k of Object.keys(ADDR_NAMES)) {
        if (got[k] === undefined) continue;
        const ref = mine[k] !== undefined ? { value: mine[k], mine: true } : first[k];
        if (!ref) { first[k] = { value: got[k], page: i }; continue; }
        const same = Array.isArray(got[k]) ? sameWords(got[k], ref.value) : got[k] === ref.value;
        if (same) continue;
        if (ref.mine) againstMine = true;
        diff.push({ k, ref });
      }
      if (!diff.length) continue;
      const parts = diff.map(({ k, ref }) => (Array.isArray(got[k]) ? ADDR_NAMES[k]
        : `${ADDR_NAMES[k]} ${got[k]}, а ${ref.mine ? 'в заявке' : `на стр. ${ref.page + 1}`} ${ref.value}`)).join('; ');
      const where = againstMine ? `с адресом из заявки (${mineText})` : `с адресом объекта на стр. ${diff[0].ref.page + 1}`;
      out.push({ page: i, quote: lineAround(page, m.index), text: `Адрес «${text}» не совпадает ${where}: ${parts} — проверьте, нет ли данных другого объекта` });
    }
  });
  return out;
}

// ——— Недвижимость и земля (2.59): площадь, этаж и этажность, доля, категория земель и назначение — как в заявке ———
// Строки про аналоги, жилую площадь, кухню, балкон, застройку не трогаем; в отчёте о квартире — площадь участка и дома,
// в отчёте об участке — площадь построек.
const AREA_NUM = /(\d{1,3}(?:[  ]\d{3})+|\d+)(?:[,.](\d{1,2}))?\s*(кв\.?\s*м\.?|м2|м²|квадратн\S*\s+метр\S*|га(?![а-яё])|гектар\S*|сот(?:ок|ки|ка|ых)?(?![а-яё]))/giu;
const AREA_SKIP = /жил\S*\s+площад|кухн|балкон|лодж|застройк/iu;
const lineBefore = (page, index, len = 80) => { const b = page.slice(Math.max(0, index - len), index); return b.slice(b.lastIndexOf('\n') + 1); };
function areaMatch(doc, ctx) {
  const mine = Number(String(ctx.fields?.area ?? '').replace(',', '.'));
  if (!(mine > 0)) return [];
  const land = ctx.service === 'land';
  const other = land ? /(?<![а-яё])дом|здани|строени|постройк|помещени/iu
    : ctx.fields?.object_type === 'house' ? /участ/iu : /участ|(?<![а-яё])дом(?:а|у|е)?(?![а-яё])|здани/iu;
  const out = [];
  const seen = new Set();
  eachPage(doc, (page, i) => {
    for (const m of page.matchAll(AREA_NUM)) {
      const before = lineBefore(page, m.index);
      const at = before.search(/площад(?!.*площад)/iu);
      // Ближайшая «площадь» перед числом: смотрим 30 знаков перед ней (чья это площадь) и всё до числа.
      const near = at < 0 ? '' : before.slice(Math.max(0, at - 30));
      if (!near || other.test(near) || AREA_SKIP.test(near) || /аналог/iu.test(lineAround(page, m.index))) continue;
      const unit = m[3].toLowerCase();
      const mult = /^га|^гектар/.test(unit) ? 10000 : /^сот/.test(unit) ? 100 : 1;
      const v = Math.round(Number(`${m[1].replace(/[  ]/g, '')}.${m[2] ?? 0}`) * mult * 100) / 100;
      if (Math.abs(v - mine) < 0.05 || seen.has(v)) continue;
      seen.add(v);
      out.push({ page: i, quote: lineAround(page, m.index), text: `Площадь ${fmt(v)} кв. м не совпадает с площадью из заявки (${fmt(mine)} кв. м) — проверьте, нет ли данных другого объекта` });
    }
  });
  return out;
}

const FLOOR_AT = [
  /этаж\s*\/\s*этажност\S*[^\d\n]{0,10}(\d{1,3})\s*\/\s*(\d{1,3})/giu,
  /(?<![\d/])(\d{1,3})(?:-?(?:м|ом|й))?\s+этаж(?:е|у)?(?![а-яё])/giu,
  /(?<![а-яё])этаж(?:\s+расположения)?\s*[:\-–—]\s*(\d{1,3})(?![\d/])/giu,
];
const FLOORS_AT = [
  /(?<![\d/])(\d{1,3})(?:-?(?:ти|х|ми))?[-\s]?этажн/giu,
  /(?<!этаж\s*\/\s*)этажност\S*(?:\s+(?:дома|здания))?\s*[:\-–—]?\s*(\d{1,3})(?![\d/])/giu,
  /(?:всего\s+)?этажей(?:\s+в\s+(?:доме|здании))?\s*[:\-–—]\s*(\d{1,3})/giu,
  /(?<![\d/])(\d{1,3})\s+этаж(?:а|ей)(?![а-яё])/giu,
];
function floorMatch(doc, ctx) {
  const f = String(ctx.fields?.floor ?? '').match(/^\s*(-?\d{1,3})\s*(?:\/\s*(\d{1,3}))?/);
  if (!f) return [];
  const [mineFloor, mineFloors] = [Number(f[1]), f[2] ? Number(f[2]) : null];
  const out = [];
  const seen = new Set();
  const add = (i, page, idx, key, text) => { if (seen.has(key)) return; seen.add(key); out.push({ page: i, quote: lineAround(page, idx), text }); };
  eachPage(doc, (page, i) => {
    FLOOR_AT.forEach((re, n) => {
      for (const m of page.matchAll(re)) {
        if (/аналог/iu.test(lineAround(page, m.index))) continue;
        const v = Number(m[1]);
        if (v !== mineFloor) add(i, page, m.index, `f${v}`, `Этаж ${v} не совпадает с этажом из заявки (${mineFloor}) — проверьте, нет ли данных другого объекта`);
        if (n === 0 && mineFloors && Number(m[2]) !== mineFloors) add(i, page, m.index, `n${m[2]}`, `Этажей в доме ${m[2]}, а в заявке ${mineFloors} — проверьте, нет ли данных другого дома`);
      }
    });
    if (!mineFloors) return;
    for (const re of FLOORS_AT) {
      for (const m of page.matchAll(re)) {
        if (/аналог/iu.test(lineAround(page, m.index))) continue;
        const v = Number(m[1]);
        if (v !== mineFloors) add(i, page, m.index, `n${v}`, `Этажей в доме ${v}, а в заявке ${mineFloors} — проверьте, нет ли данных другого дома`);
      }
    }
  });
  return out;
}

const SHARE_AT = [
  /(?<![а-яё])дол(?:я|и|е|ю|ей)(?![а-яё])[^\d\n]{0,60}?(\d{1,3})\s*\/\s*(\d{1,4})(?![\d/])/giu,
  /(?<![\d/])(\d{1,3})\s*\/\s*(\d{1,4})\s+(?:доли|долю|доля|доле)(?![а-яё])/giu,
];
function shareMatch(doc, ctx) {
  const s = String(ctx.fields?.share_size ?? '').match(/^\s*(\d{1,3})\s*\/\s*(\d{1,4})\s*$/);
  if (!s || Number(s[2]) === 0) return [];
  const [a, b] = [Number(s[1]), Number(s[2])];
  const out = [];
  const seen = new Set();
  eachPage(doc, (page, i) => {
    for (const re of SHARE_AT) {
      for (const m of page.matchAll(re)) {
        const [c, d] = [Number(m[1]), Number(m[2])];
        if (!d || a * d === b * c || seen.has(`${c}/${d}`) || /аналог|этаж/iu.test(lineAround(page, m.index))) continue;
        seen.add(`${c}/${d}`);
        out.push({ page: i, quote: lineAround(page, m.index), text: `Доля ${c}/${d} не совпадает с долей из заявки (${a}/${b}) — проверьте расчёт и описание объекта` });
      }
    }
  });
  return out;
}

const LAND_CATEGORY = {
  settlement: ['земли населённых пунктов', /населённ|населенн/iu],
  agricultural: ['земли сельхозназначения', /сельскохоз|сельхоз/iu],
  industrial: ['земли промышленности', /промышленн/iu],
  forest: [null, /лесного\s+фонда|особо\s+охраняем|водного\s+фонда|(?<![а-яё])запаса/iu],
};
const LAND_USE = {
  izhs: ['под жилой дом (ИЖС)', /индивидуальн\S*\s+жил|(?<![А-ЯЁ])ИЖС(?![А-ЯЁ])/u],
  garden: ['садоводство, дача', /садовод|дачн|огороднич/iu],
  agri: ['сельхозназначение', /сельскохозяйственн\S*\s+(?:производств|использован)|растениеводств|животноводств/iu],
  commercial: ['под коммерцию или производство', /предпринимательств|торгов|коммерч|производственн|склад|офис|обслуживан/iu],
};
const classify = (value, table) => Object.entries(table).filter(([, [, re]]) => re.test(value)).map(([id]) => id);
function landMatch(doc, ctx) {
  const cat = ctx.fields?.land_category;
  const use = ctx.fields?.land_use;
  const out = [];
  const seen = new Set();
  eachPage(doc, (page, i) => {
    if (LAND_CATEGORY[cat]?.[0]) {
      for (const m of page.matchAll(/категори\S*\s+земел\S*\s*[:\-–—]?\s*([^\n.;]{5,80})/giu)) {
        const ids = classify(m[1], LAND_CATEGORY);
        if (!ids.length || ids.includes(cat) || /аналог/iu.test(lineAround(page, m.index)) || seen.has(`c${ids[0]}`)) continue;
        seen.add(`c${ids[0]}`);
        out.push({ page: i, quote: lineAround(page, m.index), text: `Категория земель «${clean(m[1])}» не совпадает с заявкой («${LAND_CATEGORY[cat][0]}») — сверьте с выпиской ЕГРН` });
      }
    }
    if (LAND_USE[use]) {
      for (const m of page.matchAll(/разреш[её]нн\S*\s+использовани\S*\s*[:\-–—]?\s*([^\n]{5,120})/giu)) {
        const ids = classify(m[1], LAND_USE);
        if (!ids.length || ids.includes(use) || /аналог/iu.test(lineAround(page, m.index)) || seen.has(`u${ids[0]}`)) continue;
        seen.add(`u${ids[0]}`);
        out.push({ page: i, quote: lineAround(page, m.index), text: `Вид разрешённого использования «${clean(m[1]).slice(0, 80)}» не похож на назначение из заявки («${LAND_USE[use][0]}») — сверьте с выпиской ЕГРН` });
      }
    }
  });
  return out;
}

// ——— Осмотр: «без осмотра», а дата осмотра указана ———
function inspection(doc) {
  const text = (doc.pages ?? []).join('\n');
  const none = text.match(/без\s+(?:проведения\s+)?осмотра/iu);
  if (!none) return [];
  const out = [];
  eachPage(doc, (page, i) => {
    const m = page.match(/дата\s+(?:проведения\s+)?осмотра[^:\n]{0,30}[:\s]+\s*\d{1,2}[\s.]/iu);
    if (m) out.push({ page: i, quote: lineAround(page, m.index), text: 'Указана дата осмотра, хотя в отчёте сказано «без осмотра»' });
  });
  return out;
}

// ——— Цель «для суда», а в ограничениях — «не требуется появляться в суде» ———
function courtPurpose(doc, ctx) {
  const text = (doc.pages ?? []).join('\n');
  const forCourt = ctx.fields?.purpose === 'court' || /для\s+(?:последующего\s+)?(?:предоставления|представления)\s+в\s+суд/iu.test(text);
  if (!forCourt) return [];
  const out = [];
  eachPage(doc, (page, i) => {
    const m = page.replace(/\n/g, ' ').match(/не\s+требуется[^.]{0,80}(?:появляться|являться|выступать)\s+в\s+суд\S*/iu);
    if (m) out.push({ page: i, quote: clean(m[0]).slice(0, 160), text: 'Оценка для суда, а в ограничениях сказано, что оценщику не нужно являться в суд — противоречие' });
  });
  return out;
}

// ——— Сверка с досье эксперта (2.14): сроки на дату отчёта, номера, страховые суммы ———
// ctx.dossier — { items, today } (src/dossier/dossier.mjs). Дата отчёта — «дата составления (отчёта)» в тексте, иначе сегодня.
const REPORT_DATE = /дата\s+(?:составления|подписания)(?:\s+(?:отч[её]та|заключения))?[^\d\n]{0,40}(\d{1,2})\.(\d{1,2})\.(\d{4})/iu;
const MONEY = /\d{1,3}(?:[  .]\d{3})+|\d{4,}/g;
const KIND_WORD = { education: /диплом/iu, certificate: /аттестат/iu, sro: /(?<![а-яё])СРО(?![а-яё])|саморегулируем/iu, policy: /полис|страхован/iu, policy_org: /полис|страхован/iu };
const squash = (v) => String(v ?? '').toLowerCase().replace(/[^0-9a-zа-яё]/giu, '');
const ruDate = (d) => d.split('-').reverse().join('.');

function reportDate(docs, today) {
  // 2.88: дата составления — и цифрами, и словами («12 сентября 2026 г.»).
  for (const doc of docs) for (const page of doc.pages ?? []) {
    const d = dateAfter(page, MADE_LABEL);
    if (d) return { date: d, stated: true };
  }
  return { date: today, stated: false };
}

// Где в отчёте говорится о документе: страница с его номером, иначе — со словом «аттестат», «полис»…; иначе первая.
function placeOf(docs, item) {
  const num = squash(item.number);
  for (const doc of docs) {
    for (const [i, page] of (doc.pages ?? []).entries()) {
      if (num.length >= 3 && squash(page).includes(num)) return { doc, page: i, quote: lineAround(page, Math.max(0, page.search(KIND_WORD[item.kind]))), found: true };
    }
  }
  for (const doc of docs) {
    for (const [i, page] of (doc.pages ?? []).entries()) {
      const at = page.search(KIND_WORD[item.kind]);
      if (at >= 0) return { doc, page: i, quote: lineAround(page, at), found: false };
    }
  }
  return { doc: docs[0], page: 0, quote: '', found: false };
}

function dossierFindings(kinds) {
  return (docs, ctx) => {
    const items = (ctx.dossier?.items ?? []).filter((i) => kinds.includes(i.kind));
    if (!items.length || !docs.length) return [];
    const { date, stated } = reportDate(docs, ctx.dossier.today);
    const sums = new Set(docs.flatMap((d) => (d.pages ?? []).flatMap((p) => [...p.matchAll(MONEY)].map((m) => Number(m[0].replace(/[  .]/g, ''))))));
    const out = [];
    for (const it of items) {
      const where = placeOf(docs, it);
      const name = `${it.kind_name}${it.number ? ` № ${it.number}` : ''}`;
      if (it.number && squash(it.number).length >= 3 && !where.found) {
        out.push({ ...where, text: `${name} из досье в отчёте не найден${it.kind === 'sro' ? ' (номер в реестре СРО)' : ''} — проверьте сведения об эксперте` });
      }
      if (it.valid_until && it.valid_until < date) {
        out.push({ ...where, text: `${name} действует до ${ruDate(it.valid_until)}, а ${stated ? `отчёт составлен ${ruDate(date)}` : `сегодня ${ruDate(date)}`} — на дату отчёта срок истёк` });
      }
      if (it.amount_kop && where.found && !sums.has(Math.round(it.amount_kop / 100))) {
        out.push({ ...where, text: `Страховая сумма по полису ${it.number ? `№ ${it.number} ` : ''}в досье — ${fmt(Math.round(it.amount_kop / 100))} руб., в отчёте такой суммы нет` });
      }
    }
    return out;
  };
}


// ——— 2.38: обязательные сведения отчёта, требования суда, VIN из заявки, порядок дат ———
// Основной отчёт среди файлов результата — самый длинный текст, где в начале есть «отчёт» или «заключение» (подписи,
// копии документов и приложения отдельными файлами не проверяются на «обязательное»).
function mainReport(docs) {
  const len = (d) => (d.pages ?? []).reduce((n, p) => n + p.length, 0);
  return [...docs].filter((d) => /отч[её]т|заключени/iu.test((d.pages ?? []).slice(0, 2).join('\n'))).sort((a, b) => len(b) - len(a))[0] ?? null;
}

// Что суды и ФСО ждут в любом отчёте об оценке (ст. 11 закона № 135-ФЗ, ФСО VI «Отчёт об оценке»).
const REQUIRED = [
  ['дата оценки', /дат[аы]\s+оценки|дат[аы]\s+определения\s+стоимости|по\s+состоянию\s+на/iu],
  ['дата составления отчёта', /дат[аы]\s+(?:составления|подписания)/iu],
  ['цель оценки', /цел[ьи]\s+(?:проведения\s+)?оценки/iu],
  ['вид стоимости', /вид\s+(?:определяемой\s+)?стоимости|рыночн[а-яё]*\s+стоимост/iu],
  ['допущения и ограничительные условия', /допущени/iu],
  ['применённые стандарты оценки', /стандарт[а-яё]*\s+оценк|(?<![а-яё])ФСО(?![а-яё])/iu],
  ['членство оценщика в СРО', /саморегулируем|(?<![а-яё])СРО(?![а-яё])/iu],
  ['страхование ответственности', /страхов/iu],
  ['подходы к оценке', /подход/iu],
  ['основание (договор или определение суда)', /договор|определени[а-яё]*\s+суда/iu],
];

function requiredItems(docs) {
  const d = mainReport(docs);
  if (!d) return [];
  const text = d.pages.join('\n');
  const missing = REQUIRED.filter(([, re]) => !re.test(text)).map(([name]) => name);
  return missing.length
    ? [{ doc: d, page: 0, quote: '', text: `В отчёте не найдено: ${missing.join(', ')} — по закону об оценке (ст. 11) и ФСО это обязательно, суд проверяет первым` }]
    : [];
}

// Экспертиза по определению суда: номер определения и предупреждение об уголовной ответственности (ст. 307 УК РФ).
function courtOrder(docs, ctx) {
  if (ctx.basis?.kind !== 'court') return [];
  const d = mainReport(docs);
  if (!d) return [];
  const text = d.pages.join('\n');
  const out = [];
  const num = squash(ctx.basis.number);
  if (num.length >= 3 && !squash(text).includes(num)) {
    out.push({ doc: d, page: 0, quote: '', text: `Номер определения суда ${ctx.basis.number} в отчёте не найден — укажите основание с номером и датой` });
  }
  if (!/307\s*(?:УК|Уголовного)|уголовн[а-яё]*\s+ответственност[а-яё]*\s+за\s+(?:дачу\s+)?заведомо\s+ложн/iu.test(text)) {
    out.push({ doc: d, page: 0, quote: '', text: 'Экспертиза по определению суда, а предупреждения об ответственности по ст. 307 УК РФ в отчёте нет' });
  }
  return out;
}

// VIN в отчёте — как в заявке (машины из «остальных машин» заявки тоже свои).
const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/g;
function vinMatch(doc, ctx) {
  const mine = String(ctx.fields?.vin ?? '').toUpperCase();
  if (mine.length !== 17) return [];
  const known = new Set([mine, ...(String(ctx.fields?.more_vehicles ?? '').toUpperCase().match(VIN_RE) ?? [])]);
  const out = [];
  const seen = new Set();
  eachPage(doc, (page, i) => {
    for (const m of page.toUpperCase().matchAll(VIN_RE)) {
      const v = m[0];
      if (known.has(v) || seen.has(v) || !/\d/.test(v) || !/[A-Z]/.test(v)) continue;
      // Похожий на VIN номер рядом со словом VIN, не совпадающий с заявкой, — скорее всего, чужая машина из старого отчёта.
      if (!/VIN|идентификацион/iu.test(page.slice(Math.max(0, m.index - 40), m.index))) continue;
      seen.add(v);
      out.push({ page: i, quote: lineAround(page, m.index), text: `VIN ${v} не совпадает с VIN из заявки (${mine}) — проверьте, нет ли данных другой машины` });
    }
  });
  return out;
}

// Дата составления отчёта не раньше даты оценки.
const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
function ymd(y, m, d) {
  const v = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === v ? v : null;
}
function dateAfter(text, label) {
  const num = text.match(new RegExp(`${label}[^\\d\\n]{0,40}(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})`, 'iu'));
  if (num) return ymd(num[3], num[2], num[1]);
  const word = text.match(new RegExp(`${label}[^\\d\\n]{0,40}(\\d{1,2})\\s+([а-яё]+)\\s+(\\d{4})`, 'iu'));
  if (word) {
    const mi = MONTHS.findIndex((x, i) => (i === 4 ? /^ма[яй]$/iu.test(word[2]) : word[2].toLowerCase().startsWith(x)));
    if (mi >= 0) return ymd(word[3], mi + 1, word[1]);
  }
  return null;
}
const MADE_LABEL = 'дата\\s+(?:составления|подписания)(?:\\s+(?:отч[её]та|заключения))?';
const VALUE_LABEL = 'дата\\s+(?:оценки|определения\\s+(?:рыночной\\s+)?стоимости)';
function dateOrder(doc) {
  const text = (doc.pages ?? []).join('\n');
  const val = dateAfter(text, VALUE_LABEL);
  const made = dateAfter(text, MADE_LABEL);
  if (!val || !made || made >= val) return [];
  const at = (doc.pages ?? []).findIndex((p) => /дата\s+(?:составления|подписания)/iu.test(p));
  return [{ page: Math.max(0, at), quote: lineAround(doc.pages[Math.max(0, at)], Math.max(0, doc.pages[Math.max(0, at)].search(/дата\s+(?:составления|подписания)/iu))),
    text: `Дата составления отчёта (${ruDate(made)}) раньше даты оценки (${ruDate(val)}) — так быть не может` }];
}

// ——— 2.88: даты по всему отчёту ———
// Осмотр не позже составления отчёта и в те дни, когда в деле получены фото осмотра; объявления аналогов (из дела и из
// таблицы в отчёте) — не позже даты оценки: объявления, которого на дату оценки ещё не было, в аналоги брать нельзя.
// ctx.inspectionDays — дни (по Москве), когда платформа получила фото осмотра по ссылке или с выезда помощника.
const INSPECT_LABELS = [
  'дата\\s+(?:проведения\\s+)?(?:визуального\\s+|натурного\\s+)?осмотра(?:\\s+объекта(?:\\s+(?:оценки|экспертизы))?)?',
  'осмотр\\S*\\s+(?:объекта\\s+(?:оценки\\s+|экспертизы\\s+)?)?(?:был\\s+)?(?:проведен|произведен|проведён|произведён)\\S*',
];
const AD_DATE = /(?:([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:ru|рф|com|net|org|su|pro|online))\S*[^\n\d]{0,30}?(?<![а-яё])от\s+|дата\s+(?:объявления|публикации|размещения|предложения)[^\d\n]{0,30}?)(\d{1,2})\.(\d{1,2})\.(\d{4})/giu;
const pageWith = (doc, label) => {
  const re = new RegExp(label, 'iu');
  const i = Math.max(0, (doc.pages ?? []).findIndex((p) => re.test(p)));
  const page = doc.pages?.[i] ?? '';
  return { doc, page: i, quote: lineAround(page, Math.max(0, page.search(re))) };
};
function reportDates(docs, ctx) {
  const d = mainReport(docs) ?? docs[0];
  if (!d) return [];
  const text = (d.pages ?? []).join('\n');
  const made = dateAfter(text, MADE_LABEL);
  const val = dateAfter(text, VALUE_LABEL);
  const label = INSPECT_LABELS.find((l) => dateAfter(text, l));
  const insp = label ? dateAfter(text, label) : null;
  const out = [];
  if (insp && made && insp > made) {
    out.push({ ...pageWith(d, label), text: `Дата осмотра (${ruDate(insp)}) позже даты составления отчёта (${ruDate(made)}) — осмотр не может быть после того, как отчёт составлен` });
  }
  const days = [...new Set(ctx.inspectionDays ?? [])].sort();
  if (insp && days.length && !days.includes(insp) && !/без\s+(?:проведения\s+)?осмотра/iu.test(text)) {
    out.push({ ...pageWith(d, label), text: `Дата осмотра в отчёте — ${ruDate(insp)}, а фото осмотра в деле получены ${days.map(ruDate).join(', ')} — проверьте дату осмотра` });
  }
  if (!val) return out;
  const told = new Set();
  (ctx.analogs ?? []).forEach((a, i) => {
    const on = a.fields?.listed_on;
    if (typeof on !== 'string' || on <= val) return;
    told.add(on);
    out.push({ ...pageWith(d, 'аналог'), text: `Аналог ${i + 1} из дела (${siteOf(a.url)}): объявление от ${ruDate(on)} — позже даты оценки (${ruDate(val)}); на дату оценки его ещё не было — возьмите другой аналог или проверьте дату` });
  });
  for (const doc of docs) {
    eachPage(doc, (page, p) => {
      for (const m of page.matchAll(AD_DATE)) {
        const on = ymd(m[4], m[3], m[2]);
        if (!on || on <= val || told.has(on)) continue;
        told.add(on);
        out.push({ doc, page: p, quote: lineAround(page, m.index), text: `Объявление аналога от ${ruDate(on)} — позже даты оценки (${ruDate(val)}); на дату оценки его ещё не было — возьмите другой аналог или проверьте дату` });
      }
    });
  }
  return out;
}

// ——— 2.60: госномер и пробег — как в заявке (транспорт) ———
// Латинские буквы, похожие на русские, в госномере приводим к русским: в отчётах пишут и так, и так.
const LAT_CYR = { A: 'А', B: 'В', E: 'Е', K: 'К', M: 'М', H: 'Н', O: 'О', P: 'Р', C: 'С', T: 'Т', Y: 'У', X: 'Х' };
const PLATE_RE = /(?<![\p{L}\d])([АВЕКМНОРСТУХABEKMHOPCTYX])\s?(\d{3})\s?([АВЕКМНОРСТУХABEKMHOPCTYX]{2})\s?(\d{2,3})(?![\p{L}\d])/gu;
const plateKey = (s) => String(s ?? '').toUpperCase().replace(/[A-Z]/g, (c) => LAT_CYR[c] ?? c).replace(/[\s-]/g, '');

function regMatch(doc, ctx) {
  const mine = plateKey(ctx.fields?.reg_number);
  if (!/^[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}\d{2,3}$/u.test(mine)) return [];
  const known = new Set([mine, ...[...String(ctx.fields?.more_vehicles ?? '').toUpperCase().matchAll(PLATE_RE)].map((m) => plateKey(m[0]))]);
  const out = [];
  const seen = new Set();
  eachPage(doc, (page, i) => {
    for (const m of page.toUpperCase().matchAll(PLATE_RE)) {
      const v = plateKey(m[0]);
      if (known.has(v) || seen.has(v)) continue;
      // Чужой номер рядом со словами «госномер», «регистрационный знак», «г/н» и не в строке аналога.
      if (!/гос\.?\s*(?:рег\.?\s*)?(?:номер|знак)|регистрационн\S*\s+(?:номер|знак)|г\/н|грз/iu.test(page.slice(Math.max(0, m.index - 50), m.index))) continue;
      if (/аналог/iu.test(lineAround(page, m.index))) continue;
      seen.add(v);
      out.push({ page: i, quote: lineAround(page, m.index), text: `Госномер ${v} не совпадает с госномером из заявки (${mine}) — проверьте, нет ли данных другой машины` });
    }
  });
  return out;
}

// Пробег по прибору мог вырасти между заявкой и осмотром — находка, только если разница больше 10% и больше 1000 км.
const MILEAGE_RE = /пробег\S*(?:[^\n\d]{0,40}?)(\d{1,3}(?:[  ]\d{3})+|\d{1,7})\s*(тыс\.?\s*)?км/giu;
function mileageMatch(doc, ctx) {
  const mine = Number(ctx.fields?.mileage);
  if (!Number.isFinite(mine) || mine <= 0 || ctx.fields?.more_vehicles) return [];
  const out = [];
  const seen = new Set();
  eachPage(doc, (page, i) => {
    for (const m of page.matchAll(MILEAGE_RE)) {
      const line = lineAround(page, m.index);
      // Аналоги, среднегодовой пробег и нормы — не пробег объекта.
      if (/аналог|средн|годов|в\s+год|норматив|коэффициент|корректировк/iu.test(line)) continue;
      const km = Number(m[1].replace(/[  ]/g, '')) * (m[2] ? 1000 : 1);
      if (!km || seen.has(km) || Math.abs(km - mine) <= Math.max(1000, mine * 0.1)) continue;
      seen.add(km);
      out.push({ page: i, quote: line, text: `Пробег ${fmt(km)} км не совпадает с пробегом из заявки (${fmt(mine)} км) — проверьте, нет ли данных другой машины` });
    }
  });
  return out;
}

// ——— 2.60: веса подходов в согласовании в сумме 1 (все виды оценки) ———
// Два вида таблиц: строка на каждый подход («Сравнительный подход … 0,6») и строка на объект со столбцами «Вес»
// (несколько машин в одном отчёте — «Не применялся - … 1,0»). Неприменённый подход — прочерк, вес 0.
const WEIGHT_TOKEN = /^(?:0[.,]\d{1,3}|1(?:[.,]0{1,3})?|\d{1,3}(?:[.,]\d{1,2})?%)$/;
const DASH_TOKEN = /^[-–—]$/;
function weightValue(t) { return t.endsWith('%') ? Number(t.slice(0, -1).replace(',', '.')) / 100 : Number(t.replace(',', '.')); }
function lineWeights(line) {
  const toks = line.split(/\s+/).filter(Boolean);
  const out = [];
  toks.forEach((t, k) => {
    if (DASH_TOKEN.test(t)) out.push(0);
    else if (WEIGHT_TOKEN.test(t) && !/^\d{3}/.test(toks[k + 1] ?? '')) out.push(weightValue(t));
  });
  return out;
}
const near1 = (x) => Math.abs(x - 1) <= 0.011;
function approachWeights(doc) {
  const out = [];
  eachPage(doc, (page, i) => {
    if (!/вес/iu.test(page) || !/согласован|обобщени|итогов|рыночн/iu.test(page)) return;
    const lines = page.split('\n');
    const head = lines.findIndex((l) => (l.match(/(?<!\p{L})вес(?!\p{L})/giu) ?? []).length >= 2);
    if (head >= 0) {
      const n = (lines[head].match(/(?<!\p{L})вес(?!\p{L})/giu) ?? []).length;
      for (const line of lines.slice(head + 1)) {
        const w = lineWeights(line);
        if (w.length !== n || !w.some((x) => x > 0)) continue;
        const sum = w.reduce((a, b) => a + b, 0);
        if (!near1(sum)) out.push({ page: i, quote: clean(line), text: `Веса подходов в строке в сумме ${fmtW(sum)}, а должно быть 1` });
      }
      return;
    }
    const per = new Map();
    for (const line of lines) {
      const m = line.match(/(сравнительн|затратн|доходн)\S*\s+подход/iu);
      if (!m || per.has(m[1].toLowerCase())) continue;
      if (/не\s+применял|не\s+использовал/iu.test(line)) { per.set(m[1].toLowerCase(), { w: 0, line }); continue; }
      const w = lineWeights(line.slice(m.index + m[0].length)).filter((x) => x > 0 && x <= 1);
      if (w.length) per.set(m[1].toLowerCase(), { w: w[w.length - 1], line });
    }
    const vals = [...per.values()];
    if (vals.length < 2 || !vals.some((v) => v.w > 0)) return;
    const sum = vals.reduce((a, v) => a + v.w, 0);
    if (!near1(sum)) out.push({ page: i, quote: clean(vals[0].line), text: `Веса подходов в согласовании в сумме ${fmtW(sum)}, а должно быть 1` });
  });
  return out;
}
function fmtW(x) { return String(Math.round(x * 1000) / 1000).replace('.', ','); }

// ——— 2.60: аналогов не меньше трёх, ссылки у разных аналогов не повторяются ———
const ANALOG_NO = /аналог\S*\s*(?:№\s*)?(\d{1,2})(?![\d.,])/giu;
const URL_RE = /https?:\/\/[^\s<>"«»)]+/giu;
const normUrl = (u) => u.replace(/[.,;:]+$/, '').replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/i, '').toLowerCase();
function analogFindings(doc) {
  const text = (doc.pages ?? []).join('\n');
  const refusedCompare = REFUSED.some((re) => [...text.matchAll(re)].some((m) => /сравнительн/iu.test(m[1])));
  const out = [];
  const nums = new Set();
  const urls = new Map();
  eachPage(doc, (page, i) => {
    const marks = [...page.matchAll(ANALOG_NO)].map((m) => ({ at: m.index, n: Number(m[1]) })).filter((x) => x.n >= 1 && x.n <= 30);
    for (const x of marks) nums.add(x.n);
    if (!marks.length) return;
    for (const m of page.matchAll(URL_RE)) {
      const before = marks.filter((x) => x.at < m.index).pop();
      if (!before) continue;
      const u = normUrl(m[0]);
      if (!urls.has(u)) urls.set(u, { set: new Set(), page: i, quote: lineAround(page, m.index), url: m[0] });
      urls.get(u).set.add(before.n);
    }
  });
  if (!refusedCompare && nums.size >= 1 && nums.size < 3 && /сравнительн\S*\s+подход/iu.test(text)) {
    const at = (doc.pages ?? []).findIndex((p) => /аналог\S*\s*(?:№\s*)?\d/iu.test(p));
    out.push({ page: Math.max(0, at), quote: '', text: `В сравнительном подходе ${nums.size === 1 ? 'один аналог' : 'два аналога'} — нужно не меньше трёх` });
  }
  for (const v of urls.values()) {
    if (v.set.size < 2) continue;
    out.push({ page: v.page, quote: v.quote, text: `Одна и та же ссылка у аналогов № ${[...v.set].sort((a, b) => a - b).join(' и № ')} — у каждого аналога должно быть своё объявление` });
  }
  return out;
}

// ——— 2.75: таблица аналогов в отчёте — как подтверждённые аналоги дела ———
// ctx.analogs — подтверждённые экспертом аналоги дела по порядку: { url, fields: { price_rub, area }, adjustments }.
// Аналогов в деле нет — молчим (эксперт мог не вести раздел «Аналоги»). Сверяем: ссылка каждого аналога дела есть в отчёте
// (переносы строк в PDF не мешают), его цена (и цена после корректировок) и площадь есть среди чисел отчёта; ссылка под
// «Аналог № N» в отчёте — из аналогов дела; номеров аналогов в отчёте не больше, чем в деле. Находка — «не найдено», а не
// «неверно»: число могло совпасть где-то ещё, поэтому правило ловит пропуск и чужое значение, но не доказывает верность.
const NUM_RE = /(\d{1,3}(?:[   .]\d{3})+|\d+)(?:,(\d{1,3})|\.(\d{1,2})(?!\d))?(\s*(?:млн|тыс))?/giu;
function numbersIn(text) {
  const out = [];
  for (const m of text.matchAll(NUM_RE)) {
    const v = Number(`${m[1].replace(/[   .]/g, '')}.${m[2] ?? m[3] ?? '0'}`);
    const mul = !m[4] ? 1 : /млн/iu.test(m[4]) ? 1e6 : 1e3;
    out.push(v * mul);
  }
  return out;
}
const hostPath = (raw) => {
  try { return cleanUrl(raw).key.split('?')[0].replace(/\/+$/, ''); } catch { return null; }
};
const siteOf = (url) => hostPath(url)?.split('/')[0] ?? '';
function analogMatch(docs, ctx) {
  const list = ctx.analogs ?? [];
  if (!list.length) return [];
  const d = mainReport(docs) ?? docs[0];
  if (!d) return [];
  const all = docs.map((x) => (x.pages ?? []).join('\n')).join('\n');
  if (REFUSED.some((re) => [...all.matchAll(re)].some((m) => /сравнительн/iu.test(m[1])))) return [];
  const firstPage = Math.max(0, (d.pages ?? []).findIndex((p) => /аналог/iu.test(p)));
  const at = (text, quote = '') => ({ doc: d, page: firstPage, quote, text });
  const n = list.length;
  const many = n === 1 ? 'подтверждён 1 аналог' : `подтверждено ${n} ${n < 5 ? 'аналога' : 'аналогов'}`;
  if (!/аналог/iu.test(all)) return [at(`В деле ${many}, а в отчёте аналогов нет — вставьте таблицу аналогов (кнопка «Отчёт Word» соберёт её сама)`)];
  const squashed = all.replace(/\s+/g, '').toLowerCase().replace(/\/\/(www|m)\./g, '//');
  const nums = numbersIn(all);
  const has = (v, tol) => nums.some((x) => Math.abs(x - v) <= tol);
  const out = [];
  const mine = new Set();
  list.forEach((a, i) => {
    const name = `Аналог ${i + 1} из дела (${siteOf(a.url)})`;
    const hp = hostPath(a.url);
    if (hp) mine.add(hp);
    if (hp && !squashed.includes(hp)) out.push(at(`${name}: ссылки на объявление в отчёте нет — добавьте его в таблицу аналогов или уберите из дела`, a.url));
    const price = a.fields?.price_rub;
    const sum = adjusted(a);
    if (Number.isFinite(price) && !has(price, 1) && !(sum && has(sum.price, 1))) {
      out.push(at(`${name}: цена ${fmt(price)} руб. в отчёте не найдена — проверьте цену в таблице аналогов`));
    } else if (sum && !has(sum.price, 1)) {
      out.push(at(`${name}: цена после корректировок ${fmt(sum.price)} руб. в отчёте не найдена — проверьте расчёт в таблице`));
    }
    const area = a.fields?.area;
    if (Number.isFinite(area) && area > 0 && !has(area, 0.051)) out.push(at(`${name}: площадь ${String(area).replace('.', ',')} кв. м в отчёте не найдена — проверьте площадь в таблице аналогов`));
  });
  // Ссылки под «Аналог № N» в отчёте, которых нет в деле (без скриншота и времени получения платформой).
  let maxNo = 0;
  const seen = new Set();
  for (const doc of docs) {
    eachPage(doc, (page, p) => {
      const marks = [...page.matchAll(ANALOG_NO)].map((m) => ({ at: m.index, n: Number(m[1]) })).filter((x) => x.n >= 1 && x.n <= 30);
      for (const x of marks) maxNo = Math.max(maxNo, x.n);
      for (const m of page.matchAll(URL_RE)) {
        const before = marks.filter((x) => x.at < m.index && m.index - x.at <= 300).pop();
        const hp = hostPath(m[0].replace(/[.,;:]+$/, ''));
        // Ссылка, перенесённая в PDF на следующую строку, читается обрезанной — своя, если с неё начинается ссылка дела.
        if (!before || !hp || [...mine].some((x) => x.startsWith(hp)) || seen.has(hp)) continue;
        seen.add(hp);
        out.push({ doc, page: p, quote: lineAround(page, m.index), text: `Ссылка у аналога № ${before.n} в отчёте — не из аналогов дела: добавьте объявление в раздел «Аналоги» (ссылка и скриншот со временем) или проверьте ссылку` });
      }
    });
  }
  if (maxNo > n) out.unshift(at(`В отчёте есть аналог № ${maxNo}, а в деле ${many} — добавьте недостающие в раздел «Аналоги» или проверьте нумерацию`));
  return out;
}

// ——— 2.61: товароведческая — дата и цена покупки как в заявке ———
// В заявке одна строка «Когда и где куплен, цена по чеку» («12.03.2026, М.Видео, 54 990 ₽»): дата — первая дата,
// цена — сумма с «₽» или «руб.» (иначе самое большое число от 100). В заключении сверяются только строки о покупке.
const DATE_RE = /(?<!\d)(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})(?![\d.]\d)/g;
const PRICE_RE = /(?<![\d,.])(\d{1,3}(?:[  ]\d{3})+|\d{3,9})(?:[,.](\d{2}))?\s*(?:₽|руб|р\.)/giu;
const BUY_WORDS = /куп(?:л|и)|покупк|приобр[её]т|(?<![а-яё])чек/iu;
const isoDate = (d, m, y) => `${y.length === 2 ? `20${y}` : y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
const money = (whole, kop) => Number(whole.replace(/[  ]/g, '')) + (kop ? Number(kop) / 100 : 0);

export function purchaseOf(text) {
  const s = String(text ?? '');
  const d = [...s.matchAll(DATE_RE)].find((m) => Number(m[1]) <= 31 && Number(m[2]) <= 12);
  const priced = [...s.matchAll(PRICE_RE)].map((m) => money(m[1], m[2]));
  const date = d ? isoDate(d[1], d[2], d[3]) : null;
  // Без «₽» берём самое большое число от 100, кроме чисел внутри даты.
  const bare = s.replace(DATE_RE, ' ').match(/\d{1,3}(?:[  ]\d{3})+(?:[,.]\d{2})?|\d{3,9}(?:[,.]\d{2})?/g) ?? [];
  const nums = bare.map((x) => { const [w, k] = x.split(/[,.]/); return money(w, k); }).filter((x) => x >= 100);
  const price = priced.length ? priced[0] : nums.length ? Math.max(...nums) : null;
  return { date, price };
}

function purchaseMatch(doc, ctx) {
  const mine = purchaseOf(ctx.fields?.purchase);
  if (!mine.date && !mine.price) return [];
  const out = [];
  const seen = new Set();
  eachPage(doc, (page, i) => {
    for (const line of page.split('\n')) {
      if (!BUY_WORDS.test(line) || /аналог|ремонт|устранени|замен/iu.test(line)) continue;
      // Строка списка «Документы, представленные заказчиком» (2.81): «Чек … — файл «…», получен 06.10.2026» — дата получения
      // файла, а не покупки (прогон 2.82).
      if (/файл «[^»]*»,\s*получен/iu.test(line)) continue;
      if (mine.date) {
        for (const m of line.matchAll(DATE_RE)) {
          if (Number(m[1]) > 31 || Number(m[2]) > 12) continue;
          const v = isoDate(m[1], m[2], m[3]);
          // Дата покупки — дата рядом со словом о покупке, а не дата осмотра или заключения в той же строке.
          const near = line.slice(Math.max(0, m.index - 40), m.index);
          if (v === mine.date || seen.has(`d${v}`) || !BUY_WORDS.test(near)) continue;
          seen.add(`d${v}`);
          out.push({ page: i, quote: line, text: `Дата покупки ${ruDate(v)} не совпадает с датой из заявки (${ruDate(mine.date)}) — проверьте чек` });
        }
      }
      if (mine.price && /цен|стоимост|сумм|оплач|чек/iu.test(line)) {
        for (const m of line.matchAll(PRICE_RE)) {
          const v = money(m[1], m[2]);
          if (Math.abs(v - mine.price) < 1 || seen.has(`p${v}`)) continue;
          seen.add(`p${v}`);
          out.push({ page: i, quote: line, text: `Цена покупки ${fmt(v)} ₽ не совпадает с ценой по чеку из заявки (${fmt(mine.price)} ₽) — проверьте чек` });
        }
      }
    }
  });
  return out;
}

// ——— 2.108: итоговая стоимость одна во всём отчёте и в сопроводительном письме ———
// После фразы «итоговая величина рыночной стоимости», «рыночная стоимость объекта …», «стоимость ремонта без учёта
// износа / с учётом износа», «утрата товарной стоимости», «стоимость устранения недостатков» берётся первая сумма в
// рублях (цифрами, «тыс. руб.», «руб.: 3 000 000» в таблице). Стоимость по отдельному подходу, аналога, за 1 кв. м,
// кадастровая, ликвидационная не сверяются; доля, с НДС и без НДС — каждая сама с собой. Больше двух разных сумм одного
// вида или обе суммы на одной странице — в отчёте, видимо, несколько объектов: такие не сверяем.
const VALUE_KINDS = [
  ['repair', /стоимост\S*\s+(?:восстановительн\S*\s+)?ремонт\S*/giu],
  ['fix', /стоимост\S*\s+(?:\S+\s+){0,4}?устранени\S*\s+(?:\S+\s+){0,2}?(?:недостатк|дефект)\S*/giu],
  // «… без учёта износа 412 300 руб., с учётом износа — 301 900 руб.»: вторая сумма — без слова «ремонт» (только в деле о ремонте).
  ['wear', /(?:без\s+уч[её]та|с\s+уч[её]том)\s+износа/giu],
  ['uts', /утрат\S*\s+товарн\S*\s+стоимост\S*|(?<![А-ЯЁа-яё])УТС(?![А-ЯЁа-яё])/gu],
  ['market', /итогов\S*\s+(?:величин|значени)\S*\s+(?:рыночн\S*\s+)?стоимост\S*|рыночн\S*\s+стоимост\S*/giu],
];
const REPAIR = /стоимост\S*\s+(?:восстановительн\S*\s+)?ремонт/iu;
const VALUE_NAMES = {
  'repair:nowear': 'Стоимость ремонта без учёта износа', 'repair:wear': 'Стоимость ремонта с учётом износа',
  fix: 'Стоимость устранения недостатков', uts: 'Утрата товарной стоимости',
  market: 'Итоговая стоимость', 'market:share': 'Стоимость доли', 'market:vat': 'Стоимость с НДС', 'market:novat': 'Стоимость без НДС',
};
const MONEY_AFTER = /(\d{1,3}(?:[   ]\d{3})+|\d+)(?:[,.](\d{1,2}))?\s*(тыс\S*|млн\S*)?\s*(?:\([^()]{3,200}\)\s*)?(?:руб|₽)/u;
const MONEY_BEFORE = /руб\S*\s*[:|)]?\s*(\d{1,3}(?:[   ]\d{3})+|\d{4,})(?:,(\d{2}))?(?!\d)/u;
const VALUE_SKIP = /аналог|кв\.?\s*м|м2|м²|за\s+(?:1|одн|единиц)|кадастров|ликвидац|инвестиц|арендн|залогов|годн\S*\s+остат|сред\S*\s+рыночн|диапазон|интервал|границ|предложени|объявлени/iu;
const APPROACH_ONLY = /(?:сравнительн|затратн|доходн)\S*\s+подход|подход\S*\s+(?:сравнительн|затратн|доходн)|метод\S*\s+(?:сравнени|прям|дисконт)/iu;
const NOVAT = /без\s+(?:уч[её]та\s+)?НДС/iu;
const VAT = /(?:с\s+уч[её]том|включая|в\s+т\.\s*ч\.?|в\s+том\s+числе)\s+НДС/iu;

function moneyIn(text) {
  const a = text.match(MONEY_AFTER);
  const b = text.match(MONEY_BEFORE);
  const m = a && (!b || a.index <= b.index) ? a : b;
  if (!m) return null;
  const mult = m === a && m[3] ? (/^млн/iu.test(m[3]) ? 1e6 : 1e3) : 1;
  const value = Math.round((Number(m[1].replace(/[   ]/g, '')) + (m[2] ? Number(m[2].padEnd(2, '0')) / 100 : 0)) * mult);
  return value >= 1000 ? { value, index: m.index, end: m.index + m[0].length } : null;
}

function valueKey(kind, said, after) {
  if (kind === 'repair' || kind === 'wear') return /без\s+(?:уч[её]та\s+)?износа/iu.test(said) ? 'repair:nowear' : /с\s+уч[её]том\s+износа/iu.test(said) ? 'repair:wear' : null;
  if (kind !== 'market') return kind;
  if (/(?<![а-яё])дол(?:и|ю|я|ей)(?![а-яё])|\d\s*\/\s*\d/iu.test(said)) return 'market:share';
  if (NOVAT.test(said) || NOVAT.test(after)) return 'market:novat';
  if (VAT.test(said) || VAT.test(after)) return 'market:vat';
  return 'market';
}

function finalValues(docs) {
  const main = mainReport(docs);
  const ordered = main ? [main, ...docs.filter((d) => d !== main)] : docs;
  const byKey = new Map();
  for (const doc of ordered) {
    const repairDoc = (doc.pages ?? []).some((p) => REPAIR.test(p));
    eachPage(doc, (raw, i) => {
      const page = raw.replace(/\n/g, ' ');
      const hits = [];
      for (const [kind, re] of VALUE_KINDS) {
        if (kind === 'wear' && !repairDoc) continue;
        for (const m of page.matchAll(re)) {
          const end = m.index + m[0].length;
          if (hits.some((h) => m.index < h.end && end > h.index)) continue; // «рыночная стоимость ремонта» — это ремонт
          hits.push({ kind, index: m.index, end });
        }
      }
      hits.sort((x, y) => x.index - y.index);
      hits.forEach((h, n) => {
        const stop = Math.min(h.end + 220, hits[n + 1]?.index ?? page.length);
        const money = moneyIn(page.slice(h.end, stop));
        if (!money) return;
        const said = page.slice(Math.max(lineStart(raw, h.index), h.index - 60), h.end + money.index);
        if (VALUE_SKIP.test(said)) return;
        if (APPROACH_ONLY.test(said) && !/согласовани|итогов/iu.test(said)) return;
        const key = valueKey(h.kind, page.slice(h.index, h.end + money.index), page.slice(h.end + money.end, h.end + money.end + 40));
        if (!key) return;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push({ doc, page: i, value: money.value, quote: lineAround(raw, h.index) });
      });
    });
  }
  return [...byKey].flatMap(([key, list]) => oddOnes(list, (e, ref, where) =>
    `${VALUE_NAMES[key]} ${fmt(e.value)} руб. не совпадает с ${fmt(ref)} руб. ${where} — сумма должна быть одна во всём отчёте и в письме`));
}

// Одно значение в разных местах ({ doc, page, value, quote }): ровно два разных — находка у того, что встречается реже
// (поровну — у того, что не в основном отчёте / позже). Оба на одной странице — видимо, два объекта: молчим
// (samePage: true — сверяем и на одной странице).
function oddOnes(list, say, { samePage = false } = {}) {
  const counts = new Map();
  for (const e of list) counts.set(e.value, (counts.get(e.value) ?? 0) + 1);
  if (counts.size !== 2) return [];
  const [a, b] = [...counts.keys()];
  if (!samePage && list.some((x) => x.value === a && list.some((y) => y.value === b && y.doc === x.doc && y.page === x.page))) return [];
  const ref = counts.get(b) > counts.get(a) ? b : a;
  const first = list.find((e) => e.value === ref);
  const where = (e) => `${first.doc === e.doc ? '' : `в «${first.doc.name}» `}на стр. ${first.page + 1}${counts.get(ref) > 1 ? ` (и ещё в ${counts.get(ref) - 1} ${counts.get(ref) === 2 ? 'месте' : 'местах'})` : ''}`;
  const seen = new Set();
  const out = [];
  for (const e of list) {
    if (e.value === ref || seen.has(`${e.doc.name}|${e.page}`)) continue;
    seen.add(`${e.doc.name}|${e.page}`);
    out.push({ doc: e.doc, page: e.page, quote: e.quote, text: say(e, ref, where(e)) });
  }
  return out;
}

// ——— 2.116: номер отчёта и дата составления одни на титуле, в колонтитуле и в сопроводительном письме ———
// Номер — после «Отчёт (об оценке) №», «Заключение (эксперта / специалиста) №», «к отчёту №»; дата — «от …» сразу за
// номером и «дата составления (подписания) отчёта …», цифрами или словами («от «05» октября 2026 г.»). Номера сверяются
// без пробелов, точек и регистра («108/2026-О» и «108 / 2026 - о» — одно). Три и больше разных номеров (отчёт ссылается
// на прежние) не сверяем; два разных номера на одной странице — тоже.
const NUMBER_AT = /(?<![А-ЯЁа-яё])(?:отч[её]т\S*|заключени\S*)(?:\s+(?:об\s+оценке|эксперт\S*|специалист\S*|судебн\S*\s+эксперт\S*))?\s*(?:№|N[oо]?\.?(?=\s*\d))\s*([\p{L}\d][\p{L}\d.]*(?:\s*[\/\\\-–]\s*[\p{L}\d][\p{L}\d.]*)*)/giu;
const NUMBER_DATE = '^\\s*,?\\s*от(?![а-яё])';
const unquote = (s) => s.replace(/[«"“](\d{1,2})[»"”]/g, '$1');

function reportNumbers(docs) {
  const main = mainReport(docs);
  const ordered = main ? [main, ...docs.filter((d) => d !== main)] : docs;
  const nums = [];
  const dates = [];
  for (const doc of ordered) {
    eachPage(doc, (raw, i) => {
      const page = unquote(raw);
      for (const m of page.matchAll(NUMBER_AT)) {
        const shown = m[1].replace(/\s*([\/\\\-–])\s*/gu, '$1').replace(/\.+$/u, '');
        if (!/\d/.test(shown)) continue;
        const quote = lineAround(raw, m.index);
        nums.push({ doc, page: i, value: squash(shown), shown, quote });
        const rest = page.slice(m.index + m[0].length);
        const on = dateAfter(rest, NUMBER_DATE);
        if (on) dates.push({ doc, page: i, value: on, quote });
      }
      const label = new RegExp(MADE_LABEL, 'giu');
      for (const m of page.matchAll(label)) {
        const on = dateAfter(page.slice(m.index), MADE_LABEL);
        if (on) dates.push({ doc, page: i, value: on, quote: lineAround(raw, m.index) });
      }
    });
  }
  const shownOf = new Map(nums.map((e) => [e.value, e.shown]));
  // Одна и та же дата на странице (у номера и «дата составления») — одно место.
  const once = (list) => list.filter((e, k) => list.findIndex((x) => x.doc === e.doc && x.page === e.page && x.value === e.value) === k);
  return [
    ...oddOnes(once(nums), (e, ref, where) => `Номер отчёта № ${e.shown} не совпадает с № ${shownOf.get(ref)} ${where} — номер должен быть один на титуле, в колонтитулах и в письме`),
    ...oddOnes(once(dates), (e, ref, where) => `Дата отчёта ${ruDate(e.value)} не совпадает с ${ruDate(ref)} ${where} — дата составления должна быть одна на титуле, в колонтитулах и в письме`, { samePage: true }),
  ];
}

// ——— 2.123: дата оценки одна по всему отчёту и в сопроводительном письме ———
// Дата оценки — после «дата оценки (дата определения стоимости, датой оценки является)» и после «по состоянию на», если
// в той же строке перед ним говорится о стоимости объекта (кадастровая, балансовая, прежние оценки, аналоги и индексы —
// не в счёт). Цифрами или словами («по состоянию на «01» октября 2026 г.»). Ровно две разные даты — находка у той, что
// встречается реже; три и больше — молчим (значит, это не одна дата оценки).
const VALUE_AT = new RegExp(`${VALUE_LABEL}|дат\\S*\\s+проведения\\s+оценки|датой\\s+оценки\\s+(?:является|принята|считается)|по\\s+состоянию\\s+на`, 'giu');
const STATE_SKIP = /кадастров|балансов|инвентаризац|прежн|предыдущ|ранее|прошл|аналог|предложени|объявлени|индекс|инфляц|курс|выписк|ставк|задолженност/iu;

function valueDates(docs) {
  const main = mainReport(docs);
  const ordered = main ? [main, ...docs.filter((d) => d !== main)] : docs;
  const dates = [];
  for (const doc of ordered) {
    eachPage(doc, (raw, i) => {
      const page = unquote(raw);
      for (const m of page.matchAll(VALUE_AT)) {
        if (/^по/iu.test(m[0])) {
          const before = lineBefore(page, m.index, 250);
          if (!/стоимост/iu.test(before) || STATE_SKIP.test(before)) continue;
        }
        const on = dateAfter(page.slice(m.index), `^${m[0].replace(/\s+/gu, '\\s+')}`);
        if (on) dates.push({ doc, page: i, value: on, quote: lineAround(raw, m.index) });
      }
    });
  }
  const once = dates.filter((e, k) => dates.findIndex((x) => x.doc === e.doc && x.page === e.page && x.value === e.value) === k);
  return oddOnes(once, (e, ref, where) => `Дата оценки ${ruDate(e.value)} не совпадает с ${ruDate(ref)} ${where} — дата оценки должна быть одна во всём отчёте и в письме`, { samePage: true });
}

// ——— 2.61: каждый вопрос заявки найден в выводах (все виды) ———
// Вопросы — из поля заявки «Какие вопросы поставить эксперту» (нумерованные или по одному в строке). Вопрос считается
// отвеченным, если в выводах есть «по вопросу № N» / «ответ на вопрос N» или больше половины его значимых слов.
const STOP = new Set(['каков', 'какая', 'какой', 'какие', 'каково', 'является', 'являет', 'имеется', 'имеет', 'имеют', 'ли', 'если', 'данный', 'данного', 'указанн', 'представ', 'эксперт', 'вопрос', 'определ', 'установ']);
const stem = (w) => w.toLowerCase().replace(/ё/g, 'е').slice(0, 6);
function stemsOf(q) {
  return [...new Set((q.match(/[А-Яа-яЁё]{5,}/gu) ?? []).map(stem).filter((s) => ![...STOP].some((x) => s.startsWith(x.slice(0, 6)))))];
}
export function questionsOf(text) {
  const s = String(text ?? '').replace(/\r/g, '').trim();
  if (!s) return [];
  const numbered = s.split(/(?:^|\n|\s)(?=\d{1,2}\s*[.)]\s+\S)/u).map((x) => x.replace(/^\d{1,2}\s*[.)]\s*/u, '').trim()).filter(Boolean);
  const parts = numbered.length > 1 ? numbered : s.split(/\n+|(?<=\?)\s+/u).map((x) => x.trim()).filter(Boolean);
  return parts.map((x) => clean(x)).filter((x) => stemsOf(x).length >= 1);
}
const CONCLUSIONS = /^\s*(?:\d{1,2}\.?\s*)?(?:(?:основные\s+факты\s+и\s+)?выводы?(?:\s+эксперта)?|ответы\s+на\s+(?:поставленные\s+)?вопросы|итоговое\s+заключение)(?![А-Яа-яЁё])[^\n]{0,60}$/imu;
function conclusionsText(doc) {
  const pages = doc.pages ?? [];
  // Последний заголовок «Выводы» в тексте (в оглавлении он тоже есть — берём последний).
  let at = null;
  pages.forEach((p, i) => {
    const re = new RegExp(CONCLUSIONS.source, 'gimu');
    for (const m of p.matchAll(re)) if (!TOC_END.test(m[0])) at = { page: i, index: m.index };
  });
  if (!at) return null;
  return { page: at.page, text: [pages[at.page].slice(at.index), ...pages.slice(at.page + 1)].join('\n') };
}
function questionsAnswered(docs, ctx) {
  const qs = questionsOf(ctx.fields?.questions);
  if (!qs.length) return [];
  const d = mainReport(docs);
  if (!d) return [];
  const c = conclusionsText(d);
  if (!c) {
    return [{ doc: d, page: Math.max(0, d.pages.length - 1), quote: '', text: `В заключении не найден раздел «Выводы» — в заявке ${qs.length === 1 ? 'один вопрос' : `вопросов: ${qs.length}`}, на каждый нужен ответ` }];
  }
  const words = new Set((c.text.match(/[А-Яа-яЁё]{5,}/gu) ?? []).map(stem));
  const out = [];
  qs.forEach((q, k) => {
    const n = k + 1;
    const byNumber = new RegExp(`(?:по|на)\\s+(?:${n}-?(?:му|й|ому)?\\s+)?вопрос\\S*\\s*(?:№\\s*)?${n}(?!\\d)|вопрос\\S*\\s*№\\s*${n}(?!\\d)|(?:по|на)\\s+${n}-?(?:му|ому|й)\\s+вопрос`, 'iu');
    if (byNumber.test(c.text)) return;
    const st = stemsOf(q);
    const hit = st.filter((s) => words.has(s)).length;
    if (hit * 2 > st.length) return;
    out.push({ doc: d, page: c.page, quote: q, text: `Вопрос ${n} из заявки не найден в выводах: «${q.slice(0, 120)}» — дайте ответ или укажите, почему ответить нельзя` });
  });
  return out;
}

const WHOLE = {
  questions_answered: questionsAnswered,
  dossier_appraiser: dossierFindings(['certificate', 'sro', 'policy', 'policy_org']),
  dossier_education: dossierFindings(['education']),
  required_items: requiredItems,
  court_order: courtOrder,
  analog_match: analogMatch,
  report_dates: reportDates,
  final_value: finalValues,
  report_number: reportNumbers,
  value_date: valueDates,
};

const PER_DOC = {
  word_fields: wordFields,
  section_gaps: sectionGaps,
  sum_words: sumWords,
  rounding,
  approaches_toc: approachesToc,
  template_leftovers: templateLeftovers,
  inspection,
  court_purpose: courtPurpose,
  vin_match: vinMatch,
  cadastral_match: cadastralMatch,
  address_match: addressMatch,
  area_match: areaMatch,
  floor_match: floorMatch,
  share_match: shareMatch,
  land_match: landMatch,
  date_order: dateOrder,
  reg_match: regMatch,
  mileage_match: mileageMatch,
  approach_weights: approachWeights,
  analog_list: analogFindings,
  purchase_match: purchaseMatch,
};

// Все правила: имя → короткое описание (для проверки описаний модулей и для журнала).
export const AUTO_CHECKS = Object.freeze({
  word_fields: 'служебные строки Word («Ошибка! Закладка не определена»)',
  section_gaps: 'пропуск в нумерации разделов',
  vehicle_year: 'год выпуска одинаков во всём отчёте',
  vin_year: 'год выпуска сходится с 10-м знаком VIN',
  sum_words: 'сумма цифрами совпадает с суммой прописью',
  rounding: 'итог не дальше 2% от расчёта',
  approaches_toc: 'подход из оглавления не отвергнут в тексте',
  template_leftovers: 'нет остатков шаблона другого вида: недвижимость в отчёте о машине, машина в отчёте о квартире',
  cadastral_match: 'кадастровый номер в отчёте — как в заявке',
  address_match: 'адрес объекта одинаков по всему отчёту и как в заявке: населённый пункт, улица, дом, корпус, квартира, участок',
  area_match: 'площадь объекта в отчёте — как в заявке',
  floor_match: 'этаж и этажность дома в отчёте — как в заявке',
  share_match: 'размер доли в отчёте — как в заявке',
  land_match: 'категория земель и вид разрешённого использования — как в заявке',
  inspection: '«без осмотра» и дата осмотра одновременно',
  court_purpose: 'цель «для суда» и отказ являться в суд',
  dossier_appraiser: 'аттестат, СРО и полисы сходятся с досье эксперта: номера, суммы, срок на дату отчёта',
  dossier_education: 'диплом эксперта сходится с досье',
  required_items: 'обязательные сведения отчёта по ст. 11 закона об оценке и ФСО',
  court_order: 'по определению суда — номер определения и ст. 307 УК РФ',
  vin_match: 'VIN в отчёте — как в заявке',
  date_order: 'дата составления отчёта не раньше даты оценки',
  report_dates: 'даты по всему отчёту: осмотр не позже составления и в дни фото осмотра в деле, объявления аналогов не позже даты оценки',
  reg_match: 'госномер в отчёте — как в заявке',
  mileage_match: 'пробег в отчёте — как в заявке (с запасом 10%)',
  approach_weights: 'веса подходов в согласовании в сумме 1',
  analog_list: 'аналогов не меньше трёх, ссылки у разных аналогов не повторяются',
  analog_match: 'аналоги в отчёте — как подтверждённые в деле: ссылка, цена, площадь, число аналогов',
  purchase_match: 'дата и цена покупки товара — как в заявке',
  questions_answered: 'каждый вопрос заявки найден в выводах',
  final_value: 'итоговая стоимость одна на титуле, в задании, выводах, итоговой таблице и в сопроводительном письме',
  report_number: 'номер отчёта и дата составления одни на титуле, в колонтитулах и в сопроводительном письме',
  value_date: 'дата оценки одна по всему отчёту и в сопроводительном письме',
});

export function runAutoChecks(names, docs, ctx = {}) {
  const wanted = new Set(names);
  const readable = docs.filter((d) => Array.isArray(d.pages));
  const res = {};
  for (const name of wanted) res[name] = [];
  if (wanted.has('vehicle_year') || wanted.has('vin_year')) {
    const v = vehicleYears(readable);
    if (wanted.has('vehicle_year')) res.vehicle_year = v.vehicle_year;
    if (wanted.has('vin_year')) res.vin_year = v.vin_year;
  }
  for (const name of wanted) if (WHOLE[name]) res[name] = WHOLE[name](readable, ctx);
  for (const doc of readable) {
    for (const name of wanted) {
      const fn = PER_DOC[name];
      if (fn) res[name].push(...fn(doc, ctx).map((f) => ({ ...f, doc })));
    }
  }
  for (const name of Object.keys(res)) {
    res[name] = res[name].slice(0, MAX_PER_RULE).map((f) => ({
      text: f.text,
      file: f.doc.name,
      where: f.doc.pages.length > 1 ? `стр. ${f.page + 1}` : 'стр. 1',
      quote: clean(f.quote).slice(0, 200),
    }));
  }
  return res;
}

// ——— мелочи ———
function eachPage(doc, fn) { (doc.pages ?? []).forEach((p, i) => fn(p, i)); }
function clean(s) { return String(s ?? '').replace(/\s+/g, ' ').trim(); }
function fmt(n) { return Number(n).toLocaleString('ru-RU').replace(/ /g, ' '); }
function lineStart(page, index) { return page.lastIndexOf('\n', index) + 1; }
function lineAround(page, index) {
  const start = page.lastIndexOf('\n', index) + 1;
  const end = page.indexOf('\n', index);
  return clean(page.slice(start, end < 0 ? undefined : end)).slice(0, 200);
}
