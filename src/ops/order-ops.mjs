// Единая «Заявка» (задача 1.3): услуга из описания модуля, поля, срок, основание, статусы и история.
// Решения Дамира 30.09.2026: срок обязателен; основание — договор по умолчанию, определение суда — с номером, датой
// и файлом; отмена заказчиком — только до начала работ; перечень услуг и поля меняются через разработку.
import { HttpError } from '../http/core.mjs';
import { LEVEL, isStaff, memberOf, orderLevel, orderSides, visibleOrdersFilter } from '../access/policy.mjs';
import { BASIS_KINDS, cleanValues, missingRequired } from '../modules/index.mjs';
import { STATUSES, STATUS_NAME, TRANSITIONS, WORK_STARTED, addDays, availableActions, findTransition, isOverdue, todayMsk } from '../orders/workflow.mjs';
import { runSettlement, settleCancel, settleDone } from '../money/money.mjs';
import { audit, oneOf, text, uuidFrom } from './util.mjs';
import { reviewState } from './work-ops.mjs';
import { notifyStatus } from '../notify/notify.mjs';

const LEVEL_NAME = ['none', 'read', 'write', 'manage'];
const DEADLINE_MAX_DAYS = 2 * 365;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateFrom(value, field) {
  const v = String(value ?? '');
  const d = new Date(`${v}T00:00:00Z`);
  if (!DATE_RE.test(v) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    throw new HttpError(400, 'bad_date', `Поле «${field}»: укажите дату`);
  }
  return v;
}

// Срок: не раньше сегодняшнего дня по Москве и не дальше двух лет.
function deadlineFrom(value) {
  if (value === null || value === '') return null;
  const v = dateFrom(value, 'Срок');
  const today = todayMsk();
  if (v < today) throw new HttpError(400, 'deadline_past', 'Срок не может быть в прошлом');
  if (v > addDays(today, DEADLINE_MAX_DAYS)) throw new HttpError(400, 'deadline_far', 'Срок — не дальше двух лет');
  return v;
}

function basisDateFrom(value) {
  if (value === null || value === '') return null;
  const v = dateFrom(value, 'Дата определения');
  if (v > todayMsk() || v < '2000-01-01') throw new HttpError(400, 'bad_date', 'Дата определения: не позже сегодняшнего дня');
  return v;
}

function optionalText(value, field, max) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  return text(value, field, max);
}

export function orderOps() {
  // Заявка наружу: с названиями услуги и статуса, организацией и тем, кто её ведёт (имя, без телефона).
  async function orderView(sql, registry, order) {
    const extra = await sql.one`
      select o.name as org_name, u.full_name as responsible_name
      from users u left join organizations o on o.id = ${order.org_id}
      where u.id = ${order.owner_user_id}`;
    return {
      ...describe(registry, order),
      org_name: extra?.org_name ?? null,
      responsible_name: extra?.responsible_name ?? '',
    };
  }

  function describe(registry, order, today = todayMsk()) {
    const def = order.module ? registry.service(order.module, order.service) : null;
    return {
      id: order.id,
      title: order.title,
      module: order.module,
      service: order.service,
      module_name: def?.module.name ?? null,
      service_name: def?.service.name ?? null,
      status: order.status,
      status_name: STATUS_NAME[order.status],
      deadline: order.deadline,
      paid: !!order.paid_at,
      overdue: isOverdue(order, today),
      basis_kind: order.basis_kind,
      basis_name: BASIS_KINDS[order.basis_kind]?.name ?? null,
      basis_number: order.basis_number,
      basis_date: order.basis_date,
      fields: order.fields,
      org_id: order.org_id,
      owner_user_id: order.owner_user_id,
      created_at: order.created_at,
      submitted_at: order.submitted_at,
      updated_at: order.updated_at,
      ...(order.org_name !== undefined ? { org_name: order.org_name, responsible_name: order.responsible_name ?? '' } : {}),
    };
  }

  // Готова ли заявка к отправке: услуга, обязательные поля, срок, основание. Список того, чего не хватает.
  async function problemsForSubmit(tx, registry, order) {
    const out = [];
    const def = order.module ? registry.service(order.module, order.service) : null;
    if (!def) out.push('услуга');
    else out.push(...missingRequired(def.fields, order.fields));
    if (!order.deadline) out.push('срок');
    else if (order.deadline < todayMsk()) out.push('срок (дата уже прошла)');
    if (def && !def.module.basis.includes(order.basis_kind)) out.push('основание');
    if (BASIS_KINDS[order.basis_kind]?.details) {
      if (!order.basis_number) out.push('номер определения');
      if (!order.basis_date) out.push('дата определения');
      const file = await tx.one`select 1 from documents where order_id = ${order.id} and kind = 'basis' and deleted_at is null limit 1`;
      if (!file) out.push('файл определения суда');
    }
    return out;
  }

  return [
    {
      // Перечень услуг, полей и ИИ-проверок всех модулей и список статусов. Общие данные, не чьи-то личные.
      id: 'catalog', method: 'GET', path: '/api/catalog', auth: 'user', access: 'self',
      async handler({ registry }) {
        return { modules: registry.catalog(), statuses: STATUSES };
      },
    },
    {
      id: 'orders.create', method: 'POST', path: '/api/orders', auth: 'user', access: 'self',
      async handler({ sql, actor, body, res, registry }) {
        const def = registry.service(String(body?.module ?? ''), String(body?.service ?? ''));
        if (!def) throw new HttpError(400, 'bad_service', 'Выберите услугу');
        const title = body?.title == null || String(body.title).trim() === '' ? def.service.name : text(body.title, 'Название', 300);
        const orgId = body?.org_id == null ? null : uuidFrom(body.org_id, 'Организация не найдена');
        // Заявку от имени организации создаёт только её участник.
        if (orgId !== null && !memberOf(actor, orgId)) throw new HttpError(404, 'not_found', 'Организация не найдена');
        const basisKind = def.module.basis[0];
        const order = await sql.tx(async (tx) => {
          const o = await tx.one`
            insert into orders (owner_user_id, org_id, title, module, service, basis_kind)
            values (${actor.id}, ${orgId}, ${title}, ${def.module.id}, ${def.service.id}, ${basisKind}) returning *`;
          await tx`insert into order_status_history (order_id, from_status, to_status, actor_id, side)
                   values (${o.id}, null, 'new', ${actor.id}, 'customer')`;
          await audit(tx, actor, 'order.create', 'order', o.id, { module: o.module, service: o.service });
          return o;
        });
        res.status(201);
        return { order: await orderView(sql, registry, order) };
      },
    },
    {
      id: 'orders.list', method: 'GET', path: '/api/orders', auth: 'user', access: 'self',
      async handler({ sql, actor, registry }) {
        const f = visibleOrdersFilter(actor);
        // Личные — свои; от организации — свои, пока состоишь в ней; руководитель и старший — все дела организации.
        const rows = await sql`
          select r.*, o.name as org_name, u.full_name as responsible_name
          from orders r left join organizations o on o.id = r.org_id join users u on u.id = r.owner_user_id
          where ${!!f.all}
             or (r.owner_user_id = ${f.userId ?? null} and (r.org_id is null or r.org_id = any(${f.memberOrgIds ?? []}::uuid[])))
             or r.org_id = any(${f.allOrgIds ?? []}::uuid[])
             or r.executor_user_id = ${f.executorId ?? null}
          order by r.created_at desc limit 200`;
        const today = todayMsk();
        return { orders: rows.map((r) => ({ ...describe(registry, r, today), as_executor: r.executor_user_id === actor.id })) };
      },
    },
    {
      id: 'orders.get', method: 'GET', path: '/api/orders/:id', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry }) {
        const history = await sql`
          select from_status, to_status, side, reason, at from order_status_history where order_id = ${order.id} order by id`;
        const level = orderLevel(actor, order);
        // Кто исполнитель — служебным и самому исполнителю; заказчику имя исполнителя пока не показывается.
        const exec = order.executor_user_id && (isStaff(actor) || order.executor_user_id === actor.id)
          ? await sql.one`select full_name from users where id = ${order.executor_user_id}` : null;
        return {
          order: await orderView(sql, registry, order),
          executor: exec ? { user_id: order.executor_user_id, name: exec.full_name, is_me: order.executor_user_id === actor.id } : null,
          access: LEVEL_NAME[level],
          editable: order.status === 'new' && level >= LEVEL.write,
          // Закрыть неоплаченную заявку нельзя — такой кнопки и не показываем (1.6).
          actions: availableActions(order.status, orderSides(actor, order)).filter((a) => a.to !== 'closed' || !!order.paid_at),
          history: history.map((h) => ({ ...h, from_name: STATUS_NAME[h.from_status] ?? null, to_name: STATUS_NAME[h.to_status] })),
        };
      },
    },
    {
      // Заполнение заявки — пока она «новая». Отправленную меняет уже не заказчик.
      id: 'orders.update', method: 'PATCH', path: '/api/orders/:id', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'write' },
      async handler({ sql, actor, order, body, registry }) {
        if (order.status !== 'new') throw new HttpError(409, 'not_editable', 'Заявка уже отправлена — изменить её нельзя');
        const b = body ?? {};
        const moduleId = b.module ?? order.module;
        const serviceId = b.service ?? order.service;
        const def = registry.service(String(moduleId ?? ''), String(serviceId ?? ''));
        if (!def) throw new HttpError(400, 'bad_service', 'Выберите услугу');
        const serviceChanged = moduleId !== order.module || serviceId !== order.service;
        let fields;
        if (b.fields !== undefined) fields = cleanValues(def.fields, b.fields);
        else if (serviceChanged) fields = Object.fromEntries(Object.entries(order.fields).filter(([k]) => def.fields.some((f) => f.id === k)));
        else fields = order.fields;

        const title = b.title === undefined ? order.title : text(b.title, 'Название', 300);
        const deadline = b.deadline === undefined ? order.deadline : deadlineFrom(b.deadline);
        // При смене услуги на модуль без прежнего вида основания — первый вид нового модуля.
        const basisKind = b.basis_kind !== undefined ? oneOf(b.basis_kind, def.module.basis, 'Основание')
          : def.module.basis.includes(order.basis_kind) ? order.basis_kind : def.module.basis[0];
        const details = BASIS_KINDS[basisKind].details;
        const basisNumber = !details ? null : b.basis_number === undefined ? order.basis_number : optionalText(b.basis_number, 'Номер определения', 100);
        const basisDate = !details ? null : b.basis_date === undefined ? order.basis_date : basisDateFrom(b.basis_date);

        const updated = await sql.tx(async (tx) => {
          const o = await tx.one`
            update orders set title = ${title}, module = ${def.module.id}, service = ${def.service.id}, fields = ${JSON.stringify(fields)},
                   deadline = ${deadline}, basis_kind = ${basisKind}, basis_number = ${basisNumber}, basis_date = ${basisDate},
                   updated_at = now()
            where id = ${order.id} and status = 'new' returning *`;
          if (!o) throw new HttpError(409, 'not_editable', 'Заявка уже отправлена — изменить её нельзя');
          await audit(tx, actor, 'order.update', 'order', order.id);
          return o;
        });
        return { order: await orderView(sql, registry, updated) };
      },
    },
    {
      // Смена статуса: какой шаг и чьей стороне разрешён — src/orders/workflow.mjs; кто какая сторона — policy.mjs.
      id: 'orders.status', method: 'POST', path: '/api/orders/:id/status', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, body, registry, cfg, providers }) {
        const to = String(body?.to ?? '');
        // from — статус, который человек видел на экране: если его уже сменили, шаг не делается (иначе, например,
        // «отменить» могло бы сработать уже для другого этапа).
        const from = String(body?.from ?? '');
        if (!STATUS_NAME[to] || !STATUS_NAME[from]) throw new HttpError(400, 'bad_status', 'Неизвестный статус');
        const reason = optionalText(body?.reason, 'Причина', 1000);
        const test = cfg.providers.payments === 'fake';
        let settlement = {};
        const updated = await sql.tx(async (tx) => {
          // Строка заявки блокируется: два одновременных шага не пройдут оба.
          const cur = await tx.one`select * from orders where id = ${order.id} for update`;
          if (cur.status !== from) throw new HttpError(409, 'status_changed', 'Статус заявки уже изменился, обновите страницу');
          const t = findTransition(cur.status, to, orderSides(actor, cur));
          if (!t) {
            // Шаг есть, но делает его другая сторона (например, диспетчер) — нет прав; шага нет вовсе — так нельзя.
            if (TRANSITIONS.some((x) => x.from === cur.status && x.to === to)) throw new HttpError(403, 'forbidden', 'Недостаточно прав');
            throw new HttpError(409, 'bad_transition', `Из статуса «${STATUS_NAME[cur.status]}» так нельзя`);
          }
          if (t.reason && !reason) throw new HttpError(400, 'reason_required', 'Укажите причину');
          if (cur.status === 'new' && to === 'matching') {
            const missing = await problemsForSubmit(tx, registry, cur);
            if (missing.length) throw new HttpError(400, 'incomplete', `Не хватает: ${missing.join(', ')}`);
          }
          // Сдать на проверку можно только с результатом; «готово» — только если все правила проверки в порядке (1.5).
          if (cur.status === 'in_work' && to === 'review') {
            // Файл результата — именно этого исполнителя (после передачи дела файлы прежнего не в счёт).
            const res = await tx.one`select 1 from documents where order_id = ${cur.id} and kind = 'result' and deleted_at is null
                                     and uploaded_by = ${cur.executor_user_id} limit 1`;
            if (!res) throw new HttpError(400, 'no_result', 'Сначала добавьте файл результата');
          }
          if (cur.status === 'review' && to === 'done') {
            const { checks } = await reviewState(tx, registry, cur);
            const issues = checks.filter((c) => c.verdict === 'issue');
            if (issues.length) throw new HttpError(409, 'review_issues', `Есть замечания — верните результат на доработку: ${issues.map((c) => c.title).join('; ')}`);
            const left = checks.filter((c) => !c.verdict);
            if (left.length) throw new HttpError(409, 'review_incomplete', `Не все правила проверены: ${left.map((c) => c.title).join('; ')}`);
          }
          // Закрыть можно только оплаченную заявку (оплата — при заказе, до предложения исполнителю; 1.6а).
          if (to === 'closed' && !cur.paid_at) throw new HttpError(409, 'not_paid', 'Заявка ещё не оплачена');
          // Отмена после начала работ: диспетчер указывает, по чьей причине; при отказе заказчика — сделанную долю работы.
          let fault = null;
          let percent = null;
          if (to === 'cancelled' && WORK_STARTED.includes(cur.status)) {
            fault = String(body?.fault ?? '');
            if (!['executor', 'customer'].includes(fault)) throw new HttpError(400, 'fault_required', 'Укажите, по чьей причине отмена: исполнителя или заказчика');
            if (fault === 'customer') {
              percent = Number(body?.done_percent);
              if (body?.done_percent === '' || body?.done_percent == null || !Number.isInteger(percent) || percent < 0 || percent > 100) {
                throw new HttpError(400, 'bad_percent', 'Укажите, какая часть работы сделана: целое число процентов от 0 до 100');
              }
            }
          }
          // Деньги: «готово» — выплата исполнителю и закрывающие документы; отмена оплаченной — возврат (и оплата сделанной части).
          if (cur.status === 'review' && to === 'done') settlement = { payoutId: await settleDone(tx, cur, { test }) };
          if (to === 'cancelled') settlement = await settleCancel(tx, cur, { fault, percent, reason, test });
          // Исполнитель, получающий оплату за сделанную часть, сохраняет доступ к отменённому делу (видит отчёт агента).
          const keepExecutor = to === 'cancelled' && !!settlement.payoutId;
          // Предложение исполнителю закрывается: принято, отказ исполнителя, либо снято (диспетчером или отменой).
          if (cur.executor_user_id && (to === 'in_work' || to === 'matching' || to === 'cancelled') && cur.status === 'awaiting_executor') {
            const outcome = to === 'in_work' ? 'accepted' : t.by === 'executor' ? 'declined' : 'withdrawn';
            await tx`update order_offers set outcome = ${outcome}, outcome_at = now(), reason = ${reason}
                     where order_id = ${cur.id} and outcome is null`;
          }
          const o = await tx.one`
            update orders set status = ${to}, updated_at = now(),
                   executor_user_id = case when ${to} = 'matching' or (${to} = 'cancelled' and not ${keepExecutor}) then null
                                           else executor_user_id end,
                   cancel_fault = case when ${to} = 'cancelled' then ${fault} else cancel_fault end,
                   done_percent = case when ${to} = 'cancelled' then ${percent}::int else done_percent end,
                   submitted_at = case when ${to} = 'matching' then coalesce(submitted_at, now()) else submitted_at end,
                   review_round = case when ${to} = 'review' then review_round + 1 else review_round end
            where id = ${cur.id} returning *`;
          await tx`insert into order_status_history (order_id, from_status, to_status, actor_id, side, reason)
                   values (${cur.id}, ${cur.status}, ${to}, ${actor.id}, ${t.by}, ${reason})`;
          await audit(tx, actor, 'order.status', 'order', cur.id, { from: cur.status, to, side: t.by });
          await notifyStatus(tx, { actor, before: cur, to, by: t.by });
          return o;
        });
        // Выплата и возврат — через поставщика, уже после транзакции; неудачу повторяет диспетчер.
        await runSettlement(sql, providers, settlement);
        return { order: await orderView(sql, registry, updated) };
      },
    },
    {
      // Руководитель или старший передаёт дело организации другому её участнику.
      id: 'orders.transfer', method: 'PATCH', path: '/api/orders/:id/responsible', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'manage' },
      async handler({ sql, actor, order, body, registry }) {
        const userId = uuidFrom(body?.user_id, 'Сотрудник не найден');
        const updated = await sql.tx(async (tx) => {
          const target = await tx.one`select 1 from org_members where org_id = ${order.org_id} and user_id = ${userId}`;
          if (!target) throw new HttpError(404, 'not_found', 'Сотрудник не найден в этой организации');
          const o = await tx.one`update orders set owner_user_id = ${userId}, updated_at = now() where id = ${order.id} returning *`;
          await audit(tx, actor, 'order.transfer', 'order', order.id, { from: order.owner_user_id, to: userId });
          return o;
        });
        return { order: await orderView(sql, registry, updated) };
      },
    },
  ];
}
