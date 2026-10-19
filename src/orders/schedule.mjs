// «Мои сроки на две недели» эксперта (2.109): по дням, с сегодняшнего на 13 дней вперёд, — сроки своих дел (в работе, на
// проверке, предложенных), выезды помощника на свои дела и свои выезды помощником, до какого дня действует ссылка на осмотр,
// просьбы о переносе срока (на какой день просит, ждёт ответа) и дни, когда эксперт не принимает новые дела. Просроченные —
// отдельным списком сверху. Только дела, где человек исполнитель (или помощник на выезде). Свои заметки с напоминанием
// (2.115, видит только автор) — в день напоминания; не отмеченные «сделано» с прошлых дней — на сегодня (2.120); «за день
// до срока» (2.149) — с отметкой и сроком дела (2.157). Руководитель просил попросить перенос срока (2.201) — у дела
// отметка «напоминал руководитель» (2.219), пока эксперт не попросил перенос. Срок по заданию на оценку (2.303) раньше срока
// дела (2.317) — своей отметкой в его день, у срока дела — «по заданию раньше»; задание читается, только если передано хранилище.
import { addDays, todayMsk } from './workflow.mjs';
import { taskDueFor } from '../ops/draft-ops.mjs';
import { assignmentDocs } from '../ops/ai-ops.mjs';
import { orderRef } from '../notify/registry.mjs';
import { executorSignOrg } from '../access/policy.mjs';

export const SCHEDULE_DAYS = 14;
// Перегруженный день (2.134): сдать больше двух дел (в работе и предложенных; сданные на проверку не в счёт). Выезд на
// объект в тот же день (2.179: помощника по своему делу или свой помощником) считается за дело — если в день есть что сдать.
export const BUSY_DEADLINES = 2;
export const isBusy = (due, trips = 0) => due > 0 && due + trips > BUSY_DEADLINES;

// Выезды на объект по дням (по Москве), как в «Моих сроках»: не завершённые и не отменённые, дело в работе; человек —
// исполнитель дела или помощник на выезде.
export async function tripsByDay(sql, userId, from, to) {
  const rows = await sql`
    select to_char(v.planned_at at time zone 'Europe/Moscow', 'YYYY-MM-DD') as day, count(*)::int as n
    from onsite_visits v join orders o on o.id = v.order_id
    where v.finished_at is null and v.cancelled_at is null and o.status = 'in_work'
      and (o.executor_user_id = ${userId} or v.helper_id = ${userId})
      and (v.planned_at at time zone 'Europe/Moscow')::date between ${from}::date and ${to}::date
    group by 1`;
  return new Map(rows.map((r) => [r.day, r.n]));
}
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const weekday = (iso) => WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
// Дни «не принимаю дела» (2.77, 2.226): первый такой день, если он ещё впереди (иначе null), и попадает ли день в них.
const awayStart = (sp, today) => (sp.away_from && day(sp.away_from) > today ? day(sp.away_from) : null);
const inAway = (away, date) => !!away && date < away.until && (!away.from || date >= away.from);
// Время по Москве для «выезд в 10:30» и «ссылка до 18:00».
const mskDay = (t) => todayMsk(new Date(t));
const mskTime = (t) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }).format(new Date(t));

// 2.317: срок по заданию на оценку (письмо банка, определение суда) раньше срока дела — у дел в работе и предложенных, где
// ИИ-проверка сверяет сроки (правило report_dates). Номер дела → { day, by, name, page }. Карточка эксперта — тоже (2.324).
export async function taskDues(sql, storage, registry, orders) {
  const out = new Map();
  if (!storage) return out;
  for (const o of orders) {
    if (o.status === 'review' || !registry.checks(o.module, o.service).some((r) => (r.auto ?? []).includes('report_dates'))) continue;
    const d = taskDueFor(registry, o, await assignmentDocs(sql, storage, o));
    if (d && d.day < o.deadline) out.set(o.id, { day: d.day, by: d.by, name: d.name, page: d.page });
  }
  return out;
}

export async function expertSchedule(sql, userId, registry, today = todayMsk(), { storage } = {}) {
  const last = addDays(today, SCHEDULE_DAYS - 1);
  const service = (o) => registry.service(o.module, o.service)?.service.name ?? o.service;
  const orders = await sql`
    select o.id, o.title, o.module, o.service, o.status, to_char(o.deadline, 'YYYY-MM-DD') as deadline,
      (select to_char(r.new_deadline, 'YYYY-MM-DD') from deadline_requests r where r.order_id = o.id and r.outcome is null) as extend_to,
      -- Руководитель просил попросить перенос срока (2.201), а эксперт с тех пор перенос не просил (2.219).
      (select json_build_object('at', c.created_at, 'by', u.full_name) from case_reminders c join users u on u.id = c.user_id
       where c.order_id = o.id and c.expert_id = o.executor_user_id and c.kind = 'extend'
         and not exists (select 1 from deadline_requests r where r.order_id = o.id and r.requested_at >= c.created_at)
       order by c.created_at desc limit 1) as head_ask
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
  const sp = await sql.one`select away_from, away_until, away_note from specialists where user_id = ${userId}`;
  // from (2.226) — первый день «не принимаю», если ещё не наступил; null — уже не принимает.
  const away = sp?.away_until && day(sp.away_until) > today ? { from: awayStart(sp, today), until: day(sp.away_until), note: sp.away_note ?? '' } : null;

  const days = new Map();
  for (let i = 0; i < SCHEDULE_DAYS; i++) {
    const date = addDays(today, i);
    days.set(date, { date, weekday: weekday(date), today: i === 0, weekend: ['сб', 'вс'].includes(weekday(date)),
      away: inAway(away, date), items: [] });
  }
  const put = (date, item) => days.get(date)?.items.push(item);
  const base = (o, id = o.id) => ({ order_id: id, title: o.title || 'Дело', service: service(o) });
  const overdue = [];
  const task = await taskDues(sql, storage, registry, orders);
  for (const o of orders) {
    const it = { kind: 'deadline', ...base(o), status: o.status, deadline: o.deadline, extend_to: o.extend_to ?? null };
    const t = task.get(o.id);
    if (t) {
      it.task_due = t.day;
      // В день срока по заданию — своя отметка: сдать к нему, хотя срок дела позже.
      const ti = { kind: 'task_due', ...base(o), status: o.status, deadline: o.deadline, task_due: t };
      if (t.day < today) overdue.push(ti);
      else put(t.day, ti);
    }
    if (o.head_ask && o.status === 'in_work' && !o.extend_to) it.head_ask = { at: new Date(o.head_ask.at).toISOString(), by: o.head_ask.by || null };
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
  // В дне: сначала выезды по времени, потом сроки по заданию на оценку, сроки, просьбы о переносе, ссылки и заметки.
  const ORDER = { my_visit: 0, visit: 0, task_due: 1, deadline: 1, extend: 2, link: 3, note: 4 };
  for (const d of days.values()) {
    d.items.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || String(a.time ?? '').localeCompare(String(b.time ?? '')));
    d.deadlines = d.items.filter((i) => i.kind === 'deadline').length;
    d.due = d.items.filter((i) => i.kind === 'deadline' && i.status !== 'review').length;
    d.trips = d.items.filter((i) => i.kind === 'visit' || i.kind === 'my_visit').length;
    d.busy = isBusy(d.due, d.trips);
    // «Попросить перенос» — у дел в работе без открытой просьбы (просить можно только по делу в работе, 2.91).
    for (const i of d.items) {
      if (i.kind !== 'deadline') continue;
      // Срок сдачи в день «не принимаю новые дела» (2.195): попросить перенос на день возвращения или передать дело коллеге.
      i.away_due = d.away && i.status !== 'review';
      // Руководитель просил попросить перенос (2.219) — кнопка у дела, даже если отпуск уже сдвинулся и день не перегружен.
      i.can_extend = (d.busy || i.away_due || !!i.head_ask) && i.status === 'in_work' && !i.extend_to;
    }
  }
  // «Передать коллеге» — эксперту от организации, по делу в работе без открытой просьбы (2.107).
  const awayDue = [...days.values()].flatMap((d) => d.items.filter((i) => i.away_due && i.status === 'in_work'));
  if (awayDue.length && await executorSignOrg(sql, userId)) {
    const open = new Set((await sql`select order_id from handover_requests where outcome is null and requested_by = ${userId}
                                     and order_id = any(${awayDue.map((i) => i.order_id)}::uuid[])`).map((r) => r.order_id));
    for (const i of awayDue) i.can_handover = !open.has(i.order_id);
  }
  return { from: today, to: last, away, overdue, away_due: awayDue.length, days: [...days.values()] };
}

// Нагрузка экспертов организации на две недели (2.111): у руководителя — по каждому эксперту, работающему от организации,
// по дням: сроки его дел (в работе, на проверке, предложенных), выезды на объект (помощника по его делам и его самого
// помощником), дни, когда он не принимает новые дела. Чтобы назначать и передавать дело тому, у кого свободнее. Как и в
// «Делах экспертов» (2.16), без заказчика и названий заявок: услуга и номер дела; выезд по чужому делу — без номера.
// Срок по заданию на оценку раньше срока дела (2.318) — дело сдавать в день срока по заданию: там строка task_due, у срока
// дела — отметка; в «сдать за две недели» и в полосе дело считается в день срока по заданию. Задание читается, только если
// передано хранилище; без названия файла — руководитель не видит названий документов.
// Что сдавать в этот день у руководителя (2.318): срок по заданию на оценку или срок дела, у которого срока по заданию
// раньше нет, — чтобы дело не считалось дважды.
export const dueItem = (i) => i.kind === 'task_due' || (i.kind === 'deadline' && !i.task_due);
export async function orgSchedule(sql, orgId, registry, today = todayMsk(), { storage } = {}) {
  const last = addDays(today, SCHEDULE_DAYS - 1);
  const service = (o) => registry.service(o.module, o.service)?.service.name ?? o.service;
  const experts = await sql`
    select s.user_id, s.active, s.away_from, s.away_until, s.away_note, u.full_name from specialists s
    join org_members m on m.org_id = s.org_id and m.user_id = s.user_id join users u on u.id = s.user_id
    where s.org_id = ${orgId} order by u.full_name nulls last, s.user_id`;
  const ids = experts.map((e) => e.user_id);
  const header = [];
  for (let i = 0; i < SCHEDULE_DAYS; i++) {
    const date = addDays(today, i);
    header.push({ date, weekday: weekday(date), today: i === 0, weekend: ['сб', 'вс'].includes(weekday(date)) });
  }
  if (!ids.length) return { from: today, to: last, days: header.map((h) => ({ ...h, accepting: 0 })), experts: [] };
  const orders = await sql`
    select o.id, o.module, o.service, o.status, o.executor_user_id, to_char(o.deadline, 'YYYY-MM-DD') as deadline,
      (select to_char(r.new_deadline, 'YYYY-MM-DD') from deadline_requests r where r.order_id = o.id and r.outcome is null) as extend_to
    from orders o
    where o.executor_user_id = any(${ids}::uuid[]) and o.status in ('awaiting_executor', 'in_work', 'review') and o.deadline is not null
    order by o.deadline, o.created_at`;
  const visits = await sql`
    select v.id, v.order_id, v.planned_at, v.helper_id, o.module, o.service, o.executor_user_id
    from onsite_visits v join orders o on o.id = v.order_id
    where v.finished_at is null and v.cancelled_at is null and o.status = 'in_work'
      and (o.executor_user_id = any(${ids}::uuid[]) or v.helper_id = any(${ids}::uuid[]))
    order by v.planned_at`;
  const mine = new Set(ids);
  const per = new Map(experts.map((e) => {
    const away = e.away_until && day(e.away_until) > today ? { from: awayStart(e, today), until: day(e.away_until), note: e.away_note ?? null } : null;
    return [e.user_id, {
      user_id: e.user_id, full_name: e.full_name || 'Без имени', away, paused: !e.active, overdue: [],
      // Не принимает новые дела (2.194): до дня возвращения или, если выключил приём, все две недели.
      days: header.map((d) => ({ date: d.date, away: !e.active || inAway(away, d.date), items: [] })),
    }];
  }));
  const put = (userId, date, item) => {
    const x = per.get(userId);
    if (!x) return;
    if (date < today) x.overdue.push({ ...item, day: date });
    else x.days.find((d) => d.date === date)?.items.push(item);
  };
  // Срок дела после двух недель — дело нужно только ради срока по заданию в эти две недели (2.318).
  const task = await taskDues(sql, storage, registry, orders);
  for (const o of orders) {
    const t = task.get(o.id);
    if (t && t.day <= last) {
      put(o.executor_user_id, t.day, { kind: 'task_due', order_ref: orderRef(o.id), service: service(o), status: o.status,
        deadline: o.deadline, task_due: { day: t.day, by: t.by } });
    }
    if (o.deadline > last) continue;
    put(o.executor_user_id, o.deadline, { kind: 'deadline', order_ref: orderRef(o.id), service: service(o), status: o.status,
      deadline: o.deadline, extend_to: o.extend_to ?? null, ...(t ? { task_due: t.day } : {}) });
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
  const ORDER = { visit: 0, helper: 0, task_due: 1, deadline: 1 };
  const result = [...per.values()].map((x) => {
    for (const d of x.days) d.items.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || String(a.time ?? '').localeCompare(String(b.time ?? '')));
    const all = x.days.flatMap((d) => d.items);
    return {
      ...x,
      due: all.filter(dueItem).length,
      visits: all.filter((i) => i.kind === 'visit' || i.kind === 'helper').length,
      // Свободные будни: не выходной, не «не принимаю дела», ни срока, ни выезда — куда можно поставить новое дело.
      free_workdays: x.days.filter((d, i) => !header[i].weekend && !d.away && !d.items.length).length,
    };
  });
  // Сколько экспертов принимают новые дела в каждый день (2.245): на тех же днях, что полосы, — видно, в какие дни дело
  // назначить некому.
  const days = header.map((h, i) => ({ ...h, accepting: result.filter((x) => !x.days[i].away).length }));
  return { from: today, to: last, days, experts: result };
}
