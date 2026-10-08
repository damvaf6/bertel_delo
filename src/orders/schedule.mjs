// «Мои сроки на две недели» эксперта (2.109): по дням, с сегодняшнего на 13 дней вперёд, — сроки своих дел (в работе, на
// проверке, предложенных), выезды помощника на свои дела и свои выезды помощником, до какого дня действует ссылка на осмотр,
// просьбы о переносе срока (на какой день просит, ждёт ответа) и дни, когда эксперт не принимает новые дела. Просроченные —
// отдельным списком сверху. Только дела, где человек исполнитель (или помощник на выезде).
import { addDays, todayMsk } from './workflow.mjs';

export const SCHEDULE_DAYS = 14;
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const weekday = (iso) => WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
// Время по Москве для «выезд в 10:30» и «ссылка до 18:00».
const mskDay = (t) => todayMsk(new Date(t));
const mskTime = (t) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }).format(new Date(t));

export async function expertSchedule(sql, userId, registry, today = todayMsk()) {
  const last = addDays(today, SCHEDULE_DAYS - 1);
  const service = (o) => registry.service(o.module, o.service)?.service.name ?? o.service;
  const orders = await sql`
    select o.id, o.title, o.module, o.service, o.status, to_char(o.deadline, 'YYYY-MM-DD') as deadline,
      (select to_char(r.new_deadline, 'YYYY-MM-DD') from deadline_requests r where r.order_id = o.id and r.outcome is null) as extend_to
    from orders o
    where o.executor_user_id = ${userId} and o.status in ('awaiting_executor', 'in_work', 'review') and o.deadline is not null
    order by o.deadline, o.created_at`;
  const visits = await sql`
    select v.id, v.order_id, v.planned_at, v.helper_id, o.title, o.module, o.service, o.executor_user_id
    from onsite_visits v join orders o on o.id = v.order_id
    where v.finished_at is null and v.cancelled_at is null and o.status = 'in_work'
      and (o.executor_user_id = ${userId} or v.helper_id = ${userId})
    order by v.planned_at`;
  // Ссылка на осмотр: последняя по делу, ещё действует, владелец не нажал «Готово».
  const links = await sql`
    select l.order_id, l.expires_at, o.title, o.module, o.service,
      exists (select 1 from inspection_photos p where p.link_id = l.id) as has_photos
    from inspection_links l join orders o on o.id = l.order_id
    where o.executor_user_id = ${userId} and o.status = 'in_work' and l.created_by = ${userId}
      and l.revoked_at is null and l.finished_at is null and l.expires_at > now()
      and not exists (select 1 from inspection_links n where n.order_id = l.order_id and n.id > l.id)`;
  const sp = await sql.one`select away_until, away_note from specialists where user_id = ${userId}`;
  const away = sp?.away_until && day(sp.away_until) > today ? { until: day(sp.away_until), note: sp.away_note ?? '' } : null;

  const days = new Map();
  for (let i = 0; i < SCHEDULE_DAYS; i++) {
    const date = addDays(today, i);
    days.set(date, { date, weekday: weekday(date), today: i === 0, weekend: ['сб', 'вс'].includes(weekday(date)),
      away: !!away && date < away.until, items: [] });
  }
  const put = (date, item) => days.get(date)?.items.push(item);
  const base = (o, id = o.id) => ({ order_id: id, title: o.title || 'Дело', service: service(o) });
  const overdue = [];
  for (const o of orders) {
    const it = { kind: 'deadline', ...base(o), status: o.status, deadline: o.deadline, extend_to: o.extend_to ?? null };
    if (o.deadline < today) overdue.push(it);
    else put(o.deadline, it);
    // Просьба о переносе: на новый день — «сюда просите перенести», пока диспетчер не ответил.
    if (o.extend_to) put(o.extend_to, { kind: 'extend', ...base(o), deadline: o.deadline, extend_to: o.extend_to });
  }
  for (const v of visits) {
    const mine = v.helper_id === userId && v.executor_user_id !== userId;
    // Помощник видит свой выезд без названия дела — как в списке «Мои выезды».
    const it = mine
      ? { kind: 'my_visit', visit_id: v.id, service: service(v), time: mskTime(v.planned_at) }
      : { kind: 'visit', ...base(v, v.order_id), time: mskTime(v.planned_at) };
    const d = mskDay(v.planned_at);
    if (d < today) overdue.push({ ...it, day: d });
    else put(d, it);
  }
  for (const l of links) {
    put(mskDay(l.expires_at), { kind: 'link', ...base(l, l.order_id), time: mskTime(l.expires_at), has_photos: l.has_photos });
  }
  // В дне: сначала выезды по времени, потом сроки, просьбы о переносе и ссылки.
  const ORDER = { my_visit: 0, visit: 0, deadline: 1, extend: 2, link: 3 };
  for (const d of days.values()) {
    d.items.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || String(a.time ?? '').localeCompare(String(b.time ?? '')));
    d.deadlines = d.items.filter((i) => i.kind === 'deadline').length;
  }
  return { from: today, to: last, away, overdue, days: [...days.values()] };
}
