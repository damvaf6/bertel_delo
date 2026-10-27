// Свой номер отчёта эксперта (пачка 2.411–2.420). Образец — строка с токенами: {N} — порядковый номер за год
// (обязательно, один раз), {ГГГГ} — год, {ГГ} — две последние цифры года; остальное — буквы, цифры, «/», «-», «.», пробел.
// Номера сравниваются без пробелов и регистра — как в сверке 2.116 и перечне для СРО (2.410), похожие латинские буквы — как русские.
import { HttpError } from '../http/core.mjs';
import { isWorkday } from '../orders/holidays.mjs';

export const PATTERN_MAX = 40;
const TOKEN = /\{(N|ГГГГ|ГГ)\}/gu;
const LITERAL = /^[\p{L}\d/\-. ]*$/u;
// Латинские буквы, похожие на русские, — как русские, «Ё» — как «Е» (прогон 2.420): в Word номер «В-14» часто набирают
// латинской «B», и такой номер выпадал из счёта (платформа выдавала тот же номер ещё раз), а ИИ-проверка писала «не тот».
const LOOK = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У' };
const norm = (s) => String(s).replace(/\s+/g, '').toUpperCase().replace(/Ё/g, 'Е').replace(/[ABCEHKMOPTXY]/g, (ch) => LOOK[ch]);
// Ключ номера для сравнения: без пробелов и регистра, похожие латинские — как русские. plainNumber — ещё и без знаков
// («В-14/2026» и «в 14 2026» — один номер), как сверяет ИИ-проверка (2.403, 2.414).
export const numberKey = norm;
export const plainNumber = (s) => norm(s ?? '').replace(/[^\p{L}\d]/gu, '');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Проверка образца: null или пустая строка — нумерации нет. Ошибка — 400 с понятным текстом.
export function patternFrom(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  if (typeof raw !== 'string') throw new HttpError(400, 'bad_pattern', 'Образец номера — строка');
  const p = raw.trim().replace(/\s+/g, ' ');
  if (p.length > PATTERN_MAX) throw new HttpError(400, 'bad_pattern', `Образец номера — не длиннее ${PATTERN_MAX} знаков`);
  const tokens = [...p.matchAll(TOKEN)].map((m) => m[1]);
  if (tokens.filter((t) => t === 'N').length !== 1) throw new HttpError(400, 'bad_pattern', 'В образце должен быть {N} — порядковый номер, один раз');
  if (!LITERAL.test(p.replace(TOKEN, ''))) throw new HttpError(400, 'bad_pattern', 'В образце — только буквы, цифры, «/», «-», «.», пробел и {N}, {ГГГГ}, {ГГ}');
  if (/\{|\}/.test(p.replace(TOKEN, ''))) throw new HttpError(400, 'bad_pattern', 'Неизвестная вставка в фигурных скобках: можно {N}, {ГГГГ}, {ГГ}');
  return p;
}

export const formatNumber = (pattern, n, year) => pattern.replace(TOKEN, (_, t) =>
  t === 'N' ? String(n) : t === 'ГГГГ' ? String(year) : String(year).slice(-2));

// Порядковый номер из номера отчёта по образцу этого года; не по образцу или другой год — null.
export function seqOf(pattern, number, year) {
  const re = new RegExp(`^${norm(pattern).split(TOKEN).map((part, i) => (i % 2
    ? (part === 'N' ? '0*(\\d{1,6})' : part === 'ГГГГ' ? String(year) : String(year).slice(-2))
    : esc(part))).join('')}$`, 'u');
  const m = norm(number).match(re);
  return m ? Number(m[1]) : null;
}

// Образец по последнему номеру отчёта: «145/2026» → «{N}/{ГГГГ}», «О-12-26» → «О-{N}-{ГГ}». Первая группа цифр, которая
// не год, — {N}; год целиком — {ГГГГ}; две последние цифры года в конце или после разделителя — {ГГ}. Не вышло — null.
export function guessPattern(number, year) {
  if (!number) return null;
  const y = String(year);
  let seen = false;
  const p = String(number).trim().replace(/\d+/g, (d, at, s) => {
    if (d === y) return '{ГГГГ}';
    if (seen && d === y.slice(-2)) return '{ГГ}';
    if (!seen) { seen = true; return '{N}'; }
    if (d === y.slice(-2) && at + d.length === s.length) return '{ГГ}';
    return d;
  });
  try { return seen ? patternFrom(p) : null; } catch { return null; }
}

// Следующий номер: наибольший порядковый этого года среди номеров (из файлов отчётов, позже — выданных делам) + 1.
// numbers — [{ number, on, title?, free? }] (usedNumbers, numberPool в ai-ops). last — тот, от которого считали.
// free — номер отменённого дела, который эксперт освободил (2.418): не в счёт наибольшего; меньший из освобождённых, которого
// нет среди занятых, выдаётся раньше «наибольший + 1» — пропуска не будет (freed — чей это номер).
export function nextNumber(pattern, numbers, year) {
  let last = null;
  let max = 0;
  let matched = 0;
  const taken = new Set();
  for (const e of numbers) {
    if (e.free) continue;
    const n = seqOf(pattern, e.number, year);
    if (n == null) continue;
    matched += 1;
    taken.add(n);
    if (n > max) { max = n; last = e; }
  }
  let freed = null;
  for (const e of numbers) {
    const n = e.free ? seqOf(pattern, e.number, year) : null;
    if (n == null || n > max || taken.has(n)) continue;
    if (!freed || n < freed.seq) freed = { seq: n, e };
  }
  if (freed) return { seq: freed.seq, number: formatNumber(pattern, freed.seq, year), last, matched, freed: freed.e };
  return { seq: max + 1, number: formatNumber(pattern, max + 1, year), last, matched };
}

// Номер отчёта, введённый экспертом вручную в деле (2.413): «№» в начале убирается, пробелы сжимаются; те же знаки, что в
// образце, и хотя бы одна цифра. Пустой — null (номер выдастся заново при сборке Word). Ошибка — 400 с понятным текстом.
export const NUMBER_MAX = 40;
export function numberFrom(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  if (typeof raw !== 'string') throw new HttpError(400, 'bad_number', 'Номер отчёта — строка');
  const n = raw.trim().replace(/^№\s*/u, '').replace(/\s+/g, ' ');
  if (!n) return null;
  if (n.length > NUMBER_MAX) throw new HttpError(400, 'bad_number', `Номер отчёта — не длиннее ${NUMBER_MAX} знаков`);
  if (!LITERAL.test(n)) throw new HttpError(400, 'bad_number', 'В номере — только буквы, цифры, «/», «-», «.» и пробел');
  if (!/\d/.test(n)) throw new HttpError(400, 'bad_number', 'В номере отчёта должна быть хотя бы одна цифра');
  return n;
}

export const sameNumber = (a, b) => norm(a) === norm(b);

// Новый год (2.419): счёт этого года — с 1 (в счёт идут только номера этого года). Образец без {ГГГГ}/{ГГ} — номер 1 нового
// года совпадёт с № 1 прошлого; год вписан цифрами («{N}/2026») — номера нового года выйдут с прошлым годом. В январе до
// YEAR_START_DAYS-го рабочего дня включительно (праздники и выходные — по календарю 2.371) — подсказка в «Сегодня»
// эксперту и руководителю, чей это образец; suggest — образец с годом, сохраняется одним нажатием. Остальное время — null.
export const YEAR_START_DAYS = 5;
export function yearStart(today, days = YEAR_START_DAYS) {
  if (!/^\d{4}-01-/.test(today)) return false;
  let n = 0;
  for (let d = 1; d <= Number(today.slice(8, 10)); d += 1) if (isWorkday(`${today.slice(0, 8)}${String(d).padStart(2, '0')}`)) n += 1;
  return n <= days;
}
export function yearHint(pattern, today) {
  if (!pattern || !yearStart(today)) return null;
  const year = Number(today.slice(0, 4));
  const literal = pattern.split(TOKEN).filter((_, i) => i % 2 === 0).join(' ');
  const fixed = literal.match(/(?<!\d)20\d\d(?!\d)/u)?.[0];
  if (fixed && Number(fixed) !== year) {
    return withFirst({ kind: 'fixed', pattern, year, fixed: Number(fixed), first: formatNumber(pattern, 1, year),
      suggest: patternFrom(pattern.replace(new RegExp(`(?<!\\d)${fixed}(?!\\d)`, 'u'), '{ГГГГ}')) });
  }
  if (/\{(ГГГГ|ГГ)\}/u.test(pattern) || fixed) return null;
  const suggest = `${pattern}/{ГГГГ}`;
  return withFirst({ kind: 'no_year', pattern, year, first: formatNumber(pattern, 1, year),
    suggest: suggest.length <= PATTERN_MAX ? patternFrom(suggest) : null });
}
const withFirst = (h) => ({ ...h, suggest_first: h.suggest ? formatNumber(h.suggest, 1, h.year) : null });
