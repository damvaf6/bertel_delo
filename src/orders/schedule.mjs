// «Мои сроки на две недели» эксперта (2.109): по дням, с сегодняшнего на 13 дней вперёд, — сроки своих дел (в работе, на
// проверке, предложенных), выезды помощника на свои дела и свои выезды помощником, до какого дня действует ссылка на осмотр,
// просьбы о переносе срока (на какой день просит, ждёт ответа) и дни, когда эксперт не принимает новые дела. Просроченные —
// отдельным списком сверху. Только дела, где человек исполнитель (или помощник на выезде). Свои заметки с напоминанием
// (2.115, видит только автор) — в день напоминания; не отмеченные «сделано» с прошлых дней — на сегодня (2.120); «за день
// до срока» (2.149) — с отметкой и сроком дела (2.157). Руководитель просил попросить перенос срока (2.201) — у дела
// отметка «напоминал руководитель» (2.219), пока эксперт не попросил перенос. Срок по заданию на оценку (2.303) раньше срока
// дела (2.317) — своей отметкой в его день, у срока дела — «по заданию раньше»; задание читается, только если передано хранилище.
// Письмо о переносе со сроком раньше срока дела (2.353) — у отметки «срок раньше срока дела», просил ли эксперт письмо с новым
// сроком (`letter_ask`) и кнопка «Попросить письмо с новым сроком», как в «Сегодня» (2.341) и «Истории сроков» (2.349).
import { addDays, todayMsk } from './workflow.mjs';
import { holidayName, isWorkday, isWorkingWeekend, workdayBefore } from './holidays.mjs';
import { taskDueFor, taskMoveLetter } from '../ops/draft-ops.mjs';
import { assignmentDocs, TASK_MOVE } from '../ops/ai-ops.mjs';
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
// День полосы: выходной — и суббота с воскресеньем, и нерабочий праздник (2.371: `holiday` — его название). Срок сдачи в
// праздник — `work_before`: последний рабочий день перед ним (заказчик и банк в праздник не работают). Рабочая суббота по
// переносу — `working` (2.392): будний день, но с пометкой, чтобы не путали с обычным выходным.
const dayHead = (date, i) => {
  const holiday = holidayName(date);
  return { date, weekday: weekday(date), today: i === 0, weekend: !isWorkday(date),
    ...(isWorkingWeekend(date) ? { working: true } : {}),
    ...(holiday && !['сб', 'вс'].includes(weekday(date)) ? { holiday, work_before: workdayBefore(date) } : {}) };
};
// Время по Москве для «выезд в 10:30» и «ссылка до 18:00».
const mskDay = (t) => todayMsk(new Date(t));
const mskTime = (t) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }).format(new Date(t));

// 2.317: срок по заданию на оценку (письмо банка, определение суда) раньше срока дела — у дел в работе и предложенных, где
// ИИ-проверка сверяет сроки (правило report_dates). Номер дела → { day, by, name, page }. Карточка эксперта — тоже (2.324).
// 2.339: срок взят из письма о переносе срока (2.333) — `letter: { was }` (прежний срок по заданию); `letters` (Map) — сюда
// дела, где срок по письму не раньше срока дела: в «Моих сроках» у срока дела — «по письму о переносе».
export async function taskDues(sql, storage, registry, orders, letters = null) {
  const out = new Map();
  if (!storage) return out;
  for (const o of orders) {
    if (o.status === 'review' || !registry.checks(o.module, o.service).some((r) => (r.auto ?? []).includes('report_dates'))) continue;
    const assignment = await assignmentDocs(sql, storage, o);
    const d = taskDueFor(registry, o, assignment);
    if (!d) continue;
    const l = taskMoveLetter(assignment, d);
    const letter = l ? { was: l.was } : null;
    if (d.day < o.deadline) out.set(o.id, { day: d.day, by: d.by, name: d.name, page: d.page, letter });
    else if (letter && letters) letters.set(o.id, { day: d.day, name: d.name, page: d.page, was: l.was });
  }
  return out;
}

// 2.353: последняя просьба письма о переносе у заказчика (пункт task_move запроса документов): ждёт ли ответа и можно ли
// попросить письмо с новым сроком сейчас — как `taskMoved` (2.326): срок дела перенесён по согласованной просьбе, дело в
// работе, прежняя просьба не ждёт ответа. Срок дела не переносили — просить письмо не о чем (null).
async function letterAsk(sql, o) {
  const [r] = await sql`select outcome, to_char(new_deadline, 'YYYY-MM-DD') as new_deadline from deadline_requests
                        where order_id = ${o.id} and outcome is not null and outcome <> 'withdrawn'
                        order by decided_at desc, id desc limit 1`;
  if (r?.outcome !== 'approved' || r.new_deadline !== o.deadline) return null;
  const [a] = await sql`select requested_at, fulfilled_at from doc_requests
                        where order_id = ${o.id} and item_id = ${TASK_MOVE} and cancelled_at is null order by id desc limit 1`;
  const asked_at = a && !a.fulfilled_at ? new Date(a.requested_at).toISOString() : null;
  return { asked_at, can_ask: o.status === 'in_work' && !asked_at };
}

// 2.354: у руководителя — просил ли эксперт письмо с новым сроком: в какой день (по Москве), пока его нет, и можно ли
// попросить сейчас; срок дела не переносили — null.
async function askedOn(sql, o) {
  const a = await letterAsk(sql, o);
  return a ? { asked_on: a.asked_at ? mskDay(a.asked_at) : null, can_ask: a.can_ask } : null;
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
    days.set(date, { ...dayHead(date, i), away: inAway(away, date), items: [] });
  }
  const put = (date, item) => days.get(date)?.items.push(item);
  const base = (o, id = o.id) => ({ order_id: id, title: o.title || 'Дело', service: service(o) });
  const overdue = [];
  const letters = new Map();
  const task = await taskDues(sql, storage, registry, orders, letters);
  for (const o of orders) {
    const it = { kind: 'deadline', ...base(o), status: o.status, deadline: o.deadline, extend_to: o.extend_to ?? null };
    const t = task.get(o.id);
    // 2.339: срок по заданию из письма о переносе не раньше срока дела — у срока дела «по письму о переносе».
    if (letters.has(o.id)) it.task_letter = letters.get(o.id);
    if (t) {
      it.task_due = t.day;
      if (t.letter) it.task_due_letter = true;
      // В день срока по заданию — своя отметка: сдать к нему, хотя срок дела позже.
      const ti = { kind: 'task_due', ...base(o), status: o.status, deadline: o.deadline, task_due: t };
      if (t.letter) ti.letter_ask = await letterAsk(sql, o);
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
// передано хранилище; без названия файла — руководитель не видит названий документов. Срок по письму о переносе (2.354) —
// так и сказано: «по письму о переносе», прежний срок и просил ли эксперт письмо с новым сроком.
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
    header.push(dayHead(date, i));
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
  // 2.354: срок из письма о переносе раньше срока дела — у строки письмо (прежний срок, просил ли эксперт письмо с новым
  // сроком), у срока дела — «по письму о переносе»; письмо переносит срок на день срока дела или позже — у срока дела.
  const letters = new Map();
  const task = await taskDues(sql, storage, registry, orders, letters);
  for (const o of orders) {
    const t = task.get(o.id);
    if (t && t.day <= last) {
      const letter = t.letter ? { was: t.letter.was, ask: await askedOn(sql, o) } : null;
      put(o.executor_user_id, t.day, { kind: 'task_due', order_ref: orderRef(o.id), service: service(o), status: o.status,
        deadline: o.deadline, task_due: { day: t.day, by: t.by, ...(letter ? { letter } : {}) } });
    }
    if (o.deadline > last) continue;
    const l = letters.get(o.id);
    put(o.executor_user_id, o.deadline, { kind: 'deadline', order_ref: orderRef(o.id), service: service(o), status: o.status,
      deadline: o.deadline, extend_to: o.extend_to ?? null, ...(t ? { task_due: t.day } : {}), ...(t?.letter ? { task_due_letter: true } : {}),
      ...(l ? { task_letter: { day: l.day, was: l.was } } : {}) });
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
