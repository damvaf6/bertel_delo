// Напоминания о сроках (разбор 03.10.2026, 2.13; устав, раздел 1а). Раз в минуту (src/server.mjs, вместе с повтором СМС):
//   за 3 дня и за 1 день до срока — исполнителю дела в работе;
//   срок прошёл, а результат не выдан — исполнителю (если дело у него в работе) и диспетчерам.
// Каждое напоминание — один раз на заявку, вид и срок (deadline_reminders); перенесли срок — придут по новому.
// Тексты — в реестре (src/notify/registry.mjs), в СМС — только короткий номер заявки.
import { addDays, todayMsk } from '../orders/workflow.mjs';
import { dispatchers, notify } from './notify.mjs';

const ACTIVE = ['awaiting_executor', 'in_work', 'review'];
const EVENT = { d3: 'deadline_soon', d1: 'deadline_tomorrow' };

export async function remindDeadlines(sql, { today = todayMsk() } = {}) {
  let sent = 0;
  const plan = [
    { kind: 'd3', when: (o) => o.status === 'in_work' && o.deadline === addDays(today, 3) },
    { kind: 'd1', when: (o) => o.status === 'in_work' && o.deadline === addDays(today, 1) },
    { kind: 'overdue', when: (o) => o.deadline < today },
  ];
  const orders = await sql`select id, status, executor_user_id, to_char(deadline, 'YYYY-MM-DD') as deadline from orders
                           where status = any(${ACTIVE}) and deadline is not null
                             and deadline <= ${addDays(today, 3)}::date`;
  for (const o of orders) {
    for (const p of plan) {
      if (!p.when(o)) continue;
      sent += await sql.tx(async (tx) => {
        const fresh = await tx`insert into deadline_reminders (order_id, kind, deadline) values (${o.id}, ${p.kind}, ${o.deadline})
                               on conflict do nothing returning order_id`;
        if (!fresh.length) return 0;
        let n = 0;
        if (p.kind === 'overdue') {
          if (o.status === 'in_work' && o.executor_user_id) n += await notify(tx, 'deadline_overdue', { users: [o.executor_user_id], orderId: o.id });
          n += await notify(tx, 'deadline_overdue_staff', { users: await dispatchers(tx), orderId: o.id });
        } else if (o.executor_user_id) {
          n += await notify(tx, EVENT[p.kind], { users: [o.executor_user_id], orderId: o.id });
        }
        return n;
      });
    }
  }
  return sent;
}
