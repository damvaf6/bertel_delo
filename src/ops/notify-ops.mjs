// Уведомления в кабинете (задача 1.7): лента, отметка «прочитано», настройки СМС по видам.
// Каждый видит и меняет только свои уведомления и настройки. Название заявки в ленте показывается, только пока у
// человека есть доступ к заявке (ушёл из организации, снят с дела — остаётся лишь «заявка № …»).
import { HttpError } from '../http/core.mjs';
import { LEVEL, orderLevel } from '../access/policy.mjs';
import { EVENTS, TYPE, TYPES, orderRef } from '../notify/registry.mjs';
import { morningTitles, orgMorningTitles } from '../notify/morning.mjs';

const LIST_LIMIT = 100;
const READ_IDS_MAX = 200;

// Какие виды уведомлений человеку показывать в настройках.
async function typesFor(sql, actor) {
  const specialist = await sql.one`select 1 from specialists where user_id = ${actor.id}`;
  // 'head' — руководитель хотя бы одной организации (утренняя сводка по организации, 2.121).
  const head = actor.orgs.some((m) => m.role === 'head');
  return TYPES.filter((t) => t.for === 'all' || (t.for === 'specialist' && specialist) || (t.for === 'head' && head)
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

function sectionOf(actor, r) {
  const sec = EVENTS[r.event]?.section ?? null;
  if (sec === 'orgs' && r.org_id && actor.orgs.some((m) => m.org_id === r.org_id)) {
    // По делу организации (2.67) — сразу к делу: номер дела (как в «Делах экспертов») и что сделать.
    const focus = EVENTS[r.event]?.focus;
    return focus && r.order_id ? `org=${r.org_id}&case=${orderRef(r.order_id).slice(2)}&to=${focus}` : `org=${r.org_id}`;
  }
  // К блоку раздела (2.119: утренняя сводка — к «Моим срокам»).
  const anchor = EVENTS[r.event]?.anchor;
  return anchor ? `${sec}&to=${anchor}` : sec;
}

export function notifyOps() {
  return [
    {
      id: 'notifications.list', method: 'GET', path: '/api/notifications', auth: 'user', access: 'self',
      async handler({ sql, actor }) {
        const rows = await sql`
          select n.id, n.event, n.order_id, n.org_id, g.name as org_name, n.created_at, n.read_at from notifications n
          left join organizations g on g.id = n.org_id
          where n.user_id = ${actor.id} order by n.id desc limit ${LIST_LIMIT}`;
        const orderIds = [...new Set(rows.map((r) => r.order_id).filter(Boolean))];
        const orders = orderIds.length ? await sql`select * from orders where id = any(${orderIds}::uuid[])` : [];
        const visible = new Map(orders.filter((o) => orderLevel(actor, o) >= LEVEL.read).map((o) => [o.id, o]));
        // Утренняя сводка (2.119) — с цифрами дня.
        const morning = await morningTitles(sql, rows.filter((r) => r.event === 'morning_today').map((r) => String(r.id)));
        // Утренняя сводка руководителю (2.121) — с цифрами дня и названием организации.
        const orgMorning = await orgMorningTitles(sql, rows.filter((r) => r.event === 'org_morning_today').map((r) => String(r.id)));
        return {
          unread: await unreadCount(sql, actor.id),
          notifications: rows.map((r) => {
            const order = r.order_id ? visible.get(r.order_id) : null;
            return {
              id: String(r.id),
              title: morning.get(String(r.id)) ?? orgMorning.get(String(r.id)) ?? EVENTS[r.event]?.title ?? 'Уведомление',
              at: r.created_at,
              read: !!r.read_at,
              order_ref: r.order_id ? orderRef(r.order_id) : null,
              // Ссылка и название — только если заявка сейчас доступна.
              order_id: order ? order.id : null,
              order_title: order ? order.title : null,
              // Куда ведёт уведомление без заявки (2.45) — раздел из реестра; по организации — сразу в неё (если человек
              // в ней состоит: иначе — общий раздел «Организации», где видно приглашение).
              section: sectionOf(actor, r),
              // К какому блоку дела (2.115: напоминание по заметке — к заметкам).
              to: order ? (EVENTS[r.event]?.to ?? null) : null,
              // Какая организация (2.45): у руководителя их может быть несколько.
              org_name: r.org_id && actor.orgs.some((m) => m.org_id === r.org_id) ? r.org_name : null,
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
