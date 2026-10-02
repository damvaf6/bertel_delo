// Экспресс-услуга (задача 2.4): на объект выезжает помощник платформы, эксперт работает дистанционно.
// Исполнитель экспресс-заявки, пока дело у него в работе, назначает выезд: кого (помощник — специалист с отметкой «выезды»
// в районе объекта) и на когда. Помощник в кабинете видит только свой выезд: услугу, поля для поиска объекта (список — в
// описании модуля, express.show) и шаги — те же, что у дистанционного осмотра (2.3). Он снимает по шагам (у каждого фото —
// время и геометка) и заполняет данные с объекта (express.fields); «Готово» — данные и фото у эксперта, выезд закрыт.
import { HttpError, notFound } from '../http/core.mjs';
import { isStaff, orderSides } from '../access/policy.mjs';
import { cleanValues, missingRequired } from '../modules/index.mjs';
import { notify } from '../notify/notify.mjs';
import { INSPECT, stepCounts, storePhoto } from './inspect-ops.mjs';
import { audit, uuidFrom } from './util.mjs';

const PLAN_MAX_DAYS = 60;

// Выезд действует: не отменён, не завершён, дело в работе у того, кто его назначил.
export const visitState = (v, order) => {
  if (v.cancelled_at) return 'cancelled';
  if (v.finished_at) return 'finished';
  if (order.status !== 'in_work' || order.executor_user_id !== v.assigned_by) return 'closed';
  return 'active';
};

const STATE_RU = {
  cancelled: 'Выезд отменён экспертом',
  finished: 'Выезд завершён — данные переданы эксперту',
  closed: 'Выезд закрыт: дело больше не в работе у эксперта, который его назначил',
};

const canAssign = (actor, order) => order.status === 'in_work' && order.express && orderSides(actor, order).includes('executor');

// Помощники, которым можно назначить выезд: отметка «выезды», включён приём, район объекта; не заказчик, не его
// организация и не сам исполнитель.
export async function helpersFor(sql, order) {
  const region = order.fields?.region ?? null;
  return sql`
    select s.user_id, u.full_name,
      (select count(*)::int from onsite_visits v join orders o on o.id = v.order_id
        where v.helper_id = s.user_id and v.finished_at is null and v.cancelled_at is null
          and o.status = 'in_work' and o.executor_user_id = v.assigned_by) as open_visits
    from specialists s join users u on u.id = s.user_id and u.is_active
    where s.onsite and s.active and (${region}::text is null or ${region}::text = any(s.regions))
      and s.user_id <> ${order.owner_user_id} and s.user_id <> ${order.executor_user_id}
      and not exists (select 1 from org_members m where m.user_id = s.user_id and m.org_id = ${order.org_id})
    order by open_visits, u.full_name`;
}

function plannedFrom(value) {
  const d = new Date(String(value ?? ''));
  if (!value || Number.isNaN(d.getTime())) throw new HttpError(400, 'bad_input', 'Укажите дату и время выезда');
  const now = Date.now();
  if (d.getTime() < now - 3600_000) throw new HttpError(400, 'bad_input', 'Дата выезда — не в прошлом');
  if (d.getTime() > now + PLAN_MAX_DAYS * 86400_000) throw new HttpError(400, 'bad_input', `Дата выезда — не дальше ${PLAN_MAX_DAYS} дней`);
  return d.toISOString();
}

// Данные с объекта наружу: подпись поля и значение (для выбора — название варианта).
function dataView(fields, data) {
  return fields.filter((f) => data?.[f.id] !== undefined).map((f) => ({
    id: f.id, label: f.label,
    value: f.type === 'select' ? (f.options.find((o) => o.id === data[f.id])?.name ?? data[f.id]) : data[f.id],
  }));
}

export function onsiteOps() {
  // Выезд глазами помощника: услуга, поля для поиска объекта, шаги с числом фото, данные — без заявки и имён.
  async function helperView(sql, registry, visit, order) {
    const def = registry.service(order.module, order.service);
    const ex = registry.express(order.module, order.service);
    const counts = await stepCounts(sql, { visit: visit.id });
    const state = visitState(visit, order);
    return {
      id: String(visit.id),
      state,
      message: STATE_RU[state] ?? null,
      service: def?.service.name ?? null,
      planned_at: visit.planned_at,
      finished_at: visit.finished_at,
      object: dataView(ex?.show ?? [], order.fields),
      steps: registry.inspectionSteps(order.module, order.service).map((s) => ({ ...s, photos: counts[s.id] ?? 0 })),
      fields: ex?.fields ?? [],
      data: visit.data,
      limits: { photos: INSPECT.photosMax, per_step: INSPECT.perStepMax, file_bytes: INSPECT.fileMax },
    };
  }

  const requireActive = (visit, order) => {
    const state = visitState(visit, order);
    if (state !== 'active') throw new HttpError(410, 'visit_inactive', STATE_RU[state]);
  };

  return [
    {
      // Выезды в деле: когда, чем кончились, данные с объекта. Имя помощника — исполнителю и служебным.
      id: 'onsite.get', method: 'GET', path: '/api/orders/:id/onsite', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry }) {
        const ex = registry.express(order.module, order.service);
        const names = isStaff(actor) || order.executor_user_id === actor.id;
        const visits = await sql`
          select v.*, u.full_name as helper_name,
                 (select count(*)::int from inspection_photos p where p.visit_id = v.id) as photos
          from onsite_visits v join users u on u.id = v.helper_id where v.order_id = ${order.id} order by v.id desc`;
        const can = canAssign(actor, order) && !!ex;
        return {
          express: order.express,
          can_assign: can,
          helpers: can ? (await helpersFor(sql, order)).map((h) => ({ user_id: h.user_id, name: h.full_name, open_visits: h.open_visits })) : [],
          visits: visits.map((v) => ({
            id: String(v.id), state: visitState(v, order), planned_at: v.planned_at, finished_at: v.finished_at,
            cancelled_at: v.cancelled_at, photos: v.photos, helper_name: names ? v.helper_name : null,
            data: dataView(ex?.fields ?? [], v.data),
          })),
        };
      },
    },
    {
      // Назначить выезд. Открытый выезд прежнего помощника отменяется: у заявки один открытый выезд за раз.
      id: 'onsite.assign', method: 'POST', path: '/api/orders/:id/onsite', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry, body, res }) {
        if (!canAssign(actor, order)) throw new HttpError(403, 'forbidden', 'Выезд назначает исполнитель экспресс-заявки, пока дело в работе');
        if (!registry.express(order.module, order.service)) throw new HttpError(400, 'no_express', 'Для этой услуги экспресса нет');
        const helperId = uuidFrom(body?.helper_id, 'Помощник не найден');
        const planned = plannedFrom(body?.planned_at);
        const visit = await sql.tx(async (tx) => {
          const cur = await tx.one`select * from orders where id = ${order.id} for update`;
          if (!canAssign(actor, cur)) throw new HttpError(409, 'status_changed', 'Статус заявки уже изменился, обновите страницу');
          if (!(await helpersFor(tx, cur)).some((h) => h.user_id === helperId)) {
            throw new HttpError(409, 'not_eligible', 'Этому человеку выезд назначить нельзя: он не помощник на объекте, не работает в этом районе или не принимает дела');
          }
          const prev = await tx`update onsite_visits set cancelled_at = now()
                                where order_id = ${cur.id} and finished_at is null and cancelled_at is null returning helper_id`;
          const v = await tx.one`insert into onsite_visits (order_id, helper_id, assigned_by, planned_at)
                                 values (${cur.id}, ${helperId}, ${actor.id}, ${planned}) returning *`;
          await audit(tx, actor, 'onsite.assign', 'order', cur.id, { visit: String(v.id), helper: helperId, replaced: prev.length > 0 });
          // Помощнику — без номера заявки: заявку он не видит, выезд открывается в его разделе «Специалист».
          if (prev.length && prev[0].helper_id !== helperId) await notify(tx, 'onsite_cancelled', { users: [prev[0].helper_id], actor });
          await notify(tx, 'onsite_assigned', { users: [helperId], actor });
          return v;
        });
        res.status(201);
        return { visit: { id: String(visit.id), state: 'active', planned_at: visit.planned_at } };
      },
    },
    {
      id: 'onsite.cancel', method: 'DELETE', path: '/api/orders/:id/onsite/:visit', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, params }) {
        if (!canAssign(actor, order)) throw new HttpError(403, 'forbidden', 'Отменить выезд может исполнитель, пока дело в работе');
        if (!/^\d{1,18}$/.test(params.visit)) throw notFound();
        await sql.tx(async (tx) => {
          const v = await tx.one`update onsite_visits set cancelled_at = now()
                                 where id = ${params.visit} and order_id = ${order.id} and finished_at is null and cancelled_at is null
                                 returning id, helper_id`;
          if (!v) throw notFound();
          await audit(tx, actor, 'onsite.cancel', 'order', order.id, { visit: String(v.id) });
          await notify(tx, 'onsite_cancelled', { users: [v.helper_id], actor });
        });
      },
    },
    {
      // Мои выезды (помощник): последние 50, сначала действующие.
      id: 'visits.mine', method: 'GET', path: '/api/visits', auth: 'user', access: 'self',
      async handler({ sql, actor, registry }) {
        const rows = await sql`
          select v.*, o.module, o.service, o.fields, o.status as order_status, o.executor_user_id
          from onsite_visits v join orders o on o.id = v.order_id where v.helper_id = ${actor.id} order by v.id desc limit 50`;
        const list = rows.map((v) => {
          // Где объект — только из полей заявки, которые помощнику положено видеть (express.show).
          const show = registry.express(v.module, v.service)?.show ?? [];
          const place = show.find((f) => ['address', 'location'].includes(f.id) && v.fields?.[f.id]);
          return {
            id: String(v.id), state: visitState(v, { status: v.order_status, executor_user_id: v.executor_user_id }),
            planned_at: v.planned_at, finished_at: v.finished_at,
            service: registry.service(v.module, v.service)?.service.name ?? null,
            place: place ? v.fields[place.id] : null,
          };
        });
        return { visits: list.sort((a, b) => Number(b.state === 'active') - Number(a.state === 'active')) };
      },
    },
    {
      id: 'visits.get', method: 'GET', path: '/api/visits/:id', auth: 'user',
      access: { resource: 'visit', param: 'id', need: 'read' },
      async handler({ sql, registry, visit, order }) {
        return { visit: await helperView(sql, registry, visit, order) };
      },
    },
    {
      id: 'visits.photo', method: 'POST', path: '/api/visits/:id/photos', auth: 'user',
      access: { resource: 'visit', param: 'id', need: 'write' },
      body: 'raw', limit: INSPECT.fileMax,
      async handler(ctx) {
        const { actor, registry, visit, order, res } = ctx;
        requireActive(visit, order);
        const out = await storePhoto(ctx, { order, steps: registry.inspectionSteps(order.module, order.service),
          uploadedBy: actor.id, source: { visit: visit.id }, actor });
        res.status(201);
        return out;
      },
    },
    {
      // Данные с объекта: сохраняются частями, обязательные проверяются при «Готово».
      id: 'visits.data', method: 'PUT', path: '/api/visits/:id/data', auth: 'user',
      access: { resource: 'visit', param: 'id', need: 'write' },
      async handler({ sql, actor, registry, visit, order, body }) {
        const ex = registry.express(order.module, order.service);
        const data = cleanValues(ex?.fields ?? [], body?.data);
        const v = await sql.tx(async (tx) => {
          const cur = await tx.one`select * from onsite_visits where id = ${visit.id} for update`;
          requireActive(cur, order);
          const u = await tx.one`update onsite_visits set data = ${JSON.stringify(data)} where id = ${visit.id} returning *`;
          await audit(tx, actor, 'onsite.data', 'order', order.id, { visit: String(visit.id) });
          return u;
        });
        return { visit: await helperView(sql, registry, v, order) };
      },
    },
    {
      // «Готово»: нужны обязательные данные и хотя бы одно фото; эксперт получает уведомление.
      id: 'visits.finish', method: 'POST', path: '/api/visits/:id/finish', auth: 'user',
      access: { resource: 'visit', param: 'id', need: 'write' },
      async handler({ sql, actor, registry, visit, order }) {
        const ex = registry.express(order.module, order.service);
        const v = await sql.tx(async (tx) => {
          const cur = await tx.one`select * from onsite_visits where id = ${visit.id} for update`;
          requireActive(cur, order);
          const missing = missingRequired(ex?.fields ?? [], cur.data);
          if (missing.length) throw new HttpError(400, 'incomplete', `Заполните: ${missing.join(', ')}`);
          const n = Object.values(await stepCounts(tx, { visit: cur.id })).reduce((a, b) => a + b, 0);
          if (!n) throw new HttpError(409, 'no_photos', 'Сначала сделайте хотя бы одно фото');
          const u = await tx.one`update onsite_visits set finished_at = now() where id = ${cur.id} returning *`;
          await audit(tx, actor, 'onsite.finish', 'order', order.id, { visit: String(cur.id), photos: n });
          await notify(tx, 'onsite_done', { users: [cur.assigned_by], orderId: order.id, actor });
          return u;
        });
        return { visit: await helperView(sql, registry, v, order) };
      },
    },
  ];
}
