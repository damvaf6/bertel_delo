// Заказчик молчит (2.375): последнее сообщение эксперта заказчику в переписке дела, после него заказчик ничего не написал,
// и прошло 2 дня и дольше. Сообщения диспетчера не в счёт — ни как вопрос, ни как ответ. Напоминание эксперт отправляет
// сам готовой фразой (src/orders/phrases.mjs); отправил — отсчёт начинается заново.
// Прогон 2.380: 2 дня — рабочих, по Москве: выходные и нерабочие праздники (2.371, src/orders/holidays.mjs) не в счёт —
// в эти дни заказчик не работает, и напоминать ему после выходных или новогодних каникул рано.
import { isWorkday } from './holidays.mjs';

export const SILENT_DAYS = 2;

const MSK = 3 * 3600_000;
const DAY = 86400_000;
const isoOf = (t) => new Date(t).toISOString().slice(0, 10);

// Сколько миллисекунд рабочих дней (по Москве) прошло от from до to.
export function workingMs(from, to) {
  let t = new Date(from).getTime() + MSK;
  const end = new Date(to).getTime() + MSK;
  let ms = 0;
  while (t < end) {
    const next = Math.min(end, Math.floor(t / DAY) * DAY + DAY);
    if (isWorkday(isoOf(t))) ms += next - t;
    t = next;
  }
  return ms;
}

// Момент, от которого до now прошло ms рабочего времени (для тестов и подсказок): workingMs(workingAgo(ms, now), now) === ms.
export function workingAgo(ms, now = new Date()) {
  let t = new Date(now).getTime() + MSK;
  let left = ms;
  while (left > 0) {
    const start = Math.floor((t - 1) / DAY) * DAY;
    const part = t - start;
    if (isWorkday(isoOf(start))) {
      if (part >= left) return new Date(t - left - MSK);
      left -= part;
    }
    t = start;
  }
  return new Date(t - MSK);
}

// orderIds — дела, где это важно (в работе и на проверке). Ответ — Map: order_id → { at, body, count }:
// время и текст последнего сообщения эксперта, сколько его сообщений подряд без ответа заказчика.
export async function customerSilent(sql, orderIds, now = new Date()) {
  if (!orderIds.length) return new Map();
  const rows = await sql`
    select m.order_id, max(m.at) as at, count(*)::int as count,
           (array_agg(m.body order by m.id desc))[1] as body
    from order_messages m
    where m.order_id = any(${orderIds}::uuid[]) and m.side = 'executor'
      and m.id > coalesce((select max(c.id) from order_messages c where c.order_id = m.order_id and c.side = 'customer'), 0)
    group by m.order_id`;
  return new Map(rows.filter((r) => workingMs(r.at, now) >= SILENT_DAYS * DAY).map((r) => [r.order_id, { at: r.at, body: r.body, count: r.count }]));
}
