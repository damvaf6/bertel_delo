// Оценка задним числом (2.502): дата оценки раньше осмотра (наследство — день открытия наследства, суд — дата из определения).
// По ФСО в отчёте нужно допущение: состояние объекта на дату оценки принято таким же, как на дату осмотра. Строка-допущение —
// в раздел черновика «Допущения и ограничительные условия»: программа вставляет её при подготовке черновика ИИ, эксперт —
// кнопкой у находки ИИ-проверки; строка узнаётся по началу и заменяется. ИИ-проверка — правило retro_basis.
import { headKey } from '../dossier/dossier.mjs';

export const RETRO_HEAD = 'Оценка ретроспективная:';
const ruDate = (d) => String(d).slice(0, 10).split('-').reverse().join('.');

// Дата оценки (ГГГГ-ММ-ДД) и дни осмотра в деле → первый день осмотра позже даты оценки или null.
// Дата оценки — и как в черновике (ДД.ММ.ГГГГ).
export function retroInspection(valueDay, inspectionDays) {
  const m = String(valueDay ?? '').match(/^(?:(\d{4})-(\d{2})-(\d{2})|(\d{2})\.(\d{2})\.(\d{4}))$/);
  if (!m) return null;
  const day = m[1] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[6]}-${m[5]}-${m[4]}`;
  return [...new Set(inspectionDays ?? [])].filter((d) => d > day).sort()[0] ?? null;
}

// Строка-допущение; даты как в отчёте (ДД.ММ.ГГГГ или ГГГГ-ММ-ДД).
export function retroLine(valueDay, inspectDay) {
  const v = /^\d{4}-/.test(valueDay) ? ruDate(valueDay) : valueDay;
  const s = /^\d{4}-/.test(inspectDay) ? ruDate(inspectDay) : inspectDay;
  return `${RETRO_HEAD} дата оценки (${v}) раньше даты осмотра (${s}); состояние объекта на дату оценки принято таким же, как на дату осмотра, — сведений об изменении состояния за это время у оценщика нет. Цены, курсы валют и рыночные данные приняты на дату оценки.`;
}

// Раздел допущений — по названию («Допущения и ограничительные условия»).
export const isAssumptions = (title) => /допущени/iu.test(String(title ?? ''));

// Строку — в раздел допущений: прежняя «Оценка ретроспективная: …» заменяется, иначе встаёт сразу под заголовком.
export function placeRetro(body, sections, line) {
  if (!line) return body;
  const lines = body.split('\n');
  const old = lines.findIndex((l) => l.startsWith(RETRO_HEAD));
  if (old >= 0) { lines[old] = line; return lines.join('\n'); }
  const s = sections.find((x) => isAssumptions(x.title));
  if (!s) return body;
  const m = [...body.matchAll(/^#{1,3}\s*(.+)$/gm)].find((h) => headKey(h[1]) === headKey(s.title));
  if (!m) return body;
  const at = m.index + m[0].length;
  return `${body.slice(0, at)}\n${line}${body.slice(at)}`;
}

// Дни осмотра в деле (по Москве): фото по ссылке владельца и с выезда помощника (по часам телефона, иначе — когда получено)
// и завершённые выезды помощника — как в ИИ-проверке дат (2.146, 2.373).
export async function inspectionDaysOf(sql, orderId) {
  const rows = await sql`
    select to_char(coalesce(p.shot_at, p.received_at) at time zone 'Europe/Moscow', 'YYYY-MM-DD') as day from inspection_photos p
      join documents d on d.id = p.document_id where d.order_id = ${orderId} and d.deleted_at is null
    union
    select to_char(finished_at at time zone 'Europe/Moscow', 'YYYY-MM-DD') from onsite_visits
      where order_id = ${orderId} and finished_at is not null and cancelled_at is null`;
  return [...new Set(rows.map((r) => r.day))].sort();
}
