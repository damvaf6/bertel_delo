// Просьба эксперта передать дело коллеге (задача 2.107). Эксперт, который работает от организации, в деле в работе просит
// руководителя передать дело другому эксперту (отпуск, болезнь) с причиной. Руководителю — уведомление; в «Сегодня» и
// «Делах экспертов» — просьба с причиной: передать одной кнопкой (та же передача, что 2.62, — orgs.cases.transfer закрывает
// просьбу) или отказать с пояснением по желанию. Пока нет ответа, эксперт может отозвать. Заказчик и диспетчер просьбу не
// видят (внутреннее дело организации); в журнале дела — только служебным.
import { HttpError } from '../http/core.mjs';
import { executorSignOrg, orderSides } from '../access/policy.mjs';
import { notify } from '../notify/notify.mjs';
import { audit, text, uuidFrom } from './util.mjs';

const isExecutor = (actor, order) => order.executor_user_id === actor.id && orderSides(actor, order).includes('executor');

// Открытая просьба по делу — только от нынешнего исполнителя (после передачи диспетчером прежняя не в счёт).
export async function openHandover(sql, order) {
  if (!order.executor_user_id) return null;
  const r = await sql.one`select id, reason, requested_at from handover_requests
                          where order_id = ${order.id} and outcome is null and requested_by = ${order.executor_user_id}`;
  return r ? { ...r, id: String(r.id) } : null;
}

// Открытые просьбы по нескольким делам (руководителю в «Делах экспертов» и «Сегодня»).
export async function openHandovers(sql, orders) {
  const list = orders.filter((o) => o.status === 'in_work' && o.executor_user_id);
  if (!list.length) return new Map();
  const rows = await sql`select id, order_id, requested_by, reason, requested_at from handover_requests
                         where outcome is null and order_id = any(${list.map((o) => o.id)}::uuid[])`;
  const exec = new Map(list.map((o) => [o.id, o.executor_user_id]));
  return new Map(rows.filter((r) => exec.get(r.order_id) === r.requested_by)
    .map((r) => [r.order_id, { id: String(r.id), reason: r.reason, requested_at: r.requested_at }]));
}

async function view(sql, actor, order) {
  if (!isExecutor(actor, order)) return { available: false };
  const org = await executorSignOrg(sql, actor.id);
  if (!org) return { available: false };
  const open = await openHandover(sql, order);
  // Последний ответ руководителя (отказ с пояснением) — эксперт видит, почему дело осталось у него.
  const last = await sql.one`select outcome, answer, decided_at, reason from handover_requests
                             where order_id = ${order.id} and requested_by = ${actor.id} and outcome = 'declined'
                             order by id desc limit 1`;
  return {
    available: true,
    org: org.name,
    open,
    declined: !open && last ? { answer: last.answer ?? null, decided_at: last.decided_at, reason: last.reason } : null,
    can_request: order.status === 'in_work' && !open,
  };
}

// «Что сделал прежний эксперт» (задача 2.112): новому эксперту после передачи дела руководителем (2.62) — когда передали и
// что в деле осталось от прежнего: файлы результата (в сдачу не идут, 2.110), другие файлы, версии черновика, фото осмотра,
// выезд помощника, аналоги — и его просьба о переносе срока, если ждёт ответа диспетчера: оставить или отозвать. Причину
// передачи (болезнь) не показываем — её писал руководитель про прежнего эксперта. Только нынешнему исполнителю, только
// пока дело в работе и последняя передача — ему.
async function predecessorView(sql, actor, order) {
  if (!isExecutor(actor, order) || order.status !== 'in_work') return { transferred: false };
  const t = await sql.one`select at, details from audit_log where subject_type = 'order' and subject_id = ${order.id}
                          and action = 'org.case.transfer' order by id desc limit 1`;
  if (!t || t.details?.to !== actor.id || !t.details?.from) return { transferred: false };
  const prev = t.details.from;
  const who = await sql.one`select full_name from users where id = ${prev}`;
  const files = await sql`select kind, count(*)::int as n from documents
                          where order_id = ${order.id} and uploaded_by = ${prev} and deleted_at is null and kind in ('result', 'other') group by kind`;
  const fileN = (k) => files.find((f) => f.kind === k)?.n ?? 0;
  const draft = await sql.one`select count(*)::int as n, max(at) as last_at from result_drafts where order_id = ${order.id} and author_id = ${prev}`;
  // Фото осмотра — все, что пришли в дело до передачи (снимает владелец по ссылке или помощник, не сам эксперт).
  const photos = await sql.one`select count(*)::int as n from documents
                               where order_id = ${order.id} and kind = 'inspection' and deleted_at is null and created_at <= ${t.at}`;
  const visits = await sql.one`select count(*) filter (where finished_at is not null)::int as done,
                                      count(*) filter (where cancelled_at is not null and finished_at is null)::int as cancelled
                               from onsite_visits where order_id = ${order.id} and assigned_by = ${prev}`;
  const analogs = await sql.one`select count(*)::int as n, count(confirmed_at)::int as confirmed from order_analogs
                                where order_id = ${order.id} and author_id = ${prev} and deleted_at is null`;
  // Просьба о переносе срока, которую новый эксперт ещё не оставил за собой и не отозвал.
  const ext = await sql.one`select id, to_char(new_deadline, 'YYYY-MM-DD') as new_deadline, reason, requested_at from deadline_requests
                            where order_id = ${order.id} and outcome is null and requested_by <> ${actor.id} and kept_by is null`;
  return {
    transferred: true,
    at: t.at,
    from: who?.full_name || 'Без имени',
    results: fileN('result'),
    files: fileN('other'),
    drafts: draft.n,
    draft_at: draft.last_at,
    photos: photos.n,
    visits_done: visits.done,
    visits_cancelled: visits.cancelled,
    analogs: analogs.n,
    analogs_confirmed: analogs.confirmed,
    extend: ext ? { ...ext, id: String(ext.id) } : null,
  };
}

export function handoverOps() {
  return [
    {
      id: 'handover.get', method: 'GET', path: '/api/orders/:id/handover', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order }) { return view(sql, actor, order); },
    },
    {
      id: 'orders.predecessor', method: 'GET', path: '/api/orders/:id/predecessor', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order }) { return predecessorView(sql, actor, order); },
    },
    {
      // Новый эксперт оставляет за собой просьбу прежнего о переносе срока (2.112): диспетчер ответит как обычно, отозвать
      // её новый эксперт может и потом (deadline_requests.withdraw). Отозвать сразу — тоже deadline_requests.withdraw.
      id: 'orders.predecessor.keep_extend', method: 'POST', path: '/api/orders/:id/predecessor/extend/:rid/keep', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, params }) {
        if (!isExecutor(actor, order)) throw new HttpError(403, 'forbidden', 'Решает исполнитель дела');
        const rid = /^\d{1,18}$/.test(String(params.rid ?? '')) ? String(params.rid) : '0';
        const done = await sql`update deadline_requests set kept_by = ${actor.id}, kept_at = now()
                               where id = ${rid} and order_id = ${order.id} and outcome is null and kept_by is null
                                 and requested_by <> ${actor.id} returning to_char(new_deadline, 'YYYY-MM-DD') as new_deadline`;
        if (!done.length) throw new HttpError(409, 'already_decided', 'Просьбы уже нет — обновите страницу');
        await audit(sql, actor, 'deadline.keep', 'order', order.id, { to: done[0].new_deadline });
        return predecessorView(sql, actor, order);
      },
    },
    {
      // Эксперт просит руководителей своей организации передать дело коллеге. Причина обязательна.
      id: 'handover.create', method: 'POST', path: '/api/orders/:id/handover', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, body, res }) {
        if (!isExecutor(actor, order)) throw new HttpError(403, 'forbidden', 'Просит передать дело исполнитель дела');
        if (!String(body?.reason ?? '').trim()) throw new HttpError(400, 'reason_required', 'Укажите причину');
        const reason = text(body.reason, 'Причина', 1000);
        await sql.tx(async (tx) => {
          const cur = await tx.one`select status, executor_user_id from orders where id = ${order.id} for update`;
          if (cur.status !== 'in_work' || cur.executor_user_id !== actor.id) throw new HttpError(409, 'status_changed', 'Передать коллеге можно дело в работе — обновите страницу');
          const org = await executorSignOrg(tx, actor.id);
          if (!org) throw new HttpError(409, 'no_org', 'Вы работаете без организации — передать дело коллеге может только диспетчер');
          const heads = (await tx`select user_id from org_members where org_id = ${org.id} and role = 'head'`).map((h) => h.user_id);
          if (!heads.length) throw new HttpError(409, 'no_head', 'В организации нет руководителя — просить некого');
          // Просьба прежнего исполнителя (дело передали) больше не действует.
          await tx`update handover_requests set outcome = 'withdrawn', decided_at = now()
                   where order_id = ${order.id} and outcome is null and requested_by <> ${actor.id}`;
          const made = await tx`insert into handover_requests (order_id, org_id, requested_by, reason)
                                values (${order.id}, ${org.id}, ${actor.id}, ${reason}) on conflict do nothing returning id`;
          if (!made.length) throw new HttpError(409, 'already_requested', 'Просьба уже ждёт ответа руководителя');
          await audit(tx, actor, 'handover.request', 'order', order.id, { org: org.id, reason });
          await notify(tx, 'org_handover_requested', { users: heads, orderId: order.id, orgId: org.id, actor });
        });
        res.status(201);
        return view(sql, actor, order);
      },
    },
    {
      // Эксперт отзывает свою просьбу, пока руководитель не ответил.
      id: 'handover.withdraw', method: 'DELETE', path: '/api/orders/:id/handover/:rid', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, params }) {
        if (!isExecutor(actor, order)) throw new HttpError(403, 'forbidden', 'Отозвать просьбу может исполнитель дела');
        const rid = /^\d{1,18}$/.test(String(params.rid ?? '')) ? String(params.rid) : '0';
        const done = await sql`update handover_requests set outcome = 'withdrawn', decided_by = ${actor.id}, decided_at = now()
                               where id = ${rid} and order_id = ${order.id} and requested_by = ${actor.id} and outcome is null returning id`;
        if (!done.length) throw new HttpError(409, 'already_decided', 'Просьбы уже нет — обновите страницу');
        await audit(sql, actor, 'handover.withdraw', 'order', order.id, {});
        return view(sql, actor, order);
      },
    },
    {
      // Руководитель организации эксперта отказывает (пояснение — по желанию). Передать — orgs.cases.transfer.
      id: 'orgs.cases.handover_decline', method: 'POST', path: '/api/orgs/:id/cases/:orderId/handover/decline', auth: 'user',
      access: { resource: 'org', param: 'id', need: 'manage' },
      async handler({ sql, actor, org, params, body }) {
        const orderId = uuidFrom(params.orderId, 'Дело не найдено');
        const answer = body?.answer && String(body.answer).trim() ? text(body.answer, 'Пояснение', 1000) : null;
        await sql.tx(async (tx) => {
          const cur = await tx.one`select * from orders where id = ${orderId} for update`;
          if (!cur?.executor_user_id || (await executorSignOrg(tx, cur.executor_user_id))?.id !== org.id) throw new HttpError(404, 'not_found', 'Дело не найдено');
          const open = await openHandover(tx, cur);
          if (!open || cur.status !== 'in_work') throw new HttpError(409, 'already_decided', 'Просьбы уже нет — обновите страницу');
          await tx`update handover_requests set outcome = 'declined', decided_by = ${actor.id}, decided_at = now(), answer = ${answer}
                   where id = ${open.id} and outcome is null`;
          await audit(tx, actor, 'handover.decline', 'order', cur.id, { org: org.id, answer });
          await notify(tx, 'org_handover_declined', { users: [cur.executor_user_id], orderId: cur.id, actor });
        });
        return { ok: true };
      },
    },
  ];
}
