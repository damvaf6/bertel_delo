// Автоматические находки в отчёте (решение Дамира 03.10.2026: ИИ-проверка должна ловить ошибки вроде найденных в
// настоящих отчётах об оценке транспорта). Это не модель ИИ, а простые правила по всему тексту отчёта, страница за
// страницей: они видят весь отчёт, даже когда модели уходит только его часть, и всегда отвечают одинаково.
// Находка — подсказка человеку (место и страница), не вердикт: отметки ставит человек.
// Какие правила к какой проверке относятся — данными в модуле (`checks[].auto`); здесь — только сами правила.
//   runAutoChecks(names, docs, ctx) → { [имя правила]: [{ text, file, where, quote }] }
// docs — [{ name, kind, pages }] (src/ai/extract.mjs); ctx — { fields } заявки.

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

function templateLeftovers(doc) {
  const out = [];
  eachPage(doc, (page, i) => {
    for (const m of page.matchAll(LEFTOVER)) out.push({ page: i, quote: lineAround(page, m.index), text: `«${clean(m[0])}» в отчёте о движимом имуществе — возможно, остаток шаблона другого отчёта` });
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

const PER_DOC = {
  word_fields: wordFields,
  section_gaps: sectionGaps,
  sum_words: sumWords,
  rounding,
  approaches_toc: approachesToc,
  template_leftovers: templateLeftovers,
  inspection,
  court_purpose: courtPurpose,
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
  template_leftovers: 'нет остатков шаблона про недвижимость и землю',
  inspection: '«без осмотра» и дата осмотра одновременно',
  court_purpose: 'цель «для суда» и отказ являться в суд',
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
function lineAround(page, index) {
  const start = page.lastIndexOf('\n', index) + 1;
  const end = page.indexOf('\n', index);
  return clean(page.slice(start, end < 0 ? undefined : end)).slice(0, 200);
}
