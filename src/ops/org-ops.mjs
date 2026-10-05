// Слой «организация» (задача 1.2): организация, состав и роли, приглашения по номеру телефона.
// Решения Дамира 30.09.2026: организацию заводит любой пользователь сам и становится руководителем;
// роли — руководитель / старший / сотрудник; ушедший сотрудник теряет доступ к делам организации, дела остаются у неё.
import { HttpError } from '../http/core.mjs';
import { LEVEL, ORG_ROLES, executorSignOrg, orgCaseSide, orgLevel } from '../access/policy.mjs';
import { audit, oneOf, phoneFrom, text, uuidFrom } from './util.mjs';
import { dispatchers, notify, notifyPhone, orgHeads } from '../notify/notify.mjs';
import { orgExpertsFor } from './match-ops.mjs';
import { orderSignatures, orgReturns } from './sign-ops.mjs';
import { orderRef } from '../notify/registry.mjs';
import { splitAmount } from '../money/money.mjs';
import { STATUS_NAME, isOverdue, todayMsk } from '../orders/workflow.mjs';

export const INVITE_TTL_DAYS = 14;
export const LIMITS = {
  orgsCreatedPerUser: 10,     // защита от засорения; настоящим организациям хватит с запасом
  pendingInvitesPerOrg: 50,
};

// Дела экспертов организации (2.16): активные — сверху; завершённые — за 90 дней, для сверки денег за месяц.
export const CASES_ACTIVE = ['awaiting_executor', 'in_work', 'review'];
const CASES_DONE = ['done', 'closed'];
const CASES_LIMIT = 200;
// Внутренняя переписка руководителя и эксперта (2.28): пишут, пока дело не завершено; читать можно и потом.
const ORG_CHAT_MAX = 4000;
const ORG_CHAT_OPEN = [...CASES_ACTIVE, 'done'];

// Кому руководитель может передать дело в работе (2.62): эксперты организации, которым дело можно отдать (допуск, «принимаю
// дела», досье в порядке, работают от организации), кроме нынешнего исполнителя; с нагрузкой.
async function transferTargets(sql, order, orgId, registry) {
  return (await orgExpertsFor(sql, order, orgId, registry))
    .filter((c) => c.user_id !== order.executor_user_id)
    .map((c) => ({ user_id: c.user_id, full_name: c.full_name || 'Без имени' }));
}

const ROLE_RU = { head: 'руководитель', senior: 'старший', member: 'сотрудник' };

function innFrom(value) {
  if (value == null || value === '') return null;
  const v = String(value).replace(/\s/g, '');
  if (!/^(\d{10}|\d{12})$/.test(v)) throw new HttpError(400, 'bad_inn', 'ИНН: 10 цифр для организации или 12 для ИП');
  return v;
}

function kppFrom(value) {
  if (value == null || value === '') return null;
  const v = String(value).replace(/\s/g, '');
  if (!/^\d{9}$/.test(v)) throw new HttpError(400, 'bad_kpp', 'КПП: 9 цифр');
  return v;
}
function addressFrom(value) {
  if (value == null || String(value).trim() === '') return null;
  return text(value, 'Юридический адрес', 500);
}

// Реквизиты (2.46) — для счёта и акта, когда организация заказывает экспертизу.
const publicOrg = (o) => ({ id: o.id, name: o.name, inn: o.inn, kpp: o.kpp ?? null, legal_address: o.legal_address ?? null, created_at: o.created_at });
const publicInvite = (i) => ({ id: i.id, org_id: i.org_id, phone: i.phone, role: i.role, created_at: i.created_at, expires_at: i.expires_at });

// В организации всегда остаётся хотя бы один руководитель. Вызывать внутри транзакции:
// строка организации блокируется, чтобы два руководителя не сняли друг друга одновременно.
async function assertHeadRemains(tx, orgId, leavingUserId) {
  await tx`select 1 from organizations where id = ${orgId} for update`;
  const rest = await tx.one`
    select count(*)::int as n from org_members where org_id = ${orgId} and role = 'head' and user_id <> ${leavingUserId}`;
  if (rest.n === 0) throw new HttpError(409, 'last_head', 'В организации должен остаться хотя бы один руководитель');
}

export function orgOps() {
  return [
    {
      id: 'orgs.create', method: 'POST', path: '/api/orgs', auth: 'user', access: 'self',
      async handler({ sql, actor, body, res }) {
        const name = text(body?.name, 'Название', 300);
        const inn = innFrom(body?.inn);
        const org = await sql.tx(async (tx) => {
          await tx`select 1 from users where id = ${actor.id} for update`;
          const made = await tx.one`select count(*)::int as n from organizations where created_by = ${actor.id}`;
          if (made.n >= LIMITS.orgsCreatedPerUser) throw new HttpError(429, 'too_many_orgs', 'Слишком много организаций');
          const o = await tx.one`insert into organizations (name, inn, created_by) values (${name}, ${inn}, ${actor.id}) returning *`;
          await tx`insert into org_members (org_id, user_id, role) values (${o.id}, ${actor.id}, 'head')`;
          await audit(tx, actor, 'org.create', 'org', o.id);
          return o;
        });
        res.status(201);
        return { org: publicOrg(org), my_role: 'head' };
      },
    },
    {
      id: 'orgs.list', method: 'GET', path: '/api/orgs', auth: 'user', access: 'self',
      async handler({ sql, actor }) {
        const orgs = await sql`
          select o.*, m.role as my_role from org_members m join organizations o on o.id = m.org_id
          where m.user_id = ${actor.id} order by o.name`;
        return { orgs: orgs.map((o) => ({ ...publicOrg(o), my_role: o.my_role })) };
      },
    },
    {
      id: 'orgs.get', method: 'GET', path: '/api/orgs/:id', auth: 'user',
      access: { resource: 'org', param: 'id', need: 'read' },
      async handler({ actor, org }) {
        const my = actor.orgs.find((m) => m.org_id === org.id);
        return { org: publicOrg(org), my_role: my?.role ?? null, manage: orgLevel(actor, org) === LEVEL.manage };
      },
    },
    {
      id: 'orgs.update', method: 'PATCH', path: '/api/orgs/:id', auth: 'user',
      access: { resource: 'org', param: 'id', need: 'manage' },
      async handler({ sql, actor, org, body }) {
        const name = body?.name === undefined ? org.name : text(body.name, 'Название', 300);
        const inn = body?.inn === undefined ? org.inn : innFrom(body.inn);
        const kpp = body?.kpp === undefined ? org.kpp : kppFrom(body.kpp);
        const address = body?.legal_address === undefined ? org.legal_address : addressFrom(body.legal_address);
        const updated = await sql.tx(async (tx) => {
          const o = await tx.one`update organizations set name = ${name}, inn = ${inn}, kpp = ${kpp}, legal_address = ${address}
                                 where id = ${org.id} returning *`;
          await audit(tx, actor, 'org.update', 'org', org.id);
          return o;
        });
        return { org: publicOrg(updated) };
      },
    },
    {
      // Состав: имена и роли видят все участники; телефоны — руководитель; число дел (нагрузку) — руководитель и старший.
      // «Дел» — заявки сотрудника от имени организации и дела в работе, которые он ведёт экспертом от неё (2.16).
      id: 'orgs.members', method: 'GET', path: '/api/orgs/:id/members', auth: 'user',
      access: { resource: 'org', param: 'id', need: 'read' },
      async handler({ sql, actor, org }) {
        const level = orgLevel(actor, org);
        const myRole = actor.orgs.find((m) => m.org_id === org.id)?.role;
        const seesLoad = myRole === 'head' || myRole === 'senior';
        const rows = await sql`
          select m.user_id, m.role, m.created_at, u.full_name, u.phone,
                 (select count(*)::int from orders r where r.org_id = m.org_id and r.owner_user_id = m.user_id)
                 + (select count(*)::int from orders r join specialists s on s.user_id = r.executor_user_id
                    where r.executor_user_id = m.user_id and s.org_id = m.org_id and r.status in ('in_work', 'review')) as orders
          from org_members m join users u on u.id = m.user_id
          where m.org_id = ${org.id}
          order by case m.role when 'head' then 0 when 'senior' then 1 else 2 end, u.full_name, m.created_at`;
        return {
          members: rows.map((m) => ({
            user_id: m.user_id,
            full_name: m.full_name,
            role: m.role,
            since: m.created_at,
            ...(level === LEVEL.manage ? { phone: m.phone } : {}),
            ...(seesLoad ? { orders: m.orders } : {}),
          })),
        };
      },
    },
    {
      // Дела экспертов (2.16, устав 1а): дела, где исполнитель — эксперт, работающий от этой организации (выбрал её в профиле
      // специалиста и состоит в ней). Только руководитель. Без заказчика, полей заявки, документов и переписки: услуга,
      // номер, срок, состояние, эксперт, вознаграждение; нагрузка по экспертам и деньги организации за месяц.
      id: 'orgs.cases', method: 'GET', path: '/api/orgs/:id/cases', auth: 'user',
      access: { resource: 'org', param: 'id', need: 'manage' },
      async handler({ sql, org, registry }) {
        const today = todayMsk();
        const experts = await sql`
          select s.user_id, u.full_name from specialists s
          join org_members m on m.org_id = s.org_id and m.user_id = s.user_id join users u on u.id = s.user_id
          where s.org_id = ${org.id} order by u.full_name nulls last, s.user_id`;
        const ids = experts.map((e) => e.user_id);
        const rows = ids.length ? await sql`
          select o.id, o.module, o.service, o.status, o.deadline, o.price_kop, o.paid_at, o.executor_user_id, o.updated_at,
                 o.owner_user_id, o.org_id,
                 p.status as payout_status, p.amount_kop as payout_kop, p.paid_at as payout_paid_at
          from orders o left join payouts p on p.order_id = o.id
          where o.executor_user_id = any(${ids}::uuid[]) and (o.status = any(${CASES_ACTIVE}::text[])
            or (o.status = any(${CASES_DONE}::text[]) and o.updated_at > now() - interval '90 days'))
          order by (o.status = any(${CASES_ACTIVE}::text[])) desc, o.deadline nulls last, o.updated_at desc
          limit ${CASES_LIMIT}` : [];
        const name = (e) => e?.full_name || 'Без имени';
        const byId = new Map(experts.map((e) => [e.user_id, e]));
        const feeOf = (o) => (o.payout_kop != null ? Number(o.payout_kop) : o.price_kop ? splitAmount(Number(o.price_kop)).payoutKop : null);
        // Что ждёт руководителя по делу (2.36): файлы, подписанные экспертом, ждут подписи организации; возврат эксперту
        // ещё не исправлен. Только по делам в работе.
        const waits = new Map();
        for (const o of rows.filter((x) => x.status === 'in_work')) {
          const signs = await orderSignatures(sql, o.id);
          const docs = await sql`select id from documents where order_id = ${o.id} and kind = 'result' and deleted_at is null
                                 and uploaded_by = ${o.executor_user_id}`;
          waits.set(o.id, {
            sign_wait: docs.filter((d) => signs.get(d.id)?.expert && !signs.get(d.id)?.org).length,
            returned_open: (await orgReturns(sql, o.id, { orgId: org.id })).some((r) => r.open),
          });
        }
        // Кому можно передать дело в работе (2.62): эксперты организации с допуском на услугу, кроме нынешнего.
        const transfer = new Map();
        for (const o of rows.filter((x) => x.status === 'in_work')) transfer.set(o.id, await transferTargets(sql, o, org.id, registry));
        const cases = rows.map((o) => ({
          ...(waits.get(o.id) ?? { sign_wait: 0, returned_open: false }),
          transfer_to: transfer.get(o.id) ?? [],
          // Номер дела — для внутренней переписки с экспертом (2.28); саму заявку руководитель по нему не откроет.
          id: o.id,
          order_ref: orderRef(o.id),
          service: registry.service(o.module, o.service)?.service.name ?? o.service,
          status: o.status,
          status_name: STATUS_NAME[o.status],
          active: CASES_ACTIVE.includes(o.status),
          deadline: o.deadline,
          overdue: isOverdue(o, today),
          expert: name(byId.get(o.executor_user_id)),
          expert_id: o.executor_user_id,
          fee_kop: feeOf(o),
          payout: o.payout_status ?? null,
        }));
        const load = experts.map((e) => ({
          user_id: e.user_id,
          full_name: name(e),
          in_work: rows.filter((o) => o.executor_user_id === e.user_id && ['in_work', 'review'].includes(o.status)).length,
          offered: rows.filter((o) => o.executor_user_id === e.user_id && o.status === 'awaiting_executor').length,
          overdue: cases.filter((c) => c.expert_id === e.user_id && c.overdue).length,
        }));
        // Деньги за текущий месяц (по Москве): выплачено экспертам организации; ждёт выдачи — оплаченные дела в работе и
        // на проверке, а также выплаты, которые ещё проводятся.
        const month = ids.length ? await sql.one`
          select coalesce(sum(amount_kop) filter (where status = 'succeeded'
                   and paid_at >= (date_trunc('month', now() at time zone 'Europe/Moscow') at time zone 'Europe/Moscow')), 0)::bigint as paid,
                 coalesce(sum(amount_kop) filter (where status <> 'succeeded'), 0)::bigint as pending
          from payouts where executor_user_id = any(${ids}::uuid[])` : { paid: 0, pending: 0 };
        const working = ids.length ? await sql`
          select price_kop from orders where executor_user_id = any(${ids}::uuid[]) and status in ('in_work', 'review')
            and price_kop is not null and paid_at is not null` : [];
        const waiting = Number(month.pending) + working.reduce((s, o) => s + splitAmount(Number(o.price_kop)).payoutKop, 0);
        // Ждут назначения (2.17): дела, которые диспетчер предложил организации, — те же сведения, что в «Делах экспертов»,
        // и эксперты, которых можно назначить (допуск, «принимаю дела»), с нагрузкой.
        const offered = await sql`
          select * from orders where offer_org_id = ${org.id} and status = 'awaiting_executor' and executor_user_id is null
          order by deadline nulls last, updated_at limit ${CASES_LIMIT}`;
        const loadOf = new Map(load.map((l) => [l.user_id, l]));
        const pending = await Promise.all(offered.map(async (o) => ({
          id: o.id,
          order_ref: orderRef(o.id),
          service: registry.service(o.module, o.service)?.service.name ?? o.service,
          deadline: o.deadline,
          overdue: isOverdue(o, today),
          fee_kop: o.price_kop ? splitAmount(Number(o.price_kop)).payoutKop : null,
          // Эксперт отказался — руководитель видит причину последнего отказа (только своих экспертов по этому делу).
          declined: (await sql.one`select reason from order_offers where order_id = ${o.id} and org_id = ${org.id}
                                   and specialist_id is not null and outcome = 'declined' order by id desc limit 1`)?.reason ?? null,
          experts: (await orgExpertsFor(sql, o, org.id, registry)).map((c) => ({
            user_id: c.user_id, full_name: c.full_name || 'Без имени', score: c.score.total,
            in_work: loadOf.get(c.user_id)?.in_work ?? 0, overdue: loadOf.get(c.user_id)?.overdue ?? 0,
          })),
        })));
        return {
          pending,
          cases: cases.map(({ expert_id, ...c }) => c),
          load,
          money: { month: today.slice(0, 7), paid_kop: Number(month.paid), waiting_kop: waiting },
        };
      },
    },
    {
      // Внутренняя переписка руководителя организации и эксперта по делу (2.28): отдельная лента, не переписка по заявке.
      // Заказчик и диспетчер её не видят, в письма по заявке (1.9) она не уходит. Лента — той организации, от которой
      // эксперт ведёт дело сейчас.
      id: 'orgchat.list', method: 'GET', path: '/api/orders/:id/org-chat', auth: 'user',
      access: { resource: 'orgCase', param: 'id', need: 'read' },
      async handler({ sql, actor, order, signOrg }) {
        const rows = await sql`
          select m.id, m.author_id, m.side, m.body, m.at, u.full_name
          from org_messages m join users u on u.id = m.author_id
          where m.order_id = ${order.id} and m.org_id = ${signOrg.id} order by m.id limit 500`;
        return {
          org: signOrg.name,
          side: orgCaseSide(actor, { order, signOrg }),
          messages: rows.map((m) => ({ id: String(m.id), side: m.side, body: m.body, at: m.at, mine: m.author_id === actor.id, author_name: m.full_name })),
          can_write: ORG_CHAT_OPEN.includes(order.status),
        };
      },
    },
    {
      id: 'orgchat.post', method: 'POST', path: '/api/orders/:id/org-chat', auth: 'user',
      access: { resource: 'orgCase', param: 'id', need: 'write' },
      async handler({ sql, actor, order, signOrg, body, res }) {
        const side = orgCaseSide(actor, { order, signOrg });
        if (!ORG_CHAT_OPEN.includes(order.status)) throw new HttpError(409, 'order_final', 'Дело завершено — переписка закрыта');
        const msg = text(body?.body, 'Сообщение', ORG_CHAT_MAX);
        const row = await sql.tx(async (tx) => {
          const m = await tx.one`insert into org_messages (order_id, org_id, author_id, side, body)
                                 values (${order.id}, ${signOrg.id}, ${actor.id}, ${side}, ${msg}) returning *`;
          await audit(tx, actor, 'org_chat.post', 'order', order.id, { org_id: signOrg.id, message: String(m.id), side });
          // Уведомления — по виду «Мои дела как исполнителя»: эксперту — по делу, руководителям — без номера в СМС.
          if (side === 'head') await notify(tx, 'org_chat_expert', { users: [order.executor_user_id], orderId: order.id, actor });
          else await notify(tx, 'org_chat_head', { users: await orgHeads(tx, signOrg.id), orderId: order.id, orgId: signOrg.id, actor });
          return m;
        });
        res.status(201);
        return { message: { id: String(row.id), side, body: row.body, at: row.at, mine: true, author_name: actor.full_name ?? null } };
      },
    },
    {
      // Руководитель назначает эксперта из своих на дело, предложенное организации (2.17). Эксперт принимает или
      // отказывается как обычно; отказ возвращает дело руководителю (src/ops/order-ops.mjs, шаг статуса).
      id: 'orgs.cases.assign', method: 'POST', path: '/api/orgs/:id/cases/:orderId/assign', auth: 'user',
      access: { resource: 'org', param: 'id', need: 'manage' },
      async handler({ sql, actor, org, params, body, registry }) {
        const orderId = uuidFrom(params.orderId, 'Дело не найдено');
        const specialistId = uuidFrom(body?.specialist_id, 'Эксперт не найден');
        await sql.tx(async (tx) => {
          const cur = await tx.one`select * from orders where id = ${orderId} and offer_org_id = ${org.id} for update`;
          if (!cur) throw new HttpError(404, 'not_found', 'Дело не найдено');
          if (cur.status !== 'awaiting_executor' || cur.executor_user_id) throw new HttpError(409, 'status_changed', 'Дело уже изменилось, обновите страницу');
          const cand = (await orgExpertsFor(tx, cur, org.id, registry)).find((c) => c.user_id === specialistId);
          if (!cand) throw new HttpError(409, 'not_eligible', 'Этому эксперту дело отдать нельзя: нет допуска, не принимает дела, истёк аттестат или полис в досье или работает не от организации');
          await tx`update order_offers set outcome = 'accepted', outcome_at = now() where order_id = ${cur.id} and outcome is null`;
          await tx`insert into order_offers (order_id, specialist_id, org_id, score, offered_by)
                   values (${cur.id}, ${specialistId}, ${org.id}, ${JSON.stringify(cand.score)}, ${actor.id})`;
          await tx`update orders set executor_user_id = ${specialistId}, updated_at = now() where id = ${cur.id}`;
          await audit(tx, actor, 'org.case.assign', 'order', cur.id, { org: org.id, specialist: specialistId });
          await notify(tx, 'offer', { users: [specialistId], orderId: cur.id, actor });
        });
        return { ok: true };
      },
    },
    {
      // Руководитель отказывается от дела организации (2.17): дело возвращается диспетчеру в подбор.
      id: 'orgs.cases.decline', method: 'POST', path: '/api/orgs/:id/cases/:orderId/decline', auth: 'user',
      access: { resource: 'org', param: 'id', need: 'manage' },
      async handler({ sql, actor, org, params, body }) {
        const orderId = uuidFrom(params.orderId, 'Дело не найдено');
        if (!String(body?.reason ?? '').trim()) throw new HttpError(400, 'reason_required', 'Укажите причину');
        const reason = text(body.reason, 'Причина', 1000);
        await sql.tx(async (tx) => {
          const cur = await tx.one`select * from orders where id = ${orderId} and offer_org_id = ${org.id} for update`;
          if (!cur) throw new HttpError(404, 'not_found', 'Дело не найдено');
          if (cur.status !== 'awaiting_executor' || cur.executor_user_id) throw new HttpError(409, 'status_changed', 'Дело уже изменилось, обновите страницу');
          await tx`update order_offers set outcome = 'declined', outcome_at = now(), reason = ${reason}
                   where order_id = ${cur.id} and outcome is null`;
          await tx`update orders set status = 'matching', offer_org_id = null, updated_at = now() where id = ${cur.id}`;
          await tx`insert into order_status_history (order_id, from_status, to_status, actor_id, side, reason)
                   values (${cur.id}, 'awaiting_executor', 'matching', ${actor.id}, 'executor', ${reason})`;
          await audit(tx, actor, 'org.case.decline', 'order', cur.id, { org: org.id });
          await notify(tx, 'org_declined', { users: await dispatchers(tx), orderId: cur.id, actor });
        });
        return { ok: true };
      },
    },
    {
      // Руководитель передаёт дело в работе другому эксперту своей организации (2.62: заболел, ушёл). Причина обязательна.
      // Файлы, черновик, фото осмотра, аналоги и обе переписки остаются в деле; прежний эксперт теряет доступ сразу (доступ
      // к делу — по исполнителю). Статус не меняется, заказчику имя не показывается (как и раньше); в журнале дела — только
      // служебным.
      id: 'orgs.cases.transfer', method: 'POST', path: '/api/orgs/:id/cases/:orderId/transfer', auth: 'user',
      access: { resource: 'org', param: 'id', need: 'manage' },
      async handler({ sql, actor, org, params, body, registry }) {
        const orderId = uuidFrom(params.orderId, 'Дело не найдено');
        const specialistId = uuidFrom(body?.specialist_id, 'Эксперт не найден');
        if (!String(body?.reason ?? '').trim()) throw new HttpError(400, 'reason_required', 'Укажите причину');
        const reason = text(body.reason, 'Причина', 1000);
        await sql.tx(async (tx) => {
          const cur = await tx.one`select * from orders where id = ${orderId} for update`;
          // Дело чужой организации (или без эксперта от этой) — «не найдено», как и в «Делах экспертов».
          if (!cur?.executor_user_id || (await executorSignOrg(tx, cur.executor_user_id))?.id !== org.id) throw new HttpError(404, 'not_found', 'Дело не найдено');
          if (cur.status !== 'in_work') throw new HttpError(409, 'status_changed', 'Передать можно только дело в работе — обновите страницу');
          if (specialistId === cur.executor_user_id) throw new HttpError(409, 'same_expert', 'Дело уже у этого эксперта');
          if (!(await transferTargets(tx, cur, org.id, registry)).some((c) => c.user_id === specialistId)) {
            throw new HttpError(409, 'not_eligible', 'Этому эксперту дело отдать нельзя: нет допуска, не принимает дела, истёк аттестат или полис в досье или работает не от организации');
          }
          const prev = cur.executor_user_id;
          await tx`update orders set executor_user_id = ${specialistId}, updated_at = now() where id = ${cur.id}`;
          // Ссылка на осмотр и выезд помощника, выданные прежним экспертом, перестают действовать (их состояние — по
          // исполнителю); закрываем их явно, чтобы владелец и помощник не ждали. Снятые фото и данные остаются в деле.
          const links = await tx`update inspection_links set revoked_at = now()
                                 where order_id = ${cur.id} and revoked_at is null and finished_at is null and expires_at > now() returning id`;
          const visits = await tx`update onsite_visits set cancelled_at = now()
                                  where order_id = ${cur.id} and finished_at is null and cancelled_at is null returning helper_id`;
          await audit(tx, actor, 'org.case.transfer', 'order', cur.id, { org: org.id, from: prev, to: specialistId, reason,
            links_closed: links.length, visits_cancelled: visits.length });
          if (visits.length) await notify(tx, 'onsite_cancelled', { users: visits.map((v) => v.helper_id), actor });
          await notify(tx, 'org_case_given', { users: [specialistId], orderId: cur.id, actor });
          await notify(tx, 'org_case_taken', { users: [prev], actor });
        });
        return { ok: true };
      },
    },
    {
      id: 'orgs.members.update', method: 'PATCH', path: '/api/orgs/:id/members/:userId', auth: 'user',
      access: { resource: 'org', param: 'id', need: 'manage' },
      async handler({ sql, actor, org, params, body }) {
        const userId = uuidFrom(params.userId, 'Сотрудник не найден');
        const role = oneOf(body?.role, ORG_ROLES, 'Роль');
        await sql.tx(async (tx) => {
          const m = await tx.one`select role from org_members where org_id = ${org.id} and user_id = ${userId}`;
          if (!m) throw new HttpError(404, 'not_found', 'Сотрудник не найден');
          if (m.role === 'head' && role !== 'head') await assertHeadRemains(tx, org.id, userId);
          await tx`update org_members set role = ${role} where org_id = ${org.id} and user_id = ${userId}`;
          await audit(tx, actor, 'org.member.role', 'org', org.id, { user_id: userId, from: m.role, to: role });
        });
        return { user_id: userId, role };
      },
    },
    {
      id: 'orgs.members.remove', method: 'DELETE', path: '/api/orgs/:id/members/:userId', auth: 'user',
      access: { resource: 'org', param: 'id', need: 'manage' },
      async handler({ sql, actor, org, params }) {
        const userId = uuidFrom(params.userId, 'Сотрудник не найден');
        await sql.tx(async (tx) => {
          const m = await tx.one`select role from org_members where org_id = ${org.id} and user_id = ${userId}`;
          if (!m) throw new HttpError(404, 'not_found', 'Сотрудник не найден');
          if (m.role === 'head') await assertHeadRemains(tx, org.id, userId);
          await tx`delete from org_members where org_id = ${org.id} and user_id = ${userId}`;
          await audit(tx, actor, 'org.member.remove', 'org', org.id, { user_id: userId });
        });
      },
    },
    {
      id: 'orgs.leave', method: 'POST', path: '/api/orgs/:id/leave', auth: 'user',
      access: { resource: 'org', param: 'id', need: 'write' },
      async handler({ sql, actor, org }) {
        await sql.tx(async (tx) => {
          const m = await tx.one`select role from org_members where org_id = ${org.id} and user_id = ${actor.id}`;
          if (!m) throw new HttpError(404, 'not_found', 'Не найдено');
          if (m.role === 'head') await assertHeadRemains(tx, org.id, actor.id);
          await tx`delete from org_members where org_id = ${org.id} and user_id = ${actor.id}`;
          await audit(tx, actor, 'org.member.leave', 'org', org.id);
        });
      },
    },
    {
      id: 'orgs.invites.list', method: 'GET', path: '/api/orgs/:id/invites', auth: 'user',
      access: { resource: 'org', param: 'id', need: 'manage' },
      async handler({ sql, org }) {
        const rows = await sql`
          select * from org_invites
          where org_id = ${org.id} and accepted_at is null and declined_at is null and revoked_at is null and expires_at > now()
          order by created_at desc`;
        return { invites: rows.map(publicInvite) };
      },
    },
    {
      // Ответ одинаковый, есть ли у номера учётная запись или нет, — чтобы по приглашениям нельзя было проверять номера.
      id: 'orgs.invites.create', method: 'POST', path: '/api/orgs/:id/invites', auth: 'user',
      access: { resource: 'org', param: 'id', need: 'manage' },
      async handler({ sql, actor, org, body, res }) {
        const phone = phoneFrom(body?.phone);
        const role = oneOf(body?.role ?? 'member', ORG_ROLES, 'Роль');
        const invite = await sql.tx(async (tx) => {
          await tx`select 1 from organizations where id = ${org.id} for update`;
          const already = await tx.one`
            select 1 from org_members m join users u on u.id = m.user_id where m.org_id = ${org.id} and u.phone = ${phone}`;
          if (already) throw new HttpError(409, 'already_member', 'Этот человек уже в организации');
          // Просроченное приглашение на тот же номер закрываем, чтобы можно было пригласить заново.
          await tx`update org_invites set revoked_at = now()
                   where org_id = ${org.id} and phone = ${phone} and expires_at <= now()
                     and accepted_at is null and declined_at is null and revoked_at is null`;
          const open = await tx`
            select phone from org_invites
            where org_id = ${org.id} and accepted_at is null and declined_at is null and revoked_at is null and expires_at > now()`;
          if (open.some((i) => i.phone === phone)) throw new HttpError(409, 'invite_exists', 'Приглашение на этот номер уже отправлено');
          if (open.length >= LIMITS.pendingInvitesPerOrg) throw new HttpError(429, 'too_many_invites', 'Слишком много неотвеченных приглашений');
          const i = await tx.one`
            insert into org_invites (org_id, phone, role, invited_by, expires_at)
            values (${org.id}, ${phone}, ${role}, ${actor.id}, now() + make_interval(days => ${INVITE_TTL_DAYS}))
            returning *`;
          await audit(tx, actor, 'org.invite.create', 'org', org.id, { invite_id: i.id, role });
          await notifyPhone(tx, 'invite', phone, { orgId: org.id, actor });
          return i;
        });
        res.status(201);
        return { invite: publicInvite(invite) };
      },
    },
    {
      id: 'invites.revoke', method: 'DELETE', path: '/api/invites/:id', auth: 'user',
      access: { resource: 'orgInvite', param: 'id', need: 'manage' },
      async handler({ sql, actor, invite }) {
        await sql.tx(async (tx) => {
          const r = await tx.one`update org_invites set revoked_at = now()
                                 where id = ${invite.id} and accepted_at is null and declined_at is null and revoked_at is null
                                 returning id`;
          if (!r) throw new HttpError(409, 'invite_closed', 'Приглашение уже принято, отклонено или отозвано');
          await audit(tx, actor, 'org.invite.revoke', 'org', invite.org_id, { invite_id: invite.id });
        });
      },
    },
    {
      // Мои приглашения — по номеру телефона вошедшего.
      id: 'invites.mine', method: 'GET', path: '/api/invites', auth: 'user', access: 'self',
      async handler({ sql, actor }) {
        const rows = await sql`
          select i.*, o.name as org_name from org_invites i join organizations o on o.id = i.org_id
          where i.phone = ${actor.phone} and i.accepted_at is null and i.declined_at is null and i.revoked_at is null
            and i.expires_at > now()
          order by i.created_at desc`;
        return { invites: rows.map((i) => ({ ...publicInvite(i), org_name: i.org_name, role_ru: ROLE_RU[i.role] })) };
      },
    },
    {
      id: 'invites.accept', method: 'POST', path: '/api/invites/:id/accept', auth: 'user',
      access: { resource: 'invite', param: 'id', need: 'write' },
      async handler({ sql, actor, invite }) {
        return sql.tx(async (tx) => {
          const i = await tx.one`update org_invites set accepted_at = now()
                                 where id = ${invite.id} and accepted_at is null and declined_at is null and revoked_at is null
                                   and expires_at > now()
                                 returning *`;
          if (!i) throw new HttpError(409, 'invite_closed', 'Приглашение уже недействительно');
          // Уже в организации (например, пригласили дважды разные руководители) — роль не меняем.
          const joined = await tx.one`
            insert into org_members (org_id, user_id, role) values (${i.org_id}, ${actor.id}, ${i.role})
            on conflict (org_id, user_id) do nothing returning role`;
          await audit(tx, actor, 'org.invite.accept', 'org', i.org_id, { invite_id: i.id });
          const m = joined ?? await tx.one`select role from org_members where org_id = ${i.org_id} and user_id = ${actor.id}`;
          return { org_id: i.org_id, role: m.role };
        });
      },
    },
    {
      id: 'invites.decline', method: 'POST', path: '/api/invites/:id/decline', auth: 'user',
      access: { resource: 'invite', param: 'id', need: 'write' },
      async handler({ sql, actor, invite }) {
        await sql.tx(async (tx) => {
          const r = await tx.one`update org_invites set declined_at = now()
                                 where id = ${invite.id} and accepted_at is null and declined_at is null and revoked_at is null
                                 returning id`;
          if (!r) throw new HttpError(409, 'invite_closed', 'Приглашение уже недействительно');
          await audit(tx, actor, 'org.invite.decline', 'org', invite.org_id, { invite_id: invite.id });
        });
      },
    },
  ];
}
