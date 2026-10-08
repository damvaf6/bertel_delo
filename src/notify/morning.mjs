// Утренняя сводка эксперту «На сегодня» (2.119): раз в день, после 8:00 по Москве (раз в минуту вместе с напоминаниями о
// сроках, src/server.mjs), — одно уведомление специалисту: сколько дел сдать сегодня, сколько с прошедшим сроком, сколько
// выездов на объект сегодня (помощника по своим делам и своих выездов помощником) и сколько ссылок на осмотр истекают в
// ближайшие сутки. Считается так же, как «Мои сроки на две недели» (src/orders/schedule.mjs) — туда и ведёт уведомление.
// Нечего сообщить — сводки нет. В тексте и СМС только цифры: ни названий дел, ни имён, ни адресов.
import { expertSchedule } from '../orders/schedule.mjs';
import { STATUS_NAME, todayMsk } from '../orders/workflow.mjs';
import { orgPart } from '../ops/today-ops.mjs';
import { notify } from './notify.mjs';

export const MORNING_HOUR = 8;

const mskHour = (now) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', hourCycle: 'h23' }).format(now));
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
  return parts.length ? `На сегодня: ${parts.join(', ')}` : null;
}

// Разослать сводки за сегодня тем, кому ещё не считали. Возвращает, сколько уведомлений записано.
export async function sendMorning(sql, { now = new Date() } = {}) {
  if (mskHour(now) < MORNING_HOUR) return 0;
  const today = todayMsk(now);
  const people = await sql`select s.user_id from specialists s join users u on u.id = s.user_id
                           where u.is_active and not exists (select 1 from morning_digests d where d.user_id = s.user_id and d.day = ${today}::date)`;
  let sent = 0;
  for (const { user_id: userId } of people) {
    const c = digestCounts(await expertSchedule(sql, userId, NO_NAMES, today), now);
    sent += await sql.tx(async (tx) => {
      const fresh = await tx`insert into morning_digests (user_id, day, due, overdue, visits, links)
                             values (${userId}, ${today}, ${c.due}, ${c.overdue}, ${c.visits}, ${c.links})
                             on conflict do nothing returning user_id`;
      const text = digestText(c);
      if (!fresh.length || !text) return 0;
      const n = await notify(tx, 'morning_today', { users: [userId], sms: `БЕРТЕЛ Дело: ${text}. Подробно — «Мои сроки» в кабинете.` });
      if (n) {
        await tx`update morning_digests set notification_id = (select max(id) from notifications where user_id = ${userId} and event = 'morning_today')
                 where user_id = ${userId} and day = ${today}::date`;
      }
      return n;
    });
  }
  return sent;
}

// Текст сводки в ленте по номеру уведомления (цифры — из morning_digests).
export async function morningTitles(sql, ids) {
  if (!ids.length) return new Map();
  const rows = await sql`select notification_id, due, overdue, visits, links from morning_digests where notification_id = any(${ids}::bigint[])`;
  return new Map(rows.map((r) => [String(r.notification_id), digestText(r)]));
}

// Утренняя сводка руководителю «На сегодня по организации» (2.121): по каждой организации, где он руководитель, — одно
// уведомление: сколько дел ждут подписи организации, сколько экспертов просят передать дело, сколько дел экспертов сдать
// сегодня и с прошедшим сроком. Считается так же, как «Сегодня» (src/ops/today-ops.mjs); ведёт в организацию. Только цифры.
export function orgDigestCounts(part, today) {
  const inWork = (x) => x.status_name === STATUS_NAME.in_work;
  return {
    sign: part.to_sign.length,
    handover: part.handover.length,
    due: part.hot.filter((x) => inWork(x) && x.deadline === today).length,
    overdue: part.hot.filter((x) => inWork(x) && x.overdue).length,
  };
}

export function orgDigestText(c) {
  const parts = [];
  if (c.sign) parts.push(`${c.sign} ${pl(c.sign, 'дело ждёт', 'дела ждут', 'дел ждут')} подписи организации`);
  if (c.handover) parts.push(`${c.handover} ${pl(c.handover, 'просьба', 'просьбы', 'просьб')} передать дело`);
  if (c.due) parts.push(`у экспертов сдать сегодня ${c.due} ${pl(c.due, 'дело', 'дела', 'дел')}`);
  if (c.overdue) parts.push(`${c.overdue} ${pl(c.overdue, 'дело', 'дела', 'дел')} с прошедшим сроком`);
  return parts.length ? `На сегодня по организации: ${parts.join(', ')}` : null;
}

export async function sendOrgMorning(sql, registry, { now = new Date() } = {}) {
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
    if (!counted.has(h.org_id)) counted.set(h.org_id, orgDigestCounts(await orgPart(sql, { id: h.org_id, name: h.name }, registry, today), today));
    const c = counted.get(h.org_id);
    sent += await sql.tx(async (tx) => {
      const fresh = await tx`insert into org_morning_digests (user_id, org_id, day, sign, handover, due, overdue)
                             values (${h.user_id}, ${h.org_id}, ${today}, ${c.sign}, ${c.handover}, ${c.due}, ${c.overdue})
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

// К какому блоку организации ведёт сводка (2.130): есть сроки сегодня или прошедшие — «Дела экспертов» с отбором «Срок на
// этой неделе» (2.127: туда входят и просроченные); иначе — к подписи организации; иначе — отбор «Просят передать».
export function orgDigestTo(c) {
  if (c.due || c.overdue) return 'week';
  if (c.sign) return 'sign';
  return c.handover ? 'handover' : null;
}

// Текст сводки руководителя в ленте по номеру уведомления (название организации лента пишет строкой ниже) и куда она ведёт.
export async function orgMorningTitles(sql, ids) {
  if (!ids.length) return new Map();
  const rows = await sql`select notification_id, sign, handover, due, overdue from org_morning_digests where notification_id = any(${ids}::bigint[])`;
  return new Map(rows.map((r) => [String(r.notification_id), { title: orgDigestText(r), to: orgDigestTo(r) }]));
}
