// Уведомления в кабинете (задача 1.7): лента, отметка «прочитано», настройки СМС по видам.
// Каждый видит и меняет только свои уведомления и настройки. Название заявки в ленте показывается, только пока у
// человека есть доступ к заявке (ушёл из организации, снят с дела — остаётся лишь «заявка № …»).
import { HttpError } from '../http/core.mjs';
import { LEVEL, orderLevel } from '../access/policy.mjs';
import { EVENTS, TYPE, TYPES, orderRef } from '../notify/registry.mjs';

const LIST_LIMIT = 100;
const READ_IDS_MAX = 200;

// Какие виды уведомлений человеку показывать в настройках.
async function typesFor(sql, actor) {
  const specialist = await sql.one`select 1 from specialists where user_id = ${actor.id}`;
  return TYPES.filter((t) => t.for === 'all' || (t.for === 'specialist' && specialist)
    || (t.for === 'dispatcher' && actor.platform_role === 'dispatcher'));
}

async function settingsView(sql, actor) {
  const rows = await sql`select type, sms from notification_settings where user_id = ${actor.id}`;
  const mine = new Map(rows.map((r) => [r.type, r.sms]));
  return (await typesFor(sql, actor)).map((t) => ({ type: t.id, name: t.name, hint: t.hint, sms: mine.get(t.id) ?? t.sms }));
}

export async function unreadCount(sql, userId) {
  return (await sql.one`select count(*)::int as n from notifications where user_id = ${userId} and read_at is null`).n;
}

export function notifyOps() {
  return [
    {
      id: 'notifications.list', method: 'GET', path: '/api/notifications', auth: 'user', access: 'self',
      async handler({ sql, actor }) {
        const rows = await sql`
          select n.id, n.event, n.order_id, n.created_at, n.read_at from notifications n
          where n.user_id = ${actor.id} order by n.id desc limit ${LIST_LIMIT}`;
        const orderIds = [...new Set(rows.map((r) => r.order_id).filter(Boolean))];
        const orders = orderIds.length ? await sql`select * from orders where id = any(${orderIds}::uuid[])` : [];
        const visible = new Map(orders.filter((o) => orderLevel(actor, o) >= LEVEL.read).map((o) => [o.id, o]));
        return {
          unread: await unreadCount(sql, actor.id),
          notifications: rows.map((r) => {
            const order = r.order_id ? visible.get(r.order_id) : null;
            return {
              id: String(r.id),
              title: EVENTS[r.event]?.title ?? 'Уведомление',
              at: r.created_at,
              read: !!r.read_at,
              order_ref: r.order_id ? orderRef(r.order_id) : null,
              // Ссылка и название — только если заявка сейчас доступна.
              order_id: order ? order.id : null,
              order_title: order ? order.title : null,
              // Приглашение открывается в разделе «Организации» (там видно, от кого оно, пока действует); сообщение эксперта
              // руководителю (2.28) — там же, в «Делах экспертов».
              section: ['invite', 'org_chat_head'].includes(r.event) ? 'orgs' : ['crm_offer', 'onsite_assigned', 'onsite_cancelled'].includes(r.event) ? 'specialist' : null,
            };
          }),
        };
      },
    },
    {
      // Отметить прочитанными: перечисленные (ids) или все. Только свои — чужие номера просто не найдутся.
      id: 'notifications.read', method: 'POST', path: '/api/notifications/read', auth: 'user', access: 'self',
      async handler({ sql, actor, body }) {
        if (body?.all === true) {
          await sql`update notifications set read_at = now() where user_id = ${actor.id} and read_at is null`;
        } else {
          const ids = body?.ids;
          if (!Array.isArray(ids) || ids.length === 0 || ids.length > READ_IDS_MAX || ids.some((x) => !/^\d{1,18}$/.test(String(x)))) {
            throw new HttpError(400, 'bad_input', 'Не указано, какие уведомления отметить');
          }
          await sql`update notifications set read_at = now()
                    where user_id = ${actor.id} and read_at is null and id = any(${ids.map(String)}::bigint[])`;
        }
        return { unread: await unreadCount(sql, actor.id) };
      },
    },
    {
      id: 'notifications.settings', method: 'GET', path: '/api/notifications/settings', auth: 'user', access: 'self',
      async handler({ sql, actor }) {
        return { settings: await settingsView(sql, actor) };
      },
    },
    {
      // СМС по виду уведомлений: включить или выключить. В кабинете уведомления показываются всегда.
      id: 'notifications.settings.update', method: 'PUT', path: '/api/notifications/settings', auth: 'user', access: 'self',
      async handler({ sql, actor, body }) {
        const type = String(body?.type ?? '');
        if (!TYPE[type]) throw new HttpError(400, 'bad_input', 'Неизвестный вид уведомлений');
        if (typeof body?.sms !== 'boolean') throw new HttpError(400, 'bad_input', 'СМС: да или нет');
        await sql`insert into notification_settings (user_id, type, sms) values (${actor.id}, ${type}, ${body.sms})
                  on conflict (user_id, type) do update set sms = excluded.sms, updated_at = now()`;
        return { settings: await settingsView(sql, actor) };
      },
    },
  ];
}
