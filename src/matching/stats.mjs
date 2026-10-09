import { addDays, todayMsk } from '../orders/workflow.mjs';

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

// Сданное за год (2.139) — для карточки эксперта: дела, впервые ставшие «готово» за последние 365 дней по Москве (с даты
// `since` по сегодня), всего и по услугам — сколько, из них позже срока и в среднем дней от принятия дела (принял предложение
// или руководитель передал ему дело) до «готово»; дела без отметки о принятии в среднее не входят. Так же считает сводка
// руководителя за месяц (2.117, `src/orgs/report.mjs`). Без заказчика, названий и полей заявки.
export async function yearStats(sql, userId, { today = todayMsk(), registry = null } = {}) {
  const since = addDays(today, -364);
  const rows = await sql`
    select * from (
      select distinct on (o.id) o.id, o.module, o.service, o.deadline,
        to_char(h.at at time zone 'Europe/Moscow', 'YYYY-MM-DD') as done_day,
        to_char(greatest(
          (select max(f.outcome_at) from order_offers f
           where f.order_id = o.id and f.specialist_id = o.executor_user_id and f.outcome = 'accepted'),
          (select max(a.at) from audit_log a
           where a.subject_type = 'order' and a.subject_id = o.id::text and a.action = 'org.case.transfer'
             and a.details->>'to' = o.executor_user_id::text)) at time zone 'Europe/Moscow', 'YYYY-MM-DD') as taken_day
      from order_status_history h join orders o on o.id = h.order_id
      where o.executor_user_id = ${userId} and h.to_status = 'done'
      order by o.id, h.at) x
    where done_day >= ${since}`;
  const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);
  const sum = (list) => {
    const days = list.filter((o) => o.taken_day).map((o) => Math.max(0, Math.round((Date.parse(o.done_day) - Date.parse(o.taken_day)) / 86_400_000)));
    return {
      done: list.length,
      done_late: list.filter((o) => o.deadline && o.done_day > day(o.deadline)).length,
      avg_days: days.length ? Math.round((days.reduce((s, d) => s + d, 0) / days.length) * 10) / 10 : null,
    };
  };
  const groups = new Map();
  for (const o of rows) {
    const key = `${o.module}/${o.service}`;
    (groups.get(key) ?? groups.set(key, { module: o.module, service: o.service, list: [] }).get(key)).list.push(o);
  }
  const services = [...groups.values()].map((g) => ({
    module: g.module, service: g.service, name: registry?.service(g.module, g.service)?.service.name ?? g.service, ...sum(g.list),
  })).sort((a, b) => b.done - a.done || a.name.localeCompare(b.name, 'ru'));
  return { since, ...sum(rows), by_service: services };
}
