// Предупреждение перед днями «не принимаю дела» (2.226): за 3 дня до первого такого дня (away_from) — эксперту одно
// уведомление, если у него есть дела в работе со сроком в эти дни, по которым он ещё не попросил перенос или передать дело.
// Ведёт к «Моим срокам» — там у каждого такого дела «Попросить перенос» и (эксперту от организации) «Передать коллеге» (2.195);
// поэтому дела считаются в пределах «Моих сроков» (две недели). Раз в минуту вместе с напоминаниями о сроках (src/server.mjs);
// одно предупреждение на день начала (away_warned_from) — сдвинул начало, придёт по новому. В СМС — только цифры и дата.
import { SCHEDULE_DAYS } from '../orders/schedule.mjs';
import { addDays, todayMsk } from '../orders/workflow.mjs';
import { notify } from './notify.mjs';
import { MORNING_HOUR, mskHour } from './morning.mjs';

export const AWAY_WARN_DAYS = 3;

const pl = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

// Дела эксперта в работе со сроком в днях «не принимаю» (в пределах «Моих сроков»), без открытой просьбы о переносе или передаче.
export async function awaySoonCases(sql, userId, from, until, today = todayMsk()) {
  const last = [until, addDays(today, SCHEDULE_DAYS)].sort()[0];
  return sql`select o.id from orders o
             where o.executor_user_id = ${userId} and o.status = 'in_work' and o.deadline >= ${from}::date and o.deadline < ${last}::date
               and not exists (select 1 from deadline_requests r where r.order_id = o.id and r.outcome is null)
               and not exists (select 1 from handover_requests h where h.order_id = o.id and h.outcome is null)`;
}

export async function warnAway(sql, { today = todayMsk() } = {}) {
  const people = await sql`
    select s.user_id, to_char(s.away_from, 'YYYY-MM-DD') as away_from, to_char(s.away_until, 'YYYY-MM-DD') as away_until
    from specialists s join users u on u.id = s.user_id and u.is_active
    where s.away_from > ${today}::date and s.away_from <= ${addDays(today, AWAY_WARN_DAYS)}::date and s.away_until > s.away_from
      and s.away_warned_from is distinct from s.away_from`;
  let sent = 0;
  for (const p of people) {
    sent += await sql.tx(async (tx) => {
      const cur = await tx.one`select to_char(away_from, 'YYYY-MM-DD') as away_from, away_warned_from from specialists
                               where user_id = ${p.user_id} for update`;
      if (cur?.away_from !== p.away_from || cur.away_warned_from === p.away_from) return 0;
      const cases = await awaySoonCases(tx, p.user_id, p.away_from, p.away_until, today);
      // Дел со сроком в эти дни нет — не предупреждаем и не отмечаем: появится такое дело до начала — предупреждение придёт.
      if (!cases.length) return 0;
      await tx`update specialists set away_warned_from = away_from where user_id = ${p.user_id}`;
      const [, m, d] = p.away_from.split('-');
      const n = cases.length;
      return notify(tx, 'away_soon', { users: [p.user_id],
        sms: `БЕРТЕЛ Дело: с ${d}.${m} Вы не принимаете дела, а срок ${n} ${pl(n, 'дела', 'дел', 'дел')} — в эти дни. Попросите перенос или передайте коллеге — «Мои сроки» в кабинете.` });
    });
  }
  return sent;
}

// «Пока Вас не было» (2.239): эксперт вернулся (наступил away_until) — в первый день после 8:00 по Москве одно уведомление,
// что произошло с его делами за дни «не принимаю дела» [away_since, away_until): какие дела у него забрали и какие передали
// ему, что решил диспетчер по срокам (и просьбы организации о переносе, которых он не подавал), новые сообщения заказчика,
// диспетчера и руководителя, пришедшие запрошенные документы. Ничего не произошло — не беспокоим. Подробно — блок «Пока Вас
// не было» в разделе «Специалист» (неделю после возвращения); забранные дела — только числом, без названий.
export const AWAY_BACK_SHOW_DAYS = 7;
const AWAY_BACK_LATE_DAYS = 2; // площадка стояла в первый день — сводка уйдёт и на второй-третий

export async function awayBack(sql, userId, since, until) {
  // Начало дня по Москве (UTC+3 круглый год).
  const at = new Date(`${since}T00:00:00+03:00`);
  const to = new Date(`${until}T00:00:00+03:00`);
  const taken = await sql.one`
    select (select count(distinct a.subject_id) from audit_log a
            where a.action = 'org.case.transfer' and a.details->>'from' = ${userId}::text and a.at >= ${at} and a.at < ${to})::int
         + (select count(distinct n.order_id) from notifications n
            where n.user_id = ${userId} and n.event = 'executor_reassigned' and n.created_at >= ${at} and n.created_at < ${to})::int as n`;
  const given = await sql`
    select distinct on (o.id) o.id as order_id, o.title, to_char(o.deadline, 'YYYY-MM-DD') as deadline
    from audit_log a join orders o on o.id::text = a.subject_id
    where a.action = 'org.case.transfer' and a.details->>'to' = ${userId}::text and a.at >= ${at} and a.at < ${to}
      and o.executor_user_id = ${userId} and o.status in ('in_work', 'review')
    order by o.id, a.at`;
  // Ответы диспетчера (не отзывы) и просьбы о переносе, поданные не экспертом (организацией), — по делам, что сейчас у него.
  const deadlines = await sql`
    select r.order_id, o.title, r.outcome, r.answer, (r.org_id is not null) as by_org, (r.requested_by <> ${userId}) as not_mine,
           to_char(r.old_deadline, 'YYYY-MM-DD') as old_deadline, to_char(r.new_deadline, 'YYYY-MM-DD') as new_deadline,
           to_char(o.deadline, 'YYYY-MM-DD') as deadline
    from deadline_requests r join orders o on o.id = r.order_id
    where o.executor_user_id = ${userId} and o.status in ('in_work', 'review')
      and ((r.outcome in ('approved', 'declined') and r.decided_at >= ${at} and r.decided_at < ${to})
           or (r.outcome is null and r.requested_by <> ${userId} and r.requested_at >= ${at} and r.requested_at < ${to}))
    order by r.id`;
  const messages = await sql`
    select o.id as order_id, o.title,
           (select count(*) from order_messages m where m.order_id = o.id and m.side <> 'executor' and m.at >= ${at} and m.at < ${to})::int as chat,
           (select count(*) from org_messages m where m.order_id = o.id and m.side = 'head' and m.at >= ${at} and m.at < ${to})::int as head
    from orders o where o.executor_user_id = ${userId} and o.status in ('in_work', 'review')
    order by o.deadline nulls last, o.id`;
  const docs = await sql`
    select o.id as order_id, o.title, count(*)::int as n
    from doc_requests d join orders o on o.id = d.order_id
    where o.executor_user_id = ${userId} and o.status in ('in_work', 'review') and d.cancelled_at is null
      and d.fulfilled_at >= ${at} and d.fulfilled_at < ${to}
    group by o.id, o.title order by o.id`;
  const back = { from: since, until, taken: taken.n, given, deadlines,
    messages: messages.filter((m) => m.chat + m.head > 0), docs };
  back.empty = !back.taken && !given.length && !deadlines.length && !back.messages.length && !docs.length;
  return back;
}

// Последняя законченная отметка «не принимаю дела» эксперта, если вернулся не больше недели назад и не нажал «Всё
// посмотрел» (2.244), — и что произошло.
export async function awayBackOf(sql, userId, today = todayMsk()) {
  const sp = await sql.one`select to_char(coalesce(away_since, away_from, away_until - 14), 'YYYY-MM-DD') as since,
                                  to_char(away_until, 'YYYY-MM-DD') as until
                           from specialists where user_id = ${userId}
                             and away_until <= ${today}::date and away_until > ${addDays(today, -AWAY_BACK_SHOW_DAYS)}::date
                             and away_back_seen is distinct from away_until`;
  return sp ? awayBack(sql, userId, sp.since, sp.until) : null;
}

export async function sendAwayBack(sql, { now = new Date() } = {}) {
  if (mskHour(now) < MORNING_HOUR) return 0;
  const today = todayMsk(now);
  const people = await sql`
    select s.user_id from specialists s join users u on u.id = s.user_id and u.is_active
    where s.away_until <= ${today}::date and s.away_until >= ${addDays(today, -AWAY_BACK_LATE_DAYS)}::date
      and s.away_back_for is distinct from s.away_until`;
  let sent = 0;
  for (const p of people) {
    sent += await sql.tx(async (tx) => {
      const cur = await tx.one`select to_char(coalesce(away_since, away_from, away_until - 14), 'YYYY-MM-DD') as since,
                                      to_char(away_until, 'YYYY-MM-DD') as until, to_char(away_back_for, 'YYYY-MM-DD') as sent
                               from specialists where user_id = ${p.user_id} for update`;
      // Пока ждали — эксперт продлил дни или сводку уже отправили: не сейчас.
      if (!cur?.until || cur.until > today || cur.sent === cur.until) return 0;
      await tx`update specialists set away_back_for = away_until where user_id = ${p.user_id}`;
      const b = await awayBack(tx, p.user_id, cur.since, cur.until);
      if (b.empty) return 0;
      const parts = [b.taken && `передали коллегам: ${b.taken}`, b.given.length && `передали Вам: ${b.given.length}`,
        b.deadlines.length && `решения по срокам: ${b.deadlines.length}`, b.messages.length && `дела с новыми сообщениями: ${b.messages.length}`,
        b.docs.length && `пришли документы: ${b.docs.length}`].filter(Boolean);
      return notify(tx, 'away_back', { users: [p.user_id],
        sms: `БЕРТЕЛ Дело: пока Вас не было — ${parts.join(', ')}. Подробно — «Пока Вас не было» в кабинете.` });
    });
  }
  return sent;
}
