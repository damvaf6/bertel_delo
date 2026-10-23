// Утренняя сводка эксперту «На сегодня» (2.119): раз в день, после 8:00 по Москве (раз в минуту вместе с напоминаниями о
// сроках, src/server.mjs), — одно уведомление специалисту: сколько дел сдать сегодня, сколько с прошедшим сроком, сколько
// выездов на объект сегодня (помощника по своим делам и своих выездов помощником) и сколько ссылок на осмотр истекают в
// ближайшие сутки. Считается так же, как «Мои сроки на две недели» (src/orders/schedule.mjs) — туда и ведёт уведомление.
// Нечего сообщить — сводки нет. В тексте и СМС только цифры: ни названий дел, ни имён, ни адресов.
// С 2.142 — ещё сколько дел «срок близко — нет файла результата» и «заказчик ждёт ответа» (как в «Сегодня»); если, кроме
// них, в сводке ничего нет, она ведёт к «Сегодня», а не к «Моим срокам». С 2.164 — ещё сколько дел руководитель организации
// не подписал 2 дня и больше (строка «Руководитель ещё не подписал» в «Сегодня»); она тоже ведёт к «Сегодня». С 2.266 — ещё в
// скольких делах в ИИ-проверке остались расхождения с выпиской ЕГРН, которые можно заменить в черновике (строка в «Сегодня»
// ведёт к ИИ-проверке дела); тоже к «Сегодня». С 2.284 — так же расхождения с заданием на оценку (письмом, определением суда).
// С 2.315 — ещё в скольких делах срок по заданию на оценку сегодня, завтра или прошёл, а файла результата нет (строка «Срок по
// заданию на оценку близко» в «Сегодня», 2.304); тоже к «Сегодня». С 2.331 — ещё в скольких делах перенос срока согласован
// позже срока по заданию на оценку, а письмо о переносе не просили (строка «Приложите письмо о переносе» в «Сегодня», 2.326);
// срок по заданию у такого дела не повторяется; тоже к «Сегодня». С 2.355 — ещё в скольких делах письмо о переносе попросили
// у заказчика, а оно не пришло 3 дня и сегодня не напоминали (кнопка «Напомнить заказчику» у строки письма в «Сегодня», 2.347).
import { expertSchedule } from '../orders/schedule.mjs';
import { STATUS_NAME, todayMsk } from '../orders/workflow.mjs';
import { expertMorningAlerts, orgPart } from '../ops/today-ops.mjs';
import { notify } from './notify.mjs';

export const MORNING_HOUR = 8;

export const mskHour = (now) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', hourCycle: 'h23' }).format(now));
const mskTime = (now) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }).format(now);
const pl = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
// Названия услуг сводке не нужны — только счёт.
const NO_NAMES = { service: () => null };

// Цифры сводки из «Моих сроков»: сдать сегодня и просрочено — только дела в работе (сданное на проверку и ещё не
// принятое предложение — не «сдать»); ссылка на осмотр — истекает сегодня или завтра раньше, чем сейчас по часам.
export function digestCounts(schedule, now = new Date()) {
  const [d0, d1] = schedule.days;
  const inWork = (i) => i.kind === 'deadline' && i.status === 'in_work';
  const time = mskTime(now);
  return {
    due: d0.items.filter(inWork).length,
    overdue: schedule.overdue.filter(inWork).length,
    visits: d0.items.filter((i) => i.kind === 'visit' || i.kind === 'my_visit').length,
    links: d0.items.filter((i) => i.kind === 'link').length + (d1?.items.filter((i) => i.kind === 'link' && i.time < time).length ?? 0),
  };
}

// Текст сводки: «На сегодня: сдать 2 дела, 1 выезд на объект, …». Пустая сводка — null.
export function digestText(c) {
  const parts = [];
  if (c.due) parts.push(`сдать ${c.due} ${pl(c.due, 'дело', 'дела', 'дел')}`);
  if (c.overdue) parts.push(`${c.overdue} ${pl(c.overdue, 'дело', 'дела', 'дел')} с прошедшим сроком`);
  if (c.visits) parts.push(`${c.visits} ${pl(c.visits, 'выезд', 'выезда', 'выездов')} на объект`);
  if (c.links) parts.push(`${c.links} ${pl(c.links, 'ссылка', 'ссылки', 'ссылок')} на осмотр ${c.links === 1 ? 'истекает' : 'истекают'} в ближайшие сутки`);
  if (c.task_due) parts.push(`срок по заданию на оценку сегодня, завтра или прошёл, а файла результата нет: ${c.task_due} ${pl(c.task_due, 'дело', 'дела', 'дел')}`);
  if (c.letter_due) parts.push(`срок по письму о переносе сегодня, завтра или прошёл, а файла результата нет: ${c.letter_due} ${pl(c.letter_due, 'дело', 'дела', 'дел')}`);
  if (c.task_moved) parts.push(`перенос срока согласован позже срока по заданию на оценку — приложите письмо о переносе: ${c.task_moved} ${pl(c.task_moved, 'дело', 'дела', 'дел')}`);
  if (c.letter_wait) parts.push(`письмо о переносе попросили, а оно не пришло 3 рабочих дня и дольше — напомните заказчику: ${c.letter_wait} ${pl(c.letter_wait, 'дело', 'дела', 'дел')}`);
  if (c.no_result) parts.push(`нет файла результата: ${c.no_result}`);
  if (c.reply_wait) parts.push(`заказчик ждёт ответа: ${c.reply_wait}`);
  if (c.lead_unsigned) parts.push(`руководитель не подписал 2 дня и больше: ${c.lead_unsigned}`);
  if (c.egrn_swap) parts.push(`в ИИ-проверке остались расхождения с выпиской ЕГРН, которые можно заменить: ${c.egrn_swap} ${pl(c.egrn_swap, 'дело', 'дела', 'дел')}`);
  if (c.task_swap) parts.push(`в ИИ-проверке остались расхождения с заданием на оценку, которые можно заменить: ${c.task_swap} ${pl(c.task_swap, 'дело', 'дела', 'дел')}`);
  if (c.egrn_rebuild) parts.push(`исправили в черновике по выписке или заданию на оценку, а файл собран до исправления — соберите Word заново: ${c.egrn_rebuild} ${pl(c.egrn_rebuild, 'дело', 'дела', 'дел')}`);
  return parts.length ? `На сегодня: ${parts.join(', ')}` : null;
}

// Разослать сводки за сегодня тем, кому ещё не считали. Возвращает, сколько уведомлений записано.
export async function sendMorning(sql, { now = new Date(), registry = null, storage = null } = {}) {
  if (mskHour(now) < MORNING_HOUR) return 0;
  const today = todayMsk(now);
  const people = await sql`select s.user_id from specialists s join users u on u.id = s.user_id
                           where u.is_active and not exists (select 1 from morning_digests d where d.user_id = s.user_id and d.day = ${today}::date)`;
  let sent = 0;
  for (const { user_id: userId } of people) {
    const c = { ...digestCounts(await expertSchedule(sql, userId, NO_NAMES, today), now), ...await expertMorningAlerts(sql, userId, today, now, { registry, storage }) };
    sent += await sql.tx(async (tx) => {
      const fresh = await tx`insert into morning_digests (user_id, day, due, overdue, visits, links, no_result, reply_wait, lead_unsigned, egrn_swap, task_swap, egrn_rebuild, task_due, task_moved, letter_due, letter_wait)
                             values (${userId}, ${today}, ${c.due}, ${c.overdue}, ${c.visits}, ${c.links}, ${c.no_result}, ${c.reply_wait}, ${c.lead_unsigned}, ${c.egrn_swap}, ${c.task_swap}, ${c.egrn_rebuild}, ${c.task_due ?? 0}, ${c.task_moved ?? 0}, ${c.letter_due ?? 0}, ${c.letter_wait ?? 0})
                             on conflict do nothing returning user_id`;
      const text = digestText(c);
      if (!fresh.length || !text) return 0;
      const where = morningTo(c) === 'today' ? '«Сегодня»' : '«Мои сроки»';
      const n = await notify(tx, 'morning_today', { users: [userId], sms: `БЕРТЕЛ Дело: ${text}. Подробно — ${where} в кабинете.` });
      if (n) {
        await tx`update morning_digests set notification_id = (select max(id) from notifications where user_id = ${userId} and event = 'morning_today')
                 where user_id = ${userId} and day = ${today}::date`;
      }
      return n;
    });
  }
  return sent;
}

// Куда ведёт сводка (2.142): есть сроки, выезды или ссылки — к «Моим срокам»; только «нет файла результата» и «заказчик ждёт
// ответа» (и «руководитель не подписал», 2.164, «можно заменить по выписке», 2.266, «по заданию», 2.284, «соберите Word заново», 2.272, «срок по заданию на оценку», 2.315, «приложите письмо о переносе», 2.331, «срок по письму о переносе», прогон 2.350, «напомните заказчику», 2.355) — к «Сегодня», где эти дела строками.
export function morningTo(c) {
  return c.due || c.overdue || c.visits || c.links ? 'schedule' : 'today';
}

// Текст сводки в ленте по номеру уведомления (цифры — из morning_digests) и куда она ведёт.
export async function morningTitles(sql, ids) {
  if (!ids.length) return new Map();
  const rows = await sql`select notification_id, due, overdue, visits, links, no_result, reply_wait, lead_unsigned, egrn_swap, task_swap, egrn_rebuild, task_due, task_moved, letter_due, letter_wait from morning_digests
                         where notification_id = any(${ids}::bigint[])`;
  return new Map(rows.map((r) => [String(r.notification_id), { title: digestText(r), to: morningTo(r) }]));
}

// Утренняя сводка руководителю «На сегодня по организации» (2.121): по каждой организации, где он руководитель, — одно
// уведомление: сколько дел ждут подписи организации, сколько экспертов просят передать дело, сколько дел экспертов сдать
// сегодня и с прошедшим сроком, сколько дел без движения 3 дня и больше (2.141), сколько возвращённых эксперту дел не
// исправлено 2 дня и больше (2.153), в скольких исправленный файл не подписан экспертом 2 дня и больше (2.172), у скольких дел срок в дни, когда эксперт не
// принимает дела (2.209; о которых эксперт уже просит передать — не считаются, как в «Сегодня»; уже попросил перенос срока — тоже,
// руководителю тут делать нечего — прогон 2.210), из просьб передать дело — сколько тех, где передать некому, а перенос срока ещё
// не просят (2.228: руководителю — попросить диспетчера перенести срок от организации, 2.221), в скольких делах диспетчер за
// сутки отказал в переносе срока, о котором просила организация (2.238), сколько экспертов сегодня вернулись после дней «не
// принимаю дела» и у них есть дела (2.249), в скольких делах на подписи организации после возврата эксперту расхождение с
// выпиской ЕГРН осталось в его новой ИИ-проверке (2.257, как в «Подписи организации», 2.247). Считается так же, как «Сегодня»
// (src/ops/today-ops.mjs); в скольких делах на подписи организации в ИИ-проверке эксперта остались расхождения с заявкой или
// заданием на оценку (2.286, как отбор в «Подписи организации», 2.276); в скольких делах на подписи организации срок по заданию
// на оценку сегодня или прошёл (2.316, как красная строка в «Сегодня» и «Подписи организации», 2.308); в скольких делах
// перенос срока согласован позже срока по заданию на оценку, а письма о переносе нет 2 дня и дольше (2.338, как пометка в
// «Делах экспертов», 2.332); сколько из ждущих подписи организации ждут её 2 дня и дольше после подписи эксперта (2.374, как
// строка «Ждут подписи организации 2 дня и дольше» в «Сегодня»). Ведёт в организацию.
// Только цифры.
export function orgDigestCounts(part, today) {
  const inWork = (x) => x.status_name === STATUS_NAME.in_work;
  return {
    sign: part.to_sign.length,
    sign_long: part.to_sign.filter((x) => x.long).length,
    handover: part.handover.length,
    stuck: part.handover.filter((x) => !x.can_transfer && !x.extend_asked).length,
    due: part.hot.filter((x) => inWork(x) && x.deadline === today).length,
    overdue: part.hot.filter((x) => inWork(x) && x.overdue).length,
    idle: part.idle ?? 0,
    returned: part.returned_long ?? 0,
    fresh: part.fresh_long ?? 0,
    away: (part.away ?? []).filter((x) => !x.extend).length,
    ext_declined: part.ext_declined ?? 0,
    back: part.back_today ?? 0,
    egrn_kept: part.to_sign.filter((x) => x.egrn_kept).length,
    order_diff: part.to_sign.filter((x) => x.order_diff).length,
    task_due: part.to_sign.filter((x) => x.task_due && !x.task_due.moved).length,
    task_moved: part.task_moved_long ?? 0,
  };
}

export function orgDigestText(c) {
  const parts = [];
  if (c.sign) parts.push(`${c.sign} ${pl(c.sign, 'дело ждёт', 'дела ждут', 'дел ждут')} подписи организации${c.sign_long ? ` (2 дня и дольше: ${c.sign_long})` : ''}`);
  if (c.task_due) parts.push(`срок по заданию на оценку сегодня или прошёл — подпишите сегодня: ${c.task_due} ${pl(c.task_due, 'дело', 'дела', 'дел')}`);
  if (c.egrn_kept) parts.push(`после возврата расхождение с выпиской ЕГРН осталось: ${c.egrn_kept} ${pl(c.egrn_kept, 'дело', 'дела', 'дел')}`);
  if (c.order_diff) parts.push(`на подписи — расхождения с заявкой или заданием на оценку: ${c.order_diff} ${pl(c.order_diff, 'дело', 'дела', 'дел')}`);
  if (c.task_moved) {
    parts.push(`перенос срока согласован позже срока по заданию на оценку, а письма о переносе нет 2 дня и дольше: ${c.task_moved} ${pl(c.task_moved, 'дело', 'дела', 'дел')}`);
  }
  if (c.handover) {
    parts.push(`${c.handover} ${pl(c.handover, 'просьба', 'просьбы', 'просьб')} передать дело${c.stuck ? ` (передать некому: ${c.stuck})` : ''}`);
  }
  if (c.ext_declined) parts.push(`диспетчер отказал в переносе срока по просьбе организации: ${c.ext_declined}`);
  if (c.due) parts.push(`у экспертов сдать сегодня ${c.due} ${pl(c.due, 'дело', 'дела', 'дел')}`);
  if (c.overdue) parts.push(`${c.overdue} ${pl(c.overdue, 'дело', 'дела', 'дел')} с прошедшим сроком`);
  if (c.away) parts.push(`у ${c.away} ${pl(c.away, 'дела', 'дел', 'дел')} срок в дни, когда эксперт не принимает дела`);
  if (c.back) parts.push(`вернулись после дней «не принимаю дела»: ${c.back} ${pl(c.back, 'эксперт', 'эксперта', 'экспертов')}`);
  if (c.idle) parts.push(`${c.idle} ${pl(c.idle, 'дело', 'дела', 'дел')} без движения 3 дня и больше`);
  if (c.returned) {
    parts.push(`${c.returned} ${pl(c.returned, 'дело', 'дела', 'дел')} после возврата эксперту ${pl(c.returned, 'не исправлено', 'не исправлены', 'не исправлено')} 2 дня и больше`);
  }
  if (c.fresh) parts.push(`${c.fresh} ${pl(c.fresh, 'дело', 'дела', 'дел')} — исправленный файл не подписан экспертом 2 дня и больше`);
  return parts.length ? `На сегодня по организации: ${parts.join(', ')}` : null;
}

export async function sendOrgMorning(sql, registry, { now = new Date(), storage = null } = {}) {
  if (mskHour(now) < MORNING_HOUR) return 0;
  const today = todayMsk(now);
  const heads = await sql`select m.user_id, o.id as org_id, o.name from org_members m join organizations o on o.id = m.org_id
                          join users u on u.id = m.user_id
                          where m.role = 'head' and u.is_active and not exists (select 1 from org_morning_digests d
                            where d.user_id = m.user_id and d.org_id = m.org_id and d.day = ${today}::date)`;
  // Цифры одной организации считаются один раз, даже если руководителей несколько.
  const counted = new Map();
  let sent = 0;
  for (const h of heads) {
    if (!counted.has(h.org_id)) counted.set(h.org_id, orgDigestCounts(await orgPart(sql, { id: h.org_id, name: h.name }, registry, today, { storage }), today));
    const c = counted.get(h.org_id);
    sent += await sql.tx(async (tx) => {
      const fresh = await tx`insert into org_morning_digests (user_id, org_id, day, sign, sign_long, handover, stuck, due, overdue, idle, returned, fresh, away, ext_declined, back, egrn_kept, order_diff, task_due, task_moved)
                             values (${h.user_id}, ${h.org_id}, ${today}, ${c.sign}, ${c.sign_long}, ${c.handover}, ${c.stuck}, ${c.due}, ${c.overdue}, ${c.idle}, ${c.returned}, ${c.fresh}, ${c.away}, ${c.ext_declined}, ${c.back}, ${c.egrn_kept}, ${c.order_diff}, ${c.task_due}, ${c.task_moved})
                             on conflict do nothing returning user_id`;
      const text = orgDigestText(c);
      if (!fresh.length || !text) return 0;
      const n = await notify(tx, 'org_morning_today', { users: [h.user_id], orgId: h.org_id, sms: `БЕРТЕЛ Дело: ${text}. Подробно — «Дела экспертов» в кабинете.` });
      if (n) {
        await tx`update org_morning_digests set notification_id = (select max(id) from notifications
                   where user_id = ${h.user_id} and org_id = ${h.org_id} and event = 'org_morning_today')
                 where user_id = ${h.user_id} and org_id = ${h.org_id} and day = ${today}::date`;
      }
      return n;
    });
  }
  return sent;
}

// К какому блоку организации ведёт сводка (2.130): срок по заданию на оценку у дела на подписи сегодня или прошёл — к подписи
// организации (2.316: подписать нужно самому руководителю и сегодня); иначе есть сроки сегодня — «Дела экспертов» с отбором «Срок на этой неделе»
// (2.127: туда входят и просроченные); только прошедшие сроки — отбор «Срок прошёл» (2.158); иначе — отбор «Просят передать —
// передать некому» (2.228); иначе — к подписи организации, если после возврата расхождение с выпиской осталось (2.257: подписывать
// так нельзя); иначе — к подписи организации с отбором «Есть расхождения с заявкой или заданием на оценку» (2.286); иначе — отбор
// «Перенос позже срока по заданию — нет письма» (2.338, 2.332: банк ждёт отчёт к прежнему дню); иначе — к подписи организации
// с отбором «Ждут Вашей подписи 2 дня и дольше» (2.374); иначе — отбор «Перенос от организации» (2.238: диспетчер отказал); иначе — отбор «Срок в дни, когда
// эксперт не принимает дела» (2.209); иначе — отбор «Вернулись после «не принимаю дела»» (2.249); иначе — к подписи организации;
// иначе — отбор «Просят передать»; иначе — отбор «Вернул эксперту» (2.153); иначе — отбор «Исправленный файл ждёт подписи
// эксперта» (2.172); иначе — отбор «Без движения» (2.141).
export function orgDigestTo(c) {
  if (c.task_due) return 'sign';
  if (c.due) return 'week';
  if (c.overdue) return 'overdue';
  if (c.stuck) return 'stuck';
  if (c.egrn_kept) return 'sign';
  if (c.order_diff) return 'sign_order';
  if (c.task_moved) return 'task_moved';
  if (c.sign_long) return 'sign_long';
  if (c.ext_declined) return 'orgext';
  if (c.away) return 'away';
  if (c.back) return 'back';
  if (c.sign) return 'sign';
  if (c.handover) return 'handover';
  if (c.returned) return 'returned';
  if (c.fresh) return 'fresh';
  return c.idle ? 'idle' : null;
}

// Текст сводки руководителя в ленте по номеру уведомления (название организации лента пишет строкой ниже) и куда она ведёт.
export async function orgMorningTitles(sql, ids) {
  if (!ids.length) return new Map();
  const rows = await sql`select notification_id, sign, sign_long, handover, stuck, due, overdue, idle, returned, fresh, away, ext_declined, back, egrn_kept, order_diff, task_due, task_moved from org_morning_digests where notification_id = any(${ids}::bigint[])`;
  return new Map(rows.map((r) => [String(r.notification_id), { title: orgDigestText(r), to: orgDigestTo(r) }]));
}
