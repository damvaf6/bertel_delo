// Проверка в реестре уведомлений о залоге движимого имущества (2.491, «Оценка транспорта»). Эксперт проверяет машину по
// VIN в реестре нотариальной палаты и отмечает в деле дату проверки и итог: залога нет или есть — номер уведомления и
// залогодержатель. Итог — одной строкой в раздел черновика с пометкой pledge (у транспорта — «7. Описание объекта»):
// программа вставляет её при подготовке черновика ИИ, эксперт — кнопкой в деле; строка узнаётся по началу и заменяется.
import { headKey } from '../dossier/dossier.mjs';

export const PLEDGE_HEAD = 'Проверка в реестре залогов:';
export const NOTICE_NO_MAX = 60;
export const PLEDGEE_MAX = 300;
export const RESULTS = { none: 'залога нет', found: 'залог есть' };

const ruDate = (d) => String(d).slice(0, 10).split('-').reverse().join('.');

// Строка в черновик; проверки нет — null.
export function pledgeLine(p) {
  if (!p) return null;
  const where = `по данным реестра уведомлений о залоге движимого имущества (reestr-zalogov.ru) на ${ruDate(p.checked_on)}`;
  if (p.result === 'none') return `${PLEDGE_HEAD} ${where} сведений о залоге объекта оценки нет.`;
  return `${PLEDGE_HEAD} ${where} объект оценки находится в залоге — уведомление о возникновении залога № ${p.notice_no}, залогодержатель — ${p.pledgee.replace(/[.;]+$/, '')}.`;
}

// Строку — в раздел с pledge: прежняя строка «Проверка в реестре залогов: …» заменяется, иначе встаёт сразу под заголовком.
export function placePledge(body, sections, line) {
  if (!line) return body;
  const lines = body.split('\n');
  const old = lines.findIndex((l) => l.startsWith(PLEDGE_HEAD));
  if (old >= 0) { lines[old] = line; return lines.join('\n'); }
  const s = sections.find((x) => x.pledge);
  if (!s) return body;
  const m = [...body.matchAll(/^#{1,3}\s*(.+)$/gm)].find((h) => headKey(h[1]) === headKey(s.title));
  if (!m) return body;
  const at = m.index + m[0].length;
  return `${body.slice(0, at)}\n${line}${body.slice(at)}`;
}

export async function loadPledge(sql, orderId) {
  const [p] = await sql`select to_char(checked_on, 'YYYY-MM-DD') as checked_on, result, notice_no, pledgee, updated_at
                        from pledge_checks where order_id = ${orderId}`;
  return p ?? null;
}
