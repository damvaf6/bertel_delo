// Место в черновике для находки ИИ-проверки по выписке ЕГРН (2.229): где в тексте черновика стоит значение, которое
// разошлось с выпиской («45,1», кадастровый номер, этаж, адрес, год, материал стен); 2.231 — с заявкой или заданием на
// оценку (и дата оценки). Значение ищется целым словом или
// числом; если в тексте оно встречается не раз — берётся то, чья строка больше всего похожа на строку отчёта из находки.
// Короткое число (этаж, «5») без похожей строки не ищется — иначе выделится любое «5» в тексте.
// Без импортов: тот же модуль проверяется серверными тестами (tests/server/draft.test.mjs).
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
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
  // 2.231: дата оценки «01.10.2026» — и так, и словами: «01» октября 2026, 1 октября 2026 г.
  const d = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(v);
  if (d) {
    const day = `(?:0?${Number(d[1])})`;
    const month = MONTHS[Number(d[2]) - 1];
    const spelled = month ? `|[«"]?${day}[»"]?\\s+${month}\\s+${d[3]}` : '';
    return new RegExp(`(?<![\\d.])(?:${day}\\.${d[2]}\\.${d[3]}${spelled})(?![\\d])`, 'giu');
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

// 2.232: «Заменить на значение из выписки» — чем заменить найденное значение; null — заменять одной кнопкой нельзя:
// в выписках несколько годов («1984 или 1985»), материал стен словом (род и падеж в тексте свои), пустое значение.
// Разделитель дробной части — как в тексте черновика («45.1» → «47.3»).
export function swapValue(g, found) {
  const right = String(g?.right ?? '').replace(/\s+/g, ' ').trim();
  const bad = String(g?.bad ?? '');
  // 2.260: «нежилое» ↔ «жилое» (2.259, `flip: 'не'`) — та же форма слова: приставка снимается или ставится у того, что в тексте.
  if (g?.flip === 'не' && right) return flipNe(String(found ?? bad));
  // 2.267: «квартира» ↔ «комната» (`flip: 'kind'`) — окончание и заглавная — как у того, что в тексте.
  if (g?.flip === 'kind' && right) return flipKind(String(found ?? bad));
  // 2.278: вид стоимости из задания (`flip: 'value'`): «ликвидационной» → «рыночной» — окончание и заглавная как в тексте.
  if (g?.flip === 'value' && right) return flipValue(String(found ?? bad), right);
  if (!right || / или /.test(right) || !/\d/.test(bad) || right.length > 200) return null;
  // 2.274: дата оценки из задания — в той же записи, что в тексте: «01» октября 2026 → «03» октября 2026.
  const day = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(right);
  if (day && found) return dateLike(day, String(found));
  const num = /^\d[\d\s]*([,.])\d+$/;
  const was = num.exec(String(found ?? ''));
  return was && num.test(right) ? right.replace(/[,.]/, was[1]) : right;
}

function dateLike([, dd, mm, yyyy], found) {
  const m = /^([«"]?)(\d{1,2})([»"]?)(\s+)\p{L}+(\s+)\d{4}$/u.exec(found);
  if (!m) return `${dd}.${mm}.${yyyy}`;
  const d = m[2].length === 2 ? dd : String(Number(dd));
  return `${m[1]}${d}${m[3]}${m[4]}${MONTHS[Number(mm) - 1]}${m[5]}${yyyy}`;
}

function flipKind(word) {
  const m = /^(квартир|комнат)(\p{L}*)$/iu.exec(word);
  if (!m) return null;
  const stem = /^квартир$/iu.test(m[1]) ? 'комнат' : 'квартир';
  return `${/^\p{Lu}/u.test(word) ? stem[0].toUpperCase() + stem.slice(1) : stem}${m[2]}`;
}

const VALUE_STEM = /^(рыночн|ликвидационн|инвестиционн|кадастров|утилизационн)(\p{L}*)$/iu;
function flipValue(word, right) {
  const m = VALUE_STEM.exec(word);
  const to = VALUE_STEM.exec(right)?.[1].toLowerCase();
  if (!m || !to) return null;
  if (word === word.toUpperCase()) return `${to}${m[2]}`.toUpperCase();
  return `${/^\p{Lu}/u.test(word) ? to[0].toUpperCase() + to.slice(1) : to}${m[2]}`;
}

function flipNe(word) {
  if (!/^\p{L}+$/u.test(word)) return null;
  if (/^не/iu.test(word)) { const rest = word.slice(2); return /^Н/u.test(word) ? rest[0].toUpperCase() + rest.slice(1) : rest; }
  return /^\p{Lu}/u.test(word) ? `Не${word[0].toLowerCase()}${word.slice(1)}` : `не${word}`;
}

// 2.246: «Заменить всё по выписке» — все замены одним проходом по тексту: items — [{ g, quote }] (находки по выписке ЕГРН).
// Места ищутся в исходном тексте; два значения на одном месте — заменяется первое. → { body, done: [{ i, from, was, now }]
// (from — уже в новом тексте), missing: [i] — в черновике значения нет или заменить одной кнопкой нельзя }.
export function swapAll(body, items) {
  const text = String(body ?? '');
  const picked = [];
  const missing = [];
  (items ?? []).forEach(({ g, quote }, i) => {
    const at = g?.bad ? findInDraft(text, { bad: g.bad, quote }) : null;
    const was = at && text.slice(at.from, at.to);
    const now = at && swapValue(g, was);
    if (!now || picked.some((p) => at.from < p.to && p.from < at.to)) return missing.push(i);
    picked.push({ i, from: at.from, to: at.to, was, now });
  });
  picked.sort((a, b) => a.from - b.from);
  let out = '';
  let pos = 0;
  const done = picked.map((p) => {
    out += text.slice(pos, p.from);
    const from = out.length;
    out += p.now;
    pos = p.to;
    return { i: p.i, from, was: p.was, now: p.now };
  });
  return { body: out + text.slice(pos), done, missing };
}

// Отмена всех замен: где новое значение ещё стоит на своём месте — возвращается прежнее; где текст уже правили — не
// трогается. → { body, undone: [i], kept: [i] }.
export function unswapAll(body, done) {
  const text = String(body ?? '');
  const undone = [];
  const kept = [];
  let out = '';
  let pos = 0;
  for (const s of [...(done ?? [])].sort((a, b) => a.from - b.from)) {
    if (s.from < pos || text.slice(s.from, s.from + s.now.length) !== s.now) { kept.push(s.i); continue; }
    out += text.slice(pos, s.from) + s.was;
    pos = s.from + s.now.length;
    undone.push(s.i);
  }
  return { body: out + text.slice(pos), undone, kept };
}
