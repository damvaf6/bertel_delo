// Специалист, допуски и подбор исполнителя (задача 1.4).
// Допуски и профиль специалиста заводит только администратор; диспетчер видит оценку по признакам и предлагает дело;
// специалист сам принимает или отказывается (шаги исполнителя — src/orders/workflow.mjs).
// Решения Claude (на подтверждение Дамиру, DECISIONS.md 01.10.2026): допуск выдаёт администратор; специалист не получает
// собственные дела; отказ — с причиной, доля принятых предложений идёт в «качество прошлых работ».
import { HttpError } from '../http/core.mjs';
import { orderSides } from '../access/policy.mjs';
import { scoreSpecialist } from '../matching/score.mjs';
import { addDays, todayMsk } from '../orders/workflow.mjs';
import { audit, text, uuidFrom } from './util.mjs';

const REGIONS = { moscow: 'Москва', mo: 'Московская область' };
const OPEN_STATUSES = ['awaiting_executor', 'in_work', 'review'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function intIn(value, field, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, 'bad_input', `Поле «${field}»: целое от ${min} до ${max}`);
  return n;
}

function regionsFrom(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some((r) => !(r in REGIONS)) || new Set(value).size !== value.length) {
    throw new HttpError(400, 'bad_input', 'Поле «Где работает»: Москва и/или Московская область');
  }
  return value;
}

async function profileView(sql, userId) {
  const sp = await sql.one`
    select s.*, u.full_name, u.is_active as user_active,
           (select count(*)::int from orders where executor_user_id = s.user_id and status = any(${OPEN_STATUSES}::text[])) as open_orders
    from specialists s join users u on u.id = s.user_id where s.user_id = ${userId}`;
  if (!sp) return null;
  const permits = await sql`
    select module, service, valid_until from specialist_permits where user_id = ${userId} order by module, service`;
  return {
    user_id: sp.user_id, full_name: sp.full_name, active: sp.active, regions: sp.regions, capacity: sp.capacity,
    external_load: sp.external_load, open_orders: sp.open_orders, user_active: sp.user_active,
    permits: permits.map((p) => ({ ...p, valid_until: p.valid_until ?? null })),
  };
}

// Допущенные к услуге заявки специалисты с оценкой по признакам — по убыванию общей оценки.
export async function candidatesFor(sql, order) {
  const today = todayMsk();
  const rows = await sql`
    select s.user_id, s.regions, s.capacity, s.external_load, u.full_name,
      (select count(*)::int from orders o where o.executor_user_id = s.user_id and o.status = any(${OPEN_STATUSES}::text[])) as open,
      (select count(*)::int from order_offers f where f.specialist_id = s.user_id and f.outcome in ('accepted', 'declined')) as offers,
      (select count(*)::int from order_offers f where f.specialist_id = s.user_id and f.outcome = 'accepted') as accepted
    from specialists s
    join users u on u.id = s.user_id and u.is_active
    join specialist_permits p on p.user_id = s.user_id and p.module = ${order.module} and p.service = ${order.service}
         and (p.valid_until is null or p.valid_until >= ${today})
    where s.active and s.user_id <> ${order.owner_user_id}
      and not exists (select 1 from org_members m where m.user_id = s.user_id and m.org_id = ${order.org_id})`;
  const daysLeft = order.deadline ? Math.round((new Date(order.deadline) - new Date(today)) / 86400000) : null;
  return rows
    .map((r) => ({
      user_id: r.user_id, full_name: r.full_name,
      score: scoreSpecialist(r, { open: r.open, offers: r.offers, accepted: r.accepted }, order, daysLeft),
    }))
    .sort((a, b) => b.score.total - a.score.total || a.full_name.localeCompare(b.full_name));
}

function requireDispatcher(actor, order) {
  if (!orderSides(actor, order).includes('dispatcher')) throw new HttpError(403, 'forbidden', 'Недостаточно прав');
}

export function matchOps() {
  return [
    {
      // Мой профиль специалиста (если меня им сделали) — для кабинета.
      id: 'specialist.me', method: 'GET', path: '/api/specialist/me', auth: 'user', access: 'self',
      async handler({ sql, actor }) {
        return { specialist: await profileView(sql, actor.id) };
      },
    },
    {
      // Специалист сам включает и выключает приём предложений (на отпуск, болезнь).
      id: 'specialist.me.update', method: 'PATCH', path: '/api/specialist/me', auth: 'user', access: 'self',
      async handler({ sql, actor, body }) {
        if (typeof body?.active !== 'boolean') throw new HttpError(400, 'bad_input', 'Поле «Принимаю дела»: да или нет');
        const done = await sql`update specialists set active = ${body.active} where user_id = ${actor.id} returning 1`;
        if (!done.length) throw new HttpError(404, 'not_found', 'Вы не специалист');
        return { specialist: await profileView(sql, actor.id) };
      },
    },
    {
      id: 'specialists.list', method: 'GET', path: '/api/specialists', auth: 'user', access: { platform: 'staff' },
      async handler({ sql }) {
        const ids = await sql`select user_id from specialists order by user_id`;
        const list = await Promise.all(ids.map((r) => profileView(sql, r.user_id)));
        return { specialists: list.sort((a, b) => a.full_name.localeCompare(b.full_name)) };
      },
    },
    {
      // Сделать человека специалистом или поменять его профиль (район, нормальная нагрузка).
      id: 'specialists.upsert', method: 'PUT', path: '/api/admin/specialists/:id', auth: 'user', access: { platform: 'admin' },
      async handler({ sql, actor, params, body }) {
        const userId = uuidFrom(params.id, 'Пользователь не найден');
        const view = await sql.tx(async (tx) => {
          const u = await tx.one`select 1 from users where id = ${userId}`;
          if (!u) throw new HttpError(404, 'not_found', 'Пользователь не найден');
          const cur = await tx.one`select * from specialists where user_id = ${userId} for update`;
          const regions = body?.regions === undefined ? (cur?.regions ?? ['moscow', 'mo']) : regionsFrom(body.regions);
          const capacity = body?.capacity === undefined ? (cur?.capacity ?? 5) : intIn(body.capacity, 'Нормальная нагрузка', 1, 50);
          const external = body?.external_load === undefined ? (cur?.external_load ?? 0) : intIn(body.external_load, 'Дела вне платформы', 0, 500);
          await tx`
            insert into specialists (user_id, regions, capacity, external_load)
            values (${userId}, ${regions}, ${capacity}, ${external})
            on conflict (user_id) do update set regions = ${regions}, capacity = ${capacity}, external_load = ${external}`;
          await audit(tx, actor, 'specialist.upsert', 'user', userId, { regions, capacity, external });
          return profileView(tx, userId);
        });
        return { specialist: view };
      },
    },
    {
      id: 'specialists.permit.add', method: 'POST', path: '/api/admin/specialists/:id/permits', auth: 'user', access: { platform: 'admin' },
      async handler({ sql, actor, params, body, registry, res }) {
        const userId = uuidFrom(params.id, 'Специалист не найден');
        const def = registry.service(String(body?.module ?? ''), String(body?.service ?? ''));
        if (!def) throw new HttpError(400, 'bad_service', 'Выберите услугу');
        let until = null;
        if (body?.valid_until !== undefined && body.valid_until !== null && body.valid_until !== '') {
          until = String(body.valid_until);
          const d = new Date(`${until}T00:00:00Z`);
          if (!DATE_RE.test(until) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== until) throw new HttpError(400, 'bad_date', 'Поле «Действует до»: укажите дату');
          if (until < todayMsk() || until > addDays(todayMsk(), 10 * 365)) throw new HttpError(400, 'bad_date', 'Поле «Действует до»: не в прошлом и не дальше десяти лет');
        }
        const view = await sql.tx(async (tx) => {
          const sp = await tx.one`select 1 from specialists where user_id = ${userId}`;
          if (!sp) throw new HttpError(404, 'not_found', 'Специалист не найден');
          await tx`
            insert into specialist_permits (user_id, module, service, valid_until, granted_by)
            values (${userId}, ${def.module.id}, ${def.service.id}, ${until}, ${actor.id})
            on conflict (user_id, module, service) do update set valid_until = ${until}, granted_by = ${actor.id}`;
          await audit(tx, actor, 'specialist.permit.add', 'user', userId, { module: def.module.id, service: def.service.id, until });
          return profileView(tx, userId);
        });
        res.status(201);
        return { specialist: view };
      },
    },
    {
      id: 'specialists.permit.remove', method: 'DELETE', path: '/api/admin/specialists/:id/permits/:module/:service', auth: 'user', access: { platform: 'admin' },
      async handler({ sql, actor, params }) {
        const userId = uuidFrom(params.id, 'Специалист не найден');
        const view = await sql.tx(async (tx) => {
          const gone = await tx`delete from specialist_permits where user_id = ${userId} and module = ${params.module} and service = ${params.service} returning 1`;
          if (!gone.length) throw new HttpError(404, 'not_found', 'Допуск не найден');
          await audit(tx, actor, 'specialist.permit.remove', 'user', userId, { module: params.module, service: params.service });
          return profileView(tx, userId);
        });
        return { specialist: view };
      },
    },
    {
      // Диспетчер видит, кому можно отдать дело, и оценку по признакам.
      id: 'orders.candidates', method: 'GET', path: '/api/orders/:id/candidates', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order }) {
        requireDispatcher(actor, order);
        if (!['matching', 'awaiting_executor'].includes(order.status)) throw new HttpError(409, 'bad_transition', 'Подбор идёт только для заявок в подборе');
        return { candidates: await candidatesFor(sql, order), current_executor_id: order.executor_user_id };
      },
    },
    {
      // Предложить дело специалисту (из подбора) или передать другому (пока первый не ответил).
      id: 'orders.offer', method: 'POST', path: '/api/orders/:id/offer', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, body }) {
        requireDispatcher(actor, order);
        const specialistId = uuidFrom(body?.specialist_id, 'Специалист не найден');
        const from = String(body?.from ?? '');
        const updated = await sql.tx(async (tx) => {
          const cur = await tx.one`select * from orders where id = ${order.id} for update`;
          if (cur.status !== from) throw new HttpError(409, 'status_changed', 'Статус заявки уже изменился, обновите страницу');
          if (!['matching', 'awaiting_executor'].includes(cur.status)) throw new HttpError(409, 'bad_transition', `Из статуса «${cur.status}» так нельзя`);
          const cand = (await candidatesFor(tx, cur)).find((c) => c.user_id === specialistId);
          if (!cand) throw new HttpError(409, 'not_eligible', 'Этому специалисту дело отдать нельзя: нет допуска, не принимает дела или это его дело');
          const reassign = cur.status === 'awaiting_executor';
          if (reassign) {
            await tx`update order_offers set outcome = 'withdrawn', outcome_at = now(), reason = 'Передано другому специалисту'
                     where order_id = ${cur.id} and outcome is null`;
          }
          await tx`insert into order_offers (order_id, specialist_id, score, offered_by)
                   values (${cur.id}, ${specialistId}, ${JSON.stringify(cand.score)}, ${actor.id})`;
          const o = await tx.one`
            update orders set status = 'awaiting_executor', executor_user_id = ${specialistId}, updated_at = now()
            where id = ${cur.id} returning *`;
          await tx`insert into order_status_history (order_id, from_status, to_status, actor_id, side, reason)
                   values (${cur.id}, ${cur.status}, 'awaiting_executor', ${actor.id}, 'dispatcher', ${reassign ? 'Передано другому специалисту' : null})`;
          await audit(tx, actor, 'order.offer', 'order', cur.id, { specialist: specialistId, score: cand.score.total, reassign });
          return o;
        });
        return { order: { id: updated.id, status: updated.status, executor_user_id: updated.executor_user_id } };
      },
    },
  ];
}
