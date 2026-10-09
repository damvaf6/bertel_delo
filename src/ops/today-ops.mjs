// «Сегодня» (2.34, 2.42): одним экраном — что требует внимания эксперта, руководителя экспертной организации и диспетчера. Эксперту: что
// горит по срокам, что вернули на доработку (диспетчер или руководитель), что ждёт проверки диспетчера, новые предложения,
// осмотр по ссылке 2 дня без фото (2.85), «можно продолжать» — после того как эксперт последний раз открывал дело, заказчик
// прислал запрошенные документы, пришли фото осмотра или владелец нажал «Готово», помощник завершил выезд, написали заказчик
// или диспетчер (2.86).
// Руководителю — по каждой своей организации: дела экспертов, у которых горит срок, ждут подписи организации, возвращены
// эксперту и ждут исправления, дела, которые диспетчер предложил организации, сроки документов досье экспертов (2.63),
// «горящие» (2.98): срок через 1–2 дня или прошёл, а у эксперта нет ни черновика, ни файла результата или нет фото осмотра.
// Эксперту — очередь подписи (2.99): он подписал, организация ещё нет; руководителю в «Ждут подписи» — когда эксперт напоминал.
// Руководителю — просьбы экспертов передать дело коллеге (2.107); эксперт отметил «не принимаю дела до …», а у него дела
// со сроком в эти дни (2.113) — передать коллеге. Эксперту — напоминания по своим заметкам к делу (2.115); в «Можно
// продолжать» — какие запрошенные документы пришли и сколько ещё ждём (2.128). Заказчик ждёт ответа в переписке больше суток
// (2.132): его сообщение без ответа эксперта — даже если эксперт его уже прочитал. Срок через 1–2 дня или прошёл, а своего
// файла результата нет (2.138). «Вернули на доработку» — когда вернули, пункты замечания, ближе срок — выше (2.147).
// Руководителю — те же сведения, что в «Делах экспертов» (2.16): без заказчика, полей заявки, документов и переписки.
// Только свои дела и свои организации.
import { orderRef } from '../notify/registry.mjs';
import { splitAmount } from '../money/money.mjs';
import { STATUS_NAME, addDays, isOverdue, resultDue, todayMsk } from '../orders/workflow.mjs';
import { orderSignatures, orgReturns, signWait } from './sign-ops.mjs';
import { executorSignOrg } from '../access/policy.mjs';
import { dossierAlerts, loadDossier } from '../dossier/dossier.mjs';
import { silentLinks } from './inspect-ops.mjs';
import { openExtends } from './deadline-ops.mjs';
import { openHandovers } from './handover-ops.mjs';
import { dueNotes } from './note-ops.mjs';
import { caseMoves } from './org-ops.mjs';

// «Горит» — просрочено или до срока не больше двух дней (как подсветка в списке дел).
const HOT_DAYS = 2;
const LIMIT = 50;
// Заказчик ждёт ответа в переписке дольше суток (2.132).
const REPLY_HOURS = 24;

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
    const last = await sql.one`select from_status, reason, at from order_status_history where order_id = ${o.id} and to_status = 'in_work'
                               order by id desc limit 1`;
    // Когда вернули (2.147) и куда вести: после диспетчера — к файлу результата, после руководителя — к замечаниям по пунктам.
    if (last?.from_status === 'review') returned.push(item(o, { by: 'Диспетчер', comment: last.reason ?? '', at: last.at, to: 'result' }));
    // Руководитель вернул файл (2.27), а эксперт ещё не исправил.
    for (const r of (await orgReturns(sql, o.id)).filter((x) => x.open)) {
      returned.push(item(o, { by: `Руководитель${r.by ? ` (${r.by})` : ''}`, comment: r.comment, at: r.at, to: 'fix',
        points: r.items.length, left: r.left }));
    }
  }
  // Ближе срок — выше (2.147); без срока — в конце, при равном сроке раньше вернули — выше.
  returned.sort((a, b) => (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999') || new Date(a.at) - new Date(b.at));
  // Осмотр по ссылке молчит 2 дня (2.85): владелец не прислал ни одного фото — отправить ссылку снова.
  const silent = [];
  for (const l of await silentLinks(sql, { executor: actor.id })) {
    const o = rows.find((x) => x.id === l.order_id);
    if (o) silent.push(item(o, { link_at: l.created_at, expired: new Date(l.expires_at) <= new Date(), sms_to: l.sms_to ?? null }));
  }
  // Можно продолжать (2.86): что пришло по делу в работе после того, как эксперт его последний раз открыл (order_seen).
  const ready = [];
  for (const o of rows.filter((x) => x.status === 'in_work')) {
    const n = await sql.one`
      with s as (select coalesce((select seen_at from order_seen where order_id = ${o.id} and user_id = ${actor.id}), '-infinity') as seen)
      select (select count(*)::int from doc_requests, s where order_id = ${o.id} and cancelled_at is null and fulfilled_at > s.seen) as docs,
             (select count(*)::int from inspection_photos p join inspection_links l on l.id = p.link_id, s
               where l.order_id = ${o.id} and p.received_at > s.seen) as photos,
             (select count(*)::int from inspection_links, s where order_id = ${o.id} and finished_at > s.seen) as finished,
             (select count(*)::int from onsite_visits, s where order_id = ${o.id} and finished_at > s.seen and cancelled_at is null) as onsite,
             (select count(*)::int from order_messages, s where order_id = ${o.id} and side <> 'executor' and at > s.seen) as messages,
             greatest((select max(fulfilled_at) from doc_requests, s where order_id = ${o.id} and cancelled_at is null and fulfilled_at > s.seen),
                      (select max(p.received_at) from inspection_photos p join inspection_links l on l.id = p.link_id, s
                        where l.order_id = ${o.id} and p.received_at > s.seen),
                      (select max(finished_at) from inspection_links, s where order_id = ${o.id} and finished_at > s.seen),
                      (select max(finished_at) from onsite_visits, s where order_id = ${o.id} and finished_at > s.seen and cancelled_at is null),
                      (select max(at) from order_messages, s where order_id = ${o.id} and side <> 'executor' and at > s.seen)) as last_at`;
    const what = [];
    if (n.docs) what.push(await docsLine(sql, o.id, actor.id));
    if (n.finished) what.push(`осмотр закончен${n.photos ? ` (фото: ${n.photos})` : ''}`);
    else if (n.photos) what.push(`новые фото осмотра: ${n.photos}`);
    if (n.onsite) what.push('выезд помощника завершён');
    // Куда вести, если сообщений нет: к запрошенным документам или к осмотру.
    const other = what.length ? { what: [...what], to: n.docs ? 'docs' : 'inspect' } : null;
    if (n.messages) what.push(`сообщений: ${n.messages}`);
    if (what.length) ready.push(item(o, { what, at: n.last_at, to: n.messages ? 'chat' : other.to, other }));
  }
  ready.sort((a, b) => new Date(b.at) - new Date(a.at));
  const ext = await openExtends(sql, rows.map((o) => o.id));
  // Очередь подписи (2.99): эксперт подписал, организация ещё нет — сколько ждёт, можно ли напомнить руководителю.
  const signWaits = [];
  const signOrg = await executorSignOrg(sql, actor.id);
  if (signOrg) {
    for (const o of rows.filter((x) => x.status === 'in_work')) {
      const w = await signWait(sql, o);
      if (w) signWaits.push(item(o, { org: signOrg.name, ...w }));
    }
    signWaits.sort((a, b) => new Date(a.since) - new Date(b.since));
  }
  // Заказчик ждёт ответа больше суток (2.132) — replyWaits ниже.
  const waits = await replyWaits(sql, rows.filter((o) => ['in_work', 'review'].includes(o.status)).map((o) => o.id));
  const replyWait = waits.map((w) => item(rows.find((o) => o.id === w.order_id), {
    since: w.since, count: w.count, last: w.last_body.length > 80 ? `${w.last_body.slice(0, 80)}…` : w.last_body,
  }));
  // Дело уже в «Заказчик ждёт ответа» (2.140) — в «Можно продолжать» сообщения не повторяются: остаются документы и осмотр,
  // а если пришли только сообщения — строки там нет.
  const readyLeft = ready.flatMap(({ other, ...x }) => (!waits.some((w) => w.order_id === x.id) ? [x] : other ? [{ ...x, ...other }] : []));
  // Напоминания по своим заметкам к делу (2.115): день настал, заметка не отмечена «сделано».
  const notes = (await dueNotes(sql, actor.id, rows.map((o) => o.id), today))
    .map((n) => item(rows.find((o) => o.id === n.order_id), { note: n.body, remind_on: n.remind_on }));
  // Срок через 1–2 дня или прошёл, а своего файла результата нет (2.138) — на странице — выше «Горит срок» и там не повторяется.
  const hotRows = rows.filter((o) => o.status === 'in_work' && o.deadline && o.deadline <= soon);
  const due = await noResultOrders(sql, actor.id, hotRows, today);
  const drafts = due.length ? await sql`
    select distinct order_id from result_drafts where order_id = any(${due.map((o) => o.id)}::uuid[])` : [];
  const noResult = due.map((o) => item(o, { has_draft: drafts.some((x) => x.order_id === o.id), extend: ext.get(o.id) ?? null }));
  return {
    ready: readyLeft,
    no_result: noResult,
    reply_wait: replyWait,
    notes,
    sign_wait: signWaits,
    inspect_silent: silent,
    // Уже попросил перенести срок (2.100) — в строке видно, на какую дату и что ответа ещё нет.
    hot: hotRows.map((o) => item(o, { extend: ext.get(o.id) ?? null })),
    returned,
    review: rows.filter((o) => o.status === 'review').map((o) => item(o)),
    offers: rows.filter((o) => o.status === 'awaiting_executor')
      .map((o) => item(o, { fee_kop: o.price_kop ? splitAmount(Number(o.price_kop)).payoutKop : null })),
  };
}

// Заказчик ждёт ответа больше суток (2.132): после последнего сообщения эксперта заказчик написал, и первому такому
// сообщению больше суток. Сообщения диспетчера не в счёт — отвечает эксперт заказчику. orderIds — дела в работе и на проверке.
async function replyWaits(sql, orderIds) {
  return orderIds.length ? sql`
    select m.order_id, min(m.at) as since, count(*)::int as count,
           (array_agg(m.body order by m.id desc))[1] as last_body
    from order_messages m
    where m.order_id = any(${orderIds}::uuid[]) and m.side = 'customer'
      and m.id > coalesce((select max(e.id) from order_messages e where e.order_id = m.order_id and e.side = 'executor'), 0)
    group by m.order_id having min(m.at) < now() - make_interval(hours => ${REPLY_HOURS})
    order by min(m.at)` : [];
}

// Срок через 1–2 дня или прошёл, а своего файла результата нет (2.138). hotRows — дела в работе со сроком до «горит».
async function noResultOrders(sql, userId, hotRows, today) {
  const own = hotRows.length ? await sql`
    select order_id, count(*)::int as n from documents where order_id = any(${hotRows.map((o) => o.id)}::uuid[]) and kind = 'result'
      and deleted_at is null and uploaded_by = ${userId} group by order_id` : [];
  return hotRows.filter((o) => resultDue(o, own.find((x) => x.order_id === o.id)?.n ?? 0, today));
}

// Для утренней сводки эксперта (2.142): сколько дел «срок близко — нет файла результата» и «заказчик ждёт ответа» — тем же
// расчётом, что «Сегодня». Только цифры.
export async function expertMorningAlerts(sql, userId, today) {
  const rows = await sql`
    select id, status, deadline from orders where executor_user_id = ${userId} and status in ('in_work', 'review')
    order by deadline nulls last, updated_at limit ${LIMIT}`;
  const soon = addDays(today, HOT_DAYS);
  const hotRows = rows.filter((o) => o.status === 'in_work' && o.deadline && o.deadline <= soon);
  return {
    no_result: (await noResultOrders(sql, userId, hotRows, today)).length,
    reply_wait: (await replyWaits(sql, rows.map((o) => o.id))).length,
  };
}

// Срок дела приходится на дни, когда эксперт не принимает дела (2.113): отметка ещё действует, срок раньше дня возвращения.

// Что именно прислал заказчик по запросу (2.128): названия документов (до трёх) и сколько запрошенных ещё не получено —
// эксперт сразу видит, можно ли продолжать или ждать дальше.
async function docsLine(sql, orderId, userId) {
  const rows = await sql`
    with s as (select coalesce((select seen_at from order_seen where order_id = ${orderId} and user_id = ${userId}), '-infinity') as seen)
    select r.title, r.fulfilled_at > s.seen as fresh, r.fulfilled_at is null as waiting from doc_requests r, s
    where r.order_id = ${orderId} and r.cancelled_at is null order by r.fulfilled_at nulls last, r.id`;
  const got = rows.filter((r) => r.fresh).map((r) => r.title);
  const waiting = rows.filter((r) => r.waiting).length;
  const names = got.length > 3 ? `${got.slice(0, 3).join(', ')} и ещё ${got.length - 3}` : got.join(', ');
  return `документы получены: ${names} — ${waiting ? `ждём ещё ${waiting}` : 'все запрошенные'}`;
}
export function awayDeadline(o, today) {
  return !!o.away_until && o.away_until > today && !!o.deadline && o.deadline < o.away_until;
}

// Тот же расчёт — для утренней сводки руководителю (2.121, src/notify/morning.mjs).
export async function orgPart(sql, org, registry, today) {
  const soon = addDays(today, HOT_DAYS);
  const service = (o) => registry.service(o.module, o.service)?.service.name ?? o.service;
  // Дела экспертов организации (выбрали её в профиле специалиста и состоят в ней) — как в «Делах экспертов».
  const cases = await sql`
    select o.id, o.module, o.service, o.status, o.deadline, o.executor_user_id, o.updated_at, u.full_name as expert,
           to_char(s.away_until, 'YYYY-MM-DD') as away_until, s.away_note
    from orders o join specialists s on s.user_id = o.executor_user_id and s.org_id = ${org.id}
    join org_members m on m.org_id = s.org_id and m.user_id = s.user_id join users u on u.id = o.executor_user_id
    where o.status in ('awaiting_executor', 'in_work', 'review') order by o.deadline nulls last, o.id limit ${LIMIT}`;
  // Эксперт уже попросил перенести срок (2.100) — у «горящих» видно новую дату, пока диспетчер не ответил.
  const ext = await openExtends(sql, cases.map((o) => o.id));
  const view = (o, extra = {}) => ({
    order_ref: orderRef(o.id), service: service(o), deadline: o.deadline, overdue: isOverdue(o, today),
    status_name: STATUS_NAME[o.status], ...(o.expert !== undefined ? { expert: o.expert || 'Без имени' } : {}), ...extra,
  });
  // Эксперт просит передать дело коллеге (2.107): с причиной — первой строкой, ответить одной кнопкой в «Делах экспертов».
  const handovers = await openHandovers(sql, cases);
  const handover = cases.filter((o) => handovers.has(o.id))
    .map((o) => view(o, { reason: handovers.get(o.id).reason, requested_at: handovers.get(o.id).requested_at }));
  // Эксперт не принимает дела до … (2.113): его дела в работе со сроком раньше дня возвращения — в отпуске он их не сдаст.
  // Уже попросил передать сам — такие дела только в «просит передать».
  const away = cases.filter((o) => o.status === 'in_work' && !handovers.has(o.id) && awayDeadline(o, today))
    .map((o) => view(o, { away_until: o.away_until, away_note: o.away_note ?? null, extend: ext.get(o.id) ?? null }));
  const toSign = [];
  const returned = [];
  const atRisk = [];
  for (const o of cases.filter((x) => x.status === 'in_work')) {
    // «Горящее» (2.98): срок близко, а работа не начата — нет черновика и результата, нет фото осмотра (если у услуги есть осмотр).
    if (o.deadline && o.deadline <= soon) {
      const n = await sql.one`
        select (select count(*)::int from result_drafts where order_id = ${o.id}) as drafts,
               (select count(*)::int from documents where order_id = ${o.id} and kind = 'result' and deleted_at is null) as results,
               (select count(*)::int from documents where order_id = ${o.id} and kind = 'inspection' and deleted_at is null) as photos`;
      const missing = [];
      if (!n.drafts && !n.results) missing.push('нет черновика');
      if (!n.photos && registry.inspectionSteps(o.module, o.service).length) missing.push('нет фото осмотра');
      if (missing.length) atRisk.push(view(o, { missing, extend: ext.get(o.id) ?? null }));
    }
    const signs = await orderSignatures(sql, o.id);
    const docs = await sql`select id from documents where order_id = ${o.id} and kind = 'result' and deleted_at is null
                           and uploaded_by = (select executor_user_id from orders where id = ${o.id})`;
    const waiting = docs.filter((d) => signs.get(d.id)?.expert && !signs.get(d.id)?.org).length;
    if (waiting) {
      // Эксперт напоминал о подписи (2.99) — когда последний раз, пока файл ждёт (2.100).
      const w = await signWait(sql, o);
      toSign.push(view(o, { files: waiting, reminded_at: w?.reminded_at ?? null }));
    }
    const open = (await orgReturns(sql, o.id, { orgId: org.id })).filter((r) => r.open);
    if (open.length) returned.push(view(o, { comment: open.at(-1).comment }));
  }
  const offered = await sql`
    select id, module, service, status, deadline from orders where offer_org_id = ${org.id} and status = 'awaiting_executor'
      and executor_user_id is null order by deadline nulls last, updated_at limit ${LIMIT}`;
  // Документы досье экспертов организации (2.63): истёк или кончается в 30 дней — только вид и срок, без номеров и копий.
  const experts = await sql`
    select s.user_id, u.full_name from specialists s join org_members m on m.org_id = s.org_id and m.user_id = s.user_id
    join users u on u.id = s.user_id and u.is_active where s.org_id = ${org.id} order by u.full_name nulls last, s.user_id`;
  const dossier = [];
  for (const x of experts) {
    for (const a of dossierAlerts(await loadDossier(sql, x.user_id))) {
      dossier.push({ expert: x.full_name || 'Без имени', kind_name: a.kind_name, valid_until: a.valid_until, state: a.state });
    }
  }
  dossier.sort((a, b) => a.valid_until.localeCompare(b.valid_until));
  // Сколько дел без движения 3 дня и больше (2.133) — только число, для утренней сводки руководителю (2.141).
  const moves = await caseMoves(sql, cases.filter((o) => ['in_work', 'review'].includes(o.status)));
  return {
    dossier,
    idle: [...moves.values()].filter((m) => m.idle).length,
    id: org.id,
    name: org.name,
    hot: cases.filter((o) => ['in_work', 'review'].includes(o.status) && o.deadline && o.deadline <= soon)
      .map((o) => view(o, { extend: ext.get(o.id) ?? null })),
    at_risk: atRisk,
    handover,
    away,
    to_sign: toSign,
    returned,
    pending: offered.map((o) => view(o)),
  };
}

// Диспетчеру (2.42) — по всем заявкам платформы: что ждёт его хода. Назначить цену; подобрать исполнителя (оплачено, а
// предложения нет — в том числе после отказа); предложение без ответа дольше суток; результат ждёт проверки; горит срок
// у исполнителя; деньги — выплата или возврат не прошли, оплата висит дольше суток.
const SLOW_OFFER_HOURS = 24;

async function dispatcherPart(sql, actor, registry, today) {
  if (actor.platform_role !== 'dispatcher') return null;
  const soon = addDays(today, HOT_DAYS);
  const service = (o) => registry.service(o.module, o.service)?.service.name ?? o.service ?? 'Услуга не выбрана';
  const item = (o, extra = {}) => ({
    id: o.id, title: o.title, service: service(o), deadline: o.deadline, overdue: isOverdue(o, today), status_name: STATUS_NAME[o.status], ...extra,
  });
  const matching = await sql`select * from orders where status = 'matching' order by deadline nulls last, updated_at limit ${LIMIT}`;
  // Почему заявка снова в подборе: отказ исполнителя или передача другому — причина из истории.
  const back = async (o) => {
    const h = await sql.one`select from_status, reason from order_status_history where order_id = ${o.id} and to_status = 'matching'
                            order by id desc limit 1`;
    return h && h.from_status !== 'new' ? { reason: h.reason ?? '' } : {};
  };
  const toMatch = [];
  for (const o of matching.filter((x) => x.paid_at)) toMatch.push(item(o, await back(o)));
  const slow = await sql`
    select o.*, f.offered_at from orders o join order_offers f on f.order_id = o.id and f.outcome is null
    where o.status = 'awaiting_executor' and f.offered_at < now() - make_interval(hours => ${SLOW_OFFER_HOURS})
    order by f.offered_at limit ${LIMIT}`;
  const review = await sql`select * from orders where status = 'review' order by deadline nulls last, updated_at limit ${LIMIT}`;
  const hot = await sql`select * from orders where status in ('awaiting_executor', 'in_work') and deadline <= ${soon}
                        order by deadline, updated_at limit ${LIMIT}`;
  // Перенос срока (2.91): исполнитель просит новую дату — ответить.
  const extend = await sql`
    select o.*, r.id as request_id, to_char(r.new_deadline, 'YYYY-MM-DD') as new_deadline, r.reason, r.requested_at
    from deadline_requests r join orders o on o.id = r.order_id
    where r.outcome is null and o.status in ('in_work', 'review') order by r.requested_at limit ${LIMIT}`;
  const money = await sql`
    select o.*, 'payout' as what, p.failure from payouts p join orders o on o.id = p.order_id where p.status = 'failed'
    union all
    select o.*, 'refund' as what, r.failure from refunds r join orders o on o.id = r.order_id where r.status = 'failed'
    union all
    select o.*, 'payment' as what, null as failure from payments p join orders o on o.id = p.order_id
      where p.status = 'pending' and p.created_at < now() - interval '1 day' and o.paid_at is null
    order by updated_at limit ${LIMIT}`;
  return {
    price: matching.filter((x) => !x.price_kop && !x.paid_at).map((o) => item(o)),
    to_match: toMatch,
    slow_offers: slow.map((o) => item(o, { offered_at: o.offered_at })),
    review: review.map((o) => item(o)),
    extend: extend.map((o) => item(o, { new_deadline: o.new_deadline, reason: o.reason, requested_at: o.requested_at })),
    hot: hot.map((o) => item(o)),
    money: money.map((o) => item(o, { what: o.what, failure: o.failure ?? null })),
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
          dispatcher: await dispatcherPart(sql, actor, registry, today),
          orgs: await Promise.all(orgs.map((o) => orgPart(sql, o, registry, today))),
        };
      },
    },
  ];
}
