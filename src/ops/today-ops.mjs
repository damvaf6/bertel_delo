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
// Ответ диспетчера на просьбу о переносе срока — пока эксперт не открыл «Срок» в деле (2.155). Владелец нажал «Готово»
// осмотра, а обязательные шаги без фото (2.208). Выписка ЕГРН в деле старше 30 дней на дату оценки (2.224) — запросить свежую.
// Запрошенные документы не пришли 3 дня (2.234) — «Напомнить заказчику», пока сегодня ещё не напоминали.
// После ИИ-проверки пришёл запрошенный документ (2.248) — «Проверьте заново».
// Руководителю — те же сведения, что в «Делах экспертов» (2.16): без заказчика, полей заявки, документов и переписки.
// Только свои дела и свои организации.
import { orderRef } from '../notify/registry.mjs';
import { orderSplit } from '../money/money.mjs';
import { STATUS_NAME, addDays, isOverdue, resultDue, todayMsk } from '../orders/workflow.mjs';
import { orderSignatures, orgReturns, returnEgrn, signWait } from './sign-ops.mjs';
import { executorSignOrg } from '../access/policy.mjs';
import { dossierAlerts, loadDossier } from '../dossier/dossier.mjs';
import { expiringLinks, incompleteInspections, reshotAll, silentLinks } from './inspect-ops.mjs';
import { answeredExtends, openExtends, orgExtends } from './deadline-ops.mjs';
import { openHandovers } from './handover-ops.mjs';
import { dueNotes } from './note-ops.mjs';
import { caseMoves, caseRemind, transferTargets } from './org-ops.mjs';
import { docWait, egrnOld } from './docreq-ops.mjs';
import { aiRecheck } from '../ai/ai.mjs';

// «Горит» — просрочено или до срока не больше двух дней (как подсветка в списке дел).
const HOT_DAYS = 2;
const LIMIT = 50;
// Заказчик ждёт ответа в переписке дольше суток (2.132).
const REPLY_HOURS = 24;
// Файл ждёт подписи организации столько дней и дольше (2.152) — эксперту строкой «Руководитель ещё не подписал».
const SIGN_LONG_DAYS = 2;
// Возврат руководителя не исправлен 2 дня и дольше (2.153) — в утренней сводке руководителю.
const RETURN_LONG_DAYS = 2;
// Исправленный файл после возврата руководителя загружен больше суток назад, а эксперт его не подписал (2.204).
const FRESH_LATE_HOURS = 24;

async function expertPart(sql, actor, registry, today, storage) {
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
        points: r.items.length, left: r.left, fresh_file: r.fresh_file }));
    }
  }
  // Ближе срок — выше (2.147); без срока — в конце, при равном сроке раньше вернули — выше.
  returned.sort((a, b) => (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999') || new Date(a.at) - new Date(b.at));
  // Исправленный файл лежит неподписанным больше суток (2.204) — отдельной строкой «подпишите», в «Вернули» не повторяется.
  const freshLate = returned.filter((r) => r.fresh_file && Date.now() - new Date(r.fresh_file.at).getTime() >= FRESH_LATE_HOURS * 3600_000)
    .sort((a, b) => new Date(a.fresh_file.at) - new Date(b.fresh_file.at));
  // Осмотр по ссылке молчит 2 дня (2.85): владелец не прислал ни одного фото — отправить ссылку снова.
  const silent = [];
  for (const l of await silentLinks(sql, { executor: actor.id })) {
    const o = rows.find((x) => x.id === l.order_id);
    if (o) silent.push(item(o, { link_at: l.created_at, expired: new Date(l.expires_at) <= new Date(), sms_to: l.sms_to ?? null }));
  }
  // Ссылка на осмотр перестанет действовать в ближайшие сутки, а владелец не нажал «Готово» (2.196) — продлить.
  const expiring = [];
  for (const l of await expiringLinks(sql, { executor: actor.id })) {
    const o = rows.find((x) => x.id === l.order_id);
    if (o) expiring.push(item(o, { link_id: String(l.id), expires_at: l.expires_at, photos: l.photos, sms_to: l.sms_to ?? null }));
  }
  // Владелец нажал «Готово», а обязательные шаги осмотра без фото (2.208) — попросить доснять по новой ссылке.
  const incomplete = [];
  for (const l of await incompleteInspections(sql, registry, { executor: actor.id })) {
    const o = rows.find((x) => x.id === l.order_id);
    if (o) incomplete.push(item(o, { finished_at: l.finished_at, photos: l.photos, missing: l.missing.map((s) => s.title), asked: l.asked }));
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
    // Осмотр закончен не полностью (2.208) — своя строка «снял не всё», здесь не повторяется.
    if (n.finished && !incomplete.some((x) => x.id === o.id)) {
      // Доснял по просьбе всё недостающее (2.214) — видно, какие шаги.
      const last = await sql.one`select * from inspection_links where order_id = ${o.id} and finished_at is not null order by id desc limit 1`;
      const reshot = await reshotAll(sql, registry, last);
      what.push(reshot.length ? `владелец доснял всё, о чём Вы просили: ${reshot.join(', ')}${n.photos ? ` (фото: ${n.photos})` : ''}`
        : `осмотр закончен${n.photos ? ` (фото: ${n.photos})` : ''}`);
    }
    else if (n.photos && !n.finished) what.push(`новые фото осмотра: ${n.photos}`);
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
      // Ждёт 2 дня и дольше (2.152) — отдельной строкой «Руководитель ещё не подписал» с «Напомнить руководителю».
      if (w) signWaits.push(item(o, { org: signOrg.name, ...w, long: Date.now() - new Date(w.since).getTime() >= SIGN_LONG_DAYS * 86400_000 }));
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
  // Диспетчер ответил на просьбу о переносе срока (2.155), а эксперт ещё не открывал «Срок» в деле: согласился или отказал.
  const answers = await answeredExtends(sql, rows.filter((o) => ['in_work', 'review'].includes(o.status)).map((o) => o.id));
  const extendAnswer = rows.filter((o) => answers.has(o.id)).map((o) => {
    const { order_id: _, ...a } = answers.get(o.id);
    return item(o, a);
  }).sort((a, b) => new Date(b.decided_at) - new Date(a.decided_at));
  const awayDeclined = await awayDeclinedCases(sql, actor, rows, ext, today, item);
  // Выписка ЕГРН в деле старше 30 дней на дату оценки, свежую ещё не просили (2.224) — запросить одной кнопкой.
  const egrnStale = [];
  for (const o of rows.filter((x) => x.status === 'in_work')) {
    const old = await egrnOld(sql, storage, registry, o, today);
    if (old && !old.asked) egrnStale.push(item(o, { egrn: old }));
  }
  // Запрошенное не пришло 3 дня и дольше (2.234): строка с «Напомнить заказчику»; напомнили — до завтра строки нет.
  const docsWait = [];
  for (const o of rows.filter((x) => x.status === 'in_work')) {
    const w = await docWait(sql, o);
    if (w?.can_remind) docsWait.push(item(o, { wait: w }));
  }
  docsWait.sort((a, b) => new Date(a.wait.since) - new Date(b.wait.since));
  // После ИИ-проверки пришли запрошенные документы (2.248) — «Проверьте заново»; новая ИИ-проверка — строка уходит.
  const recheck = [];
  for (const o of rows.filter((x) => x.status === 'in_work')) {
    const r = await aiRecheck(sql, o);
    if (r) recheck.push(item(o, { recheck: r }));
  }
  recheck.sort((a, b) => new Date(b.recheck.docs.at(-1).at) - new Date(a.recheck.docs.at(-1).at));
  return {
    ai_recheck: recheck,
    egrn_old: egrnStale,
    docs_wait: docsWait,
    // Отказ в переносе, а срок в дни «не принимаю дела» (2.215) — своей строкой с «Попросить руководителя передать дело».
    away_declined: awayDeclined,
    extend_answer: extendAnswer.filter((x) => !awayDeclined.some((a) => a.id === x.id)),
    ready: readyLeft,
    no_result: noResult,
    reply_wait: replyWait,
    notes,
    sign_wait: signWaits,
    inspect_silent: silent,
    inspect_expiring: expiring,
    inspect_incomplete: incomplete,
    // Уже попросил перенести срок (2.100) — в строке видно, на какую дату и что ответа ещё нет.
    hot: hotRows.map((o) => item(o, { extend: ext.get(o.id) ?? null })),
    fresh_late: freshLate,
    returned: returned.filter((r) => !freshLate.includes(r)),
    review: rows.filter((o) => o.status === 'review').map((o) => item(o)),
    offers: rows.filter((o) => o.status === 'awaiting_executor')
      .map((o) => item(o, { fee_kop: o.price_kop ? orderSplit(o).payoutKop : null })),
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
export async function expertMorningAlerts(sql, userId, today, now = new Date()) {
  const rows = await sql`
    select id, status, deadline, executor_user_id from orders where executor_user_id = ${userId} and status in ('in_work', 'review')
    order by deadline nulls last, updated_at limit ${LIMIT}`;
  const soon = addDays(today, HOT_DAYS);
  const hotRows = rows.filter((o) => o.status === 'in_work' && o.deadline && o.deadline <= soon);
  // Руководитель не подписал 2 дня и дольше (2.164) — как строка «Руководитель ещё не подписал» в «Сегодня» (2.152).
  let leadUnsigned = 0;
  if (await executorSignOrg(sql, userId)) {
    for (const o of rows.filter((x) => x.status === 'in_work')) {
      const w = await signWait(sql, o);
      if (w && now.getTime() - new Date(w.since).getTime() >= SIGN_LONG_DAYS * 86400_000) leadUnsigned += 1;
    }
  }
  return {
    no_result: (await noResultOrders(sql, userId, hotRows, today)).length,
    reply_wait: (await replyWaits(sql, rows.map((o) => o.id))).length,
    lead_unsigned: leadUnsigned,
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
// Диспетчер отказал в переносе срока, а срок в дни, когда эксперт не принимает дела (2.215): эксперту от организации —
// попросить руководителя передать дело коллеге. Строка держится, пока эксперт не попросил передать (или руководитель уже
// отказал после этого отказа диспетчера), не попросил перенос заново или не сдвинул «не принимаю дела до …».
async function awayDeclinedCases(sql, actor, rows, ext, today, item) {
  const sp = await sql.one`select to_char(away_from, 'YYYY-MM-DD') as away_from, to_char(away_until, 'YYYY-MM-DD') as away_until, away_note
                           from specialists where user_id = ${actor.id}`;
  const list = rows.filter((o) => o.status === 'in_work' && !ext.get(o.id) && awayDeadline({ ...o, away_from: sp?.away_from, away_until: sp?.away_until }, today));
  if (!list.length || !(await executorSignOrg(sql, actor.id))) return [];
  const ids = list.map((o) => o.id);
  const last = new Map((await sql`
    select distinct on (order_id) order_id, outcome, to_char(new_deadline, 'YYYY-MM-DD') as new_deadline, answer, decided_at
    from deadline_requests where order_id = any(${ids}::uuid[]) and outcome is not null
    order by order_id, decided_at desc, id desc`).map((r) => [r.order_id, r]));
  const handed = await sql`select order_id, outcome, coalesce(decided_at, requested_at) as at from handover_requests
                           where requested_by = ${actor.id} and order_id = any(${ids}::uuid[])`;
  return list.flatMap((o) => {
    const d = last.get(o.id);
    if (d?.outcome !== 'declined') return [];
    if (handed.some((h) => h.order_id === o.id && (h.outcome === null || new Date(h.at) > new Date(d.decided_at)))) return [];
    return [item(o, { away_until: sp.away_until, asked: d.new_deadline, answer: d.answer ?? null, decided_at: d.decided_at })];
  });
}

// Срок дела — в днях «не принимаю дела» эксперта: до дня возвращения и не раньше первого такого дня (away_from, 2.226).
export function awayDeadline(o, today) {
  return !!o.away_until && o.away_until > today && !!o.deadline && o.deadline < o.away_until && (!o.away_from || o.deadline >= o.away_from);
}

// Тот же расчёт — для утренней сводки руководителю (2.121, src/notify/morning.mjs).
export async function orgPart(sql, org, registry, today, { actorId = null } = {}) {
  const soon = addDays(today, HOT_DAYS);
  const service = (o) => registry.service(o.module, o.service)?.service.name ?? o.service;
  // Дела экспертов организации (выбрали её в профиле специалиста и состоят в ней) — как в «Делах экспертов».
  const cases = await sql`
    select o.id, o.module, o.service, o.status, o.deadline, o.executor_user_id, o.updated_at, u.full_name as expert,
           to_char(s.away_from, 'YYYY-MM-DD') as away_from, to_char(s.away_until, 'YYYY-MM-DD') as away_until, s.away_note
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
  // Прогон 2.220: под причиной — почему просит (срок в дни «не принимаю дела», диспетчер отказал в переносе) и есть ли кому
  // передать — чтобы руководитель решал, не открывая дело.
  const asking = cases.filter((o) => handovers.has(o.id));
  const askFull = asking.length ? await sql`select * from orders where id = any(${asking.map((o) => o.id)}::uuid[])` : [];
  const askMates = new Map(await Promise.all(askFull.map(async (o) => [o.id, (await transferTargets(sql, o, org.id, registry)).length > 0])));
  const declined = new Set(asking.length ? (await sql`
    select distinct on (order_id) order_id, outcome from deadline_requests
    where order_id = any(${asking.map((o) => o.id)}::uuid[]) and outcome is not null
    order by order_id, decided_at desc, id desc`).filter((r) => r.outcome === 'declined').map((r) => r.order_id) : []);
  const handover = asking.map((o) => view(o, {
    reason: handovers.get(o.id).reason, requested_at: handovers.get(o.id).requested_at,
    away_until: o.status === 'in_work' && awayDeadline(o, today) ? o.away_until : null,
    extend_declined: !ext.get(o.id) && declined.has(o.id), can_transfer: askMates.get(o.id) ?? false,
    extend_asked: !!ext.get(o.id),
  }));
  // Эксперт не принимает дела до … (2.113): его дела в работе со сроком раньше дня возвращения — в отпуске он их не сдаст.
  // Уже попросил передать сам — такие дела только в «просит передать».
  // Передать некому (прогон 2.210) — «передайте коллеге» не советуем, как в «Делах экспертов» (прогон 2.200).
  const awayCases = cases.filter((o) => o.status === 'in_work' && !handovers.has(o.id) && awayDeadline(o, today));
  const full = awayCases.length ? await sql`select * from orders where id = any(${awayCases.map((o) => o.id)}::uuid[])` : [];
  const mates = new Map(await Promise.all(full.map(async (o) => [o.id, (await transferTargets(sql, o, org.id, registry)).length > 0])));
  const away = awayCases.map((o) => view(o, { away_until: o.away_until, away_note: o.away_note ?? null, extend: ext.get(o.id) ?? null,
    can_transfer: mates.get(o.id) ?? false }));
  // Диспетчер отказал в переносе срока, о котором просила организация (2.238), за последние сутки — в утренней сводке.
  const orgExt = await orgExtends(sql, org.id, cases.filter((o) => o.status === 'in_work'));
  const extDeclined = [...orgExt.values()].filter((x) => x.state === 'declined' && Date.now() - new Date(x.decided_at).getTime() < 86400_000).length;
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
    const docs = await sql`select id, created_at from documents where order_id = ${o.id} and kind = 'result' and deleted_at is null
                           and uploaded_by = (select executor_user_id from orders where id = ${o.id})`;
    const waiting = docs.filter((d) => signs.get(d.id)?.expert && !signs.get(d.id)?.org).length;
    const returns = await orgReturns(sql, o.id, { orgId: org.id });
    if (waiting) {
      // Эксперт напоминал о подписи (2.99) — когда последний раз, пока файл ждёт (2.100).
      const w = await signWait(sql, o);
      // Когда эксперт подписал и сколько ждёт (2.160 — как в «Делах экспертов», 2.148).
      // Два дня и дольше — заметно (2.161 — как в «Делах экспертов», 2.148).
      // После возврата расхождение с выпиской ЕГРН осталось в новой ИИ-проверке эксперта (2.257, как в «Подписи организации»,
      // 2.247) — сколько таких пунктов последнего возврата; для строки здесь и утренней сводки.
      const last = returns.at(-1);
      const kept = last ? [...(await returnEgrn(sql, o.id, last, docs)).values()].filter((s) => s === 'kept').length : 0;
      toSign.push(view(o, { files: waiting, reminded_at: w?.reminded_at ?? null, since: w?.since ?? null,
        long: !!w?.since && Date.now() - new Date(w.since).getTime() >= SIGN_LONG_DAYS * 86400_000, egrn_kept: kept }));
    }
    const open = returns.filter((r) => r.open);
    // Сколько пунктов замечания эксперт уже отметил исправленными (2.160 — как в «Делах экспертов», 2.151).
    // «Напомнить эксперту» прямо в «Сегодня» (2.162) — как в «Делах экспертов» (2.125): раз в сутки; своё дело — без кнопки.
    if (open.length) returned.push(view(o, { comment: open.at(-1).comment, at: open[0].at, points: open.at(-1).items.length, left: open.at(-1).left,
      fresh_file: open.at(-1).fresh_file,
      remind: o.executor_user_id === actorId ? null : await caseRemind(sql, o) }));
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
  // «Ждут подписи организации» (2.161): дольше всех ждущие — первыми, без времени подписи — в конце.
  toSign.sort((a, b) => (a.since ? Date.parse(a.since) : Infinity) - (b.since ? Date.parse(b.since) : Infinity));
  // Сколько дел без движения 3 дня и больше (2.133) — только число, для утренней сводки руководителю (2.141).
  const moves = await caseMoves(sql, cases.filter((o) => ['in_work', 'review'].includes(o.status)));
  return {
    dossier,
    idle: [...moves.values()].filter((m) => m.idle).length,
    // Сколько возвращённых эксперту дел не исправлено 2 дня и больше (2.153) — только число, для утренней сводки.
    // Дела, где исправленный файл уже загружен (2.172), — не «не исправлено», а отдельным числом: файл ждёт подписи эксперта
    // 2 дня и больше (как красная строка в отборе «Исправленный файл ждёт подписи эксперта», 2.171).
    returned_long: returned.filter((r) => !r.fresh_file && Date.now() - new Date(r.at).getTime() >= RETURN_LONG_DAYS * 86400_000).length,
    fresh_long: returned.filter((r) => r.fresh_file && Date.now() - new Date(r.fresh_file.at).getTime() >= SIGN_LONG_DAYS * 86400_000).length,
    // Отказы диспетчера в переносе срока по просьбе организации за сутки (2.238) — только число, для утренней сводки.
    ext_declined: extDeclined,
    // Сколько экспертов сегодня вернулись после дней «не принимаю дела» (2.249) и у них есть дела — для утренней сводки.
    back_today: new Set(cases.filter((o) => o.away_until === today).map((o) => o.executor_user_id)).size,
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
    select o.*, r.id as request_id, to_char(r.new_deadline, 'YYYY-MM-DD') as new_deadline, r.reason, r.requested_at, g.name as org_name
    from deadline_requests r join orders o on o.id = r.order_id left join organizations g on g.id = r.org_id
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
    extend: extend.map((o) => item(o, { new_deadline: o.new_deadline, reason: o.reason, requested_at: o.requested_at, org_name: o.org_name ?? null })),
    hot: hot.map((o) => item(o)),
    money: money.map((o) => item(o, { what: o.what, failure: o.failure ?? null })),
  };
}

export function todayOps() {
  return [
    {
      id: 'today.get', method: 'GET', path: '/api/today', auth: 'user', access: 'self',
      async handler({ sql, actor, registry, providers }) {
        const today = todayMsk();
        const headOf = actor.orgs.filter((m) => m.role === 'head').map((m) => m.org_id);
        const orgs = headOf.length ? await sql`select id, name from organizations where id = any(${headOf}::uuid[]) order by name` : [];
        return {
          today,
          expert: await expertPart(sql, actor, registry, today, providers.storage),
          dispatcher: await dispatcherPart(sql, actor, registry, today),
          orgs: await Promise.all(orgs.map((o) => orgPart(sql, o, registry, today, { actorId: actor.id }))),
        };
      },
    },
  ];
}
