// Итоги работы специалиста (2.35) — для карточки эксперта и оценки «качество» в подборе: сданных дел (готово или закрыто),
// из них в срок (последняя сдача на проверку — не позже срока по Москве; без срока — в срок) и возвратов на доработку
// (диспетчер вернул с проверки или руководитель организации вернул файл).
export async function workStats(sql, userIds) {
  const out = new Map(userIds.map((id) => [id, { done: 0, on_time: 0, returned: 0 }]));
  if (!userIds.length) return out;
  const done = await sql`
    select o.executor_user_id as id, count(*)::int as done,
      count(*) filter (where o.deadline is null or (select (max(h.at) at time zone 'Europe/Moscow')::date from order_status_history h
                       where h.order_id = o.id and h.to_status = 'review') <= o.deadline)::int as on_time
    from orders o where o.executor_user_id = any(${userIds}::uuid[]) and o.status in ('done', 'closed') group by o.executor_user_id`;
  for (const r of done) Object.assign(out.get(r.id), { done: r.done, on_time: r.on_time });
  const back = await sql`
    select id, sum(n)::int as n from (
      select o.executor_user_id as id, count(*) as n from order_status_history h join orders o on o.id = h.order_id
      where o.executor_user_id = any(${userIds}::uuid[]) and h.from_status = 'review' and h.to_status = 'in_work' group by o.executor_user_id
      union all
      select executor_user_id as id, count(*) as n from org_returns where executor_user_id = any(${userIds}::uuid[]) group by executor_user_id
    ) x group by id`;
  for (const r of back) out.get(r.id).returned = r.n;
  return out;
}
