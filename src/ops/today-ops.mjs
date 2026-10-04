// «Сегодня» (2.34): одним экраном — что требует внимания эксперта и руководителя экспертной организации. Эксперту: что
// горит по срокам, что вернули на доработку (диспетчер или руководитель), что ждёт проверки диспетчера, новые предложения.
// Руководителю — по каждой своей организации: дела экспертов, у которых горит срок, ждут подписи организации, возвращены
// эксперту и ждут исправления, дела, которые диспетчер предложил организации. Руководителю — те же сведения, что в «Делах
// экспертов» (2.16): без заказчика, полей заявки, документов и переписки. Только свои дела и свои организации.
import { orderRef } from '../notify/registry.mjs';
import { splitAmount } from '../money/money.mjs';
import { STATUS_NAME, addDays, isOverdue, todayMsk } from '../orders/workflow.mjs';
import { orderSignatures, orgReturns } from './sign-ops.mjs';

// «Горит» — просрочено или до срока не больше двух дней (как подсветка в списке дел).
const HOT_DAYS = 2;
const LIMIT = 50;

async function expertPart(sql, actor, registry, today) {
  const sp = await sql.one`select user_id from specialists where user_id = ${actor.id}`;
  if (!sp) return null;
  const rows = await sql`
    select * from orders where executor_user_id = ${actor.id} and status in ('awaiting_executor', 'in_work', 'review')
    order by deadline nulls last, updated_at limit ${LIMIT}`;
  const service = (o) => registry.service(o.module, o.service)?.service.name ?? o.service;
  const item = (o, extra = {}) => ({ id: o.id, title: o.title, service: service(o), deadline: o.deadline, overdue: isOverdue(o, today), ...extra });
  const soon = addDays(today, HOT_DAYS);
  const returned = [];
  for (const o of rows.filter((x) => x.status === 'in_work')) {
    // Диспетчер вернул на доработку: последний переход в «В работе» — из «Проверки результата».
    const last = await sql.one`select from_status, reason from order_status_history where order_id = ${o.id} and to_status = 'in_work'
                               order by id desc limit 1`;
    if (last?.from_status === 'review') returned.push(item(o, { by: 'Диспетчер', comment: last.reason ?? '' }));
    // Руководитель вернул файл (2.27), а эксперт ещё не исправил.
    for (const r of (await orgReturns(sql, o.id)).filter((x) => x.open)) {
      returned.push(item(o, { by: `Руководитель${r.by ? ` (${r.by})` : ''}`, comment: r.comment }));
    }
  }
  return {
    hot: rows.filter((o) => o.status === 'in_work' && o.deadline && o.deadline <= soon).map((o) => item(o)),
    returned,
    review: rows.filter((o) => o.status === 'review').map((o) => item(o)),
    offers: rows.filter((o) => o.status === 'awaiting_executor')
      .map((o) => item(o, { fee_kop: o.price_kop ? splitAmount(Number(o.price_kop)).payoutKop : null })),
  };
}

async function orgPart(sql, org, registry, today) {
  const soon = addDays(today, HOT_DAYS);
  const service = (o) => registry.service(o.module, o.service)?.service.name ?? o.service;
  // Дела экспертов организации (выбрали её в профиле специалиста и состоят в ней) — как в «Делах экспертов».
  const cases = await sql`
    select o.id, o.module, o.service, o.status, o.deadline, u.full_name as expert
    from orders o join specialists s on s.user_id = o.executor_user_id and s.org_id = ${org.id}
    join org_members m on m.org_id = s.org_id and m.user_id = s.user_id join users u on u.id = o.executor_user_id
    where o.status in ('awaiting_executor', 'in_work', 'review') order by o.deadline nulls last, o.id limit ${LIMIT}`;
  const view = (o, extra = {}) => ({
    order_ref: orderRef(o.id), service: service(o), deadline: o.deadline, overdue: isOverdue(o, today),
    status_name: STATUS_NAME[o.status], ...(o.expert !== undefined ? { expert: o.expert || 'Без имени' } : {}), ...extra,
  });
  const toSign = [];
  const returned = [];
  for (const o of cases.filter((x) => x.status === 'in_work')) {
    const signs = await orderSignatures(sql, o.id);
    const docs = await sql`select id from documents where order_id = ${o.id} and kind = 'result' and deleted_at is null
                           and uploaded_by = (select executor_user_id from orders where id = ${o.id})`;
    const waiting = docs.filter((d) => signs.get(d.id)?.expert && !signs.get(d.id)?.org).length;
    if (waiting) toSign.push(view(o, { files: waiting }));
    const open = (await orgReturns(sql, o.id, { orgId: org.id })).filter((r) => r.open);
    if (open.length) returned.push(view(o, { comment: open.at(-1).comment }));
  }
  const offered = await sql`
    select id, module, service, status, deadline from orders where offer_org_id = ${org.id} and status = 'awaiting_executor'
      and executor_user_id is null order by deadline nulls last, updated_at limit ${LIMIT}`;
  return {
    id: org.id,
    name: org.name,
    hot: cases.filter((o) => ['in_work', 'review'].includes(o.status) && o.deadline && o.deadline <= soon).map((o) => view(o)),
    to_sign: toSign,
    returned,
    pending: offered.map((o) => view(o)),
  };
}

export function todayOps() {
  return [
    {
      id: 'today.get', method: 'GET', path: '/api/today', auth: 'user', access: 'self',
      async handler({ sql, actor, registry }) {
        const today = todayMsk();
        const headOf = actor.orgs.filter((m) => m.role === 'head').map((m) => m.org_id);
        const orgs = headOf.length ? await sql`select id, name from organizations where id = any(${headOf}::uuid[]) order by name` : [];
        return {
          today,
          expert: await expertPart(sql, actor, registry, today),
          orgs: await Promise.all(orgs.map((o) => orgPart(sql, o, registry, today))),
        };
      },
    },
  ];
}
