// Единая «Заявка» (задача 1.3): услуга из описания модуля, поля, срок, основание, статусы и история.
// Решения Дамира 30.09.2026: срок обязателен; основание — договор по умолчанию, определение суда — с номером, датой
// и файлом; отмена заказчиком — только до начала работ; перечень услуг и поля меняются через разработку.
import { HttpError } from '../http/core.mjs';
import { LEVEL, executorSignOrg, isStaff, memberOf, orderLevel, orderSides, visibleOrdersFilter } from '../access/policy.mjs';
import { BASIS_KINDS, cleanValues, missingRequired } from '../modules/index.mjs';
import { STATUSES, STATUS_NAME, TRANSITIONS, WORK_STARTED, addDays, availableActions, findTransition, isOverdue, todayMsk } from '../orders/workflow.mjs';
import { runSettlement, settleCancel, settleDone, splitAmount } from '../money/money.mjs';
import { audit, oneOf, quoted, text, uuidFrom } from './util.mjs';
import { reviewState } from './work-ops.mjs';
import { notify, notifyStatus, orgHeads } from '../notify/notify.mjs';

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

// Заявки, которые видит вошедший (последние 200): та же логика, что orderLevel в policy.mjs.
export async function listVisibleOrders(sql, actor) {
  const f = visibleOrdersFilter(actor);
  // Личные — свои; от организации — свои, пока состоишь в ней; руководитель и старший — все дела организации.
  return sql`
    select r.*, o.name as org_name, u.full_name as responsible_name
    from orders r left join organizations o on o.id = r.org_id join users u on u.id = r.owner_user_id
    where ${!!f.all}
       or (r.owner_user_id = ${f.userId ?? null} and (r.org_id is null or r.org_id = any(${f.memberOrgIds ?? []}::uuid[])))
       or r.org_id = any(${f.allOrgIds ?? []}::uuid[])
       or r.executor_user_id = ${f.executorId ?? null}
    order by r.created_at desc limit 200`;
}

// Новая заявка (статус «новая») от имени вошедшего: лично или от организации (участие проверяет вызывающий).
export async function insertOrder(tx, actor, def, { title, orgId, fields = {}, via = null }) {
  const o = await tx.one`
    insert into orders (owner_user_id, org_id, title, module, service, basis_kind, fields)
    values (${actor.id}, ${orgId}, ${title}, ${def.module.id}, ${def.service.id}, ${def.module.basis[0]}, ${JSON.stringify(fields)}) returning *`;
  await tx`insert into order_status_history (order_id, from_status, to_status, actor_id, side)
           values (${o.id}, null, 'new', ${actor.id}, 'customer')`;
  await audit(tx, actor, 'order.create', 'order', o.id, { module: o.module, service: o.service, ...(via ? { via } : {}) });
  return o;
}

// Готова ли заявка к отправке: услуга, обязательные поля, срок, основание. Список того, чего не хватает.
export async function problemsForSubmit(tx, registry, order) {
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

// Отправка заявки-черновика заказчиком («новая» → «подбор»): кабинетом (orders.status) или ответом «Отправить» на письмо (1.9).
// cur — строка заявки, заблокированная вызывающим (select … for update).
export async function submitDraft(tx, registry, actor, cur) {
  const t = findTransition(cur.status, 'matching', orderSides(actor, cur));
  if (cur.status !== 'new' || !t || t.by !== 'customer') throw new HttpError(409, 'bad_transition', 'Заявка уже отправлена');
  const missing = await problemsForSubmit(tx, registry, cur);
  if (missing.length) throw new HttpError(400, 'incomplete', `Не хватает: ${missing.join(', ')}`);
  const o = await tx.one`update orders set status = 'matching', updated_at = now(), submitted_at = coalesce(submitted_at, now())
                         where id = ${cur.id} returning *`;
  await tx`insert into order_status_history (order_id, from_status, to_status, actor_id, side)
           values (${cur.id}, 'new', 'matching', ${actor.id}, 'customer')`;
  await audit(tx, actor, 'order.status', 'order', cur.id, { from: 'new', to: 'matching', side: 'customer' });
  await notifyStatus(tx, { actor, before: cur, to: 'matching', by: 'customer' });
  return o;
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

  // Главное о деле одной строкой: значения коротких полей заявки по порядку (без длинных текстов), не больше шести.
  const clipText = (t, n) => { const x = t.replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
  function fieldsBrief(registry, order) {
    const def = order.module ? registry.service(order.module, order.service) : null;
    if (!def) return null;
    // Длинный текст — только главный (перечень имущества, что с товаром, 2.43) и коротко; «Что ещё важно знать» — нет.
    const parts = def.fields.filter((f) => f.id !== 'comment' && order.fields?.[f.id] !== undefined && order.fields[f.id] !== '' && (f.type !== 'longtext' || f.required))
      .map((f) => (f.type === 'select' ? f.options.find((o) => o.id === order.fields[f.id])?.name ?? order.fields[f.id]
        : f.type === 'longtext' ? clipText(String(order.fields[f.id]), 80)
          // Число — с единицей из подписи поля (2.66): «54,3 кв. м», «12 000 км», а не голое «54,3».
          : f.type === 'number' ? [Number(order.fields[f.id]).toLocaleString('ru-RU', { useGrouping: Math.abs(Number(order.fields[f.id])) >= 10000 }), f.label.match(/,\s*([^,]{1,6})$/)?.[1]].filter(Boolean).join(' ')
            : String(order.fields[f.id])))
      .slice(0, 6);
    return parts.length ? parts.join(' · ').slice(0, 300) : null;
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
      express: order.express,
      express_available: !!def && !!registry.express(order.module, order.service),
      org_id: order.org_id,
      owner_user_id: order.owner_user_id,
      created_at: order.created_at,
      submitted_at: order.submitted_at,
      updated_at: order.updated_at,
      ...(order.org_name !== undefined ? { org_name: order.org_name, responsible_name: order.responsible_name ?? '' } : {}),
    };
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
        const order = await sql.tx((tx) => insertOrder(tx, actor, def, { title, orgId }));
        res.status(201);
        return { order: await orderView(sql, registry, order) };
      },
    },
    {
      id: 'orders.list', method: 'GET', path: '/api/orders', auth: 'user', access: 'self',
      async handler({ sql, actor, registry }) {
        const rows = await listVisibleOrders(sql, actor);
        const today = todayMsk();
        // Исполнителю в списке — его вознаграждение (80% цены), чтобы не открывать каждое дело (разбор 03.10.2026, 2.12).
        return {
          orders: rows.map((r) => {
            const mine = r.executor_user_id === actor.id;
            return {
              ...describe(registry, r, today), as_executor: mine,
              ...(mine && r.price_kop ? { fee_kop: splitAmount(Number(r.price_kop)).payoutKop } : {}),
              // Исполнителю — главное о деле одной строкой (2.33): решить по предложению, не открывая каждое.
              ...(mine ? { brief: fieldsBrief(registry, r) } : {}),
            };
          }),
        };
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
        // Заявка по письму (1.9): ответы уходят в переписку на адрес заказчика; адрес — только стороне заказчика.
        const thread = await sql.one`select email from mail_threads where order_id = ${order.id}`;
        return {
          order: await orderView(sql, registry, order),
          mail: thread ? { email: level >= LEVEL.write ? thread.email : null } : null,
          executor: exec ? { user_id: order.executor_user_id, name: exec.full_name, is_me: order.executor_user_id === actor.id } : null,
          // Дело у организации (2.17): эксперта назначает её руководитель; видят только служебные.
          offer_org: order.offer_org_id && order.status === 'awaiting_executor' && isStaff(actor)
            ? await sql.one`select id, name from organizations where id = ${order.offer_org_id}` : null,
          // Внутренняя переписка с руководителем организации (2.28): только самому исполнителю, если он работает от организации.
          org_chat: order.executor_user_id === actor.id ? (await executorSignOrg(sql, actor.id))?.name ?? null : null,
          access: LEVEL_NAME[level],
          editable: order.status === 'new' && level >= LEVEL.write,
          // «Что дальше» заказчику (2.41) и диспетчеру (2.42): чья сторона и чего не хватает для отправки черновика.
          customer: orderSides(actor, order).includes('customer'),
          dispatcher: orderSides(actor, order).includes('dispatcher'),
          submit_missing: order.status === 'new' && level >= LEVEL.write ? await problemsForSubmit(sql, registry, order) : [],
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
        // Экспресс (2.4): выезд помощника, эксперт работает дистанционно. При смене услуги без экспресса — снимается.
        if (b.express !== undefined && typeof b.express !== 'boolean') throw new HttpError(400, 'bad_input', 'Поле «Экспресс»: да или нет');
        const canExpress = !!registry.express(def.module.id, def.service.id);
        if (b.express === true && !canExpress) throw new HttpError(400, 'no_express', 'Для этой услуги экспресса нет');
        const express = canExpress && (b.express ?? order.express);

        const updated = await sql.tx(async (tx) => {
          const o = await tx.one`
            update orders set title = ${title}, module = ${def.module.id}, service = ${def.service.id}, fields = ${JSON.stringify(fields)},
                   deadline = ${deadline}, basis_kind = ${basisKind}, basis_number = ${basisNumber}, basis_date = ${basisDate},
                   express = ${express}, updated_at = now()
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
        const test = cfg.testMoney;
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
          // Дело организации (2.17): отказ эксперта возвращает его руководителю — статус не меняется, эксперта назначат другого.
          if (t.by === 'executor' && to === 'matching' && cur.offer_org_id) {
            await tx`update order_offers set outcome = 'declined', outcome_at = now(), reason = ${reason}
                     where order_id = ${cur.id} and outcome is null`;
            await tx`insert into order_offers (order_id, org_id, score, offered_by)
                     values (${cur.id}, ${cur.offer_org_id}, ${JSON.stringify({ org: true, returned: true })}, null)`;
            const back = await tx.one`update orders set executor_user_id = null, updated_at = now() where id = ${cur.id} returning *`;
            await audit(tx, actor, 'order.org_returned', 'order', cur.id, { org: cur.offer_org_id });
            await notify(tx, 'org_expert_declined', { users: await orgHeads(tx, cur.offer_org_id), orgId: cur.offer_org_id, actor });
            return back;
          }
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
            // Заключение подписывается УКЭП до сдачи, если так требует модуль (2.5, 2.5а, src/ops/sign-ops.mjs): эксперт и,
            // если он работает от организации, — её руководитель.
            if (registry.signatureRequired(cur.module, cur.service)) {
              const unsigned = await tx`select d.filename from documents d
                                        left join document_signatures s on s.document_id = d.id and s.role = 'expert'
                                        where d.order_id = ${cur.id} and d.kind = 'result' and d.deleted_at is null
                                          and d.uploaded_by = ${cur.executor_user_id} and s.id is null order by d.created_at`;
              if (unsigned.length) throw new HttpError(400, 'not_signed', `Подпишите УКЭП файлы результата: ${unsigned.map((d) => d.filename).join(', ')}`);
              const signOrg = await executorSignOrg(tx, cur.executor_user_id);
              if (signOrg) {
                const noOrg = await tx`select d.filename from documents d
                                       left join document_signatures s on s.document_id = d.id and s.role = 'org' and s.org_id = ${signOrg.id}
                                       where d.order_id = ${cur.id} and d.kind = 'result' and d.deleted_at is null
                                         and d.uploaded_by = ${cur.executor_user_id} and s.id is null order by d.created_at`;
                if (noOrg.length) throw new HttpError(400, 'not_signed_org', `Нужна подпись организации ${quoted(signOrg.name)} (руководитель): ${noOrg.map((d) => d.filename).join(', ')}`);
              }
            }
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
          if ((cur.executor_user_id || cur.offer_org_id) && (to === 'in_work' || to === 'matching' || to === 'cancelled') && cur.status === 'awaiting_executor') {
            const outcome = to === 'in_work' ? 'accepted' : t.by === 'executor' ? 'declined' : 'withdrawn';
            await tx`update order_offers set outcome = ${outcome}, outcome_at = now(), reason = ${reason}
                     where order_id = ${cur.id} and outcome is null`;
          }
          const o = await tx.one`
            update orders set status = ${to}, updated_at = now(),
                   executor_user_id = case when ${to} = 'matching' or (${to} = 'cancelled' and not ${keepExecutor}) then null
                                           else executor_user_id end,
                   offer_org_id = case when ${to} = 'matching' then null else offer_org_id end,
                   cancel_fault = case when ${to} = 'cancelled' then ${fault} else cancel_fault end,
                   done_percent = case when ${to} = 'cancelled' then ${percent}::int else done_percent end,
                   submitted_at = case when ${to} = 'matching' then coalesce(submitted_at, now()) else submitted_at end,
                   review_round = case when ${to} = 'review' then review_round + 1 else review_round end
            where id = ${cur.id} returning *`;
          await tx`insert into order_status_history (order_id, from_status, to_status, actor_id, side, reason)
                   values (${cur.id}, ${cur.status}, ${to}, ${actor.id}, ${t.by}, ${reason})`;
          await audit(tx, actor, 'order.status', 'order', cur.id, { from: cur.status, to, side: t.by });
          await notifyStatus(tx, { actor, before: cur, to, by: t.by });
          // Дело было у организации и снято (возврат в подбор, отмена) — её руководителю тоже сообщаем (2.17).
          if (cur.offer_org_id && cur.status === 'awaiting_executor' && to !== 'in_work') {
            await notify(tx, 'org_offer_withdrawn', { users: await orgHeads(tx, cur.offer_org_id), orgId: cur.offer_org_id, actor });
          }
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
