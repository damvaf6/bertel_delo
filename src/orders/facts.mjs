// Строка «Из заявки: …» (2.492). Раздел черновика с facts: [id поля…] получает одной строкой заполненные поля заявки —
// у оценки транспорта двигатель, коробка, привод, цвет, ДТП, владелец и балансовая стоимость в «7. Описание объекта».
// Программа вставляет строку при подготовке черновика ИИ сразу под заголовком; строка узнаётся по началу и заменяется.
import { headKey } from '../dossier/dossier.mjs';

export const FACTS_HEAD = 'Из заявки:';

const NUM = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
// «Мощность двигателя, л. с.» → название «мощность двигателя» и единица «л. с.»; «ДТП» остаётся заглавными.
const lower = (s) => (/^\p{Lu}\p{Ll}/u.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

function factOf(f, v) {
  if (v === undefined || v === null || v === '') return null;
  const [name, unit] = f.label.split(/,\s*(?=[^,]*$)/);
  if (f.type === 'select') {
    const o = f.options.find((x) => x.id === v);
    return o ? `${lower(f.label)} — ${lower(o.name)}` : null;
  }
  if (f.type === 'number') {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    // До 10 000 — без пробела («1998 куб. см»), дальше — по разрядам («1 250 000 руб.»).
    const shown = Math.abs(n) < 10000 ? String(n).replace('.', ',') : NUM.format(n).replace(/\s/g, ' ');
    return `${lower(name)} — ${shown}${unit ? ` ${unit}` : ''}`;
  }
  const t = String(v).replace(/\s+/g, ' ').trim().replace(/[.;]+$/, '');
  return t ? `${lower(f.label)} — ${t}` : null;
}

// Строка для раздела; полей нет или не заполнены — null.
export function factsLine(fields, ids, values) {
  if (!ids?.length) return null;
  const parts = ids.map((id) => fields.find((f) => f.id === id)).filter(Boolean).map((f) => factOf(f, values?.[f.id])).filter(Boolean);
  if (!parts.length) return null;
  const text = parts.join('; ');
  return `${FACTS_HEAD} ${text}${text.endsWith('.') ? '' : '.'}`;
}

// Строку — в раздел с facts: прежняя «Из заявки: …» заменяется, иначе встаёт сразу под заголовком.
export function placeFacts(body, sections, line) {
  if (!line) return body;
  const lines = body.split('\n');
  const old = lines.findIndex((l) => l.startsWith(FACTS_HEAD));
  if (old >= 0) { lines[old] = line; return lines.join('\n'); }
  const s = sections.find((x) => x.facts);
  if (!s) return body;
  const m = [...body.matchAll(/^#{1,3}\s*(.+)$/gm)].find((h) => headKey(h[1]) === headKey(s.title));
  if (!m) return body;
  const at = m.index + m[0].length;
  return `${body.slice(0, at)}\n${line}${body.slice(at)}`;
}
