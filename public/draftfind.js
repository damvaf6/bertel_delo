// Место в черновике для находки ИИ-проверки по выписке ЕГРН (2.229): где в тексте черновика стоит значение, которое
// разошлось с выпиской («45,1», кадастровый номер, этаж, адрес, год, материал стен). Значение ищется целым словом или
// числом; если в тексте оно встречается не раз — берётся то, чья строка больше всего похожа на строку отчёта из находки.
// Короткое число (этаж, «5») без похожей строки не ищется — иначе выделится любое «5» в тексте.
// Без импортов: тот же модуль проверяется серверными тестами (tests/server/draft.test.mjs).
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (s) => new Set((String(s ?? '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []));

function pattern(bad) {
  const v = String(bad ?? '').replace(/\s+/g, ' ').trim();
  if (!v) return null;
  // Число: «45,1» = «45.1», «1 234» с любым пробелом; не часть другого числа.
  if (/^\d[\d\s]*(?:[,.]\d+)?$/.test(v)) {
    const [int, frac] = v.split(/[,.]/);
    const body = int.replace(/\s/g, '').split('').map(esc).join('[\\s\\u00a0\\u202f]?');
    return new RegExp(`(?<![\\d,.])${body}${frac ? `[,.]${frac}` : ''}(?![\\d]|[,.]\\d)`, 'gu');
  }
  // Текст: пробелы — любые, регистр не важен, не часть другого слова.
  const body = v.split(' ').map(esc).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu');
}

// → { from, to } или null (в черновике этого значения нет).
export function findInDraft(body, { bad, quote } = {}) {
  const text = String(body ?? '');
  const re = pattern(bad);
  if (!re) return null;
  const want = words(quote);
  let best = null;
  for (const m of text.matchAll(re)) {
    const start = text.lastIndexOf('\n', m.index) + 1;
    const stop = text.indexOf('\n', m.index);
    const line = words(text.slice(start, stop < 0 ? text.length : stop));
    let score = 0;
    for (const w of line) if (want.has(w)) score += 1;
    if (!best || score > best.score) best = { from: m.index, to: m.index + m[0].length, score };
  }
  if (!best) return null;
  const short = /^\d{1,3}$/.test(String(bad).trim());
  return short && best.score === 0 ? null : { from: best.from, to: best.to };
}
