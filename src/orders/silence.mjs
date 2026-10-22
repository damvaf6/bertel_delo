// Заказчик молчит (2.375): последнее сообщение эксперта заказчику в переписке дела, после него заказчик ничего не написал,
// и прошло 2 дня и дольше. Сообщения диспетчера не в счёт — ни как вопрос, ни как ответ. Напоминание эксперт отправляет
// сам готовой фразой (src/orders/phrases.mjs); отправил — отсчёт начинается заново.

export const SILENT_DAYS = 2;

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
  const edge = now.getTime() - SILENT_DAYS * 86400_000;
  return new Map(rows.filter((r) => new Date(r.at).getTime() <= edge).map((r) => [r.order_id, { at: r.at, body: r.body, count: r.count }]));
}
