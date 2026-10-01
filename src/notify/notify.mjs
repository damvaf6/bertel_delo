// Уведомления (задача 1.7): запись — в той же транзакции, что и само событие (нет события — нет уведомления);
// СМС — через очередь notification_deliveries, отправляется после транзакции (deliverPending), с повторами.
// Сам себе человек уведомлений не получает; отключённые учётные записи — тоже.
import { EVENTS, TYPE, smsText } from './registry.mjs';

export const DELIVERY = {
  maxAttempts: 5,        // после пятой неудачи СМС больше не повторяется (строка остаётся с ошибкой)
  retryAfterSec: 60,     // пауза перед повтором растёт: 1, 2, 4, 8 минут
  batch: 20,             // сколько СМС отправляется за один проход
};

// Записать уведомление события каждому получателю; СМС — тем, у кого они включены для этого вида.
export async function notify(tx, eventId, { users = [], orderId = null, orgId = null, actor = null } = {}) {
  const e = EVENTS[eventId];
  if (!e) throw new Error(`Неизвестное событие уведомления: ${eventId}`);
  const ids = [...new Set(users.filter(Boolean))].filter((id) => id !== actor?.id);
  if (!ids.length) return 0;
  const rows = await tx`
    select u.id, u.phone, s.sms from users u
    left join notification_settings s on s.user_id = u.id and s.type = ${e.type}
    where u.id = any(${ids}::uuid[]) and u.is_active`;
  for (const u of rows) {
    const n = await tx.one`insert into notifications (user_id, type, event, order_id, org_id)
                           values (${u.id}, ${e.type}, ${eventId}, ${orderId}, ${orgId}) returning id`;
    if (u.sms ?? TYPE[e.type].sms) {
      await tx`insert into notification_deliveries (notification_id, channel, phone, body)
               values (${n.id}, 'sms', ${u.phone}, ${smsText(eventId, { orderId })})`;
    }
  }
  return rows.length;
}

// Уведомление по номеру телефона (приглашение в организацию): есть учётная запись — как обычно; нет — только СМС.
export async function notifyPhone(tx, eventId, phone, { orgId = null, actor = null } = {}) {
  const u = await tx.one`select id from users where phone = ${phone}`;
  if (u) return notify(tx, eventId, { users: [u.id], orgId, actor });
  await tx`insert into notification_deliveries (channel, phone, body) values ('sms', ${phone}, ${smsText(eventId)})`;
  return 1;
}

// Кто сейчас «заказчик» заявки: ответственный (если он ещё в организации заявки), иначе руководители организации.
export async function customersOf(tx, order) {
  if (!order.org_id) return [order.owner_user_id];
  const rows = await tx`
    select user_id from org_members where org_id = ${order.org_id}
      and (user_id = ${order.owner_user_id}
           or (role = 'head' and not exists (select 1 from org_members where org_id = ${order.org_id} and user_id = ${order.owner_user_id})))`;
  return rows.map((r) => r.user_id);
}

export async function dispatchers(tx) {
  return (await tx`select id from users where platform_role = 'dispatcher' and is_active`).map((r) => r.id);
}

// Уведомления о шаге статуса заявки: before — заявка до шага (с прежним исполнителем), to — новый статус, by — чья сторона.
export async function notifyStatus(tx, { actor, before, to, by }) {
  const from = before.status;
  const orderId = before.id;
  const executor = before.executor_user_id;
  const opts = (users) => ({ users, orderId, actor });
  if (from === 'new' && to === 'matching') return notify(tx, 'submitted', opts(await dispatchers(tx)));
  if (from === 'awaiting_executor' && to === 'in_work') return notify(tx, 'accepted', opts(await customersOf(tx, before)));
  if (from === 'awaiting_executor' && to === 'matching') {
    if (by === 'executor') return notify(tx, 'declined', opts(await dispatchers(tx)));
    return notify(tx, 'offer_withdrawn', opts([executor]));
  }
  if ((from === 'in_work' || from === 'review') && to === 'matching') {
    await notify(tx, 'reassigned', opts(await customersOf(tx, before)));
    return notify(tx, 'executor_reassigned', opts([executor]));
  }
  if (from === 'in_work' && to === 'review') return notify(tx, 'in_review', opts(await dispatchers(tx)));
  if (from === 'review' && to === 'in_work') return notify(tx, 'rework', opts([executor]));
  if (from === 'review' && to === 'done') {
    await notify(tx, 'done', opts(await customersOf(tx, before)));
    return notify(tx, 'result_accepted', opts([executor]));
  }
  if (to === 'closed') return notify(tx, 'executor_closed', opts([executor]));
  if (to === 'cancelled') {
    if (by === 'dispatcher') await notify(tx, 'cancelled_by_dispatcher', opts(await customersOf(tx, before)));
    else if (from !== 'new') await notify(tx, 'cancelled_by_customer', opts(await dispatchers(tx)));
    return notify(tx, 'executor_cancelled', opts([executor]));
  }
  return 0;
}

// Новое сообщение в переписке: всем сторонам заявки, кроме автора (диспетчерам — если пишет не диспетчер).
export async function notifyMessage(tx, { actor, order, side }) {
  const users = [...(await customersOf(tx, order))];
  if (order.executor_user_id) users.push(order.executor_user_id);
  if (side !== 'dispatcher') users.push(...(await dispatchers(tx)));
  return notify(tx, 'message', { users, orderId: order.id, actor });
}

// Отправить накопившиеся СМС. Строки сначала «занимаются» (сдвигается время следующей попытки), потом отправляются вне
// транзакции: две копии сервера одну СМС не отправят. Неудача — повтор позже, после maxAttempts — «не отправлено».
export async function deliverPending(sql, providers, { limit = DELIVERY.batch } = {}) {
  const claimed = await sql`
    update notification_deliveries d
       set attempts = d.attempts + 1,
           next_at = now() + make_interval(secs => ${DELIVERY.retryAfterSec} * power(2, d.attempts)::int)
     where d.id in (select id from notification_deliveries
                    where status = 'pending' and next_at <= now() order by id limit ${limit} for update skip locked)
     returning d.*`;
  let sent = 0;
  for (const d of claimed) {
    try {
      const r = await providers.sms.send({ phone: d.phone, text: d.body });
      await sql`update notification_deliveries set status = 'sent', sent_at = now(), error = null, provider_id = ${r?.id ?? null}
                where id = ${d.id}`;
      sent += 1;
    } catch (e) {
      const error = String(e?.message || 'отказ поставщика').slice(0, 500);
      const final = d.attempts >= DELIVERY.maxAttempts;
      await sql`update notification_deliveries set error = ${error}, status = ${final ? 'failed' : 'pending'} where id = ${d.id}`;
    }
  }
  return { claimed: claimed.length, sent };
}
