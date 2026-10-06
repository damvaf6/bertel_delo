// Методические разделы из своего прошлого дела (2.65): эксперт берёт в черновик текст разделов с пометкой reuse (стандарты,
// допущения, выбор подходов, методика) из своего последнего черновика по делу той же услуги. Данные прошлого заказчика и
// объекта вычищаются: значения полей прошлой заявки, название, основание, имя заказчика и организации, их даты, а также всё,
// что похоже на VIN, госномер, кадастровый номер, телефон, почту, ИНН и суммы в рублях, — на месте каждого пометка
// «[заполнить: данные этого дела]», чтобы эксперт проверил и вписал своё. Разделы без reuse не трогаются.
import { headKey } from '../dossier/dossier.mjs';

export const PAST_MARK = '[заполнить: данные этого дела]';
const EMPTY = '[заполнить: раздел по этому делу]';

// Разделы текста: заголовок «## …» и всё до следующего заголовка.
export function splitSections(body) {
  const heads = [...body.matchAll(/^#{1,3}\s*(.+)$/gm)];
  return heads.map((h, i) => {
    const start = h.index + h[0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index : body.length;
    return { key: headKey(h[1]), start, end, text: body.slice(start, end).trim() };
  });
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ruDate = (d) => {
  if (!d) return null;
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split('-').reverse().join('.') : null;
};

// Похожее на данные конкретного дела — независимо от того, что заполнял заказчик.
const PATTERNS = [
  /\b[A-HJ-NPR-Z0-9]{17}\b/g,                                                   // VIN
  /\b\d{2}:\d{2}:\d{5,7}:\d{1,7}\b/g,                                           // кадастровый номер
  /(?<![А-ЯЁA-Z0-9])[АВЕКМНОРСТУХABEKMHOPCTYX]\s?\d{3}\s?[АВЕКМНОРСТУХABEKMHOPCTYX]{2}\s?\d{2,3}(?![0-9])/gi, // госномер
  /(?:\+7|\b8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/g,               // телефон
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,                                              // почта
  /\b\d{10,15}\b/g,                                                             // ИНН, ОГРН, СНИЛС, номера счетов
  /\d[\d  ]{2,}(?:[.,]\d{1,2})?[  ]*(?:руб(?:\.|лей|ля|ль)?|₽)/gi,               // суммы
];

// Значения прошлой заявки, которые нельзя переносить: текст полей (не выбор из списка), название, основание, имена, даты.
export function pastValues(registry, past, names = []) {
  const def = registry.service(past.module, past.service);
  const listed = new Set((def?.fields ?? []).filter((f) => f.type === 'select' || f.type === 'checkbox').map((f) => f.id));
  const vals = [];
  for (const [k, v] of Object.entries(past.fields ?? {})) {
    if (listed.has(k) || v === null || typeof v === 'boolean') continue;
    vals.push(String(v));
  }
  vals.push(past.title, past.basis_number, ...names, ruDate(past.basis_date), ruDate(past.deadline), ruDate(past.created_at));
  // Длинное значение (адрес из нескольких частей) вычищается и целиком, и по частям через запятую.
  const out = new Set();
  for (const v of vals.filter(Boolean)) {
    for (const part of [v, ...String(v).split(/[,;\n]/)]) {
      const t = part.replace(/\s+/g, ' ').trim();
      if (t.length >= 3 && /[\p{L}\d]/u.test(t)) out.add(t);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

// Вычистить из текста данные прошлого дела; n — сколько мест заменено.
export function scrub(text, values) {
  let n = 0;
  let out = text;
  for (const v of values) {
    const re = new RegExp(`(?<![\\p{L}\\d])${esc(v).replace(/ /g, '\\s+')}(?![\\p{L}\\d])`, 'giu');
    out = out.replace(re, () => { n += 1; return PAST_MARK; });
  }
  for (const re of PATTERNS) out = out.replace(re, () => { n += 1; return PAST_MARK; });
  return { text: out, n };
}

// Заготовка черновика без ИИ: все разделы с заголовками, в каждом — пометка «заполнить».
export const skeleton = (sections) => sections.map((s) => `## ${s.title}\n${EMPTY}`).join('\n\n');

// В тексте base заменить разделы reuse на текст тех же разделов прошлого черновика. Раздела нет в прошлом или он пустой —
// остаётся как был. Раздела нет в base — добавляется в конце (так же, как cleanDraftAnswer добавляет пропущенные).
export function reuseSections(base, sections, pastBody, values) {
  const past = new Map(splitSections(pastBody).map((s) => [s.key, s.text]));
  let out = base;
  const used = [];
  let marks = 0;
  for (const s of sections.filter((x) => x.reuse)) {
    const key = headKey(s.title);
    const src = past.get(key);
    if (!src) continue;
    const { text, n } = scrub(src, values);
    marks += n;
    used.push(s.title);
    const cur = splitSections(out).find((x) => x.key === key);
    if (cur) out = `${out.slice(0, cur.start)}\n${text}\n\n${out.slice(cur.end).replace(/^\n+/, '')}`;
    else out = `${out.trimEnd()}\n\n## ${s.title}\n${text}`;
  }
  return { body: out.trim(), used, marks };
}
