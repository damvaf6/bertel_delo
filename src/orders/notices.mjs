// Извещение об осмотре (2.470, «Ущерб автомобилю после ДТП»). Эксперт сообщает страховой и второму участнику ДТП дату,
// время и место осмотра (образец Word — src/docs/inspection-notice.mjs) и отмечает, как и когда известил. Отмеченные
// извещения — одной строкой в раздел черновика с пометкой notice (у ДТП — «4. Осмотр»): программа вставляет её при
// подготовке черновика ИИ, эксперт — кнопкой в деле; строка узнаётся по началу и заменяется целиком.
import { headKey } from '../dossier/dossier.mjs';

export const HOW = {
  telegram: { name: 'телеграммой' },
  letter: { name: 'заказным письмом с уведомлением' },
  email: { name: 'по электронной почте' },
  messenger: { name: 'сообщением в мессенджере' },
  phone: { name: 'по телефону' },
  hand: { name: 'лично под подпись' },
};
export const NOTICE_HEAD = 'Извещение об осмотре:';
export const NAME_MAX = 200;
export const PLACE_MAX = 300;

const ruDate = (d) => String(d).slice(0, 10).split('-').reverse().join('.');
// Момент осмотра по Москве → { date: 'ГГГГ-ММ-ДД', time: 'ЧЧ:ММ' }.
export function mskParts(at) {
  const s = new Date(new Date(at).getTime() + 3 * 3600 * 1000).toISOString();
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}
export const whenRu = (at) => { const p = mskParts(at); return `${ruDate(p.date)} в ${p.time}`; };

// Строка в черновик по отмеченным извещениям; нет отмеченных — null. Осмотров с разным временем или местом (перенесли) —
// каждый своей частью, по порядку.
export function noticeLine(list, parties) {
  const marked = list.filter((n) => n.how && n.sent_on);
  if (!marked.length) return null;
  const partyName = (id) => { const s = parties.find((p) => p.id === id)?.name ?? id; return s[0].toLowerCase() + s.slice(1); };
  const groups = [];
  for (const n of marked) {
    const key = `${new Date(n.inspect_at).getTime()}|${n.place}`;
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push(g = { key, at: n.inspect_at, place: n.place, items: [] });
    g.items.push(`${n.name} (${partyName(n.party)}) — ${HOW[n.how]?.name ?? n.how} ${ruDate(n.sent_on)}`);
  }
  const parts = groups.map((g) => `об осмотре ${whenRu(g.at)}, место — ${g.place.replace(/[.;]+$/, '')}, извещены: ${g.items.join('; ')}`);
  return `${NOTICE_HEAD} ${parts.join('. Также ')}.`;
}

// Строку — в раздел с notice: прежняя строка «Извещение об осмотре: …» заменяется, иначе встаёт сразу под заголовком.
export function placeNotice(body, sections, line) {
  if (!line) return body;
  const lines = body.split('\n');
  const old = lines.findIndex((l) => l.startsWith(NOTICE_HEAD));
  if (old >= 0) { lines[old] = line; return lines.join('\n'); }
  const s = sections.find((x) => x.notice);
  if (!s) return body;
  const m = [...body.matchAll(/^#{1,3}\s*(.+)$/gm)].find((h) => headKey(h[1]) === headKey(s.title));
  if (!m) return body;
  const at = m.index + m[0].length;
  return `${body.slice(0, at)}\n${line}${body.slice(at)}`;
}

export async function loadNotices(sql, orderId) {
  return sql`select id, party, name, inspect_at, place, how, to_char(sent_on, 'YYYY-MM-DD') as sent_on, marked_at, created_at
             from inspection_notices where order_id = ${orderId} order by inspect_at, id`;
}
