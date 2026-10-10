// «Мои сроки на две недели» эксперта (2.109): по дням, с сегодняшнего на 13 дней вперёд, — сроки своих дел (в работе, на
// проверке, предложенных), выезды помощника на свои дела и свои выезды помощником, до какого дня действует ссылка на осмотр,
// просьбы о переносе срока (на какой день просит, ждёт ответа) и дни, когда эксперт не принимает новые дела. Просроченные —
// отдельным списком сверху. Только дела, где человек исполнитель (или помощник на выезде). Свои заметки с напоминанием
// (2.115, видит только автор) — в день напоминания; не отмеченные «сделано» с прошлых дней — на сегодня (2.120); «за день
// до срока» (2.149) — с отметкой и сроком дела (2.157).
import { addDays, todayMsk } from './workflow.mjs';
import { orderRef } from '../notify/registry.mjs';

export const SCHEDULE_DAYS = 14;
// Перегруженный день (2.134): сдать больше двух дел (в работе и предложенных; сданные на проверку не в счёт).
export const BUSY_DEADLINES = 2;
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
  const notes = await sql`
    select n.id, n.order_id, n.body, to_char(n.remind_on, 'YYYY-MM-DD') as remind_on, n.remind_deadline,
      to_char(o.deadline, 'YYYY-MM-DD') as deadline, o.title, o.module, o.service
    from order_notes n join orders o on o.id = n.order_id
    where n.author_id = ${userId} and o.executor_user_id = ${userId} and o.status in ('awaiting_executor', 'in_work', 'review', 'done')
      and n.deleted_at is null and n.done_at is null and n.remind_on is not null and n.remind_on <= ${last}::date
    order by n.remind_on, n.id`;
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
      ? { kind: 'my_visit', visit_id: v.id, service: service(v), time: mskTime(v.planned_at), at: new Date(v.planned_at).toISOString() }
      : { kind: 'visit', ...base(v, v.order_id), visit_id: v.id, time: mskTime(v.planned_at), at: new Date(v.planned_at).toISOString() };
    const d = mskDay(v.planned_at);
    if (d < today) overdue.push({ ...it, day: d });
    else put(d, it);
  }
  for (const l of links) {
    put(mskDay(l.expires_at), { kind: 'link', ...base(l, l.order_id), time: mskTime(l.expires_at), has_photos: l.has_photos });
  }
  for (const n of notes) {
    put(n.remind_on < today ? today : n.remind_on, { kind: 'note', ...base(n, n.order_id), note_id: String(n.id), note: n.body, remind_on: n.remind_on,
      late: n.remind_on < today, ...(n.remind_deadline && n.deadline ? { by_deadline: true, deadline: n.deadline } : {}) });
  }
  // В дне: сначала выезды по времени, потом сроки, просьбы о переносе, ссылки и заметки.
  const ORDER = { my_visit: 0, visit: 0, deadline: 1, extend: 2, link: 3, note: 4 };
  for (const d of days.values()) {
    d.items.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || String(a.time ?? '').localeCompare(String(b.time ?? '')));
    d.deadlines = d.items.filter((i) => i.kind === 'deadline').length;
    d.due = d.items.filter((i) => i.kind === 'deadline' && i.status !== 'review').length;
    d.busy = d.due > BUSY_DEADLINES;
    // «Попросить перенос» — у дел в работе без открытой просьбы (просить можно только по делу в работе, 2.91).
    for (const i of d.items) if (i.kind === 'deadline') i.can_extend = d.busy && i.status === 'in_work' && !i.extend_to;
  }
  return { from: today, to: last, away, overdue, days: [...days.values()] };
}

// Нагрузка экспертов организации на две недели (2.111): у руководителя — по каждому эксперту, работающему от организации,
// по дням: сроки его дел (в работе, на проверке, предложенных), выезды на объект (помощника по его делам и его самого
// помощником), дни, когда он не принимает новые дела. Чтобы назначать и передавать дело тому, у кого свободнее. Как и в
// «Делах экспертов» (2.16), без заказчика и названий заявок: услуга и номер дела; выезд по чужому делу — без номера.
export async function orgSchedule(sql, orgId, registry, today = todayMsk()) {
  const last = addDays(today, SCHEDULE_DAYS - 1);
  const service = (o) => registry.service(o.module, o.service)?.service.name ?? o.service;
  const experts = await sql`
    select s.user_id, s.active, s.away_until, s.away_note, u.full_name from specialists s
    join org_members m on m.org_id = s.org_id and m.user_id = s.user_id join users u on u.id = s.user_id
    where s.org_id = ${orgId} order by u.full_name nulls last, s.user_id`;
  const ids = experts.map((e) => e.user_id);
  const header = [];
  for (let i = 0; i < SCHEDULE_DAYS; i++) {
    const date = addDays(today, i);
    header.push({ date, weekday: weekday(date), today: i === 0, weekend: ['сб', 'вс'].includes(weekday(date)) });
  }
  if (!ids.length) return { from: today, to: last, days: header, experts: [] };
  const orders = await sql`
    select o.id, o.module, o.service, o.status, o.executor_user_id, to_char(o.deadline, 'YYYY-MM-DD') as deadline,
      (select to_char(r.new_deadline, 'YYYY-MM-DD') from deadline_requests r where r.order_id = o.id and r.outcome is null) as extend_to
    from orders o
    where o.executor_user_id = any(${ids}::uuid[]) and o.status in ('awaiting_executor', 'in_work', 'review') and o.deadline is not null
      and o.deadline <= ${last}::date
    order by o.deadline, o.created_at`;
  const visits = await sql`
    select v.id, v.order_id, v.planned_at, v.helper_id, o.module, o.service, o.executor_user_id
    from onsite_visits v join orders o on o.id = v.order_id
    where v.finished_at is null and v.cancelled_at is null and o.status = 'in_work'
      and (o.executor_user_id = any(${ids}::uuid[]) or v.helper_id = any(${ids}::uuid[]))
    order by v.planned_at`;
  const mine = new Set(ids);
  const per = new Map(experts.map((e) => {
    const away = e.away_until && day(e.away_until) > today ? { until: day(e.away_until), note: e.away_note ?? null } : null;
    return [e.user_id, {
      user_id: e.user_id, full_name: e.full_name || 'Без имени', away, paused: !e.active, overdue: [],
      days: header.map((d) => ({ date: d.date, away: !!away && d.date < away.until, items: [] })),
    }];
  }));
  const put = (userId, date, item) => {
    const x = per.get(userId);
    if (!x) return;
    if (date < today) x.overdue.push({ ...item, day: date });
    else x.days.find((d) => d.date === date)?.items.push(item);
  };
  for (const o of orders) {
    put(o.executor_user_id, o.deadline, { kind: 'deadline', order_ref: orderRef(o.id), service: service(o), status: o.status,
      deadline: o.deadline, extend_to: o.extend_to ?? null });
  }
  for (const v of visits) {
    const d = todayMsk(new Date(v.planned_at));
    if (d > last) continue;
    // Выезд помощника по делу эксперта — у эксперта; эксперт сам едет помощником — у него же, по чужому делу без номера.
    if (mine.has(v.executor_user_id)) {
      put(v.executor_user_id, d, { kind: 'visit', order_ref: orderRef(v.order_id), service: service(v), time: mskTime(v.planned_at) });
    }
    if (v.helper_id && v.helper_id !== v.executor_user_id && mine.has(v.helper_id)) {
      put(v.helper_id, d, { kind: 'helper', ...(mine.has(v.executor_user_id) ? { order_ref: orderRef(v.order_id) } : {}), service: service(v), time: mskTime(v.planned_at) });
    }
  }
  const ORDER = { visit: 0, helper: 0, deadline: 1 };
  const result = [...per.values()].map((x) => {
    for (const d of x.days) d.items.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || String(a.time ?? '').localeCompare(String(b.time ?? '')));
    const all = x.days.flatMap((d) => d.items);
    return {
      ...x,
      due: all.filter((i) => i.kind === 'deadline').length,
      visits: all.filter((i) => i.kind !== 'deadline').length,
      // Свободные будни: не выходной, не «не принимаю дела», ни срока, ни выезда — куда можно поставить новое дело.
      free_workdays: x.days.filter((d, i) => !header[i].weekend && !d.away && !d.items.length).length,
    };
  });
  return { from: today, to: last, days: header, experts: result };
}
