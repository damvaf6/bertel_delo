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

// Число → слова (рубли): 3500000 → «три миллиона пятьсот тысяч» (2.364: верная сумма прописью для находки).
const W_ONES = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const W_TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const W_HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
const W_SCALES = [[1e9, ['миллиард', 'миллиарда', 'миллиардов']], [1e6, ['миллион', 'миллиона', 'миллионов']], [1e3, ['тысяча', 'тысячи', 'тысяч'], true]];
const plural = (n, [one, few, many]) => (n % 100 >= 11 && n % 100 <= 19 ? many : n % 10 === 1 ? one : n % 10 >= 2 && n % 10 <= 4 ? few : many);
function triad(n, feminine) {
  const out = [W_HUNDREDS[Math.floor(n / 100)]];
  const rest = n % 100;
  if (rest < 20) out.push(W_ONES[rest]);
  else out.push(W_TENS[Math.floor(rest / 10)], W_ONES[rest % 10]);
  const last = out.length - 1;
  if (feminine) out[last] = out[last] === 'один' ? 'одна' : out[last] === 'два' ? 'две' : out[last];
  return out.filter(Boolean);
}
export function numberToWords(num) {
  let n = Math.floor(Number(num));
  if (!Number.isFinite(n) || n < 0 || n >= 1e12) return null;
  if (n === 0) return 'ноль';
  const out = [];
  for (const [size, forms, feminine] of W_SCALES) {
    const k = Math.floor(n / size);
    n %= size;
    if (k) out.push(...triad(k, feminine), plural(k, forms));
  }
  out.push(...triad(n, false));
  return out.join(' ');
}

// «3 148 760,14 руб. (Три миллиона … шестьдесят рублей 14 копеек)», «4 100 000,00 = (Четыре миллиона сто тысяч) рублей»,
// «(…) руб. 00 коп.». В скобках — рубли словами, за ними (в скобках или после) — копейки цифрами или словами.
const SUM_WORDS = /(\d{1,3}(?:[  .]\d{3})+|\d{4,})(?:[,.](\d{2}))?\s*(\(?\s*руб(?:\.|лей|ля|ль)?\s*\)?)?\s*=?\s*\(\s*([А-Яа-яЁё][^()\d]{3,200}?(?:\s+\d{1,2}\s*коп[а-яё]*\.?)?)\s*\)\s*(руб|рубл)?/gu;
const RUB_WORD = /(?:^|\s)руб(?:л[а-яё]*|\.)?(?=\s|$)/u;
const KOP_TAIL = /^(.*?)\s*(\d{1,2})?\s*коп[а-яё]*\.?$/u;
const sumFmt = (rub, kop) => `${fmt(rub)}${kop ? `,${String(kop).padStart(2, '0')}` : ''}`;
// Перед суммой — итоговая (рыночная, ликвидационная) стоимость: находка называет её так (2.364).
const FINAL_BEFORE = /(?:итогов\S*\s+(?:величин|стоимост|значени)|(?:рыночн|ликвидационн|справедлив|инвестиционн)\S*\s+стоимост)/iu;

function sumWords(doc) {
  const out = [];
  eachPage(doc, (raw, i) => {
    const page = raw.replace(/\n/g, ' ');
    for (const m of page.matchAll(SUM_WORDS)) {
      if (!m[3] && !m[5] && !RUB_WORD.test(` ${m[4].toLowerCase()} `)) continue;
      const num = Number(m[1].replace(/[  .]/g, ''));
      // Рубли словами — до слова «рублей» в скобках; копейки — после него, в скобках или сразу за ними.
      const inner = m[4].replace(/\s+/g, ' ').trim();
      const cut = RUB_WORD.exec(inner.toLowerCase());
      let rubText = cut ? inner.slice(0, cut.index).trim() : inner;
      let kopText = cut ? inner.slice(cut.index + cut[0].length).trim() : '';
      if (!cut) {
        const tail = KOP_TAIL.exec(rubText);
        if (tail && /коп/iu.test(rubText)) {
          rubText = tail[1];
          kopText = tail[0].slice(tail[1].length).trim();
        }
      }
      if (!kopText && m[5]) kopText = (/^[а-яё.]*\s*(\d{1,2}\s*коп[а-яё]*)/u.exec(page.slice(m.index + m[0].length, m.index + m[0].length + 30)) ?? [])[1] ?? '';
      const said = wordsToNumber(rubText);
      if (said === null || !num) continue;
      const kopDigits = /(\d{1,2})\s*коп/u.exec(kopText)?.[1];
      const kopWords = !kopDigits && /коп/u.test(kopText) ? wordsToNumber(kopText.replace(/коп[а-яё]*\.?/u, '')) : null;
      const saidKop = kopDigits != null ? Number(kopDigits) : kopWords;
      const kop = m[2] != null ? Number(m[2]) : null;
      const kopOff = kop != null && saidKop != null && kop !== saidKop;
      if (said === num && !kopOff) continue;
      const showKop = kop != null && saidKop != null && (kop || saidKop);
      const final = FINAL_BEFORE.test(page.slice(Math.max(0, m.index - 200), m.index));
      const right = numberToWords(num);
      const upper = /^\p{Lu}/u.test(rubText);
      const rightText = right && (upper ? right[0].toUpperCase() + right.slice(1) : right);
      out.push({
        page: i, quote: clean(m[0]).slice(0, 160),
        text: `${final ? 'Итоговая стоимость: сумма' : 'Сумма'} цифрами ${showKop ? sumFmt(num, kop) : fmt(num)} не совпадает с суммой прописью (${showKop ? sumFmt(said, saidKop) : fmt(said)})`
          + (said !== num && rightText ? ` — цифрам соответствует «${rightText}»` : ''),
        ...(said !== num && rightText ? { words: { bad: rubText, right: rightText } } : {}),
      });
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
// 2.203: выписка ЕГРН в деле (ctx.egrn — ai-ops) — номер берётся из неё, как площадь (2.202).
const CADASTRAL_RE = /\b\d{2}:\d{2}:\d{6,7}:\d{1,7}\b/g;
// В выписке рядом с номером объекта бывают номер участка или здания, «в пределах которого» он стоит, номера помещений
// в здании, прежние номера — это не номер объекта.
const EGRN_CAD_OTHER = /предел|располож|образован|исходн|ранее\s+присвоен|преж|помещени\S*\s*,?\s*(?:расположен|в\s+здани)|машино-мест|входящ|связ|квартал|аналог/iu;
export function egrnCadastral(egrn, ctx) {
  return oneValue(egrnCadastralValues(egrn, ctx));
}
function egrnCadastralValues(egrn, ctx) {
  const land = ctx.service === 'land';
  const values = new Map();
  for (const d of egrn ?? []) {
    if (!Array.isArray(d.pages)) continue;
    const head = d.pages.slice(0, 2).join('\n');
    if (land ? EGRN_BUILT.test(head) && !EGRN_LAND.test(head) : EGRN_LAND.test(head) && !EGRN_BUILT.test(head)) continue;
    // Номер объекта в выписке — первый номер после слов «кадастровый номер» в начале выписки.
    d.pages.some((page, i) => {
      for (const m of page.matchAll(CADASTRAL_RE)) {
        const before = page.slice(Math.max(0, m.index - 80), m.index);
        if (!/кадастров\S*\s+(?:номер|№)\s*(?:объекта(?:\s+недвижимости)?)?\s*[:\-–—]?\s*$/iu.test(before)) continue;
        if (EGRN_CAD_OTHER.test(lineBefore(page, m.index))) continue;
        if (!values.has(m[0])) values.set(m[0], { name: d.name, page: i, doc: d.id, quote: lineAround(page, m.index) });
        return true;
      }
      return false;
    });
  }
  return values;
}
// 2.218: где в выписке ЕГРН стоит значение, с которым сверяли, — у находки кнопка «Выписка ЕГРН, стр. N».
function egrnAt(at) {
  return at?.doc ? { doc: at.doc, name: at.name, page: at.page, quote: at.quote } : null;
}
// Ровно одно значение из выписок — { v, name, page, doc, quote }; ни одного или разные — null.
function oneValue(values) {
  if (values.size !== 1) return null;
  const [[v, at]] = [...values];
  return { v, ...at };
}

function cadastralMatch(doc, ctx) {
  const typed = String(ctx.fields?.cadastral ?? '').trim();
  const mine = /^\d{2}:\d{2}:\d{6,7}:\d+$/.test(typed) ? typed : '';
  const egrn = ctx.egrn?.length ? egrnCadastral(ctx.egrn, ctx) : null;
  const ref = egrn ? egrn.v : mine;
  if (!ref) return [];
  // В заявке другой номер — заказчик ошибся или выписка не на тот объект: подсказываем.
  const differs = egrn && mine && mine !== egrn.v;
  const out = [];
  const seen = new Set();
  eachPage(doc, (page, i) => {
    for (const m of page.matchAll(CADASTRAL_RE)) {
      const v = m[0];
      if (v === ref || seen.has(v)) continue;
      // Номера аналогов и кадастрового квартала стоят без слов «кадастровый номер объекта» — их не трогаем.
      if (!/кадастров\S*\s+(?:номер|№)/iu.test(page.slice(Math.max(0, m.index - 60), m.index))) continue;
      if (/аналог/iu.test(lineAround(page, m.index))) continue;
      seen.add(v);
      out.push({ page: i, quote: lineAround(page, m.index), egrn: egrnAt(egrn), fix: egrn ? { bad: v, right: egrn.v } : { bad: v, right: mine, from: MINE }, text: egrn
        ? `Кадастровый номер ${v} не совпадает с номером в выписке ЕГРН «${egrn.name}» (${egrn.v}, стр. ${egrn.page + 1})${differs ? `; в заявке — ${mine}` : ''} — проверьте, нет ли данных другого объекта`
        : `Кадастровый номер ${v} не совпадает с номером из заявки (${mine}) — проверьте, нет ли данных другого объекта` });
    }
  });
  return out;
}

// ——— 2.94: адрес объекта — как в заявке и одинаков по всему отчёту (титул, задание, описание, выводы) ———
// Адрес берём только после слов «адрес объекта», «местоположение», «по адресу» и не в строках про аналоги, оценщика,
// организацию, заказчика, регистрацию. Сверяем по частям: населённый пункт, улица, дом, корпус, строение, квартира,
// помещение, участок. Части, которой нет в одном из адресов, не сверяем. Нет части в заявке — сверяем с первым
// адресом в отчёте.
const ADDR_AT = /(?:адрес\S*\s*\((?:местоположени|местонахождени)[^)\n]{0,20}\)(?!\s*(?:объект|участк|квартир|помещени|здани|имуществ))|адрес\S*\s*(?:\([^)\n]{0,30}\)\s*)?(?:объект\S*|местонахожд\S*|местоположен\S*|квартир\S*|помещени\S*|участк\S*|(?<![а-яё])дом\S*|здани\S*|имуществ\S*|оцениваем\S*|исследуем\S*)(?:\s+(?:оценки|экспертизы|исследования|недвижимости))?|(?:местоположени\S*|местонахождени\S*)\s*(?:\([^)\n]{0,20}\)\s*)?(?:(?:объект|участк|квартир|помещени|здани|имуществ)\S*(?:\s+(?:оценки|экспертизы|исследования))?)?|(?<![а-яё])по\s+адресу)\s*[:\-–—]?\s*/giu;
const ADDR_OTHER = /зарегистр|прожива|юридическ|почтов|организац|обществ|(?<![А-ЯЁ])ООО(?![А-ЯЁ])|оценщик|заказчик|исполнител|офис|(?<![а-яё])СРО(?![а-яё])|суд/iu;
const ADDR_OBJECT = /объект|квартир|комнат|помещени|участ|здани|строени|имуществ|недвижим|(?<![а-яё])дом/iu;
// Конец адреса: дальше идут кадастровый номер, площадь, этаж, собственник или новое предложение.
// 2.197: сокращения в названии улицы («ул. Акад. Королёва», «Больш. Серпуховская») — не конец предложения.
const ADDR_END = /\s(?:с|со)\s+(?=кадастр|общ|площ)|кадастр|площад|общей|этаж|принадлеж|собственн|[;()]|\s[—–]\s|(?<=[а-яё]{4}|\d)(?<!(?<![а-яё])(?:акад|генер|марш|адмир|проф|больш|верх|нижн|стар|сред|просп|влад|корп|литер|кварт|респ|посел|посёл|станиц))\.\s+(?=[А-ЯЁA-Z])/iu;
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
// 2.167: буква дома латиницей («3A»), через пробел («3 А») и литерой («д. 3, лит. А») — одно и то же «3а».
const LATIN_LETTER = { a: 'а', b: 'б', c: 'с', e: 'е', k: 'к', m: 'м', o: 'о', p: 'р', x: 'х' };
export function parseAddress(text) {
  const t = String(text ?? '').toLowerCase().replace(/ё/g, 'е')
    .replace(/(\d)\s?([abcekmopx])(?![a-z])/g, (_, d, l) => d + LATIN_LETTER[l])
    .replace(/(\d)\s+([абвг])(?=\s*(?:,|$))/gu, '$1$2')
    .replace(/(?<![а-я])(?:д|дом)\.?\s*№?\s*(\d+)(?![\d/а-я])([^,]*),\s*(?:лит|литер|литера)\.?\s*([абвг])(?![а-я])/u, 'д. $1$3$2');
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
// 2.197: сокращённое слово названия — то же слово («Ген. Белова» = «Генерала Белова», «Акад.» = «Академика»).
const wordIn = (w, list) => list.some((x) => x === w || (x.startsWith(w) || w.startsWith(x)));
const sameWords = (a, b) => a.every((w) => wordIn(w, b)) || b.every((w) => wordIn(w, a));
// 2.197: населённый пункт в одном адресе без «г.» или с внутригородским делением («Москва, вн.тер.г. муниципальный
// округ …», «Москва, поселение Внуковское, д. Ракитки») — тот же, если его название есть в другом адресе.
const addrWords = (s) => stems(String(s ?? '').toLowerCase().replace(/ё/g, 'е'));
// Адреса объекта на страницах документа: { page, index, text, got, words }; одинаковые записи — один раз.
function objectAddresses(doc) {
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
      // 2.167: и адрес, разорванный в ячейке таблицы без запятой («…ул. Долевая,» / «д. 3, кв. 8» или «г. Москва, ул.» / «Долевая…»).
      const wrapped = (line, next) => /[,-]\s*$/.test(line) || (!line.trim() && next.trim())
        || (/(?<![а-яё])(?:ул|г|д|пр|пер|наб|ш|улица|дом)\.?\s*$/iu.test(line) && next.trim())
        || (!/\d/.test(line) && /^\s*(?:д|дом|кв|корп|стр|уч|участок|вл)\.?\s*№?\s*\d/iu.test(next));
      const nextEnd = page.indexOf('\n', end + 1);
      if (end < page.length && wrapped(page.slice(from, end), page.slice(end + 1, nextEnd < 0 ? page.length : nextEnd))) { const e2 = page.indexOf('\n', end + 1); end = e2 < 0 ? page.length : e2; }
      let text = page.slice(from, end).replace(/\n/g, ' ');
      const cut = text.search(ADDR_END);
      if (cut >= 0) text = text.slice(0, cut);
      text = clean(text).replace(/[,.\s]+$/, '').slice(0, 200);
      const got = parseAddress(text);
      if (!got.house && !got.flat && !got.plot && !got.room) continue;
      const key = JSON.stringify(got);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ page: i, index: m.index, text, got, words: addrWords(text) });
    }
  });
  return out;
}
// Часть адреса k одинакова в got (слова — words) и ref (слова — refWords).
function samePart(k, got, words, ref, refWords) {
  if (!Array.isArray(got)) return got === ref;
  return sameWords(got, ref) || (k === 'settlement' && (ref.every((w) => words.includes(w)) || got.every((w) => refWords.includes(w))));
}
// Адреса a и b не расходятся ни в одной части, которая есть в обоих.
const sameAddress = (a, b) => Object.keys(ADDR_NAMES).every((k) => a.got[k] === undefined || b.got[k] === undefined
  || samePart(k, a.got[k], a.words, b.got[k], b.words));

// 2.213: адрес из выписок ЕГРН дела (ctx.egrn — ai-ops), как площадь (2.202): первый адрес объекта в каждой выписке.
// Выписка на участок при оценке квартиры или дома (и наоборот) не в счёт. Выписки на дом и на квартиру в нём не спорят —
// берём адрес, где частей больше; разные адреса — какой верный, решает эксперт: сверяем с заявкой, как раньше.
export function egrnAddress(egrn, ctx) {
  const list = egrnAddressValues(egrn, ctx);
  return list.length === 1 ? list[0] : null;
}
// Все разные адреса объекта в выписках (2.222 — для черновика): одинаковые сливаются, остаётся более полный.
function egrnAddressValues(egrn, ctx) {
  const land = ctx.service === 'land';
  const list = [];
  for (const d of egrn ?? []) {
    if (!Array.isArray(d.pages)) continue;
    const head = d.pages.slice(0, 2).join('\n');
    if (land ? EGRN_BUILT.test(head) && !EGRN_LAND.test(head) : EGRN_LAND.test(head) && !EGRN_BUILT.test(head)) continue;
    const [a] = objectAddresses(d);
    if (!a) continue;
    const got = { ...a, name: d.name, doc: d.id, quote: lineAround(d.pages[a.page], a.index) };
    const i = list.findIndex((b) => sameAddress(b, got));
    if (i < 0) list.push(got);
    else if (Object.keys(got.got).length > Object.keys(list[i].got).length) list[i] = got;
  }
  return list;
}
// Адрес text (из заявки) не расходится с адресом a из выписки (2.222).
export const sameAddressText = (a, text) => sameAddress(a, { got: parseAddress(clean(text)), words: addrWords(clean(text)) });

// 2.277: адрес объекта из приложенных к делу задания на оценку, письма заказчика или определения суда (ctx.assignment —
// ai-ops, как дата оценки 2.198): первый адрес объекта в каждом документе; выписки ЕГРН среди них не в счёт. Документы
// с разными адресами — какой верный, решает эксперт: молчим. Нет адреса — null.
export function assignmentAddress(assignment) {
  const list = [];
  for (const d of assignment ?? []) {
    if (!Array.isArray(d.pages)) continue;
    if (EGRN_NAME.test(d.pages.slice(0, 2).join('\n')) && /выписк/iu.test(d.pages.slice(0, 2).join('\n'))) continue;
    const [a] = objectAddresses(d);
    if (!a) continue;
    const got = { ...a, name: d.name, what: assignmentWhat(d) };
    const i = list.findIndex((b) => sameAddress(b, got));
    if (i < 0) list.push(got);
    else if (Object.keys(got.got).length > Object.keys(list[i].got).length) list[i] = got;
  }
  return list.length === 1 ? list[0] : null;
}

function addressMatch(doc, ctx) {
  const mineText = clean(ctx.fields?.address);
  const egrn = ctx.egrn?.length ? egrnAddress(ctx.egrn, ctx) : null;
  const task = assignmentAddress(ctx.assignment);
  if (!mineText && !egrn && !task) return [];
  const mine = parseAddress(mineText);
  const mineWords = addrWords(mineText);
  // В заявке другой адрес, чем в выписке, — заказчик ошибся или выписка не на тот объект: подсказываем.
  const mineDiffers = egrn && mineText && !sameAddress(egrn, { got: mine, words: mineWords });
  // 2.277: адрес в задании на оценку — после выписки, раньше заявки (заявку пишет заказчик, задание подписано).
  const taskFrom = task && `${task.what} «${task.name}»`;
  const first = {}; // часть, которой нет ни в выписке, ни в заявке, → { value, page }
  const out = [];
  for (const { page: i, index, text, got, words } of objectAddresses(doc)) {
    const page = doc.pages[i];
    const diff = [];
    let against = null;
    for (const k of Object.keys(ADDR_NAMES)) {
      if (got[k] === undefined) continue;
      const ref = egrn?.got[k] !== undefined ? { value: egrn.got[k], egrn: true, words: egrn.words }
        : task?.got[k] !== undefined ? { value: task.got[k], task: true, words: task.words }
          : mine[k] !== undefined ? { value: mine[k], mine: true, words: mineWords } : first[k];
      if (!ref) { first[k] = { value: got[k], page: i, words }; continue; }
      if (samePart(k, got[k], words, ref.value, ref.words)) continue;
      if (ref.egrn) against = 'egrn';
      else if (ref.task && against !== 'egrn') against = 'task';
      else if (ref.mine && !against) against = 'mine';
      diff.push({ k, ref });
    }
    if (!diff.length) continue;
    const refName = (ref) => (ref.egrn ? 'в выписке' : ref.task ? task.what.replace(/^в письме заказчика$/u, 'в письме') : ref.mine ? 'в заявке' : `на стр. ${ref.page + 1}`);
    const parts = diff.map(({ k, ref }) => (Array.isArray(got[k]) ? ADDR_NAMES[k]
      : `${ADDR_NAMES[k]} ${got[k]}, а ${refName(ref)} ${ref.value}`)).join('; ');
    const where = against === 'egrn' ? `с адресом в выписке ЕГРН «${egrn.name}» (${egrn.text}, стр. ${egrn.page + 1})${mineDiffers ? `; в заявке — ${mineText}` : ''}`
      : against === 'task' ? `с адресом ${taskFrom} (${task.text}, стр. ${task.page + 1})`
        : against === 'mine' ? `с адресом из заявки (${mineText})` : `с адресом объекта на стр. ${diff[0].ref.page + 1}`;
    const fix = against === 'egrn' ? { bad: text, right: egrn.text } : against === 'task' ? { bad: text, right: task.text, from: taskFrom }
      : against === 'mine' ? { bad: text, right: mineText, from: MINE } : null;
    out.push({ page: i, quote: lineAround(page, index), egrn: against === 'egrn' ? egrnAt(egrn) : null, fix, text: `Адрес «${text}» не совпадает ${where}: ${parts} — проверьте, нет ли данных другого объекта` });
  }
  return out;
}

// ——— Недвижимость и земля (2.59): площадь, этаж и этажность, доля, категория земель и назначение — как в заявке ———
// Строки про аналоги, жилую площадь, кухню, балкон, застройку не трогаем; в отчёте о квартире — площадь участка и дома,
// в отчёте об участке — площадь построек.
// 2.174: «1200 +/- 12 кв. м» (погрешность из ЕГРН) — площадь 1200, не 12; «0,1200 га» — число целиком; «м 2» — разорванный «м²».
const AREA_UNIT = String.raw`кв\.?\s*м\.?|м2(?![\d,.])|м\s2(?![\d,.])|м²|квадратн\S*\s+метр\S*|га(?![а-яё])|гектар\S*|сот(?:ок|ки|ка|ых)?(?![а-яё])`;
const AREA_NUM = new RegExp(String.raw`(?<![\d,.])(\d{1,3}(?:[  ]\d{3})+|\d+)(?:[,.](\d{1,4}))?(?:\s*(?:±|\+\s*\/?\s*-)\s*\d+(?:[,.]\d+)?)?\s*(${AREA_UNIT})`, 'giu');
// 2.174: единица перед числом — столбец таблицы «Общая площадь, кв. м: 45,1» или «Площадь (кв. м) 45,1».
const AREA_HEAD = new RegExp(String.raw`(?<=площад[а-яё]*[^\n\d]{0,40}?[,(]\s*)(${AREA_UNIT})\)?\s*[:\-–—]?\s*(\d{1,3}(?:[  ]\d{3})+|\d+)(?:[,.](\d{1,4}))?(?![\d,./])`, 'giu');
// 2.174: части квартиры или дома — комнаты, санузел, коридор и т. п. — не площадь объекта.
const AREA_SKIP = /жил\S*\s+площад|кухн|балкон|лодж|застройк|комнат|санузл|ванн|туалет|коридор|прихож|холл|кладов|гардероб|подсобн|вспомогат|лестни|общего\s+пользован|террас|веранд|подвал|чердак|мансард/iu;
const ROOM_SKIP = /жил\S*\s+площад|кухн|балкон|лодж|застройк|санузл|ванн|туалет|коридор|прихож|холл|кладов|гардероб|подсобн|вспомогат|лестни|общего\s+пользован/iu;
const lineBefore = (page, index, len = 80) => { const b = page.slice(Math.max(0, index - len), index); return b.slice(b.lastIndexOf('\n') + 1); };
// 2.174: «…общей площадью» / «45,1 кв. м» — число в начале строки: «площадь» ищем и в строке выше.
function areaBefore(page, index) {
  const before = lineBefore(page, index);
  if (/[а-яёa-z]/iu.test(before)) return before;
  if (index - before.length === 0) return before;
  return `${lineBefore(page, index - before.length - 1)} ${before}`;
}
// Площади объекта на страницах документа (без аналогов, частей квартиры и чужих объектов — дома при участке и т. п.).
// Чужие объекты рядом с площадью: дом при участке, участок при доме или квартире, квартира при комнате.
function otherObject(ctx) {
  if (ctx.service === 'land') return /(?<![а-яё])дом|здани|строени|постройк|помещени/iu;
  if (ctx.fields?.object_type === 'house') return /участ/iu;
  return ctx.fields?.object_type === 'room' ? /участ|(?<![а-яё])дом(?:а|у|е)?(?![а-яё])|здани|квартир/iu : /участ|(?<![а-яё])дом(?:а|у|е)?(?![а-яё])|здани/iu;
}
function objectAreas(doc, ctx) {
  const other = otherObject(ctx);
  const skip = ctx.fields?.object_type === 'room' ? ROOM_SKIP : AREA_SKIP;
  const out = [];
  eachPage(doc, (page, i) => {
    const found = [];
    for (const m of page.matchAll(AREA_NUM)) found.push({ index: m.index, int: m[1], frac: m[2], unit: m[3] });
    for (const m of page.matchAll(AREA_HEAD)) found.push({ index: m.index, int: m[2], frac: m[3], unit: m[1], head: true });
    found.sort((a, b) => a.index - b.index);
    for (const f of found) {
      const before = areaBefore(page, f.index);
      const at = before.search(/площад(?!.*площад)/iu);
      // Ближайшая «площадь» перед числом: до 30 знаков перед ней (чья это площадь, но не дальше запятой или точки
      // перед ней — 2.174: «площадь кухни 8 кв. м, общая площадь 45,1» — 45,1 не кухня) и всё до числа.
      let pre = at < 0 ? '' : before.slice(Math.max(0, at - 30), at);
      const cut = Math.max(pre.lastIndexOf(';'), pre.search(/[,.]\s(?!.*[,.]\s)/u));
      if (cut >= 0) pre = pre.slice(cut + 1);
      const near = at < 0 ? '' : pre + before.slice(at);
      if (!near || other.test(near) || skip.test(near) || /аналог/iu.test(lineAround(page, f.index))) continue;
      const unit = f.unit.toLowerCase();
      const mult = /^га|^гектар/.test(unit) ? 10000 : /^сот/.test(unit) ? 100 : 1;
      out.push({ page: i, index: f.index, raw: `${f.int}${f.frac ? `,${f.frac}` : ''}`, v: Math.round(Number(`${f.int.replace(/[  ]/g, '')}.${f.frac ?? 0}`) * mult * 100) / 100 });
    }
  });
  return out;
}

// 2.202: площадь из выписки ЕГРН, приложенной к делу (ctx.egrn — ai-ops). Выписка на участок при оценке квартиры или дома
// (и наоборот) не в счёт; в выписках разные площади объекта — какая верная, решает эксперт: сверяем с заявкой, как раньше.
const EGRN_LAND = /вид\s+объекта(?:\s+недвижимости)?\s*[:\-–—]?\s*земельн/iu;
const EGRN_BUILT = /вид\s+объекта(?:\s+недвижимости)?\s*[:\-–—]?\s*(?:помещени|здани|сооружени|объект\s+незаверш|машино)/iu;
export function egrnArea(egrn, ctx) {
  const got = oneValue(egrnAreaValues(egrn, ctx));
  return got && got.v > 0 ? got : null;
}
function egrnAreaValues(egrn, ctx) {
  const land = ctx.service === 'land';
  const values = new Map();
  for (const d of egrn ?? []) {
    if (!Array.isArray(d.pages)) continue;
    const head = d.pages.slice(0, 2).join('\n');
    if (land ? EGRN_BUILT.test(head) && !EGRN_LAND.test(head) : EGRN_LAND.test(head) && !EGRN_BUILT.test(head)) continue;
    for (const a of objectAreas(d, ctx)) if (a.v > 0 && !values.has(a.v)) values.set(a.v, { name: d.name, page: a.page, doc: d.id, quote: lineAround(d.pages[a.page], a.index) });
  }
  return values;
}

// 2.211: площадь и кадастровый номер из выписок ЕГРН дела — для черновика заключения, теми же правилами, что в ИИ-проверке
// (2.202, 2.203). Каждое — { v, name, page }, когда в выписках оно одно; разные — { values: […] } (какое верное, решает
// эксперт); нет — null.
// 2.222: и этаж с этажностью (2.212), и адрес (2.213) — так же.
export function egrnFacts(egrn, ctx) {
  const pick = (values) => (values.size > 1 ? { values: [...values.keys()] } : oneValue(values));
  const { floors, totals } = egrnFloorValues(egrn, ctx);
  const addresses = egrnAddressValues(egrn, ctx);
  return {
    area: pick(egrnAreaValues(egrn, ctx)),
    cadastral: pick(egrnCadastralValues(egrn, ctx)),
    floor: pick(floors),
    floors: pick(totals),
    address: addresses.length > 1 ? { values: addresses.map((a) => a.text) } : addresses[0] ?? null,
  };
}

// 2.224: дата выписки ЕГРН — «02.10.2026 № КУВИ-001/…», «Дата формирования выписки: …», «Выписка сформирована …»,
// «Дата: …» в начале строки (цифрами или «2 октября 2026 г.»). «По состоянию на …» — дата кадастровой стоимости, не выписки.
// Ищем в первых двух страницах; нашли несколько — берём самую позднюю. Каждой выписке — { id, name, page, day: 'ГГГГ-ММ-ДД' }; без даты — не в списке.
const EGRN_DAY_AT = [
  /(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4})\s*(?:г(?:ода)?\.?)?\s*№\s*КУВИ/giu,
  /(?:дата\s+(?:формирования|выдачи|подготовки|составления)(?:\s+выписки)?|выписк\S*\s+(?:сформирован|выдан|подготовлен)\S*|^[^\S\n]*дата)[^\S\n]*[:\-–—]?[^\S\n]*(?:«\s*)?(\d{1,2})(?:\s*»)?(?:\.(\d{1,2})\.|[^\S\n]+([а-яё]+)[^\S\n]+)(\d{4})/gimu,
];
function egrnDayIn(text) {
  const days = [];
  for (const re of EGRN_DAY_AT) {
    for (const m of text.matchAll(re)) {
      let v = null;
      if (m.length === 4) v = ymd(m[3], m[2], m[1]);
      else if (m[2]) v = ymd(m[4], m[2], m[1]);
      else {
        const mi = MONTHS.findIndex((x, i) => (i === 4 ? /^ма[яй]$/iu.test(m[3]) : m[3].toLowerCase().startsWith(x)));
        if (mi >= 0) v = ymd(m[4], mi + 1, m[1]);
      }
      if (v) days.push(v);
    }
  }
  return days.sort().at(-1) ?? null;
}
// 2.230: выписки на сам объект оценки — для свежести (2.224). При оценке квартиры, комнаты, доли или нежилого помещения
// выписка на здание или участок не в счёт, при оценке дома — на помещение; вид не распознан — в счёт. Выписок на сам объект
// нет — судим по всем, как раньше.
const EGRN_KIND_AT = /вид\s+объекта(?:\s+недвижимости)?\s*[:\-–—]?\s*([а-яё-]+)/iu;
const PREMISES = ['flat', 'room', 'share', 'commercial'];
function egrnKind(d) {
  const m = (d.pages ?? []).slice(0, 2).join('\n').match(EGRN_KIND_AT);
  if (!m) return null;
  if (/^(?:помещени|машино)/iu.test(m[1])) return 'premises';
  if (/^(?:здани|сооружени|многоквартир|объект)/iu.test(m[1])) return 'building';
  return /^земельн/iu.test(m[1]) ? 'land' : null;
}
export function egrnOnObject(egrn, ctx) {
  const type = ctx?.fields?.object_type;
  if (ctx?.service !== 'realty' || !type) return egrn ?? [];
  const wrong = PREMISES.includes(type) ? ['building', 'land'] : type === 'house' ? ['premises'] : [];
  const mine = (egrn ?? []).filter((d) => !wrong.includes(egrnKind(d)));
  return mine.length ? mine : egrn ?? [];
}

export function egrnIssued(egrn) {
  const out = [];
  for (const d of egrn ?? []) {
    const pages = (d.pages ?? []).slice(0, 2);
    for (let i = 0; i < pages.length; i += 1) {
      const day = egrnDayIn(String(pages[i] ?? ''));
      if (day) { out.push({ id: d.id ?? null, name: d.name, page: i, day }); break; }
    }
  }
  return out;
}

// ——— 2.264: номер и дата выписки ЕГРН в отчёте (перечень документов, задание, приложения) — как у выписки в деле ———
// Номер — «КУВИ-001/2026-12345678» (тире и пробелы любые), дата — «от 02.10.2026» или «от 2 октября 2026 г.» в той же
// части строки (до «;»), либо «02.10.2026 № КУВИ-…». У выписки в деле — номер с первых двух страниц и дата по 2.224
// (`egrnIssued`). Номер в отчёте есть в деле — сверяется дата; нет в деле — находка «в деле такой нет». Выписка в отчёте без
// номера, но «Выписка из ЕГРН … от …» — дата должна быть у одной из выписок дела. Названия файлов в «…» не в счёт: в имени
// файла дата бывает любой. Выписки дела — все (и на здание, и на участок): в перечне документов отчёта бывают все.
const KUVI_AT = /КУВИ[^\S\n]*[-‐‑–—][^\S\n]*(\d{3})[^\S\n]*\/[^\S\n]*(\d{4})[^\S\n]*[-‐‑–—][^\S\n]*(\d{4,12})/giu;
const kuviNum = (m) => `КУВИ-${m[1]}/${m[2]}-${m[3]}`;
const EGRN_NAME = /(?:ЕГРН|ЕГРП|единого\s+государственного\s+реестра\s+(?:недвижимости|прав))/iu;
const DOC_DAY_AT = /(\d{1,2})\.(\d{1,2})\.(\d{4})|(\d{1,2})[^\S\n]+([а-яё]+)[^\S\n]+(\d{4})/giu;
const MONTHS_OF = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
function dayOfDoc(m) {
  if (m[1]) return ymd(m[3], m[2], m[1]);
  const mi = MONTHS.findIndex((x, i) => (i === 4 ? /^ма[яй]$/iu.test(m[5]) : m[5].toLowerCase().startsWith(x)));
  return mi >= 0 ? ymd(m[6], mi + 1, m[4]) : null;
}
// Дата в тексте — тем же видом, что в отчёте: «02.10.2026» или «2 октября 2026».
const dayLike = (day, raw) => {
  const [y, m, d] = day.split('-');
  return /^\d{1,2}\.\d/.test(raw) ? `${d}.${m}.${y}` : `${Number(d)} ${MONTHS_OF[Number(m) - 1]} ${y}`;
};
// Выписки дела: { num, day, name, page, doc, quote } — у кого нет ни номера, ни даты, те не в списке.
export function egrnRefs(egrn) {
  const issued = new Map(egrnIssued(egrn).map((x) => [x.id ?? x.name, x]));
  const out = [];
  for (const d of egrn ?? []) {
    const pages = (d.pages ?? []).slice(0, 2).map((p) => String(p ?? ''));
    let num = null;
    pages.some((page, i) => {
      const m = [...page.matchAll(KUVI_AT)][0];
      if (m) num = { num: kuviNum(m), page: i, quote: lineAround(page, m.index) };
      return !!m;
    });
    const got = issued.get(d.id ?? d.name);
    if (!num && !got) continue;
    const page = num?.page ?? got.page;
    out.push({ num: num?.num ?? null, day: got?.day ?? null, name: d.name, doc: d.id, page,
      quote: num?.quote ?? lineAround(pages[page], Math.max(0, pages[page].search(/выписк|дата/iu))) });
  }
  return out;
}
// Часть строки вокруг места: от «;» (или начала строки) до «;» (или конца строки); имена файлов в «…» — пробелами.
function partAround(page, index) {
  const start = Math.max(page.lastIndexOf('\n', index), page.lastIndexOf(';', index)) + 1;
  const ends = [page.indexOf('\n', index), page.indexOf(';', index)].filter((x) => x >= 0);
  const end = ends.length ? Math.min(...ends) : page.length;
  return { start, text: page.slice(start, end).replace(/«[^»\n]*»/g, (s) => ' '.repeat(s.length)) };
}
function dayIn(part, start) {
  for (const m of part.matchAll(DOC_DAY_AT)) {
    const day = dayOfDoc(m);
    if (day) return { day, raw: m[0], index: start + m.index };
  }
  return null;
}
function egrnDocMatch(doc, ctx) {
  const refs = egrnRefs(ctx.egrn);
  if (!refs.length) return [];
  const numbered = refs.filter((r) => r.num);
  const days = [...new Set(refs.map((r) => r.day).filter(Boolean))];
  const out = [];
  const seen = new Set();
  const inCase = (r) => `${r.num ? `№ ${r.num}` : ''}${r.num && r.day ? ' ' : ''}${r.day ? `от ${ruDate(r.day)}` : ''} («${r.name}», стр. ${r.page + 1})`;
  eachPage(doc, (page, i) => {
    const withNum = new Set();
    for (const m of page.matchAll(KUVI_AT)) {
      const num = kuviNum(m);
      const part = partAround(page, m.index);
      withNum.add(part.start);
      if (seen.has(num)) continue;
      seen.add(num);
      const ref = refs.find((r) => r.num === num);
      if (!ref) {
        if (!numbered.length) continue;
        const one = numbered.length === 1 ? numbered[0] : null;
        out.push({ page: i, quote: lineAround(page, m.index), egrn: one ? egrnAt(one) : null, ...(one ? { fix: { bad: m[0], right: one.num } } : {}),
          text: `Выписка ЕГРН № ${num} в отчёте — в деле такой нет; в деле — ${numbered.map(inCase).join(', ')} — проверьте, не номер ли это старой выписки или другого объекта` });
        continue;
      }
      const got = ref.day && dayIn(part.text, part.start);
      if (!got || got.day === ref.day) continue;
      out.push({ page: i, quote: lineAround(page, m.index), egrn: egrnAt(ref), fix: { bad: got.raw, right: dayLike(ref.day, got.raw) },
        text: `Дата выписки ЕГРН № ${num} в отчёте — ${ruDate(got.day)}, а у этой выписки в деле — ${ruDate(ref.day)} («${ref.name}», стр. ${ref.page + 1}) — проверьте перечень документов` });
    }
    // Выписка без номера: «Выписка из ЕГРН … от …».
    if (!days.length) return;
    for (const m of page.matchAll(/выписк\S*/giu)) {
      const part = partAround(page, m.index);
      if (withNum.has(part.start) || !EGRN_NAME.test(part.text)) continue;
      const after = part.text.slice(m.index - part.start);
      const at = after.match(/(?<![а-яё])от[^\S\n]+/iu);
      if (!at) continue;
      const got = dayIn(after.slice(at.index), m.index + at.index);
      if (!got || got.index !== m.index + at.index + at[0].length || days.includes(got.day) || seen.has(got.day)) continue;
      seen.add(got.day);
      const dated = refs.filter((r) => r.day);
      const one = days.length === 1 ? dated[0] : null;
      out.push({ page: i, quote: lineAround(page, m.index), egrn: one ? egrnAt(one) : null, ...(one ? { fix: { bad: got.raw, right: dayLike(one.day, got.raw) } } : {}),
        text: `Выписка ЕГРН от ${ruDate(got.day)} в отчёте — в деле выписки от этого числа нет; в деле — ${dated.map(inCase).join(', ')} — проверьте перечень документов` });
    }
  });
  return out;
}

function areaMatch(doc, ctx) {
  const mine = Number(String(ctx.fields?.area ?? '').replace(',', '.'));
  const egrn = ctx.egrn?.length ? egrnArea(ctx.egrn, ctx) : null;
  const ref = egrn ? egrn.v : mine;
  if (!(ref > 0)) return [];
  // В заявке другая площадь — заказчик ошибся или выписка не на тот объект: подсказываем один раз, у первой площади.
  const differs = egrn && mine > 0 && Math.abs(mine - egrn.v) >= 0.05;
  const out = [];
  const seen = new Set();
  for (const a of objectAreas(doc, ctx)) {
    if (Math.abs(a.v - ref) < 0.05 || seen.has(a.v)) continue;
    seen.add(a.v);
    const page = doc.pages[a.page];
    out.push({ page: a.page, quote: lineAround(page, a.index), egrn: egrnAt(egrn), fix: egrn ? { bad: a.raw, right: fmt(egrn.v) } : { bad: a.raw, right: fmt(mine), from: MINE }, text: egrn
      ? `Площадь ${fmt(a.v)} кв. м не совпадает с площадью в выписке ЕГРН «${egrn.name}» (${fmt(egrn.v)} кв. м, стр. ${egrn.page + 1})${differs ? `; в заявке — ${fmt(mine)} кв. м` : ''} — площадь берётся из выписки`
      : `Площадь ${fmt(a.v)} кв. м не совпадает с площадью из заявки (${fmt(mine)} кв. м) — проверьте, нет ли данных другого объекта` });
  }
  return out;
}

// 2.378: площадь объекта одна во всём отчёте — в описании, расчёте и итоге. Расчёт — строка с умножением и рублями
// («150 000 руб./кв. м × 45,1 кв. м = 6 765 000 руб.»): «площади» рядом с числом там нет, area_match его не видит.
// Есть выписка ЕГРН или площадь в заявке — сверяем с ней только площадь в расчёте (остальное — area_match); нет — все
// площади объекта с первой, в описании объекта.
const CALC_LINE = /[×*]|\s[xх]\s|умнож/iu;
function calcAreas(doc, ctx) {
  const other = otherObject(ctx);
  const skip = ctx.fields?.object_type === 'room' ? ROOM_SKIP : AREA_SKIP;
  const out = [];
  eachPage(doc, (page, i) => {
    for (const m of page.matchAll(AREA_NUM)) {
      const line = lineAround(page, m.index);
      if (!CALC_LINE.test(line) || !/руб/iu.test(line) || /аналог/iu.test(line) || skip.test(line) || other.test(line)) continue;
      // Рядом «площадь» — это число уже видит objectAreas.
      if (/площад/iu.test(lineBefore(page, m.index))) continue;
      const unit = m[3].toLowerCase();
      const mult = /^га|^гектар/.test(unit) ? 10000 : /^сот/.test(unit) ? 100 : 1;
      out.push({ page: i, index: m.index, raw: `${m[1]}${m[2] ? `,${m[2]}` : ''}`, v: Math.round(Number(`${m[1].replace(/[  ]/g, '')}.${m[2] ?? 0}`) * mult * 100) / 100, calc: true });
    }
  });
  return out;
}
function areaSame(doc, ctx) {
  const mine = Number(String(ctx.fields?.area ?? '').replace(',', '.'));
  const egrn = ctx.egrn?.length ? egrnArea(ctx.egrn, ctx) : null;
  const ref = egrn ? egrn.v : mine > 0 ? mine : null;
  const calc = calcAreas(doc, ctx);
  const out = [];
  const seen = new Set();
  if (ref) {
    for (const a of calc) {
      if (Math.abs(a.v - ref) < 0.05 || seen.has(a.v)) continue;
      seen.add(a.v);
      out.push({ page: a.page, quote: lineAround(doc.pages[a.page], a.index), egrn: egrnAt(egrn), fix: egrn ? { bad: a.raw, right: fmt(egrn.v) } : { bad: a.raw, right: fmt(mine), from: MINE },
        text: `В расчёте площадь ${fmt(a.v)} кв. м, а площадь объекта ${egrn ? `в выписке ЕГРН «${egrn.name}»` : 'в заявке'} — ${fmt(ref)} кв. м — пересчитайте стоимость с верной площадью` });
    }
    return out;
  }
  const described = objectAreas(doc, ctx);
  const main = described[0];
  if (!main) return [];
  const all = [...described, ...calc.filter((c) => !described.some((d) => d.page === c.page && d.index === c.index))]
    .sort((a, b) => a.page - b.page || a.index - b.index);
  for (const a of all) {
    if (Math.abs(a.v - main.v) < 0.05 || seen.has(a.v)) continue;
    seen.add(a.v);
    out.push({ page: a.page, quote: lineAround(doc.pages[a.page], a.index), fix: { bad: a.raw, right: fmt(main.v), from: 'в описании объекта' },
      text: `${a.calc ? 'В расчёте площадь' : 'Площадь'} ${fmt(a.v)} кв. м, а в описании объекта — ${fmt(main.v)} кв. м (стр. ${main.page + 1}) — площадь объекта должна быть одной во всём отчёте` });
  }
  return out;
}

// Этаж объекта; вторая группа, если есть, — этажей в доме: «этаж/этажность: 3/9», «на 3 этаже из 9», «этаж 3 из 9»,
// «Этаж: 3/9», «3/9 эт.» (2.187).
const FLOOR_AT = [
  /этаж\s*\/\s*этаж(?:ност\S*|ей)[^\d\n]{0,20}?(\d{1,3})\s*\/\s*(\d{1,3})/giu,
  /(?<![\d/])(\d{1,3})(?:-?(?:м|ом|й))?[^\S\n]+этаж(?:е|у)?(?![а-яё])(?:\s*(?:из|\/)\s*(\d{1,3})(?![\d/,.]\d))?/giu,
  /(?<![а-яё])этаж(?:е|\s+расположения)?\s*[:\-–—]?\s*(\d{1,3})(?:\s*(?:\/|из)\s*(\d{1,3}))?(?![\d/]|-|\s*этажн)/giu,
  /(?<![\d/,.])(\d{1,3})\s*\/\s*(\d{1,3})\s*эт(?:\.|аж(?:е|а)?(?![а-яё]))/giu,
];
const FLOORS_AT = [
  /(?<![\d/])(\d{1,3})(?:-?(?:ти|х|ми))?[-\t ]?этажн/giu,
  /(?<!этаж\s*\/\s*)этажност\S*(?:\s+(?:дома|здания))?\s*[:\-–—]?\s*(\d{1,3})(?![\d/])/giu,
  /(?<!этаж\s*\/\s*)(?:всего\s+)?этажей(?:\s+в\s+(?:доме|здании))?\s*[:\-–—]\s*(\d{1,3})(?![\d/])/giu,
  /(?<![\d/])(\d{1,3})[^\S\n]+этаж(?:а|ей)(?![а-яё])/giu,
];
// Не про объект: этаж аналога, магазин или нежилые помещения на первом этаже дома; подземные этажи — не этажность.
const FLOOR_OTHER = /аналог|магазин|нежил|коммерч|офис/iu;
// Заявка: «5 / 9», «5/9», «5 из 9», «5 этаж из 9», «5».
export function parseFloorField(value) {
  const f = String(value ?? '').match(/^\s*(-?\d{1,3})(?:\s*(?:-?(?:й|м|ом))?\s*(?:этаж\S*\s*)?(?:\/|из)\s*(\d{1,3}))?/iu);
  return f ? { floor: Number(f[1]), floors: f[2] ? Number(f[2]) : null } : null;
}
// 2.212: этаж помещения и этажность здания из выписок ЕГРН дела (ctx.egrn — ai-ops), как площадь (2.202). Выписка на
// участок не в счёт. Этаж — «Номер, тип этажа, на котором расположено помещение: Этаж № 3», «Номер этажа: 3»; помещение на
// двух этажах (в выписке разные этажи) — этаж не берём. Этажность — «Количество этажей, в том числе подземных этажей: 10,
// в том числе подземных 1»: в отчёте обычно пишут надземные (9) — годится и то, и другое число.
const EGRN_FLOOR_AT = [
  /номер,?\s*(?:тип\s+)?этажа[^:\n]{0,80}:\s*(?:этаж\s*)?№?\s*(\d{1,3})(?!\d|[,.]\d)/giu,
  /(?<![а-яё])этаж\s*№\s*(\d{1,3})(?!\d|[,.]\d)/giu,
];
const EGRN_FLOORS_AT = /количество\s+этажей[^:\n]{0,60}:\s*(\d{1,3})(?!\d|[,.]\d)([^\n]*)/giu;
function egrnFloorValues(egrn, ctx) {
  const floors = new Map();
  const totals = new Map();
  if (ctx.service === 'land') return { floors, totals };
  for (const d of egrn ?? []) {
    if (!Array.isArray(d.pages)) continue;
    const head = d.pages.slice(0, 2).join('\n');
    if (EGRN_LAND.test(head) && !EGRN_BUILT.test(head)) continue;
    const mine = new Map();
    d.pages.forEach((page, i) => {
      for (const re of EGRN_FLOOR_AT) {
        for (const m of page.matchAll(re)) {
          if (/аналог|машино-мест\S*\s+в\s+здани/iu.test(lineBefore(page, m.index))) continue;
          if (!mine.has(Number(m[1]))) mine.set(Number(m[1]), { page: i, quote: lineAround(page, m.index) });
        }
      }
      for (const m of page.matchAll(EGRN_FLOORS_AT)) {
        const total = Number(m[1]);
        const under = m[2].match(/подземн\S*(?:\s+этаж\S*)?\s*[:\-–—]?\s*(\d{1,3})(?!\d|[,.]\d)/iu);
        const above = under && Number(under[1]) > 0 && Number(under[1]) < total ? total - Number(under[1]) : null;
        if (total > 0 && !totals.has(total)) totals.set(total, { name: d.name, page: i, above, doc: d.id, quote: lineAround(page, m.index) });
      }
    });
    if (mine.size === 1) {
      const [[v, at]] = [...mine];
      if (!floors.has(v)) floors.set(v, { name: d.name, doc: d.id, ...at });
    }
  }
  return { floors, totals };
}
export function egrnFloor(egrn, ctx) {
  const { floors, totals } = egrnFloorValues(egrn, ctx);
  return { floor: oneValue(floors), floors: oneValue(totals) };
}

function floorMatch(doc, ctx) {
  const f = parseFloorField(ctx.fields?.floor);
  const egrn = ctx.egrn?.length ? egrnFloor(ctx.egrn, ctx) : { floor: null, floors: null };
  if (!f && !egrn.floor && !egrn.floors) return [];
  const mineFloor = f?.floor ?? null;
  const mineFloors = f?.floors ?? null;
  const refFloor = egrn.floor ? egrn.floor.v : mineFloor;
  const refFloors = egrn.floors ? egrn.floors.v : mineFloors;
  const floorsOk = (v) => v === refFloors || (egrn.floors?.above != null && v === egrn.floors.above);
  const out = [];
  const seen = new Set();
  const add = (i, page, idx, key, text, at, fix) => { if (seen.has(key)) return; seen.add(key); out.push({ page: i, quote: lineAround(page, idx), egrn: egrnAt(at), fix: at ? fix : { ...fix, from: MINE }, text }); };
  // В заявке другое — заказчик ошибся или выписка не на тот объект: подсказываем.
  const floorText = (v) => (egrn.floor
    ? `Этаж ${v} не совпадает с этажом в выписке ЕГРН «${egrn.floor.name}» (${refFloor}, стр. ${egrn.floor.page + 1})${mineFloor != null && mineFloor !== refFloor ? `; в заявке — ${mineFloor}` : ''} — проверьте, нет ли данных другого объекта`
    : `Этаж ${v} не совпадает с этажом из заявки (${mineFloor}) — проверьте, нет ли данных другого объекта`);
  const floorsText = (v) => {
    if (!egrn.floors) return `Этажей в доме ${v}, а в заявке ${mineFloors} — проверьте, нет ли данных другого дома`;
    const { name, page, above } = egrn.floors;
    const shown = above != null ? `${refFloors}, из них надземных ${above}` : `${refFloors}`;
    const differs = mineFloors && mineFloors !== refFloors && mineFloors !== above;
    return `Этажей в доме ${v}, а в выписке ЕГРН «${name}» — ${shown} (стр. ${page + 1})${differs ? `; в заявке — ${mineFloors}` : ''} — проверьте, нет ли данных другого дома`;
  };
  eachPage(doc, (page, i) => {
    for (const re of FLOOR_AT) {
      for (const m of page.matchAll(re)) {
        if (FLOOR_OTHER.test(lineAround(page, m.index))) continue;
        const v = Number(m[1]);
        if (refFloor != null && v !== refFloor) add(i, page, m.index, `f${v}`, floorText(v), egrn.floor, { bad: String(v), right: String(refFloor) });
        if (m[2] && refFloors && !floorsOk(Number(m[2]))) add(i, page, m.index, `n${m[2]}`, floorsText(m[2]), egrn.floors, { bad: m[2], right: String(refFloors) });
      }
    }
    if (!refFloors) return;
    for (const re of FLOORS_AT) {
      for (const m of page.matchAll(re)) {
        if (/аналог/iu.test(lineAround(page, m.index)) || /подземн|цокол/iu.test(page.slice(Math.max(0, m.index - 25), m.index + m[0].length))) continue;
        const v = Number(m[1]);
        if (!floorsOk(v)) add(i, page, m.index, `n${v}`, floorsText(v), egrn.floors, { bad: String(v), right: String(refFloors) });
      }
    }
  });
  return out;
}

// 2.223: год постройки и материал стен дома в отчёте — как в выписке ЕГРН на здание из дела (ctx.egrn — ai-ops), как этаж
// (2.212); выписки на участок не в счёт. В выписке бывают и «Год ввода в эксплуатацию», и «Год завершения строительства» —
// годится любой. Выписки спорят между собой — какая верная, решает эксперт: год сверяем с заявкой, материал — не сверяем.
const EGRN_YEAR_AT = /год\s+(?:ввода\s+в\s+эксплуатацию(?:\s+по\s+завершени\S*\s+строительства)?|завершения\s+строительства)\s*[:\-–—]?\s*(\d{4})(?!\d)/giu;
const EGRN_WALLS_AT = /материал\s+(?:наружных\s+)?стен\S*[^:\n]{0,30}:\s*([^\n]{3,60})/giu;
const YEAR_AT = [
  /(?<![а-яё])год\S*\s+(?:постройки|постр\.|ввода\s+(?:дома\s+|здания\s+)?в\s+эксплуатацию|завершения\s+строительства|строительства)(?:\s+(?:дома|здания))?\s*[:\-–—]?\s*(\d{4})(?!\d)/giu,
  /(?<![\d/.,])(\d{4})\s*(?:г\.?|года?)?\s+постройки/giu,
  /(?<![а-яё])(?:построен|введ[её]н)\S*(?:\s+в\s+эксплуатацию)?\s+в\s+(\d{4})(?!\d)/giu,
];
const WALLS_AT = [
  /материал\S*\s+(?:наружных\s+)?стен\S*(?:\s+(?:дома|здания))?\s*[:\-–—]?\s*([^\n;.]{3,60})/giu,
  // Просто «Стены: обои, панели ПВХ» — отделка квартиры, не материал дома.
  /(?<![а-яё])(?:наружные\s+стены(?:\s+(?:дома|здания))?|стены\s+(?:дома|здания))\s*[:\-–—]\s*([^\n;.]{3,60})/giu,
  /(?<![а-яё])тип\s+(?:дома|здания)\s*[:\-–—]?\s*([^\n;.]{3,40})/giu,
  /(?<![а-яё-])((?:[а-яё]+-)?(?:кирпичн|крупнопанельн|панельн|монолитн|блочн|деревянн|бревенчат)\S*\s+(?:(?:\d+-?)?(?:много|мало)?(?:квартирн|этажн|жил|секционн|подъездн)\S*\s+){0,2}(?:дом|здани)[а-яё]*)/giu,
];
// Класс материала: «кирпичный дом» и «Кирпичные» — одно; «монолитно-кирпичный» сходится и с кирпичом, и с монолитом;
// «Смешанные», «Прочие» — не сверяем.
const WALL_KIND = [
  ['brick', /кирпич|камен/iu],
  ['panel', /панел|железобетон|ж\/б/iu],
  ['monolith', /монолит|железобетон|ж\/б/iu],
  ['block', /бло(?:к|ч)|газобетон|пенобетон|газосиликат|керамзитобетон|шлакобло|камен/iu],
  ['wood', /дерев|брус|бр[её]в(?:е|н)|каркасн|щитов/iu],
  ['metal', /металл/iu],
];
function wallKinds(text) {
  return new Set(WALL_KIND.filter(([, re]) => re.test(text)).map(([id]) => id));
}
const overlap = (a, b) => [...a].some((x) => b.has(x));
function egrnBuilding(egrn, ctx) {
  const out = { years: null, walls: null };
  if (ctx.service === 'land') return out;
  let years = null;
  let walls = null;
  let yearsBad = false;
  let wallsBad = false;
  for (const d of egrn ?? []) {
    if (!Array.isArray(d.pages)) continue;
    const head = d.pages.slice(0, 2).join('\n');
    if (EGRN_LAND.test(head) && !EGRN_BUILT.test(head)) continue;
    const ys = new Map();
    let w = null;
    d.pages.forEach((page, i) => {
      for (const m of page.matchAll(EGRN_YEAR_AT)) {
        if (!ys.has(Number(m[1]))) ys.set(Number(m[1]), { name: d.name, doc: d.id, page: i, quote: lineAround(page, m.index) });
      }
      for (const m of page.matchAll(EGRN_WALLS_AT)) {
        const kinds = wallKinds(m[1]);
        if (!w && kinds.size) w = { v: clean(m[1]), kinds, name: d.name, doc: d.id, page: i, quote: lineAround(page, m.index) };
      }
    });
    if (ys.size) {
      if (!years) years = ys;
      else if (![...ys.keys()].some((y) => years.has(y))) yearsBad = true;
      else for (const [y, at] of ys) if (!years.has(y)) years.set(y, at);
    }
    if (w) {
      if (!walls) walls = w;
      else if (!overlap(walls.kinds, w.kinds)) wallsBad = true;
    }
  }
  if (years && !yearsBad) out.years = years;
  if (walls && !wallsBad) out.walls = walls;
  return out;
}

function buildingMatch(doc, ctx) {
  if (ctx.service !== 'realty') return [];
  const typed = Number(ctx.fields?.year_built);
  const mine = Number.isInteger(typed) && typed > 0 ? typed : null;
  const egrn = ctx.egrn?.length ? egrnBuilding(ctx.egrn, ctx) : { years: null, walls: null };
  if (!mine && !egrn.years && !egrn.walls) return [];
  const yearAt = egrn.years ? [...egrn.years.values()][0] : null;
  const refYears = egrn.years ? [...egrn.years.keys()] : mine ? [mine] : [];
  const out = [];
  const seen = new Set();
  const add = (i, page, idx, key, text, at, fix) => { if (seen.has(key)) return; seen.add(key); out.push({ page: i, quote: lineAround(page, idx), egrn: egrnAt(at), fix: at ? fix : { ...fix, from: MINE }, text }); };
  const yearText = (v) => {
    if (!egrn.years) return `Год постройки ${v} не совпадает с годом из заявки (${mine}) — проверьте, нет ли данных другого дома`;
    const shown = refYears.join(' и ');
    const differs = mine && !refYears.includes(mine);
    return `Год постройки ${v} не совпадает с выпиской ЕГРН «${yearAt.name}» (${shown}, стр. ${yearAt.page + 1})${differs ? `; в заявке — ${mine}` : ''} — проверьте, нет ли данных другого дома`;
  };
  eachPage(doc, (page, i) => {
    if (refYears.length) {
      for (const re of YEAR_AT) {
        for (const m of page.matchAll(re)) {
          const line = lineAround(page, m.index);
          if (/аналог|капитальн\S*\s+ремонт|реконструкц/iu.test(line)) continue;
          // Строка таблицы аналогов: «Год постройки 1975 1980 1990» — не про объект.
          const end = m.index + m[0].length;
          if (/^[\s|;\t]*\d{4}(?!\d)/.test(page.slice(end, page.indexOf('\n', end) < 0 ? undefined : page.indexOf('\n', end)))) continue;
          const v = Number(m[1]);
          if (v < 1700 || v > 2100 || refYears.includes(v)) continue;
          add(i, page, m.index, `y${v}`, yearText(v), yearAt, { bad: String(v), right: refYears.join(' или ') });
        }
      }
    }
    if (egrn.walls) {
      for (const re of WALLS_AT) {
        for (const m of page.matchAll(re)) {
          if (/аналог/iu.test(lineAround(page, m.index))) continue;
          const raw = clean(m[1].split(',')[0]);
          const kinds = wallKinds(raw);
          if (!kinds.size || overlap(kinds, egrn.walls.kinds)) continue;
          const { v, name, page: p } = egrn.walls;
          add(i, page, m.index, `w${[...kinds].sort().join()}`, `Материал стен «${raw}» не совпадает с выпиской ЕГРН «${name}» («${v}», стр. ${p + 1}) — проверьте, нет ли данных другого дома`, egrn.walls, { bad: raw, right: v });
        }
      }
    }
  });
  return out;
}

// ——— 2.259: назначение объекта (жилое / нежилое) в отчёте — как в выписке ЕГРН на объект из дела ———
// В выписке на помещение — «Назначение помещения: Жилое помещение» / «Нежилое помещение», на здание — «Назначение: Жилой
// дом» / «Нежилое здание» / «Многоквартирный дом» (это жилое). При оценке помещения назначение здания не в счёт (нежилое
// помещение бывает в жилом доме), при оценке дома — назначение помещений. Выписки спорят — молчим. Без выписки — как в
// заявке: «Нежилое помещение» — нежилое, квартира, комната, доля, жилой дом — жилое. В отчёте — «Назначение …: …» и
// «Объект оценки: … нежилое помещение»; аналоги, соседи, первый этаж дома — не про объект.
const USE_WORD = '(нежил\\S*|(?<![а-яё])жил(?:ое|ой|ая|ого|ым|ом|ые|ых)(?![а-яё])|многоквартирн\\S*)';
const EGRN_USE_AT = new RegExp(`назначени\\S*(?:\\s+(объекта(?:\\s+недвижимости)?|помещени\\S*|здани\\S*|дома))?\\s*[:\\-–—]?\\s*${USE_WORD}`, 'giu');
const USE_AT = [
  EGRN_USE_AT,
  new RegExp(`(?:объект\\S*\\s+оценки|вид\\s+объекта|тип\\s+объекта|наименование\\s+объекта)\\s*[:\\-–—]?[^\\n:]{0,60}?${USE_WORD}\\s+(помещени|здани|дом)`, 'giu'),
];
const USE_SKIP = /аналог|сосед|прежн|перв\S*\s+этаж\S*\s+(?:дома|здания)|в\s+(?:доме|здании)\s+(?:имеются|расположен)/iu;
const useKind = (word) => (/^нежил/iu.test(word) ? 'non' : 'living');
export const USE_NAME = { non: 'нежилое', living: 'жилое' };
// «Нежилое» ↔ «жилое» в той же форме и с той же заглавной — для «Исправить в черновике»; «многоквартирный» не меняем.
function useSwap(word) {
  if (/^многоквартирн/iu.test(word)) return null;
  if (/^нежил/iu.test(word)) { const rest = word.slice(2); return /^Н/u.test(word) ? rest[0].toUpperCase() + rest.slice(1) : rest; }
  return /^Ж/u.test(word) ? `Не${word[0].toLowerCase()}${word.slice(1)}` : `не${word}`;
}
// Чьё назначение в строке: 'building' (здание, дом), 'premises' (помещение) или null (не сказано).
function useOf(qual, word) {
  if (/^многоквартирн/iu.test(word) || /^(?:здани|дом)/iu.test(qual ?? '')) return 'building';
  return /^помещени/iu.test(qual ?? '') ? 'premises' : null;
}
export function egrnUse(egrn, ctx) {
  const values = egrnUses(egrn, ctx);
  return values ? oneValue(values) : null;
}
// 2.261: все назначения из выписок на объект ('living' / 'non') — черновику: одно — в таблицу задания, разные — выбрать эксперту.
export function egrnUses(egrn, ctx) {
  if (ctx.service !== 'realty') return null;
  const house = ctx.fields?.object_type === 'house';
  const values = new Map();
  for (const d of egrnOnObject(egrn, ctx)) {
    if (!Array.isArray(d.pages)) continue;
    const head = d.pages.slice(0, 2).join('\n');
    if (EGRN_LAND.test(head) && !EGRN_BUILT.test(head)) continue;
    d.pages.forEach((page, i) => {
      for (const m of page.matchAll(EGRN_USE_AT)) {
        const of = useOf(m[1], m[2]);
        if (house ? of === 'premises' : of === 'building') continue;
        if (/аналог/iu.test(lineBefore(page, m.index))) continue;
        const line = lineAround(page, m.index);
        const kind = useKind(m[2]);
        if (!values.has(kind)) values.set(kind, { name: d.name, page: i, doc: d.id, quote: line, word: clean(page.slice(m.index + m[0].length - m[2].length).split('\n')[0]).slice(0, 40) });
      }
    });
  }
  return values;
}
function useMatch(doc, ctx) {
  if (ctx.service !== 'realty') return [];
  const type = ctx.fields?.object_type;
  const mine = type === 'commercial' ? 'non' : type ? 'living' : null;
  const egrn = ctx.egrn?.length ? egrnUse(ctx.egrn, ctx) : null;
  const ref = egrn ? egrn.v : mine;
  if (!ref) return [];
  const house = type === 'house';
  const out = [];
  const seen = new Set();
  eachPage(doc, (page, i) => {
    for (const re of USE_AT) {
      for (const m of page.matchAll(re)) {
        const qual = re === EGRN_USE_AT ? m[1] : m[3];
        const word = re === EGRN_USE_AT ? m[2] : m[1];
        const of = useOf(qual, word);
        if (house ? of === 'premises' : of === 'building') continue;
        const line = lineAround(page, m.index);
        const kind = useKind(word);
        if (kind === ref || USE_SKIP.test(line) || seen.has(kind)) continue;
        seen.add(kind);
        const swap = useSwap(word);
        const fix = swap ? { bad: word, right: swap, flip: 'не' } : null;
        const what = house ? 'дома' : 'помещения';
        out.push({ page: i, quote: line, egrn: egrnAt(egrn), ...(fix ? { fix: egrn ? fix : { ...fix, from: MINE } } : {}),
          text: egrn
            ? `Назначение ${what} «${USE_NAME[kind]}» не совпадает с выпиской ЕГРН «${egrn.name}» («${egrn.word}», стр. ${egrn.page + 1})${mine && mine !== egrn.v ? `; в заявке — ${USE_NAME[mine]}` : ''} — проверьте, нет ли данных другого объекта`
            : `Назначение ${what} «${USE_NAME[kind]}» не совпадает с заявкой (${USE_NAME[mine]}) — проверьте, нет ли данных другого объекта` });
      }
    }
  });
  return out;
}

// ——— 2.267: вид жилого помещения (квартира / комната) в отчёте — как в выписке ЕГРН на объект из дела ———
// В выписке на помещение — «Вид жилого помещения: Квартира» / «Комната» (бывает «Наименование: Комната»). В отчёте — только
// подписи про сам объект: «Вид жилого помещения: …», «Наименование объекта: …», «Объект оценки: …» — первое слово
// «квартира» или «комната» после подписи («комната в трёхкомнатной квартире» — комната; «двухкомнатная квартира» —
// квартира). Комнаты в описании квартиры, аналоги, соседи — не в счёт. Выписки спорят — молчим. Без выписки — как в заявке
// («Квартира» / «Комната»; доля, дом, нежилое — не сверяем). Исправить в черновике — «квартира» ↔ «комната» в той же форме.
const ROOM_KIND_WORD = '(?<![а-яё])(квартир(?:а|ы|у|е|ой|ою)?|комнат(?:а|ы|у|е|ой|ою)?)(?![а-яё])';
const EGRN_KIND_LIVING_AT = new RegExp(`(?:вид\\s+жилого\\s+помещения|наименование(?:\\s+(?:объекта|помещения))?)\\s*[:\\-–—]\\s*${ROOM_KIND_WORD}`, 'giu');
const ROOM_KIND_AT = new RegExp(`(?:вид\\s+жилого\\s+помещения|наименование\\s+объекта(?:\\s+оценки)?|объект\\S*\\s+оценки)\\s*[:\\-–—]([^\\n:]{0,60}?)${ROOM_KIND_WORD}(?!\\s*[:\\-–—]?\\s*\\d)`, 'giu');
const ROOM_KIND_SKIP = /аналог|сосед|прежн/iu;
const roomKind = (word) => (/^комнат/iu.test(word) ? 'room' : 'flat');
export const ROOM_KIND_NAME = { flat: 'квартира', room: 'комната' };
export function egrnRoomKind(egrn, ctx) {
  if (ctx.service !== 'realty' || !['flat', 'room', 'share'].includes(ctx.fields?.object_type)) return null;
  const values = new Map();
  for (const d of egrnOnObject(egrn, ctx)) {
    if (!Array.isArray(d.pages) || egrnKind(d) === 'building' || egrnKind(d) === 'land') continue;
    d.pages.forEach((page, i) => {
      for (const m of page.matchAll(EGRN_KIND_LIVING_AT)) {
        if (/аналог/iu.test(lineBefore(page, m.index))) continue;
        const kind = roomKind(m[1]);
        if (!values.has(kind)) values.set(kind, { name: d.name, page: i, doc: d.id, quote: lineAround(page, m.index), word: m[1] });
      }
    });
  }
  return oneValue(values);
}
function roomKindMatch(doc, ctx) {
  if (ctx.service !== 'realty') return [];
  const type = ctx.fields?.object_type;
  if (!['flat', 'room', 'share'].includes(type)) return [];
  const mine = type === 'share' ? null : type;
  const egrn = ctx.egrn?.length ? egrnRoomKind(ctx.egrn, ctx) : null;
  const ref = egrn ? egrn.v : mine;
  if (!ref) return [];
  const out = [];
  const seen = new Set();
  eachPage(doc, (page, i) => {
    for (const m of page.matchAll(ROOM_KIND_AT)) {
      // Между подписью и словом — не другое слово-объект («объект оценки: доля … в квартире» — ещё объект, «аналог» — нет).
      if (/(?<![а-яё])(?:дом|здани|участ)|состав|колич|числ|план/iu.test(m[1])) continue;
      const line = lineAround(page, m.index);
      const word = m[2];
      const kind = roomKind(word);
      if (kind === ref || ROOM_KIND_SKIP.test(line) || seen.has(kind)) continue;
      seen.add(kind);
      const fix = { bad: word, right: ROOM_KIND_NAME[ref], flip: 'kind' };
      out.push({ page: i, quote: line, egrn: egrnAt(egrn), fix: egrn ? fix : { ...fix, from: MINE },
        text: egrn
          ? `Вид жилого помещения «${ROOM_KIND_NAME[kind]}» не совпадает с выпиской ЕГРН «${egrn.name}» («${egrn.word}», стр. ${egrn.page + 1})${mine && mine !== egrn.v ? `; в заявке — ${ROOM_KIND_NAME[mine]}` : ''} — проверьте, нет ли данных другого объекта`
          : `Вид жилого помещения «${ROOM_KIND_NAME[kind]}» не совпадает с заявкой (${ROOM_KIND_NAME[mine]}) — проверьте, нет ли данных другого объекта` });
    }
  });
  return out;
}

// ——— 2.233: кадастровая стоимость в отчёте — как в выписке ЕГРН из дела ———
// В выписке: «Кадастровая стоимость, руб.: 8123456.78» (число — в той же строке или в следующей, если в строке только
// подпись), дата — «по состоянию на …» в той же строке или «Дата определения кадастровой стоимости: …» на странице.
// В отчёте: число после слов «кадастровая стоимость» в той же строке; «млн», «тыс.» — сверяем с точностью записи.
// Не про объект: удельный показатель, за кв. м, проценты и отношения, аналоги; при оценке квартиры — стоимость дома или
// участка, при оценке дома — участка, при оценке участка — дома. Если в строке отчёта своя дата «по состоянию на» и она не
// как в выписке (или в выписке даты нет) — это может быть прежняя кадастровая стоимость, не сверяем.
const CADV_LABEL = /кадастров\S*\s+стоимост\S*/giu;
const CADV_DATE = /(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s*г(?:ода|\.)?)?|(?<!\d)(\d{1,2})\s+([а-яё]+)\s+(\d{4})(?:\s*г(?:ода|\.)?)?/giu;
const CADV_NUM = /(?<![\d.,])(\d{1,3}(?:[   ]\d{3})+|\d+)(?:[.,](\d{1,2}))?(?![\d])(?:\s*(млн|тыс))?/u;
const CADV_SKIP = /удельн|за\s+(?:1|одн|единиц)|кв\.?\s*м|м2|м²|(?<![а-яё])дат|аналог|процент|отношени|коэффициент|изменени|оспари|пересмотр/iu;
function dayOf(m) {
  if (m[1]) return ymd(m[3], m[2], m[1]);
  const mi = MONTHS.findIndex((x, i) => (i === 4 ? /^ма[яй]$/iu.test(m[5]) : m[5].toLowerCase().startsWith(x)));
  return mi >= 0 ? ymd(m[6], mi + 1, m[4]) : null;
}
function lineDay(text) {
  for (const m of String(text).matchAll(CADV_DATE)) { const d = dayOf(m); if (d) return d; }
  return null;
}
// Числа после подписи «кадастровая стоимость» на странице: { index, raw, v, tol, unit, day, line }.
function cadValues(page, other) {
  const out = [];
  for (const l of page.matchAll(CADV_LABEL)) {
    const start = page.lastIndexOf('\n', l.index) + 1;
    const stop = page.indexOf('\n', l.index);
    const line = page.slice(start, stop < 0 ? page.length : stop);
    let from = l.index + l[0].length;
    let rest = page.slice(from, stop < 0 ? page.length : stop);
    // Подпись в строке одна («Кадастровая стоимость, руб.:») — число в следующей строке.
    if (!/\d/.test(rest.replace(CADV_DATE, '')) && stop >= 0 && !/[а-яё]{3}/iu.test(rest.replace(/руб\S*|по\s+состоянию\s+на/giu, '').replace(CADV_DATE, ''))) {
      const next = page.indexOf('\n', stop + 1);
      const nl = page.slice(stop + 1, next < 0 ? page.length : next);
      if (/^[\s|:]*\d[\d\s  .,]*(?:руб\S*)?\s*$/iu.test(nl)) { from = stop + 1; rest = nl; }
    }
    const masked = rest.slice(0, 120).replace(CADV_DATE, (s) => ' '.repeat(s.length));
    const m = CADV_NUM.exec(masked);
    if (!m) continue;
    const between = masked.slice(0, m.index);
    const near = `${page.slice(Math.max(start, l.index - 30), l.index)}${l[0]}${between}`;
    if (CADV_SKIP.test(near) || (other && other.test(near)) || /аналог/iu.test(line)) continue;
    if (/^\s*(?:%|кв|м2|м²|руб\S*\s*(?:за|\/))/iu.test(masked.slice(m.index + m[0].length))) continue;
    const unit = m[3]?.toLowerCase();
    const mult = unit === 'млн' ? 1e6 : unit === 'тыс' ? 1e3 : 1;
    const v = Number(`${m[1].replace(/[   ]/g, '')}.${m[2] ?? 0}`) * mult;
    if (!(v >= 1000)) continue;
    const step = (m[2] ? 10 ** -m[2].length : 1) * mult;
    out.push({ index: from + m.index, raw: `${m[1]}${m[2] ? `,${m[2]}` : ''}`, v: Math.round(v * 100) / 100, tol: Math.max(1, step / 2), unit, day: lineDay(line), line });
  }
  return out;
}
const CADV_DAY_AT = /(?:дата\s+определения\s+кадастров\S*\s+стоимост\S*|по\s+состоянию\s+на)\s*[:\-–—]?\s*/giu;
function egrnCadValueValues(egrn, ctx) {
  const land = ctx.service === 'land';
  const values = new Map();
  for (const d of egrnOnObject(egrn, ctx)) {
    if (!Array.isArray(d.pages)) continue;
    const head = d.pages.slice(0, 2).join('\n');
    if (land ? EGRN_BUILT.test(head) && !EGRN_LAND.test(head) : EGRN_LAND.test(head) && !EGRN_BUILT.test(head)) continue;
    d.pages.some((page, i) => {
      const got = cadValues(page, null).find((c) => !c.unit);
      if (!got) return false;
      let day = got.day;
      if (!day) for (const m of page.matchAll(CADV_DAY_AT)) { day = lineDay(page.slice(m.index + m[0].length, m.index + m[0].length + 30)); if (day) break; }
      if (!values.has(got.v)) values.set(got.v, { name: d.name, page: i, doc: d.id, quote: lineAround(page, got.index), day });
      return true;
    });
  }
  return values;
}
export function egrnCadValue(egrn, ctx) {
  return oneValue(egrnCadValueValues(egrn, ctx));
}
function cadValueMatch(doc, ctx) {
  if (!ctx.egrn?.length) return [];
  const egrn = egrnCadValue(ctx.egrn, ctx);
  if (!egrn) return [];
  const type = ctx.fields?.object_type;
  const other = ctx.service === 'land' ? /(?<![а-яё])дом|здани|строени|постройк|помещени|квартир/iu
    : type === 'house' ? /участ/iu
      : PREMISES.includes(type) ? /участ|(?<![а-яё])дом(?:а|у|е)?(?![а-яё])|здани/iu : /участ/iu;
  const out = [];
  const seen = new Set();
  eachPage(doc, (page, i) => {
    for (const c of cadValues(page, other)) {
      if (Math.abs(c.v - egrn.v) < c.tol || seen.has(`${c.v}${c.unit ?? ''}`)) continue;
      if (c.day && c.day !== egrn.day) continue;
      seen.add(`${c.v}${c.unit ?? ''}`);
      const on = egrn.day ? ` по состоянию на ${ruDate(egrn.day)}` : '';
      out.push({ page: i, quote: lineAround(page, c.index), egrn: egrnAt(egrn), ...(c.unit ? {} : { fix: { bad: c.raw, right: fmt(egrn.v) } }),
        text: `Кадастровая стоимость ${c.unit ? `${c.raw} ${c.unit === 'млн' ? 'млн' : 'тыс.'}` : fmt(c.v)} руб. не совпадает с выпиской ЕГРН «${egrn.name}» (${fmt(egrn.v)} руб.${on}, стр. ${egrn.page + 1}) — проверьте, не стоимость ли это другого объекта или прежней даты` });
    }
  });
  return out;
}

// ——— 2.241: правообладатель и вид права в отчёте — как в выписке ЕГРН на объект из дела ———
// В выписке: «Правообладатель (правообладатели): 1.1. Иванов Иван Иванович» (имена — в той же строке и в следующих, до
// строки «Вид, номер и дата государственной регистрации права») и «Вид … регистрации права: 2.1. Общая долевая
// собственность, …». Сведения скрыты («Физическое лицо», «не предоставлены») — правообладателя не сверяем.
// В отчёте: строки с подписью «Правообладатель:», «Собственник:», «Субъект права:» — фамилия (и первая буква имени, если
// есть) или название организации в кавычках; падеж и женская фамилия («Иванова») находкой не считаются. Вид права — в
// строках «Вид права:», «Оцениваемые права:», «Имущественные права …:», «Существующие права:», «… на праве … собственности»:
// «долевая», «совместная», «индивидуальная» (или просто «Собственность») — сверяем; общее «право собственности» — нет.
// Прежний собственник, продавец, аналоги — не про объект.
const RIGHTS_HOLDER_AT = /правообладател\S*(?:\s*\([^)\n]*\))?\s*[:\-–—]?/giu;
const RIGHTS_KIND_AT = /вид\S*(?:,\s*номер\S*)?(?:\s+и)?(?:\s+дата\S*)?(?:\s+и\s+время)?\s+(?:государственн\S*\s+)?регистраци\S*\s+прав\S*\s*[:\-–—]?/giu;
const RIGHTS_STOP = /^\s*(?:\d+(?:\.\d+)*\.?\s*)?(?:вид\S*[,\s]|документ|ограничени|сведения|заявленн|особые|правоприт|кадастров|получател|назначени|наименовани|адрес|площад)/iu;
const PERSON = /(?<![А-ЯЁа-яё])([А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?)\s+(?:([А-ЯЁ])[а-яё]+\s+[А-ЯЁ][а-яё]+(?:вич|вна|чна|оглы|кызы)|([А-ЯЁ])\.\s*[А-ЯЁ]\.)/gu;
const ORG = /(?<![А-ЯЁа-яё])(?:ООО|АО|ПАО|ЗАО|ОАО|НАО|ГУП|МУП|ФГУП|ИП)\s*[«"„]([^»"“\n]{2,80})[»"“]/gu;
const REPORT_HOLDER_AT = /(?:правообладател\S*|собственник\S*(?:\s+объекта(?:\s+оценки)?)?|субъект\S*\s+прав\S*)(?:\s*\([^)\n]*\))?\s*[:\-–—]\s*/giu;
const REPORT_KIND_AT = /(?:вид\S*\s+(?:зарегистрированн\S*\s+)?прав\S*|оцениваем\S*\s+(?:имущественн\S*\s+)?прав\S*|имущественн\S*\s+прав\S*(?:\s+на\s+объект\S*(?:\s+оценки)?)?|существующ\S*\s+прав\S*(?:\s+на\s+объект\S*(?:\s+оценки)?)?)(?:\s*\([^)\n]*\))?\s*[:\-–—]\s*|на\s+праве\s+(?=(?:общей\s+)?(?:долев|совместн|индивидуальн|единоличн)\S*\s+собственност)/giu;
const RIGHTS_SKIP = /аналог|прежн|бывш|продав|покупател|предыдущ|до\s+(?:перехода|регистрации)/iu;
function holdersIn(text) {
  const out = [];
  for (const m of text.matchAll(PERSON)) out.push({ raw: m[0], surname: m[1].toLowerCase(), initial: (m[2] ?? m[3]).toLowerCase() });
  for (const m of text.matchAll(ORG)) out.push({ raw: m[0], org: m[1].toLowerCase().replace(/\s+/g, ' ').trim() });
  return out;
}
function sameHolder(a, b) {
  if (a.org || b.org) return !!a.org && !!b.org && (a.org.includes(b.org) || b.org.includes(a.org));
  const [x, y] = [a.surname, b.surname];
  let n = 0;
  while (n < x.length && x[n] === y[n]) n += 1;
  return n >= Math.max(4, Math.min(x.length, y.length) - 2) && a.initial === b.initial;
}
function rightsKind(text) {
  const t = String(text);
  if (/долев/iu.test(t)) return 'shared';
  if (/совместн/iu.test(t)) return 'joint';
  if (/(?:индивидуальн|единоличн)\S*\s+собственност/iu.test(t) || /^[\s.\d]*собственность(?![а-яё])\s*(?:[,;.(№\d]|$)/iu.test(t)) return 'own';
  if (/собственност/iu.test(t)) return null;
  return /\S/.test(t) ? 'other' : null;
}
const RIGHTS_KIND_NAME = { own: 'собственность', shared: 'общая долевая собственность', joint: 'общая совместная собственность' };
// Подпись в строке, значение — в той же строке после неё и, если нужно, в следующих (до следующей подписи выписки).
function egrnBlock(page, at, lines) {
  const stop = page.indexOf('\n', at);
  const out = [page.slice(at, stop < 0 ? page.length : stop)];
  let from = stop;
  for (let k = 0; k < lines && from >= 0; k += 1) {
    const next = page.indexOf('\n', from + 1);
    const line = page.slice(from + 1, next < 0 ? page.length : next);
    if (RIGHTS_STOP.test(line) || /правообладател/iu.test(line)) break;
    out.push(line);
    from = next;
  }
  return out.join('\n');
}
function egrnRights(egrn, ctx) {
  const land = ctx.service === 'land';
  const got = { holders: [], hidden: false, kinds: new Map() };
  for (const d of egrnOnObject(egrn, ctx)) {
    if (!Array.isArray(d.pages)) continue;
    const head = d.pages.slice(0, 2).join('\n');
    if (land ? EGRN_BUILT.test(head) && !EGRN_LAND.test(head) : EGRN_LAND.test(head) && !EGRN_BUILT.test(head)) continue;
    d.pages.forEach((page, i) => {
      for (const m of page.matchAll(RIGHTS_HOLDER_AT)) {
        const block = egrnBlock(page, m.index + m[0].length, 4);
        const found = holdersIn(block);
        if (!found.length && /\p{L}{3}/u.test(block)) got.hidden = true;
        for (const h of found) {
          if (!got.holders.some((x) => sameHolder(x, h))) got.holders.push({ ...h, name: d.name, page: i, doc: d.id, quote: lineAround(page, m.index) });
        }
      }
      for (const m of page.matchAll(RIGHTS_KIND_AT)) {
        const block = egrnBlock(page, m.index + m[0].length, 1).replace(/\n/g, ' ');
        const kind = rightsKind(block.replace(/^[\s\d.]*/, ''));
        if (kind && !got.kinds.has(kind)) {
          const v = block.replace(/^[\s\d.]*/, '');
          const text = clean((v.match(/^[^,;№\d]*?собственност[а-яё]*/iu) ?? [v.split(/[,;№\d]/)[0]])[0]);
          got.kinds.set(kind, { v: text, name: d.name, page: i, doc: d.id, quote: lineAround(page, m.index) });
        }
      }
    });
  }
  return got;
}
function rightsMatch(doc, ctx) {
  if (!ctx.egrn?.length) return [];
  const egrn = egrnRights(ctx.egrn, ctx);
  const kinds = [...egrn.kinds.keys()];
  // Вид права сверяем, только когда в выписках он один из трёх видов собственности и один.
  const kind = kinds.length === 1 && RIGHTS_KIND_NAME[kinds[0]] ? egrn.kinds.get(kinds[0]) : null;
  const holders = egrn.hidden ? [] : egrn.holders;
  if (!kind && !holders.length) return [];
  const out = [];
  const seen = new Set();
  eachPage(doc, (page, i) => {
    if (holders.length) {
      for (const m of page.matchAll(REPORT_HOLDER_AT)) {
        const line = lineAround(page, m.index);
        if (RIGHTS_SKIP.test(line)) continue;
        const stop = page.indexOf('\n', m.index);
        const rest = page.slice(m.index + m[0].length, stop < 0 ? page.length : stop);
        for (const h of holdersIn(rest)) {
          if (holders.some((x) => sameHolder(x, h)) || seen.has(`h${h.raw}`)) continue;
          seen.add(`h${h.raw}`);
          const at = holders[0];
          const all = holders.map((x) => x.raw).join(', ');
          out.push({ page: i, quote: line, egrn: egrnAt(at), fix: { bad: h.raw, right: at.raw },
            text: `Правообладатель «${h.raw}» не совпадает с выпиской ЕГРН «${at.name}» (${all}, стр. ${at.page + 1}) — проверьте, нет ли данных другого объекта или старого отчёта` });
        }
      }
    }
    if (kind) {
      for (const m of page.matchAll(REPORT_KIND_AT)) {
        const line = lineAround(page, m.index);
        if (RIGHTS_SKIP.test(line)) continue;
        const stop = page.indexOf('\n', m.index);
        const rest = page.slice(m.index + m[0].length, stop < 0 ? page.length : stop);
        const mine = rightsKind(rest);
        if (!mine || mine === 'other' || mine === kinds[0] || seen.has(`k${mine}`)) continue;
        seen.add(`k${mine}`);
        const raw = clean((rest.match(/^[^,;.(]*?собственност[а-яё]*/iu) ?? [rest.split(/[,;(]/)[0]])[0]);
        out.push({ page: i, quote: line, egrn: egrnAt(kind), fix: { bad: raw, right: kind.v },
          text: `Вид права «${raw}» не совпадает с выпиской ЕГРН «${kind.name}» («${kind.v}», стр. ${kind.page + 1}) — проверьте раздел о правах на объект оценки` });
      }
    }
  });
  return out;
}

// ——— 2.242: ограничения и обременения из выписки ЕГРН (ипотека, арест, аренда …) упомянуты в отчёте ———
// В выписке: «Ограничение прав и обременение объекта недвижимости: не зарегистрировано» или блок с «вид: Ипотека в силу
// закона» (в той же строке или в следующих, до следующей подписи выписки). В отчёте вид обременения должен быть назван
// хоть где-то, кроме аналогов, цели оценки и рынка («ипотечные ставки», «ставки аренды» — другие слова или не в счёт).
// Отчёт прямо говорит «Обременения: не зарегистрированы» — находка у этой строки с «Исправить в черновике».
const ENC_AT = /ограничени\S*\s+прав\S*\s+и\s+обременени\S*(?:\s+объекта(?:\s+недвижимости)?)?\s*[:\-–—]?/giu;
const ENC_STOP = /^\s*(?:\d+(?:\.\d+)*\.?\s*)?(?:заявленн|сведения|правоприт|правообладател|кадастров|получател|особые|вид\S*,\s*номер|ограничени\S*\s+прав\S*\s+и\s+обременени)/iu;
const ENC_NONE = /не\s+зарегистрирован|отсутству|данные\s+отсутству|не\s+выявлен|не\s+установлен|не\s+имеется|(?<![а-яё])нет(?![а-яё])/iu;
const ENC_KINDS = {
  mortgage: ['ипотека', /ипотек|залог/iu, /(?<![а-яё])ипотек(?:а|и|е|у|ой|ою)?(?![а-яё])|(?<![а-яё])залог(?:а|е|у|ом)?(?![а-яё])|залогодерж/iu],
  arrest: ['арест', /арест/iu, /(?<![а-яё])арест/iu],
  ban: ['запрещение регистрации', /запрещ|запрет/iu, /запрещени\S*\s+(?:сделок|регистрац|на\s+совершени)|запрет\S*\s+(?:на\s+)?(?:регистрац|совершени|сделок)/iu],
  lease: ['аренда', /аренд/iu, /(?<![а-яё])(?:суб)?аренд(?:а|ы|е|у|ой|атор)(?![а-яё])/iu],
  servitude: ['сервитут', /сервитут/iu, /сервитут/iu],
  trust: ['доверительное управление', /доверительн\S*\s+управлен/iu, /доверительн\S*\s+управлен/iu],
};
const ENC_SKIP = /аналог|цел\S*\s+(?:проведения\s+)?оценки|предполагаем\S*\s+использован|ипотечн|ставк|рын/iu;
function egrnEncumbrances(egrn, ctx) {
  const land = ctx.service === 'land';
  const got = new Map();
  for (const d of egrnOnObject(egrn, ctx)) {
    if (!Array.isArray(d.pages)) continue;
    const head = d.pages.slice(0, 2).join('\n');
    if (land ? EGRN_BUILT.test(head) && !EGRN_LAND.test(head) : EGRN_LAND.test(head) && !EGRN_BUILT.test(head)) continue;
    d.pages.forEach((page, i) => {
      for (const m of page.matchAll(ENC_AT)) {
        const stop = page.indexOf('\n', m.index);
        const lines = [page.slice(m.index + m[0].length, stop < 0 ? page.length : stop)];
        for (let from = stop, k = 0; k < 12 && from >= 0; k += 1) {
          const next = page.indexOf('\n', from + 1);
          const line = page.slice(from + 1, next < 0 ? page.length : next);
          if (ENC_STOP.test(line)) break;
          lines.push(line);
          from = next;
        }
        if (ENC_NONE.test(lines[0]) && !/вид\s*:/iu.test(lines[0])) {
          got.none ??= { name: d.name, page: i, doc: d.id };
          continue;
        }
        // Вид — в строках «вид: …»; нет их — весь блок (без строк о сроке и о том, в чью пользу).
        const vid = lines.map((l) => l.match(/(?<![а-яё])вид\s*:\s*(.+)$/iu)?.[1]).filter(Boolean);
        const where = vid.length ? vid : lines.filter((l) => !/в\s+пользу|срок|дата|номер/iu.test(l));
        for (const v of where) {
          for (const [kind, [, re]] of Object.entries(ENC_KINDS)) {
            if (!re.test(v) || got.has(kind)) continue;
            got.set(kind, { v: clean(v.replace(/^[\s\d.]*/, '').split(/[,;]/)[0]), name: d.name, page: i, doc: d.id, quote: lineAround(page, Math.max(m.index, page.indexOf(v, m.index))) });
          }
        }
      }
    });
  }
  return got;
}
// 2.243: правообладатель, вид права и обременения из выписок ЕГРН на объект — для таблицы задания в черновике. Сведения о
// правообладателе скрыты — его не даём; видов права в выписках несколько — эксперт выбирает сам; обременений нет, а выписка
// прямо пишет «не зарегистрировано» — так и даём.
export function egrnRightsFacts(egrn, ctx) {
  const r = egrnRights(egrn, ctx);
  const at = (x) => ({ name: x.name, page: x.page + 1 });
  const holders = r.hidden || !r.holders.length ? null : { v: r.holders.map((h) => h.raw).join(', '), ...at(r.holders[0]) };
  const kinds = [...r.kinds.values()];
  const kind = kinds.length > 1 ? { values: kinds.map((k) => k.v) } : kinds.length ? { v: kinds[0].v, ...at(kinds[0]) } : null;
  const e = egrnEncumbrances(egrn, ctx);
  const list = [...e.values()];
  const enc = list.length ? { v: list.map((x) => x.v).join('; '), ...at(list[0]) } : e.none ? { v: 'не зарегистрированы', ...at(e.none) } : null;
  return { holders, kind, enc };
}
function encumbranceMatch(docs, ctx) {
  if (!ctx.egrn?.length || !docs.length) return [];
  const enc = egrnEncumbrances(ctx.egrn, ctx);
  if (!enc.size) return [];
  const main = mainReport(docs) ?? docs[0];
  const named = new Set();
  for (const d of docs) {
    for (const page of d.pages) {
      for (const line of page.split('\n')) {
        if (ENC_SKIP.test(line)) continue;
        for (const [kind, [, , re]] of Object.entries(ENC_KINDS)) if (re.test(line)) named.add(kind);
      }
    }
  }
  // Где в отчёте раздел об обременениях: строка «обременения … не зарегистрированы» — первая, иначе любая про обременения.
  let none = null;
  let any = null;
  main.pages.forEach((page, i) => {
    for (const m of page.matchAll(/обременени|ограничени\S*\s+прав/giu)) {
      const line = lineAround(page, m.index);
      if (ENC_SKIP.test(line)) continue;
      if (!any) any = { page: i, quote: line };
      const after = line.match(/(?:обременени|ограничени)[^:\n]*:\s*((?:не\s+зарегистрирован|отсутству|не\s+выявлен|не\s+установлен|не\s+имеется|нет(?![а-яё]))[а-яё]*)/iu);
      if (!none && (after || (ENC_NONE.test(line) && !Object.values(ENC_KINDS).some(([, , re]) => re.test(line))))) none = { page: i, quote: line, bad: after?.[1] ?? null };
    }
  });
  const out = [];
  for (const [kind, at] of enc) {
    if (named.has(kind)) continue;
    const what = `${ENC_KINDS[kind][0]} («${at.v}», стр. ${at.page + 1})`;
    if (none) {
      out.push({ doc: main, page: none.page, quote: none.quote, egrn: egrnAt(at), ...(none.bad ? { fix: { bad: none.bad, right: at.v } } : {}),
        text: `В отчёте сказано, что обременений нет, а в выписке ЕГРН «${at.name}» — ${what}: укажите обременение в разделе о правах и обременениях` });
    } else {
      out.push({ doc: main, page: any?.page ?? 0, quote: any?.quote ?? '', egrn: egrnAt(at),
        text: `В выписке ЕГРН «${at.name}» есть обременение — ${what}, а в отчёте оно не упомянуто: укажите его в разделе о правах и обременениях` });
    }
  }
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

// ——— 2.253: размер доли в отчёте — как в выписке ЕГРН на объект из дела ———
// В выписке доля — в строке вида права («Общая долевая собственность, 1/2» или «…, доля в праве 1/2») или отдельно
// («Доля в праве: 1/3», «1.1. Петров П.П. (доля 1/2)»). Номер регистрации «…-77/051/2020-3» долей не считается. Совпадает
// хоть с одной долей из выписки (у собственников разные доли) — не находка; 2/4 и 1/2 — одно и то же. «Исправить в
// черновике» — только когда доля в выписках одна. Аналоги, этажи, прежние собственники — не про объект.
const EGRN_SHARE_AT = [
  /(?<![а-яё])дол(?:я|и|е|ю|ей)(?![а-яё])(?:\s+в\s+праве)?(?:\s+общей\s+долевой\s+собственности)?\s*[:\-–—]?\s*(\d{1,3})\s*\/\s*(\d{1,4})(?![\d/])/giu,
  /долев\S*\s+собственность\s*[,:\-–—]?\s*(\d{1,3})\s*\/\s*(\d{1,4})(?![\d/])/giu,
];
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const shareKey = (a, b) => { const g = gcd(a, b) || 1; return `${a / g}/${b / g}`; };
export function egrnShares(egrn, ctx) {
  const land = ctx.service === 'land';
  const got = new Map();
  for (const d of egrnOnObject(egrn, ctx)) {
    if (!Array.isArray(d.pages)) continue;
    const head = d.pages.slice(0, 2).join('\n');
    if (land ? EGRN_BUILT.test(head) && !EGRN_LAND.test(head) : EGRN_LAND.test(head) && !EGRN_BUILT.test(head)) continue;
    d.pages.forEach((page, i) => {
      for (const re of EGRN_SHARE_AT) {
        for (const m of page.matchAll(re)) {
          const [a, b] = [Number(m[1]), Number(m[2])];
          if (!a || !b || a > b) continue;
          const key = shareKey(a, b);
          if (!got.has(key)) got.set(key, { v: `${a}/${b}`, name: d.name, page: i, doc: d.id, quote: lineAround(page, m.index) });
        }
      }
    });
  }
  return got;
}
function shareEgrnMatch(doc, ctx) {
  if (!ctx.egrn?.length) return [];
  const shares = egrnShares(ctx.egrn, ctx);
  if (!shares.size) return [];
  const list = [...shares.values()];
  const at = list[0];
  const all = list.length > 1 ? `доли в праве: ${list.map((x) => x.v).join(', ')}` : `доля в праве ${at.v}`;
  const out = [];
  const seen = new Set();
  eachPage(doc, (page, i) => {
    for (const re of SHARE_AT) {
      for (const m of page.matchAll(re)) {
        const [c, d] = [Number(m[1]), Number(m[2])];
        if (!c || !d || c > d) continue;
        const key = shareKey(c, d);
        const line = lineAround(page, m.index);
        if (shares.has(key) || seen.has(key) || /аналог|этаж/iu.test(line) || RIGHTS_SKIP.test(line)) continue;
        seen.add(key);
        out.push({ page: i, quote: line, egrn: egrnAt(at), ...(list.length === 1 ? { fix: { bad: `${c}/${d}`, right: at.v } } : {}),
          text: `Доля ${c}/${d} не совпадает с выпиской ЕГРН «${at.name}» (${all}, стр. ${at.page + 1}) — проверьте, не доля ли это другого собственника или другого объекта` });
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
// 2.321: дата составления отчёта в файле — как её берёт правило report_dates — и страница с ней (с 1): эксперту в «Сегодня»
// до подписи. Даты нет — null.
export function reportMade(pages) {
  const day = dateAfter((pages ?? []).join('\n'), MADE_LABEL);
  return day ? { day, page: pageWith({ pages }, MADE_LABEL).page + 1 } : null;
}
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
// ctx.inspectionDays — дни (по Москве), когда сделаны фото осмотра по ссылке или с выезда помощника (по часам телефона,
// если он их передал, иначе — когда платформа получила фото); ctx.inspectionUploadDays — дни получения (2.146): фото,
// снятое вечером и дошедшее утром при плохой связи, — тоже день осмотра.
// 2.146: все даты осмотра в отчёте, а не только первая — разные даты в одном отчёте (титул от шаблона, раздел от дела)
// и «без осмотра», когда в деле есть фото осмотра, — тоже находки.
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
const RETRO = /ретроспектив|состояни\S*[^.]{0,160}дат\S*\s+(?:оценки[^.]{0,160}дат\S*\s+осмотра|осмотра[^.]{0,160}дат\S*\s+оценки)/iu;
const NO_INSPECT = /без\s+(?:проведения\s+)?осмотра/iu;
// Все даты осмотра в отчёте: по одной на день, в порядке страниц, с местом первого упоминания.
function inspectDates(doc) {
  const seen = new Map();
  eachPage(doc, (page, i) => {
    const hits = [];
    for (const l of INSPECT_LABELS) {
      for (const m of page.matchAll(new RegExp(l, 'giu'))) {
        const part = page.slice(m.index, m.index + m[0].length + 60);
        const day = dateAfter(part, l);
        if (day) hits.push({ day, index: m.index, raw: rawDateAfter(part, l) });
      }
    }
    for (const h of hits.sort((a, b) => a.index - b.index)) {
      if (!seen.has(h.day)) seen.set(h.day, { day: h.day, page: i, quote: lineAround(page, h.index), raw: h.raw });
    }
  });
  return [...seen.values()];
}
// 2.373: дата после подписи так, как она написана в тексте («15.10.2026», «15 октября 2026»), — для замены в черновике.
function rawDateAfter(text, label) {
  const m = text.match(new RegExp(`${label}[^\\d\\n]{0,40}(?:\\d{1,2}\\.\\d{1,2}\\.\\d{4}|\\d{1,2}\\s+[а-яё]+\\s+\\d{4})`, 'iu'));
  return m ? m[0].slice(m[0].search(/\d/)) : null;
}
// 2.373: где в деле осмотр — по ссылке владельца и выезд помощника отдельно (ctx.inspectionBy); без разбивки — как раньше.
function inspectionSeen(ctx, days) {
  const by = ctx.inspectionBy;
  if (!by?.visit?.length) return `фото осмотра в деле сделаны ${days.map(ruDate).join(', ')}`;
  const parts = [...(by.link?.length ? [`фото по ссылке владельца — ${[...by.link].sort().map(ruDate).join(', ')}`] : []),
    `выезд помощника на объект — ${[...by.visit].sort().map(ruDate).join(', ')}`];
  return `в деле осмотр: ${parts.join('; ')}`;
}
function reportDates(docs, ctx) {
  const d = mainReport(docs) ?? docs[0];
  if (!d) return [];
  const text = (d.pages ?? []).join('\n');
  const made = dateAfter(text, MADE_LABEL);
  const val = dateAfter(text, VALUE_LABEL);
  const found = inspectDates(d);
  const out = [];
  const late = found.find((f) => made && f.day > made);
  if (late) {
    out.push({ doc: d, page: late.page, quote: late.quote, text: `Дата осмотра (${ruDate(late.day)}) позже даты составления отчёта (${ruDate(made)}) — осмотр не может быть после того, как отчёт составлен` });
  }
  // 2.154: дата составления не позже дня подписи эксперта; файл ещё не подписан — не позже сегодняшнего дня.
  const signed = ctx.signedOn?.[d.id];
  const limit = signed ?? ctx.today;
  if (made && limit && made > limit) {
    out.push({ ...pageWith(d, MADE_LABEL), text: signed
      ? `Дата составления отчёта (${ruDate(made)}) позже дня, когда эксперт подписал файл (${ruDate(signed)}), — отчёт подписан раньше, чем составлен; исправьте дату и подпишите файл заново`
      : `Дата составления отчёта (${ruDate(made)}) ещё не наступила (сегодня ${ruDate(limit)}) — подписать отчёт раньше даты составления нельзя; поставьте дату, когда будете подписывать` });
  }
  // 2.175: дата оценки не позже дня подписи (без подписи — сегодня), если дата составления не указана (с ней — date_order
  // и строка выше); и не раньше осмотра, если в отчёте не сказано, что оценка ретроспективная или что состояние объекта
  // на дату оценки принято таким же, как на дату осмотра (ФСО — такое допущение обязательно).
  if (val && !made && limit && val > limit) {
    out.push({ ...pageWith(d, VALUE_LABEL), text: signed
      ? `Дата оценки (${ruDate(val)}) позже дня, когда эксперт подписал файл (${ruDate(signed)}), — оценить на дату, которая ещё не наступила, нельзя; исправьте дату и подпишите файл заново`
      : `Дата оценки (${ruDate(val)}) ещё не наступила (сегодня ${ruDate(limit)}) — оценить на будущую дату нельзя; проверьте дату оценки` });
  }
  // 2.298: дата составления не раньше даты самого задания на оценку (письма заказчика, определения суда), приложенного к делу.
  const task = made && assignmentIssued(ctx.assignment);
  if (task?.day && made < task.day) {
    out.push({ ...pageWith(d, MADE_LABEL), text: `Дата составления отчёта (${ruDate(made)}) раньше даты ${ISSUED_OF[task.what]} «${task.name}» (${ruDate(task.day)}, стр. ${task.page + 1}) — отчёт не может быть составлен раньше, чем ${ISSUED_WHO[task.what]}; исправьте дату составления или приложите к делу верный документ` });
  }
  // 2.302: дата составления не позже срока отчёта из задания на оценку («не позднее …», «срок составления отчёта …»).
  // 2.345: срок взят из письма о переносе срока (как taskMoveLetter, 2.333) — находка называет письмо и прежний срок; совет —
  // не «приложите документ о переносе» (он уже в деле), а исправить дату или попросить письмо с новым сроком.
  const due = made && assignmentDue(ctx.assignment);
  if (due?.day && made > due.day) {
    const moved = dueMoved(ctx.assignment, due);
    out.push({ ...pageWith(d, MADE_LABEL), text: moved
      ? `Дата составления отчёта (${ruDate(made)}) позже срока из письма о переносе срока «${due.name}» (не позднее ${ruDate(due.day)}, стр. ${due.page + 1}) — срок переносили письмом${moved.was ? ` (${moved.wasLetter ? 'по прежнему письму' : 'по заданию'} было ${ruDate(moved.was)})` : ''}, но отчёт составлен и после нового срока; проверьте дату составления или попросите у заказчика письмо с новым сроком`
      : `Дата составления отчёта (${ruDate(made)}) позже срока из ${ISSUED_OF[due.what]} «${due.name}» (не позднее ${ruDate(due.day)}, стр. ${due.page + 1}) — отчёт составлен после срока; проверьте дату составления, а если срок переносили — приложите к делу документ о переносе` });
  }
  const after = val && found.find((f) => f.day > val);
  if (after && !RETRO.test(text) && !NO_INSPECT.test(text)) {
    out.push({ ...pageWith(d, VALUE_LABEL), text: `Дата оценки (${ruDate(val)}) раньше даты осмотра (${ruDate(after.day)}) — если оценка ретроспективная, напишите это и допущение, что состояние объекта на дату оценки такое же, как на дату осмотра; иначе исправьте дату` });
  }
  if (found.length > 1) {
    out.push({ doc: d, page: found[1].page, quote: found[1].quote, text: `В отчёте разные даты осмотра: ${found.map((f) => `${ruDate(f.day)} (стр. ${f.page + 1})`).join(', ')} — оставьте одну, верную` });
  }
  const days = [...new Set(ctx.inspectionDays ?? [])].sort();
  const ok = new Set([...days, ...(ctx.inspectionUploadDays ?? [])]);
  const none = text.match(NO_INSPECT);
  if (days.length && !none) {
    // 2.373: осмотр в деле в один день — «Заменить на дату осмотра из дела» в черновике (shot); дней несколько — только находка.
    const [y, m, dd] = (days.length === 1 ? days[0] : '').split('-');
    for (const f of found.filter((x) => !ok.has(x.day))) {
      out.push({ doc: d, page: f.page, quote: f.quote, ...(dd && f.raw ? { shot: { bad: f.raw, right: `${dd}.${m}.${y}` } } : {}),
        text: `Дата осмотра в отчёте — ${ruDate(f.day)}, а ${inspectionSeen(ctx, days)} — проверьте дату осмотра` });
    }
  }
  if (days.length && none) {
    const i = Math.max(0, (d.pages ?? []).findIndex((p) => NO_INSPECT.test(p)));
    const seen = ctx.inspectionBy?.visit?.length ? `${inspectionSeen(ctx, days)}` : `в деле есть фото осмотра от ${days.map(ruDate).join(', ')}`;
    out.push({ doc: d, page: i, quote: lineAround(d.pages[i], Math.max(0, d.pages[i].search(NO_INSPECT))),
      text: `В отчёте сказано «${clean(none[0])}», а ${seen} — проверьте, был ли осмотр` });
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
  // 2.184: ссылка из дела, но под чужим номером (под «Аналог № 2» — объявление аналога 1 из дела) — тоже находка:
  // скриншоты в приложении подписаны номерами дела. Номер — первая ячейка строки таблицы или ближайшее «Аналог № N»
  // без другой ссылки между ними.
  const keys = list.map((a) => hostPath(a.url));
  const caseNo = (hp) => {
    const hit = keys.map((k, i) => (k && k.startsWith(hp) ? i + 1 : 0)).filter(Boolean);
    return hit.length === 1 ? hit[0] : 0;
  };
  let maxNo = 0;
  const seen = new Set();
  for (const doc of docs) {
    eachPage(doc, (page, p) => {
      const marks = [...page.matchAll(ANALOG_NO)].map((m) => ({ at: m.index, n: Number(m[1]) })).filter((x) => x.n >= 1 && x.n <= 30);
      for (const x of marks) maxNo = Math.max(maxNo, x.n);
      let prevUrl = -1;
      for (const m of page.matchAll(URL_RE)) {
        const before = marks.filter((x) => x.at < m.index && m.index - x.at <= 300).pop();
        const hp = hostPath(m[0].replace(/[.,;:]+$/, ''));
        const row = lineAround(page, m.index).match(TABLE_ROW_NO);
        const label = row ? Number(row[1]) : before && before.at > prevUrl ? before.n : 0;
        prevUrl = m.index;
        if (!hp) continue;
        // Ссылка, перенесённая в PDF на следующую строку, читается обрезанной — своя, если с неё начинается ссылка дела.
        if ([...mine].some((x) => x.startsWith(hp))) {
          const k = caseNo(hp);
          if (label && k && label !== k && label <= n && !seen.has(`${label}:${k}`)) {
            seen.add(`${label}:${k}`);
            out.push({ doc, page: p, quote: lineAround(page, m.index), text: `У аналога № ${label} в отчёте ссылка аналога ${k} из дела (${siteOf(list[k - 1].url)}) — номера в отчёте и в деле разные, а скриншоты в приложении подписаны по делу: проверьте порядок аналогов` });
          }
          continue;
        }
        if (!before || seen.has(hp)) continue;
        seen.add(hp);
        out.push({ doc, page: p, quote: lineAround(page, m.index), text: `Ссылка у аналога № ${before.n} в отчёте — не из аналогов дела: добавьте объявление в раздел «Аналоги» (ссылка и скриншот со временем) или проверьте ссылку` });
      }
    });
  }
  out.push(...analogPriceOrder(docs, list));
  if (maxNo > n) out.unshift(at(`В отчёте есть аналог № ${maxNo}, а в деле ${many} — добавьте недостающие в раздел «Аналоги» или проверьте нумерацию`));
  return out;
}

// ——— 2.184: цена аналога — в его строке (столбце) таблицы, а не у соседа ———
// Строка таблицы «| N | … |» — у аналога № N; строка «Цена …» с ценами по столбцам — по порядку аналогов. Находка, если
// в строке (столбце) аналога нет ни его цены, ни цены после корректировок, но стоит цена другого аналога дела —
// строки переставлены или цена перенесена не туда. Совпадение цен у двух аналогов находкой не считается. Строки берём
// только под шапкой «№ … Цена …» (не таблицы позиций и корректировок, где номер — не номер аналога).
const TABLE_ROW_NO = /^\s*\|\s*(?:аналог\S*\s*)?(?:№\s*)?(\d{1,2})\s*\|/iu;
function analogPriceOrder(docs, list) {
  const own = list.map((a) => [a.fields?.price_rub, adjusted(a)?.price].filter((x) => Number.isFinite(x)));
  const near = (vals, x) => vals.some((v) => Math.abs(v - x) <= 1);
  const wrong = (no, vals) => {
    if (!own[no - 1]?.length || vals.some((x) => near(own[no - 1], x))) return null;
    for (const x of vals) {
      const k = own.findIndex((o, i) => i !== no - 1 && near(o, x));
      if (k >= 0) return { x, k: k + 1 };
    }
    return null;
  };
  const out = [];
  const seen = new Set();
  const say = (doc, p, quote, no, hit) => {
    if (seen.has(no)) return;
    seen.add(no);
    const a = list[hit.k - 1];
    out.push({ doc, page: p, quote, text: `У аналога № ${no} в таблице отчёта цена ${fmt(hit.x)} руб. — это цена аналога ${hit.k} из дела (${siteOf(a.url)}); у аналога ${no} из дела — ${fmt(list[no - 1].fields.price_rub)} руб.: проверьте порядок строк и цены в таблице` });
  };
  for (const doc of docs) {
    eachPage(doc, (page, p) => {
      let head = false; // строки берём только под шапкой таблицы аналогов: «| № | … | Цена … |» (не перечень позиций)
      for (const line of page.split('\n')) {
        const row = line.match(TABLE_ROW_NO);
        if (!row && /^\s*\|/u.test(line) && !/^\s*\|\s*цен/iu.test(line)) {
          const first = line.split('|')[1].trim();
          head = /^(?:№|n|аналог|п\/п)/iu.test(first) && /цен/iu.test(line) && !/позици|средн/iu.test(line);
          continue;
        }
        if (row) {
          if (!head) continue;
          const no = Number(row[1]);
          if (no < 1 || no > list.length) continue;
          const vals = numbersIn(line.slice(row[0].length)).filter((x) => x >= 1000);
          const hit = vals.length && wrong(no, vals);
          if (hit) say(doc, p, line.trim(), no, hit);
          continue;
        }
        // Таблица «по столбцам»: «| Цена предложения, руб. | 14 000 000 | 14 500 000 | 15 000 000 |».
        const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
        if (cells.length < 2 || !/^цен/iu.test(cells[0]) || /кв\.?\s*м|м2|м²|за\s+(?:1|ед)/iu.test(cells[0])) continue;
        const cols = cells.slice(1).map((c) => numbersIn(c).filter((x) => x >= 1000));
        if (cols.length !== list.length || cols.some((c) => c.length !== 1)) continue;
        cols.forEach((c, i) => {
          const hit = wrong(i + 1, c);
          if (hit) say(doc, p, line.trim(), i + 1, hit);
        });
      }
    });
  }
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

function valuesByKey(docs) {
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
  return byKey;
}

function finalValues(docs) {
  const byKey = valuesByKey(docs);
  return [...byKey].flatMap(([key, list]) => oddOnes(list, (e, ref, where) =>
    `${VALUE_NAMES[key]} ${fmt(e.value)} руб. не совпадает с ${fmt(ref)} руб. ${where} — сумма должна быть одна во всём отчёте и в письме`));
}

// 2.401: номер отчёта, дата составления и итоговая стоимость для перечня отчётов в СРО — то, что чаще всего встречается в
// файлах результата (по тем же правилам, что сверка 2.116 и 2.108). Стоимость — рыночная (или ремонта, УТС, устранения
// недостатков, доли — первая из найденных по порядку FACT_KEYS); не нашлось — null.
const most = (list) => {
  const n = new Map();
  for (const e of list) n.set(e.value, (n.get(e.value) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};
const FACT_KEYS = ['market', 'repair:wear', 'repair:nowear', 'fix', 'uts', 'market:share', 'market:novat', 'market:vat'];
export function reportFacts(docs) {
  const { nums, dates } = numbersAndDates(docs);
  const num = most(nums);
  const byKey = valuesByKey(docs);
  const key = FACT_KEYS.find((k) => byKey.has(k));
  return {
    number: num == null ? null : nums.find((e) => e.value === num).shown,
    made_on: most(dates),
    value_rub: key ? most(byKey.get(key)) : null,
    value_name: key ? VALUE_NAMES[key] : null,
  };
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

function numbersAndDates(docs) {
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
  return { nums, dates };
}

function reportNumbers(docs) {
  const { nums, dates } = numbersAndDates(docs);
  const shownOf = new Map(nums.map((e) => [e.value, e.shown]));
  // Одна и та же дата на странице (у номера и «дата составления») — одно место.
  const once = (list) => list.filter((e, k) => list.findIndex((x) => x.doc === e.doc && x.page === e.page && x.value === e.value) === k);
  return [
    ...oddOnes(once(nums), (e, ref, where) => `Номер отчёта № ${e.shown} не совпадает с № ${shownOf.get(ref)} ${where} — номер должен быть один на титуле, в колонтитулах и в письме`),
    ...oddOnes(once(dates), (e, ref, where) => `Дата отчёта ${ruDate(e.value)} не совпадает с ${ruDate(ref)} ${where} — дата составления должна быть одна на титуле, в колонтитулах и в письме`, { samePage: true }),
  ];
}

// ——— 2.403: номер отчёта уже был в другом деле эксперта этого года ———
// ctx.usedNumbers — номера отчётов из других дел того же эксперта, где файл результата загружен в этом году (по Москве):
// [{ number, title?, on }]. Номер этого отчёта — тот, что чаще всего встречается в его файлах (как в перечне для СРО, 2.401).
// Совпал (без пробелов, точек и регистра) — одна находка у первого места, где номер написан. Названия чужого дела в находке
// нет, если проверку запускает не сам эксперт (title не передан).
function numberRepeats(docs, ctx) {
  const used = ctx.usedNumbers ?? [];
  if (!used.length) return [];
  const { nums } = numbersAndDates(docs);
  const num = most(nums);
  if (num == null) return [];
  const twin = used.find((u) => squash(u.number) === num);
  if (!twin) return [];
  const at = nums.find((e) => e.value === num);
  const where = twin.title ? `в Вашем деле «${twin.title}»` : 'в другом деле эксперта';
  return [{ doc: at.doc, page: at.page, quote: at.quote,
    text: `Номер отчёта № ${at.shown} уже был ${where} (файл загружен ${ruDate(twin.on)}) — у каждого отчёта за год свой номер, проверьте нумерацию` }];
}

// ——— 2.123: дата оценки одна по всему отчёту и в сопроводительном письме ———
// Дата оценки — после «дата оценки (дата определения стоимости, датой оценки является)» и после «по состоянию на», если
// в той же строке перед ним говорится о стоимости объекта (кадастровая, балансовая, прежние оценки, аналоги и индексы —
// не в счёт). Цифрами или словами («по состоянию на «01» октября 2026 г.»). Ровно две разные даты — находка у той, что
// встречается реже; три и больше — молчим (значит, это не одна дата оценки).
const VALUE_AT = new RegExp(`${VALUE_LABEL}|дат\\S*\\s+проведения\\s+оценки|датой\\s+оценки\\s+(?:является|принята|считается)|по\\s+состоянию\\s+на`, 'giu');
const STATE_SKIP = /кадастров|балансов|инвентаризац|прежн|предыдущ|ранее|прошл|аналог|предложени|объявлени|индекс|инфляц|курс|выписк|ставк|задолженност/iu;

// Все даты оценки в документе: по одной на страницу и день, с местом.
function valueDatesIn(doc) {
  const dates = [];
  eachPage(doc, (raw, i) => {
    const page = unquote(raw);
    for (const m of page.matchAll(VALUE_AT)) {
      if (/^по/iu.test(m[0])) {
        const before = lineBefore(page, m.index, 250);
        if (!/стоимост/iu.test(before) || STATE_SKIP.test(before)) continue;
      }
      const on = dateAfter(page.slice(m.index), `^${m[0].replace(/\s+/gu, '\\s+')}`);
      if (on && !dates.some((x) => x.page === i && x.value === on)) dates.push({ doc, page: i, value: on, quote: lineAround(raw, m.index) });
    }
  });
  return dates;
}

function valueDates(docs, ctx = {}) {
  const main = mainReport(docs);
  const ordered = main ? [main, ...docs.filter((d) => d !== main)] : docs;
  const once = ordered.flatMap(valueDatesIn);
  const out = oddOnes(once, (e, ref, where) => `Дата оценки ${ruDate(e.value)} не совпадает с ${ruDate(ref)} ${where} — дата оценки должна быть одна во всём отчёте и в письме`, { samePage: true });
  return [...out, ...assignmentDate(once, ctx.assignment ?? [])];
}

// ——— 2.198: дата оценки — как в задании на оценку, письме заказчика или определении суда, приложенных к делу ———
// ctx.assignment — документы дела, которые не результат: основание и файлы с «заданием на оценку» или «письмом» (ai-ops).
// В них ровно одна дата оценки, а в отчёте — тоже одна и другая: находка у первого места в отчёте. Разные даты в
// приложенных документах (новое задание рядом со старым) — молчим: какая верная, решает эксперт.
function assignmentDate(reportDates, assignment) {
  const values = [...new Set(reportDates.map((e) => e.value))];
  if (values.length !== 1) return [];
  const got = assignmentValue(assignment);
  if (!got.day || got.day === values[0]) return [];
  const first = reportDates[0];
  return [{ doc: first.doc, page: first.page, quote: first.quote,
    fix: { bad: ruDate(values[0]), right: ruDate(got.day), from: `${got.what} «${got.name}»` },
    text: `Дата оценки в отчёте ${ruDate(values[0])}, а ${got.what} «${got.name}» — ${ruDate(got.day)} (стр. ${got.page + 1}); дата оценки берётся из задания — исправьте отчёт или приложите к делу новое задание` }];
}

// 2.207: дата оценки из приложенных к делу задания на оценку, письма заказчика или определения суда — для ИИ-проверки
// (2.198) и черновика заключения. Ровно одна дата — { day: 'ГГГГ-ММ-ДД', name, page, what }; разные — { days: […] }
// (какая верная, решает эксперт); нет ни одной — {}.
export function assignmentValue(assignment) {
  const given = (assignment ?? []).filter((d) => Array.isArray(d.pages)).flatMap(valueDatesIn);
  const days = [...new Set(given.map((e) => e.value))];
  if (days.length > 1) return { days };
  if (!days.length) return {};
  const src = given[0].doc;
  return { day: days[0], name: src.name, page: given[0].page, what: assignmentWhat(src) };
}
// 2.298: дата самого задания на оценку, письма заказчика или определения суда — в шапке первой страницы (первые 12 строк):
// «Задание на оценку № 5 от 01.10.2026», «Исх. № 15 от «03» октября 2026 г.», «Дата задания: …» или дата отдельной строкой
// в шапке определения («18 сентября 2026 года  г. Москва»). Строки о дате оценки, осмотре, сроке отчёта и выписках — не в
// счёт. У разных документов разные даты — берётся самая ранняя: отчёт раньше неё точно составлен раньше задания.
// { day, name, page: 0, what } или null.
const ISSUED_SKIP = /оценк\S*\s+на|по\s+состоянию|дат\S*\s+оценки|определени\S*\s+(?:рыночной\s+)?стоимост|осмотр|выписк|срок|не\s+позднее|(?<![а-яё])до\s+[«"]?\d/iu;
const ISSUED_AT = ['(?<![а-яё])от', 'дата\\s+(?:задания|выдачи|письма|определения)(?!\\s+(?:рыночной\\s+)?стоимост)'];
const ISSUED_OF = { 'в задании на оценку': 'задания на оценку', 'в определении суда': 'определения суда', 'в письме заказчика': 'письма заказчика' };
const ISSUED_WHO = { 'в задании на оценку': 'дано задание', 'в определении суда': 'вынесено определение', 'в письме заказчика': 'написано письмо' };
export function assignmentIssued(assignment) {
  let got = null;
  for (const d of assignment ?? []) {
    if (!Array.isArray(d.pages) || !d.pages.length) continue;
    let day = null;
    for (const line of unquote(String(d.pages[0])).split('\n').slice(0, 12)) {
      if (ISSUED_SKIP.test(line)) continue;
      day = ISSUED_AT.map((l) => dateAfter(line, l)).find(Boolean)
        ?? (/^\s*\d{1,2}(?:\.\d{1,2}\.\d{4}|\s+[а-яё]+\s+\d{4})(?:\s*(?:года|г\.)?)(?:\s+г\.\s*[А-ЯЁ][^\n]{0,40})?\s*$/iu.test(line) ? dateAfter(line, '^') : null);
      if (day) break;
    }
    if (day && (!got || day < got.day)) got = { day, name: d.name, page: 0, what: assignmentWhat(d) };
  }
  return got;
}

// 2.302: срок составления отчёта из задания на оценку, письма заказчика или определения суда: «Срок составления отчёта:
// не позднее 30.09.2026», «Отчёт представить до 30.09.2026», «Срок проведения оценки — до «30» сентября 2026 г.».
// Строки об оплате, дате оценки и выписках — не в счёт. В одном документе сроков несколько — самый поздний (дата отчёта до
// него точно в срок); в разных документах — самый поздний (новое задание могло перенести срок). { day, name, page, what }
// или null.
const DUE_LINE = /срок\S*|не\s+позднее|(?<![а-яё])до\s+[«"]?\d/iu;
const DUE_ABOUT = /отч[её]т|заключени|оценк|экспертиз|работ|исполнени|выполнени/iu;
const DUE_SKIP = /оплат|аванс|по\s+состоянию|дат\S*\s+оценки|выписк|действ\S*\s+до|договор\S*\s+(?:№|от)/iu;
const DUE_AT = ['не\\s+позднее', '(?<![а-яё])до', 'срок\\S*(?:\\s+[а-яё]+){0,4}\\s*[:—–-]'];
export function assignmentDue(assignment) {
  let got = null;
  for (const d of assignment ?? []) {
    if (!Array.isArray(d.pages)) continue;
    d.pages.forEach((page, i) => {
      for (const line of unquote(String(page)).split('\n')) {
        if (!DUE_LINE.test(line) || !(DUE_ABOUT.test(line) || /^\s*срок/iu.test(line)) || DUE_SKIP.test(line)) continue;
        const day = DUE_AT.map((l) => dateAfter(line, l)).find(Boolean);
        if (day && (!got || day > got.day)) got = { day, name: d.name, page: i, what: assignmentWhat(d) };
      }
    });
  }
  return got;
}

// 2.345: срок по заданию (assignmentDue) взят из письма о переносе срока — файла к просьбе «Письмо банка о переносе» (`moved`,
// 2.326) или файла с более поздним сроком, чем в другом файле задания (как taskMoveLetter в draft-ops.mjs, 2.333). `was` —
// прежний срок, `wasLetter` — он сам из прежнего письма. Не письмо — null.
function dueMoved(assignment, due) {
  const letter = (assignment ?? []).find((a) => a.name === due.name);
  const days = (assignment ?? []).filter((a) => a !== letter).map((a) => ({ a, day: assignmentDue([a])?.day })).filter((x) => x.day && x.day < due.day);
  const was = days.map((x) => x.day).sort().at(-1) ?? null;
  if (!letter || !(letter.moved || was)) return null;
  return { was, wasLetter: !!was && (days.some((x) => x.day === was && x.a.moved) || days.some((x) => x.day < was)) };
}

// Как назвать приложенный документ в находке: задание на оценку, определение суда или письмо заказчика.
// Приложен к просьбе «Задание на оценку от банка» (2.299, `asked`) — задание, а не письмо заказчика (найдено прогоном 2.300).
function assignmentWhat(src) {
  const head = (src.pages ?? []).slice(0, 2).join('\n');
  return src.asked || /задани\S*\s+на\s+(?:проведение\s+)?оценк/iu.test(head) || /задани/iu.test(src.name) ? 'в задании на оценку'
    : /(?<![а-яё])суд(?:а|ом|ебн\S*)?(?![а-яё])/iu.test(head) && /определ|назнач/iu.test(head) ? 'в определении суда'
      : 'в письме заказчика';
}

// ——— 2.131: цель оценки — как в заявке, вид стоимости один по отчёту и подходит к цели ———
// Цель — после «цель оценки» / «предполагаемое использование результатов»: суд, наследство, банк, сделка, раздел, ущерб.
// Совместимые цели не в счёт (раздел через суд, ипотека при покупке). Вид — после «вид (определяемой) стоимости».
// Для суда, нотариуса, банка, сделки и раздела нужна рыночная (ст. 7 закона об оценке; для залога ликвидационная — только
// вместе с рыночной). Только отчёты об оценке; цель «другое» и пустая — не сверяем.
const VALUATION = ['realty', 'land', 'vehicle', 'movable'];
const PURPOSE_AT = /цел[ьи]\s+(?:проведения\s+)?оценки|предполагаем\S*\s+использовани\S*\s+результат\S*(?:\s+оценки)?/giu;
const PURPOSE_KIND = {
  court: /(?<![а-яё])(?:суд(?:а|у|е|ом|ебн\S*)?|арбитраж\S*)(?![а-яё])/iu,
  inheritance: /наследств|наследник|нотари/iu,
  bank: /ипотек|залог|кредит|(?<![а-яё])банк/iu,
  deal: /купл|продаж|сделк|отчужден/iu,
  division: /раздел\S*\s+(?:совместн|общ|имуществ|наследств)|супруг|развод|выдел\S*\s+(?:в\s+натуре|дол)/iu,
  damage: /ущерб|страхов|возмещени|(?<![А-ЯЁ])ДТП(?![А-ЯЁ])|залив|пожар/iu,
};
const PURPOSE_NAME = { court: 'для суда', inheritance: 'наследство, нотариус', bank: 'ипотека, залог, банк', deal: 'купля-продажа', division: 'раздел имущества', damage: 'ущерб, страховой случай' };
const PURPOSE_ALSO = { court: ['division', 'inheritance', 'damage'], inheritance: ['court', 'division'], bank: ['deal'], deal: ['bank'], division: ['court', 'inheritance'], damage: ['court'] };
const KIND_AT = /вид\S*\s+(?:(?:определяем|оцениваем|рассчитываем|устанавливаем)\S*\s+)?стоимост\S*/giu;
const VALUE_KIND = { market: /рыночн/iu, liquidation: /ликвидац/iu, investment: /инвестиц/iu, cadastral: /кадастров/iu, utilization: /утилизац/iu };
const KIND_NAME = { market: 'рыночная', liquidation: 'ликвидационная', investment: 'инвестиционная', cadastral: 'кадастровая', utilization: 'утилизационная' };
const NEED_MARKET = ['court', 'inheritance', 'bank', 'deal', 'division'];
const STOP_AT = /\.\s+(?=[А-ЯЁA-Z])|;|\s{3,}|\n|вид\S*\s+(?:определяем\S*\s+)?стоимост|дат\S*\s+оценки|предполагаем\S*\s+пользоват|цел[ьи]\s+оценки/iu;
function labelled(docs, re, max) {
  const out = [];
  for (const doc of docs) {
    eachPage(doc, (raw, i) => {
      for (const m of raw.matchAll(re)) {
        if (TOC_END.test(lineAround(raw, m.index))) continue;
        const rest = raw.slice(m.index + m[0].length).replace(/^[\s:\-–—]+/u, '');
        const cut = rest.search(STOP_AT);
        const value = clean(rest.slice(0, cut < 0 ? max : Math.min(cut, max))).replace(/[.,]+$/u, '');
        if (value) out.push({ doc, page: i, value, quote: lineAround(raw, m.index) });
      }
    });
  }
  return out;
}
const kindsOf = (text, table) => Object.keys(table).filter((k) => table[k].test(text));
function purposeValue(docs, ctx) {
  if (ctx.service && !VALUATION.includes(ctx.service)) return [];
  const main = mainReport(docs);
  const ordered = main ? [main, ...docs.filter((d) => d !== main)] : docs;
  const out = [];
  const purpose = ctx.fields?.purpose;
  const task = assignmentPurpose(ctx.assignment);
  if (task) out.push(...purposeByTask(ordered, task));
  else if (PURPOSE_NAME[purpose]) {
    const ok = [purpose, ...PURPOSE_ALSO[purpose]];
    const seen = new Set();
    for (const e of labelled(ordered, PURPOSE_AT, 200)) {
      const kinds = kindsOf(e.value, PURPOSE_KIND);
      if (!kinds.length || kinds.some((k) => ok.includes(k)) || seen.has(`${e.doc.name}|${e.page}`)) continue;
      seen.add(`${e.doc.name}|${e.page}`);
      out.push({ doc: e.doc, page: e.page, quote: e.quote, text: `Цель оценки в отчёте — «${e.value.slice(0, 80)}» (${kinds.map((k) => PURPOSE_NAME[k]).join('; ')}), а в заявке — «${PURPOSE_NAME[purpose]}»: цель должна быть как в заявке` });
    }
  }
  const kinds = labelled(ordered, KIND_AT, 120).map((e) => ({ ...e, kinds: kindsOf(e.value, VALUE_KIND) })).filter((e) => e.kinds.length);
  const single = kinds.filter((e) => e.kinds.length === 1).map((e) => ({ ...e, value: e.kinds[0] }));
  const both = (a, b) => kinds.some((e) => e.kinds.includes(a) && e.kinds.includes(b));
  const distinct = [...new Set(single.map((e) => e.value))];
  if (distinct.length === 2 && !both(...distinct)) {
    out.push(...oddOnes(single, (e, ref, where) => `Вид стоимости «${KIND_NAME[e.value]}» не совпадает с «${KIND_NAME[ref]}» ${where} — вид стоимости должен быть один во всём отчёте и в письме`));
  } else out.push(...assignmentKind(kinds, ctx.assignment));
  if (NEED_MARKET.includes(purpose) && kinds.length && !kinds.some((e) => e.kinds.includes('market'))) {
    const e = kinds[0];
    out.push({ doc: e.doc, page: e.page, quote: e.quote, text: `В отчёте вид стоимости — ${e.kinds.map((k) => `«${KIND_NAME[k]}»`).join(', ')}, а для цели заявки «${PURPOSE_NAME[purpose]}» нужна рыночная стоимость` });
  }
  return out;
}

// ——— 2.287: цель оценки — как в задании на оценку, письме заказчика или определении суда, приложенных к делу ———
// Цель в задании — после «цель оценки» / «предполагаемое использование результатов»; определение суда без такой строки —
// цель «для суда». Задание важнее заявки: когда цель в задании есть, с заявкой не сверяем. Приложенные документы с разными
// целями — молчим: какая верная, решает эксперт. Совместимые цели (раздел через суд, ипотека при покупке) — не в счёт.
export function assignmentPurpose(assignment) {
  const got = [];
  for (const d of assignment ?? []) {
    if (!Array.isArray(d.pages)) continue;
    const head = d.pages.slice(0, 2).join('\n');
    if (EGRN_NAME.test(head) && /выписк/iu.test(head)) continue;
    const found = labelled([d], PURPOSE_AT, 200).map((e) => ({ page: e.page, value: e.value, kinds: kindsOf(e.value, PURPOSE_KIND) })).filter((e) => e.kinds.length);
    const what = assignmentWhat(d);
    if (found.length) {
      const kinds = Object.keys(PURPOSE_KIND).filter((k) => found.some((e) => e.kinds.includes(k)));
      got.push({ kinds, value: found[0].value, name: d.name, page: found[0].page, what });
    } else if (what === 'в определении суда') got.push({ kinds: ['court'], value: 'для суда', name: d.name, page: 0, what });
  }
  const sets = [...new Set(got.map((g) => g.kinds.join('+')))];
  return sets.length === 1 ? got[0] : null;
}
// 2.291: цель заявки совместима с целью задания (раздел через суд, ипотека при покупке) — как сверяет purposeByTask.
export const purposeFits = (task, purpose) => task.kinds.some((k) => k === purpose || PURPOSE_ALSO[k].includes(purpose));
// 2.301: какие цели названы в тексте (строка «Для чего нужна оценка» таблицы задания черновика).
export const purposeKinds = (text) => kindsOf(String(text ?? ''), PURPOSE_KIND);
function purposeByTask(docs, task) {
  const ok = new Set(task.kinds.flatMap((k) => [k, ...PURPOSE_ALSO[k]]));
  const out = [];
  const seen = new Set();
  for (const e of labelled(docs, PURPOSE_AT, 200)) {
    const kinds = kindsOf(e.value, PURPOSE_KIND);
    if (!kinds.length || kinds.some((k) => ok.has(k)) || seen.has(`${e.doc.name}|${e.page}`)) continue;
    seen.add(`${e.doc.name}|${e.page}`);
    // 2.293: цель целиком меняется на цель из задания (`flip: 'text'`, public/draftfind.js); обрезанная по длине — нет.
    const whole = e.value.length < 200 && task.value.length < 200;
    const fix = whole ? { bad: e.value, right: task.value, from: `${task.what} «${task.name}»`, flip: 'text' } : null;
    out.push({ doc: e.doc, page: e.page, quote: e.quote, ...(fix ? { fix } : {}),
      text: `Цель оценки в отчёте — «${e.value.slice(0, 80)}» (${kinds.map((k) => PURPOSE_NAME[k]).join('; ')}), а ${task.what} «${task.name}» — «${task.value.slice(0, 80)}» (стр. ${task.page + 1}); цель берётся из задания — исправьте отчёт или приложите к делу новое задание` });
  }
  return out;
}

// ——— 2.288: заказчик оценки — как в задании на оценку (письме заказчика), а без него — как в заявке ———
// Заказчик — после «Заказчик» / «Заказчик оценки» с двоеточием или тире (определение «Заказчик — лицо, …» с маленькой буквы
// не в счёт). Человек сверяется по фамилии и первой букве имени (падеж фамилии не важен), организация — по названию в
// кавычках. Задание важнее заявки; задания с разными заказчиками и определение суда (суд — не заказчик) — молчим. С заявкой
// сверяем, только когда в отчёте заказчик — человек, а в заявке — он же владелец заявки (ctx.customer): представитель
// организации в заявке — обычное дело; цель «для суда» — тоже не сверяем.
const CUSTOMER_AT = /(?<![а-яё])заказчик(?:\s+оценки)?(?:\s+работ)?\s*[:\-–—]+\s*/giu;
const CUSTOMER_END = /\n|;|,\s*(?:ИНН|ОГРН|КПП|паспорт|адрес|зарегистр|дата\s+рожд|тел|проживающ|место\s+нахожд|юридическ|почтов)/iu;
const ORG_FORM = /(?<![А-ЯЁа-яё])(?:ООО|ОАО|ЗАО|ПАО|АО|ИП|НКО|ГБУ|ГУП|МУП|ФГУП|общество\s+с\s+ограниченной\s+ответственностью|акционерное\s+общество|публичное\s+акционерное\s+общество|индивидуальный\s+предприниматель|банк)(?![А-ЯЁа-яё])/iu;
const PERSON_LEAD = /^(?:физическое\s+лицо|гражданин(?:ка)?(?:\s+РФ)?|гр\.)\s*/iu;
const surnameStem = (w) => w.toLowerCase().replace(/ё/gu, 'е').replace(/(?:ому|ого|ым|ой|ую|ом|ей|а|у|е|ы)$/u, '');
export function customerOf(value) {
  const v = clean(value).replace(/[.,]+$/u, '');
  if (!v || /заполн/iu.test(v)) return null;
  const q = v.match(/[«"„“]([^»"“”]{2,80})[»"“”]/u);
  if (ORG_FORM.test(v) || q) {
    const key = (q ? q[1] : v.replace(ORG_FORM, '')).toLowerCase().replace(/ё/gu, 'е').replace(/[^а-яa-z0-9]+/giu, ' ').trim();
    return key ? { org: true, key, value: v.slice(0, 120) } : null;
  }
  const p = v.replace(PERSON_LEAD, '');
  if (!/^[А-ЯЁ]/u.test(p)) return null;
  const words = p.match(/[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?|[А-ЯЁ]\./gu) ?? [];
  if (!words.length || words[0].length < 3 || words[0].endsWith('.')) return null;
  return { org: false, surname: surnameStem(words[0]), initial: words[1]?.[0] ?? null, value: p.slice(0, 120) };
}
export function sameCustomer(a, b) {
  if (a.org !== b.org) return false;
  if (a.org) return a.key === b.key || a.key.includes(b.key) || b.key.includes(a.key);
  return a.surname === b.surname && (!a.initial || !b.initial || a.initial === b.initial);
}
function customersIn(docs) {
  const out = [];
  for (const doc of docs) {
    eachPage(doc, (raw, i) => {
      for (const m of raw.matchAll(CUSTOMER_AT)) {
        if (TOC_END.test(lineAround(raw, m.index))) continue;
        const rest = raw.slice(m.index + m[0].length, m.index + m[0].length + 200);
        const cut = rest.search(CUSTOMER_END);
        const who = customerOf(cut < 0 ? rest : rest.slice(0, cut));
        if (who) out.push({ doc, page: i, who, quote: lineAround(raw, m.index) });
      }
    });
  }
  return out;
}
// 2.301: заказчики, названные в тексте черновика строками «Заказчик: …» / «Заказчик — …».
export const customersInText = (text) => customersIn([{ name: '', pages: [String(text ?? '')] }]).map((x) => x.who);
export function assignmentCustomer(assignment) {
  const got = [];
  for (const d of assignment ?? []) {
    if (!Array.isArray(d.pages)) continue;
    const head = d.pages.slice(0, 2).join('\n');
    if (EGRN_NAME.test(head) && /выписк/iu.test(head)) continue;
    const what = assignmentWhat(d);
    if (what === 'в определении суда') return null;
    const found = customersIn([d])[0];
    if (found) got.push({ who: found.who, name: d.name, page: found.page, what });
  }
  if (!got.length || got.some((g) => !sameCustomer(g.who, got[0].who))) return null;
  return got[0];
}
function customerMatch(docs, ctx) {
  if (ctx.service && !VALUATION.includes(ctx.service)) return [];
  const main = mainReport(docs);
  const ordered = main ? [main, ...docs.filter((d) => d !== main)] : docs;
  const task = assignmentCustomer(ctx.assignment);
  const mine = !task && ctx.fields?.purpose !== 'court' && !(ctx.assignment ?? []).some((d) => Array.isArray(d.pages) && assignmentWhat(d) === 'в определении суда')
    ? customerOf(ctx.customer ?? '') : null;
  const ref = task?.who ?? (mine && !mine.org ? mine : null);
  if (!ref) return [];
  const out = [];
  const seen = new Set();
  for (const e of customersIn(ordered)) {
    if ((!task && e.who.org) || sameCustomer(e.who, ref) || seen.has(`${e.doc.name}|${e.page}`)) continue;
    seen.add(`${e.doc.name}|${e.page}`);
    out.push(task
      // 2.294: заказчик целиком меняется на заказчика из задания как есть (`flip: 'name'`, public/draftfind.js); обрезанный — нет.
      ? { doc: e.doc, page: e.page, quote: e.quote, fix: { bad: e.who.value, right: task.who.value, from: `${task.what} «${task.name}»`,
        ...(e.who.value.length < 120 && task.who.value.length < 120 ? { flip: 'name' } : {}) },
        text: `Заказчик в отчёте — «${e.who.value}», а ${task.what} «${task.name}» — «${task.who.value}» (стр. ${task.page + 1}); заказчик берётся из задания — исправьте отчёт или приложите к делу новое задание` }
      : { doc: e.doc, page: e.page, quote: e.quote,
        text: `Заказчик в отчёте — «${e.who.value}», а в заявке — «${ref.value}»: проверьте заказчика; если он другой — приложите к делу задание на оценку` });
  }
  return out;
}

// ——— 2.307: при оценке для банка предполагаемый пользователь результатов оценки — банк из заявки ———
// Пользователь — после «предполагаемый пользователь (результатов оценки, отчёта)» / «пользователь результатов оценки».
// Банк — из заявки (поле bank: Сбербанк), а для «другого банка» — из строки о пользователе в задании на оценку, если она
// там есть. Цель «банк» — по заявке или по заданию на оценку. Пользователь в отчёте не назван вовсе — тоже находка: в
// задании на оценку предполагаемые пользователи обязательны (ФСО III), а банк смотрит, что отчёт для него. Несколько
// пользователей («заказчик и ПАО Сбербанк») — нужный банк среди них, этого довольно.
const USER_AT = /предполагаем\S*\s+пользовател\S*(?:\s*\([^)\n]{0,30}\))?(?:\s+(?:результат\S*|оценк\S*|отч[её]т\S*|об|и)(?![а-яё])){0,5}|(?<!предполагаем\S*\s)пользовател\S*\s+результат\S*\s+оценки(?:\s+(?:и|об)\s+отч[её]т\S*)?/giu;
const BANKS = [
  { id: 'sber', re: /сбер/iu, name: 'ПАО Сбербанк' },
  { id: 'vtb', re: /(?<![А-ЯЁ])ВТБ(?![А-ЯЁ])/u },
  { id: 'gpb', re: /газпромбанк/iu },
  { id: 'alfa', re: /альфа[\s-]*банк/iu },
  { id: 'rshb', re: /россельхозбанк/iu },
  { id: 'psb', re: /промсвязьбанк|(?<![А-ЯЁ])ПСБ(?![А-ЯЁ])/u },
  { id: 'domrf', re: /дом\.?\s*рф/iu },
  { id: 'sovcom', re: /совкомбанк/iu },
  { id: 'raif', re: /райффайзен/iu },
  { id: 'rosbank', re: /(?<![а-яё])росбанк/iu },
  { id: 'otkr', re: /(?<![а-яё])открыти/iu },
  { id: 'tbank', re: /(?<![А-ЯЁа-яё])т[-\s]?банк|тинькофф/iu },
  { id: 'mkb', re: /(?<![А-ЯЁ])МКБ(?![А-ЯЁ])|московский\s+кредитный/iu },
  { id: 'uralsib', re: /уралсиб/iu },
];
const ANY_BANK = /банк|(?<![А-ЯЁ])(?:ВТБ|ПСБ|МКБ)(?![А-ЯЁ])|кредитн\S*\s+организац|дом\.?\s*рф/iu;
// 2.311: какие банки названы в тексте (строка о пользователе в таблице задания черновика).
export const banksIn = (text) => BANKS.filter((b) => b.re.test(text)).map((b) => b.id);
export const usersIn = (docs) => labelled(docs, USER_AT, 160).filter((e) => !/^(?:результат|оценки|отч[её]т)/iu.test(e.value));
export function assignmentBank(assignment) {
  const got = [];
  for (const d of assignment ?? []) {
    if (!Array.isArray(d.pages)) continue;
    const head = d.pages.slice(0, 2).join('\n');
    if (EGRN_NAME.test(head) && /выписк/iu.test(head)) continue;
    const e = usersIn([d]).find((x) => banksIn(x.value).length === 1);
    if (e) got.push({ id: banksIn(e.value)[0], value: e.value, name: d.name, page: e.page, what: assignmentWhat(d) });
  }
  return got.length && got.every((g) => g.id === got[0].id) ? got[0] : null;
}
function bankUser(docs, ctx) {
  if (ctx.service && !VALUATION.includes(ctx.service)) return [];
  const fields = ctx.fields ?? {};
  if (fields.purpose !== 'bank' && !assignmentPurpose(ctx.assignment)?.kinds.includes('bank')) return [];
  const main = mainReport(docs);
  if (!main) return [];
  const ordered = [main, ...docs.filter((d) => d !== main)];
  const task = fields.bank === 'sber' ? null : assignmentBank(ctx.assignment);
  const ref = fields.bank === 'sber' ? { id: 'sber', value: 'ПАО Сбербанк', from: MINE, where: 'в заявке банк — «Сбербанк»' }
    : task ? { id: task.id, value: task.value, from: `${task.what} «${task.name}»`, where: `${task.what} «${task.name}» — «${task.value.slice(0, 80)}» (стр. ${task.page + 1})` } : null;
  const users = usersIn(ordered);
  if (!users.length) {
    const who = ref ? `банк — ${ref.id === 'sber' ? 'ПАО Сбербанк' : `«${ref.value.slice(0, 80)}»`}` : 'банк, для которого отчёт';
    return [{ doc: main, page: 0, quote: '', text: `В отчёте не указан предполагаемый пользователь результатов оценки — оценка для банка: укажите пользователем ${who}` }];
  }
  const out = [];
  const seen = new Set();
  for (const e of users) {
    if (seen.has(`${e.doc.name}|${e.page}`)) continue;
    const named = banksIn(e.value);
    let text = null;
    if (ref && !named.includes(ref.id)) {
      text = `Предполагаемый пользователь в отчёте — «${e.value.slice(0, 80)}», а ${ref.where}: при оценке для банка пользователь результатов — этот банк; исправьте отчёт`;
    } else if (!ref && fields.bank === 'other' && named.length && named.every((b) => b === 'sber')) {
      text = `Предполагаемый пользователь в отчёте — «${e.value.slice(0, 80)}», а в заявке — другой банк, не Сбербанк: проверьте, для какого банка отчёт`;
    } else if (!ref && !ANY_BANK.test(e.value)) {
      text = `Предполагаемый пользователь в отчёте — «${e.value.slice(0, 80)}», а оценка для банка: назовите пользователем банк, для которого отчёт`;
    }
    if (!text) continue;
    seen.add(`${e.doc.name}|${e.page}`);
    // Пользователь целиком меняется на банк (`flip: 'name'`, public/draftfind.js); длинный или обрезанный — нет.
    const fix = ref && e.value.length < 120 ? { bad: e.value, right: ref.id === 'sber' ? 'ПАО Сбербанк' : ref.value, from: ref.from, ...(ref.value.length < 120 ? { flip: 'name' } : {}) } : null;
    out.push({ doc: e.doc, page: e.page, quote: e.quote, ...(fix ? { fix } : {}), text });
  }
  return out;
}

// ——— 2.278: вид стоимости — как в задании на оценку, письме заказчика или определении суда, приложенных к делу ———
// В задании вид стоимости — после «вид стоимости», а без такой строки — «определить рыночную стоимость» (кадастровая в
// тексте письма — не вид стоимости). Приложенные документы с разными видами — молчим: какой верный, решает эксперт. В отчёте
// виды стоимости по всем строкам «вид стоимости»; если они уже расходятся между собой (находка выше) — с заданием не сверяем.
const KIND_STEM = { market: 'рыночн', liquidation: 'ликвидационн', investment: 'инвестиционн', cadastral: 'кадастров', utilization: 'утилизационн' };
const TASK_KIND = /((?:рыночн|ликвидационн|инвестиционн|утилизационн)\S*(?:\s*(?:,|и|а\s+также)\s+(?:рыночн|ликвидационн|инвестиционн|утилизационн)\S*)*)\s+стоимост/giu;
export const kindList = (list) => list.map((k) => KIND_NAME[k]).join(' и ');
export function assignmentKinds(assignment) {
  const got = [];
  for (const d of assignment ?? []) {
    if (!Array.isArray(d.pages)) continue;
    const head = d.pages.slice(0, 2).join('\n');
    if (EGRN_NAME.test(head) && /выписк/iu.test(head)) continue;
    let found = labelled([d], KIND_AT, 120).map((e) => ({ page: e.page, kinds: kindsOf(e.value, VALUE_KIND) })).filter((e) => e.kinds.length);
    if (!found.length) {
      eachPage(d, (raw, i) => {
        for (const m of raw.matchAll(TASK_KIND)) {
          if (/(?:определ|оцен|рассчит|установ|расч[её]т)/iu.test(lineBefore(raw, m.index, 120))) found.push({ page: i, kinds: kindsOf(m[1], VALUE_KIND) });
        }
      });
    }
    if (!found.length) continue;
    const kinds = Object.keys(VALUE_KIND).filter((k) => found.some((e) => e.kinds.includes(k)));
    got.push({ kinds, name: d.name, page: found[0].page, what: assignmentWhat(d) });
  }
  const sets = [...new Set(got.map((g) => g.kinds.join('+')))];
  return sets.length === 1 ? got[0] : null;
}
function assignmentKind(reportKinds, assignment) {
  if (!reportKinds.length) return [];
  const task = assignmentKinds(assignment);
  if (!task) return [];
  const mine = Object.keys(VALUE_KIND).filter((k) => reportKinds.some((e) => e.kinds.includes(k)));
  if (mine.join('+') === task.kinds.join('+')) return [];
  const e = reportKinds[0];
  const from = `${task.what} «${task.name}»`;
  // Один вид и там и там — слово в отчёте меняется на слово из задания в той же форме (`flip: 'value'`, public/draftfind.js).
  const word = e.value.match(new RegExp(`[А-Яа-яЁё]*(?:${Object.values(KIND_STEM).join('|')})[А-Яа-яЁё]*`, 'iu'))?.[0];
  const fix = word ? { bad: word, right: kindList(task.kinds), from, ...(mine.length === 1 && task.kinds.length === 1 ? { flip: 'value' } : {}) } : null;
  return [{ doc: e.doc, page: e.page, quote: e.quote, fix,
    text: `Вид стоимости в отчёте — «${kindList(mine)}», а ${task.what} «${task.name}» — «${kindList(task.kinds)}» (стр. ${task.page + 1}); вид стоимости берётся из задания — исправьте отчёт или приложите к делу новое задание` }];
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
  report_number: (docs, ctx) => [...reportNumbers(docs), ...numberRepeats(docs, ctx)],
  value_date: valueDates,
  purpose_value: purposeValue,
  customer_match: customerMatch,
  bank_user: bankUser,
  encumbrance_match: encumbranceMatch,
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
  area_same: areaSame,
  floor_match: floorMatch,
  building_match: buildingMatch,
  use_match: useMatch,
  room_kind_match: roomKindMatch,
  cad_value_match: cadValueMatch,
  rights_match: rightsMatch,
  share_match: shareMatch,
  share_egrn_match: shareEgrnMatch,
  egrn_doc_match: egrnDocMatch,
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
  cadastral_match: 'кадастровый номер в отчёте — как в выписке ЕГРН из дела, а без неё — как в заявке',
  address_match: 'адрес объекта одинаков по всему отчёту и как в выписке ЕГРН, задании на оценку и заявке: населённый пункт, улица, дом, корпус, квартира, участок',
  area_match: 'площадь объекта в отчёте — как в выписке ЕГРН из дела, а без неё — как в заявке',
  area_same: 'площадь объекта одна во всём отчёте: в описании, расчёте и итоге',
  floor_match: 'этаж и этажность дома в отчёте — как в выписке ЕГРН из дела, а без неё — как в заявке',
  building_match: 'год постройки и материал стен дома в отчёте — как в выписке ЕГРН на здание из дела, а год без неё — как в заявке',
  use_match: 'назначение помещения или дома (жилое / нежилое) в отчёте — как в выписке ЕГРН на объект из дела, а без неё — как в заявке',
  room_kind_match: 'вид жилого помещения (квартира / комната) в отчёте — как в выписке ЕГРН на объект из дела, а без неё — как в заявке',
  cad_value_match: 'кадастровая стоимость объекта в отчёте — как в выписке ЕГРН из дела (если в отчёте своя дата «по состоянию на» — с той же датой)',
  rights_match: 'правообладатель и вид права (собственность, общая долевая, общая совместная) в отчёте — как в выписке ЕГРН на объект из дела',
  encumbrance_match: 'ограничения и обременения из выписки ЕГРН на объект (ипотека, арест, запрещение регистрации, аренда, сервитут, доверительное управление) упомянуты в отчёте',
  share_match: 'размер доли в отчёте — как в заявке',
  share_egrn_match: 'размер доли в отчёте — одна из долей в выписке ЕГРН на объект из дела',
  egrn_doc_match: 'номер и дата выписки ЕГРН в отчёте (перечень документов, задание, приложения) — как у выписки в деле',
  land_match: 'категория земель и вид разрешённого использования — как в заявке',
  inspection: '«без осмотра» и дата осмотра одновременно',
  court_purpose: 'цель «для суда» и отказ являться в суд',
  dossier_appraiser: 'аттестат, СРО и полисы сходятся с досье эксперта: номера, суммы, срок на дату отчёта',
  dossier_education: 'диплом эксперта сходится с досье',
  required_items: 'обязательные сведения отчёта по ст. 11 закона об оценке и ФСО',
  court_order: 'по определению суда — номер определения и ст. 307 УК РФ',
  vin_match: 'VIN в отчёте — как в заявке',
  date_order: 'дата составления отчёта не раньше даты оценки',
  report_dates: 'даты по всему отчёту: осмотр не позже составления, составление и дата оценки не позже подписи, составление не раньше задания на оценку и не позже срока из него, дата оценки не раньше осмотра, одна дата осмотра и в дни фото осмотра или выезда помощника в деле, объявления аналогов не позже даты оценки',
  reg_match: 'госномер в отчёте — как в заявке',
  mileage_match: 'пробег в отчёте — как в заявке (с запасом 10%)',
  approach_weights: 'веса подходов в согласовании в сумме 1',
  analog_list: 'аналогов не меньше трёх, ссылки у разных аналогов не повторяются',
  analog_match: 'аналоги в отчёте — как подтверждённые в деле: ссылка, цена, площадь, число аналогов; у каждого номера — своя ссылка и своя цена',
  purchase_match: 'дата и цена покупки товара — как в заявке',
  questions_answered: 'каждый вопрос заявки найден в выводах',
  final_value: 'итоговая стоимость одна на титуле, в задании, выводах, итоговой таблице и в сопроводительном письме',
  report_number: 'номер отчёта и дата составления одни на титуле, в колонтитулах и в сопроводительном письме; такого номера не было в другом деле эксперта этого года',
  value_date: 'дата оценки одна по всему отчёту и в сопроводительном письме и такая же, как в задании на оценку (письме заказчика, определении суда), если оно приложено к делу',
  purpose_value: 'цель оценки — как в задании на оценку, если оно приложено к делу, иначе как в заявке; вид стоимости один по всему отчёту и в письме и как в задании на оценку, если оно приложено к делу; для суда, нотариуса, банка, сделки и раздела — рыночная',
  customer_match: 'заказчик оценки в отчёте и в письме — как в задании на оценку (письме заказчика), если оно приложено к делу, иначе как в заявке',
  bank_user: 'при оценке для банка предполагаемый пользователь результатов оценки в отчёте — банк из заявки (Сбербанк) или из задания на оценку',
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
      ...(f.egrn ? { egrn: { doc_id: f.egrn.doc, file: f.egrn.name, where: `стр. ${f.egrn.page + 1}`, quote: clean(f.egrn.quote).slice(0, 200),
        // 2.229: что в отчёте разошлось с выпиской и что в выписке — «Исправить в черновике» ищет это место в тексте черновика.
        ...(f.fix ? { bad: clean(f.fix.bad).slice(0, 200), right: clean(f.fix.right).slice(0, 200), ...(f.fix.flip ? { flip: f.fix.flip } : {}) } : {}) } } : {}),
      // 2.231: находка сверена с заявкой или заданием на оценку, а не с выпиской — то же «Исправить в черновике», без выписки.
      // 2.364: сумма прописью не та, что цифрами — «Исправить в черновике» выделяет слова и говорит, как верно.
      ...(f.words ? { words: { bad: clean(f.words.bad).slice(0, 200), right: clean(f.words.right).slice(0, 200) } } : {}),
      // 2.373: дата осмотра не та, что у осмотра в деле, — «Заменить на дату осмотра из дела».
      ...(f.shot ? { shot: { bad: clean(f.shot.bad).slice(0, 200), right: f.shot.right } } : {}),
      ...(f.fix?.from && !f.egrn ? { fix: { bad: clean(f.fix.bad).slice(0, 200), right: clean(f.fix.right).slice(0, 200), from: clean(f.fix.from).slice(0, 200), ...(f.fix.flip ? { flip: f.fix.flip } : {}) } } : {}),
    }));
  }
  return res;
}

// ——— мелочи ———
// 2.231: откуда верное значение у находки без выписки ЕГРН — для «Исправить в черновике».
const MINE = 'в заявке';
function eachPage(doc, fn) { (doc.pages ?? []).forEach((p, i) => fn(p, i)); }
function clean(s) { return String(s ?? '').replace(/\s+/g, ' ').trim(); }
function fmt(n) { return Number(n).toLocaleString('ru-RU').replace(/ /g, ' '); }
function lineStart(page, index) { return page.lastIndexOf('\n', index) + 1; }
function lineAround(page, index) {
  const start = page.lastIndexOf('\n', index) + 1;
  const end = page.indexOf('\n', index);
  return clean(page.slice(start, end < 0 ? undefined : end)).slice(0, 200);
}
