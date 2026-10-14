// Предупреждение перед днями «не принимаю дела» (2.226): за 3 дня до первого такого дня (away_from) — эксперту одно
// уведомление, если у него есть дела в работе со сроком в эти дни, по которым он ещё не попросил перенос или передать дело.
// Ведёт к «Моим срокам» — там у каждого такого дела «Попросить перенос» и (эксперту от организации) «Передать коллеге» (2.195);
// поэтому дела считаются в пределах «Моих сроков» (две недели). Раз в минуту вместе с напоминаниями о сроках (src/server.mjs);
// одно предупреждение на день начала (away_warned_from) — сдвинул начало, придёт по новому. В СМС — только цифры и дата.
import { SCHEDULE_DAYS } from '../orders/schedule.mjs';
import { addDays, todayMsk } from '../orders/workflow.mjs';
import { notify } from './notify.mjs';

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
