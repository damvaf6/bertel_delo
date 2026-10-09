// Специалист, допуски и подбор исполнителя (задача 1.4).
// Допуски и профиль специалиста заводит только администратор; диспетчер видит оценку по признакам и предлагает дело;
// специалист сам принимает или отказывается (шаги исполнителя — src/orders/workflow.mjs).
// Решения Claude (на подтверждение Дамиру, DECISIONS.md 01.10.2026): допуск выдаёт администратор; специалист не получает
// собственные дела; отказ — с причиной, доля принятых предложений идёт в «качество прошлых работ».
import { HttpError } from '../http/core.mjs';
import { orderSides, roleIn } from '../access/policy.mjs';
import { scoreSpecialist } from '../matching/score.mjs';
import { workStats, yearStats } from '../matching/stats.mjs';
import { STATUS_NAME, addDays, isOverdue, todayMsk } from '../orders/workflow.mjs';
import { CASE_IDLE_DAYS, caseMoves } from './org-ops.mjs';
import { openExtends } from './deadline-ops.mjs';
import { orderRef } from '../notify/registry.mjs';
import { audit, text, uuidFrom } from './util.mjs';
import { notify, orgHeads } from '../notify/notify.mjs';
import { BLOCKING_KINDS, dossierAlerts, loadDossier, needsValidDossier } from '../dossier/dossier.mjs';
import { expertMonthReport, reportMonth } from '../orgs/report.mjs';
import { expertSchedule } from '../orders/schedule.mjs';
import { scheduleIcs } from '../orders/ics.mjs';

const REGIONS = { moscow: 'Москва', mo: 'Московская область' };
const OPEN_STATUSES = ['awaiting_executor', 'in_work', 'review'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// «Не принимаю новые дела до …» (2.77): не дальше года вперёд, причина — коротко.
const AWAY_MAX_DAYS = 365;
const AWAY_NOTE_MAX = 80;
const isoDay = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// Отметка «не принимаю до …» действует, пока день возвращения не наступил; прошла — как будто её нет.
export function awayOf(sp, today = todayMsk()) {
  if (!sp?.away_until) return null;
  const until = isoDay(sp.away_until);
  return until > today ? { until, note: sp.away_note ?? null } : null;
}

function intIn(value, field, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, 'bad_input', `Поле «${field}»: целое от ${min} до ${max}`);
  return n;
}

function regionsFrom(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some((r) => !(r in REGIONS)) || new Set(value).size !== value.length) {
    throw new HttpError(400, 'bad_input', 'Поле «Где работает»: Москва и/или Московская область');
  }
  return value;
}

async function profileView(sql, userId) {
  const sp = await sql.one`
    select s.*, u.full_name, u.is_active as user_active, c.languages as crm_languages, c.qualification as crm_qualification,
           (select o.name from organizations o join org_members m on m.org_id = o.id and m.user_id = s.user_id where o.id = s.org_id) as org_name,
           (select count(*)::int from orders where executor_user_id = s.user_id and status = any(${OPEN_STATUSES}::text[])) as open_orders
    from specialists s join users u on u.id = s.user_id left join crm_profiles c on c.user_id = s.user_id where s.user_id = ${userId}`;
  if (!sp) return null;
  const permits = await sql`
    select module, service, valid_until from specialist_permits where user_id = ${userId} order by module, service`;
  return {
    user_id: sp.user_id, full_name: sp.full_name, active: sp.active, regions: sp.regions, capacity: sp.capacity,
    external_load: sp.external_load, open_orders: sp.open_orders, user_active: sp.user_active,
    // Помощник на объекте (2.4): ему назначают выезды по экспресс-заявкам.
    onsite: sp.onsite,
    // Не принимает новые дела до дня until (2.77) — отпуск, загрузка; null — отметки нет или она прошла.
    away: awayOf(sp),
    // Организация, от которой работает (2.5а): результат подписывает ещё и её руководитель. null — частная практика.
    org: sp.org_name ? { id: sp.org_id, name: sp.org_name } : null,
    permits: permits.map((p) => ({ ...p, valid_until: p.valid_until ?? null })),
    // Профиль перенесён из БЕРТЕЛ CRM (1.10): языки и квалификация; дела вне платформы приходят из CRM.
    crm: sp.crm_languages ? { languages: sp.crm_languages, qualification: sp.crm_qualification } : null,
    // Досье (2.14): только предупреждения о сроках — сами документы видит лишь эксперт.
    dossier_alerts: dossierAlerts(await loadDossier(sql, userId)),
  };
}

// Допущенные к услуге заявки специалисты с оценкой по признакам — по убыванию общей оценки.
// Решение Дамира 03.10.2026 (2.14, вопрос 17): по услугам оценки (где ИИ-проверка сверяет отчёт с досье —
// правило dossier_appraiser в описании модуля) эксперт с истёкшим аттестатом или полисом в подбор не попадает.
export async function candidatesFor(sql, order, registry) {
  const today = todayMsk();
  const rows = await sql`
    select s.user_id, s.regions, s.capacity, s.external_load, u.full_name,
      (select count(*)::int from orders o where o.executor_user_id = s.user_id and o.status = any(${OPEN_STATUSES}::text[])) as open,
      (select count(*)::int from order_offers f where f.specialist_id = s.user_id and f.outcome in ('accepted', 'declined')) as offers,
      (select count(*)::int from order_offers f where f.specialist_id = s.user_id and f.outcome = 'accepted') as accepted
    from specialists s
    join users u on u.id = s.user_id and u.is_active
    join specialist_permits p on p.user_id = s.user_id and p.module = ${order.module} and p.service = ${order.service}
         and (p.valid_until is null or p.valid_until >= ${today})
    where s.active and (s.away_until is null or s.away_until <= ${today}) and s.user_id <> ${order.owner_user_id}
      and not exists (select 1 from org_members m where m.user_id = s.user_id and m.org_id = ${order.org_id})`;
  const daysLeft = order.deadline ? Math.round((new Date(order.deadline) - new Date(today)) / 86400000) : null;
  // Истёкшие документы досье (2.14): по услугам оценки аттестат и полисы снимают с подбора, остальное — предупреждение.
  const blocking = needsValidDossier(registry, order);
  // Сдано в срок и возвраты (2.35) — в оценку «качество».
  const work = await workStats(sql, rows.map((r) => r.user_id));
  const expired = new Map();
  for (const r of rows) expired.set(r.user_id, dossierAlerts(await loadDossier(sql, r.user_id)).filter((a) => a.state === 'expired'));
  return rows
    .filter((r) => !blocking || !expired.get(r.user_id).some((a) => BLOCKING_KINDS.includes(a.kind)))
    .map((r) => ({
      user_id: r.user_id, full_name: r.full_name,
      score: scoreSpecialist(r, { open: r.open, offers: r.offers, accepted: r.accepted, ...work.get(r.user_id) }, order, daysLeft),
      dossier_expired: expired.get(r.user_id).map((a) => a.kind_name),
    }))
    .sort((a, b) => b.score.total - a.score.total || a.full_name.localeCompare(b.full_name));
}

// Организации, где есть эксперты, которым можно отдать дело (2.17): эксперт выбрал организацию в профиле специалиста,
// состоит в ней и сам проходит подбор (допуск, «принимаю дела», не его дело). Лучшая оценка эксперта — оценка организации.
export async function orgCandidatesFor(sql, order, registry) {
  const cands = await candidatesFor(sql, order, registry);
  if (!cands.length) return [];
  const rows = await sql`
    select s.user_id, o.id as org_id, o.name from specialists s
    join org_members m on m.org_id = s.org_id and m.user_id = s.user_id join organizations o on o.id = s.org_id
    where s.user_id = any(${cands.map((c) => c.user_id)}::uuid[])`;
  const byOrg = new Map();
  for (const r of rows) {
    const c = cands.find((x) => x.user_id === r.user_id);
    const g = byOrg.get(r.org_id) ?? { org_id: r.org_id, name: r.name, experts: 0, best: 0 };
    g.experts += 1;
    g.best = Math.max(g.best, c.score.total);
    byOrg.set(r.org_id, g);
  }
  return [...byOrg.values()].sort((a, b) => b.best - a.best || a.name.localeCompare(b.name));
}

// Эксперты организации, которых её руководитель может назначить на дело (2.17), — из общего подбора по этой заявке.
export async function orgExpertsFor(sql, order, orgId, registry) {
  const cands = await candidatesFor(sql, order, registry);
  if (!cands.length) return [];
  const mine = await sql`
    select s.user_id from specialists s join org_members m on m.org_id = s.org_id and m.user_id = s.user_id
    where s.org_id = ${orgId} and s.user_id = any(${cands.map((c) => c.user_id)}::uuid[])`;
  const ids = new Set(mine.map((r) => r.user_id));
  return cands.filter((c) => ids.has(c.user_id));
}

// Разбор отметки «не принимаю до …» (2.77): день — завтра или позже, но не дальше года; причина — по желанию.
function awayFrom(value) {
  if (value === null) return null;
  const until = String(value?.until ?? '');
  const d = new Date(`${until}T00:00:00Z`);
  if (!DATE_RE.test(until) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== until) {
    throw new HttpError(400, 'bad_date', 'Укажите день, с которого снова принимаете дела');
  }
  const today = todayMsk();
  if (until <= today) throw new HttpError(400, 'bad_date', 'День, с которого снова принимаете дела, — не раньше завтра');
  if (until > addDays(today, AWAY_MAX_DAYS)) throw new HttpError(400, 'bad_date', 'Не дальше чем на год вперёд');
  const raw = value?.note == null ? '' : String(value.note).trim();
  if (raw.length > AWAY_NOTE_MAX) throw new HttpError(400, 'bad_input', `Поле «Почему»: не длиннее ${AWAY_NOTE_MAX} знаков`);
  return { until, note: raw || null };
}

function requireDispatcher(actor, order) {
  if (!orderSides(actor, order).includes('dispatcher')) throw new HttpError(403, 'forbidden', 'Недостаточно прав');
}

export function matchOps() {
  return [
    {
      // Мой профиль специалиста (если меня им сделали) — для кабинета.
      id: 'specialist.me', method: 'GET', path: '/api/specialist/me', auth: 'user', access: 'self',
      async handler({ sql, actor }) {
        return { specialist: await profileView(sql, actor.id) };
      },
    },
    {
      // Специалист сам включает и выключает приём предложений (на отпуск, болезнь) и выбирает, от какой своей организации
      // работает (2.5а) — пока нет дел в работе и на проверке, чтобы подпись организации не менялась посреди дела.
      // «Не принимаю новые дела до …» (2.77): away — { until: день, с которого снова принимает, note: почему } или null —
      // снять отметку. Дела, которые уже у эксперта, остаются; новые подбор не предлагает, руководитель видит до какого дня.
      id: 'specialist.me.update', method: 'PATCH', path: '/api/specialist/me', auth: 'user', access: 'self',
      async handler({ sql, actor, body }) {
        const hasActive = body?.active !== undefined;
        const hasOrg = body?.org_id !== undefined;
        const hasAway = body?.away !== undefined;
        if (!hasActive && !hasOrg && !hasAway) throw new HttpError(400, 'bad_input', 'Нечего менять');
        if (hasActive && typeof body.active !== 'boolean') throw new HttpError(400, 'bad_input', 'Поле «Принимаю дела»: да или нет');
        const orgId = !hasOrg || body.org_id === null ? null : uuidFrom(body.org_id, 'Организация не найдена');
        if (orgId && !actor.orgs.some((m) => m.org_id === orgId)) throw new HttpError(404, 'not_found', 'Организация не найдена');
        const away = hasAway ? awayFrom(body.away) : null;
        await sql.tx(async (tx) => {
          const sp = await tx.one`select * from specialists where user_id = ${actor.id} for update`;
          if (!sp) throw new HttpError(404, 'not_found', 'Вы не специалист');
          if (hasActive) await tx`update specialists set active = ${body.active} where user_id = ${actor.id}`;
          if (hasAway) {
            await tx`update specialists set away_until = ${away?.until ?? null}, away_note = ${away?.note ?? null} where user_id = ${actor.id}`;
            await audit(tx, actor, 'specialist.away', 'user', actor.id, { until: away?.until ?? null });
            // Руководителю организации, от которой эксперт работает, — чтобы не ждал от него ответа на новые дела.
            const org = (hasOrg ? orgId : sp.org_id);
            if (away && org) await notify(tx, 'expert_away_head', { users: await orgHeads(tx, org), orgId: org, actor });
          }
          if (hasOrg && orgId !== sp.org_id) {
            const busy = await tx.one`select 1 from orders where executor_user_id = ${actor.id} and status in ('in_work', 'review') limit 1`;
            if (busy) throw new HttpError(409, 'orders_in_work', 'Организацию можно сменить, когда нет дел в работе и на проверке');
            await tx`update specialists set org_id = ${orgId} where user_id = ${actor.id}`;
            await audit(tx, actor, 'specialist.org', 'user', actor.id, { org_id: orgId });
          }
        });
        return { specialist: await profileView(sql, actor.id) };
      },
    },
    {
      // «Мои итоги за месяц» (2.92): сдано, из них в срок, возвраты, вознаграждение и выплачено — только свои дела.
      // Месяц — как в сводке руководителя (текущий и 12 прошлых).
      id: 'specialist.me.report', method: 'GET', path: '/api/specialist/me/report', auth: 'user', access: 'self',
      async handler({ sql, actor, query }) {
        if (!(await sql.one`select 1 from specialists where user_id = ${actor.id}`)) throw new HttpError(404, 'not_found', 'Вы не специалист');
        return { report: await expertMonthReport(sql, actor.id, reportMonth(query.month)) };
      },
    },
    {
      // «Мои сроки на две недели» (2.109): по дням — сроки своих дел, выезды и ссылки на осмотр, просьбы о переносе срока.
      // ?format=ics (2.122) — сроки и выезды файлом для календаря телефона, без заказчика и адресов.
      id: 'specialist.me.schedule', method: 'GET', path: '/api/specialist/me/schedule', auth: 'user', access: 'self',
      async handler({ sql, actor, registry, query, res }) {
        if (!(await sql.one`select 1 from specialists where user_id = ${actor.id}`)) throw new HttpError(404, 'not_found', 'Вы не специалист');
        const schedule = await expertSchedule(sql, actor.id, registry);
        if (query.format !== 'ics') return { schedule };
        res.set({
          'content-type': 'text/calendar; charset=utf-8',
          'content-disposition': `attachment; filename="sroki.ics"; filename*=UTF-8''${encodeURIComponent(`Мои сроки ${schedule.from}.ics`)}`,
          'cache-control': 'no-store',
        });
        return res.send(scheduleIcs(schedule));
      },
    },
    {
      // Карточка эксперта (2.35): то, по чему диспетчер и руководитель выбирают, кому отдать дело. Досье — без копий
      // документов (копии видит только сам эксперт); история — без заказчика, названий заявок и полей. Сданное за год по услугам
      // и средний срок (2.139) — `year`. «Сейчас в работе» (2.143) — `now`: дела в работе, на проверке и предложенные, со сроком,
      // днями без движения (как «Дела экспертов», 2.133) и открытой просьбой о переносе срока; руководителю организации эксперта
      // — `org_id`, чтобы открыть дело в «Делах экспертов». Без заказчика и данных заявки.
      id: 'specialists.card', method: 'GET', path: '/api/specialists/:id/card', auth: 'user',
      access: { resource: 'specialistCard', param: 'id', need: 'read' },
      async handler({ sql, actor, specialist, signOrg, registry }) {
        const id = specialist.user_id;
        const profile = await profileView(sql, id);
        const dossier = (await loadDossier(sql, id)).map((i) => ({
          kind: i.kind, kind_name: i.kind_name, title: i.title, number: i.number, issued_on: i.issued_on,
          valid_until: i.valid_until, amount_kop: i.amount_kop, state: i.state, has_copy: !!i.file,
        }));
        const offers = await sql.one`
          select count(*) filter (where outcome in ('accepted', 'declined'))::int as offers, count(*) filter (where outcome = 'accepted')::int as accepted
          from order_offers where specialist_id = ${id}`;
        const work = (await workStats(sql, [id])).get(id);
        const stats = { ...offers, ...work };
        const quality = scoreSpecialist({ ...profile, external_load: profile.external_load ?? 0 }, { open: 0, ...stats }, { fields: {} }, null).features.quality;
        const rows = await sql`
          select o.id, o.module, o.service, o.status, o.deadline,
            (select (max(h.at) at time zone 'Europe/Moscow')::date from order_status_history h where h.order_id = o.id and h.to_status = 'review') as submitted,
            (select count(*)::int from order_status_history h where h.order_id = o.id and h.from_status = 'review' and h.to_status = 'in_work')
              + (select count(*)::int from org_returns r where r.order_id = o.id) as returns
          from orders o where o.executor_user_id = ${id} and o.status <> 'cancelled'
          order by o.updated_at desc limit 30`;
        const day = (d) => (d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null);
        const today = todayMsk();
        const active = await sql`
          select id, module, service, status, deadline, updated_at from orders
          where executor_user_id = ${id} and status = any(${OPEN_STATUSES}::text[])
          order by deadline nulls last, updated_at desc`;
        const moves = await caseMoves(sql, active.filter((o) => o.status !== 'awaiting_executor'));
        const ext = await openExtends(sql, active.map((o) => o.id));
        return {
          specialist: profile,
          dossier,
          stats,
          quality: { score: quality.score, note: quality.note },
          year: await yearStats(sql, id, { registry }),
          now: {
            org_id: signOrg && roleIn(actor, signOrg.id) === 'head' ? signOrg.id : null,
            cases: active.map((o) => ({
              order_ref: orderRef(o.id),
              service: registry.service(o.module, o.service)?.service.name ?? o.service,
              status: o.status,
              status_name: STATUS_NAME[o.status],
              deadline: o.deadline,
              overdue: isOverdue(o, today),
              // «Горит» — как в «Делах экспертов» (2.102): в работе или на проверке, срок прошёл или через 1–2 дня.
              hot: o.status !== 'awaiting_executor' && !!o.deadline && o.deadline <= addDays(today, 2),
              idle_days: moves.get(o.id)?.days ?? null,
              idle: (moves.get(o.id)?.days ?? 0) >= CASE_IDLE_DAYS,
              extend: ext.get(o.id) ? { new_deadline: ext.get(o.id).new_deadline } : null,
            })),
          },
          history: rows.map((o) => ({
            order_ref: orderRef(o.id),
            service: registry.service(o.module, o.service)?.service.name ?? o.service,
            status: o.status,
            status_name: STATUS_NAME[o.status],
            deadline: o.deadline,
            submitted: day(o.submitted),
            on_time: ['done', 'closed'].includes(o.status) ? (!o.deadline || (o.submitted && day(o.submitted) <= o.deadline)) : null,
            returns: o.returns,
          })),
        };
      },
    },
    {
      id: 'specialists.list', method: 'GET', path: '/api/specialists', auth: 'user', access: { platform: 'staff' },
      async handler({ sql }) {
        const ids = await sql`select user_id from specialists order by user_id`;
        const list = await Promise.all(ids.map((r) => profileView(sql, r.user_id)));
        return { specialists: list.sort((a, b) => a.full_name.localeCompare(b.full_name)) };
      },
    },
    {
      // Сделать человека специалистом или поменять его профиль (район, нормальная нагрузка, выезды на объект — 2.4).
      id: 'specialists.upsert', method: 'PUT', path: '/api/admin/specialists/:id', auth: 'user', access: { platform: 'admin' },
      async handler({ sql, actor, params, body }) {
        const userId = uuidFrom(params.id, 'Пользователь не найден');
        const view = await sql.tx(async (tx) => {
          const u = await tx.one`select 1 from users where id = ${userId}`;
          if (!u) throw new HttpError(404, 'not_found', 'Пользователь не найден');
          const cur = await tx.one`select * from specialists where user_id = ${userId} for update`;
          const regions = body?.regions === undefined ? (cur?.regions ?? ['moscow', 'mo']) : regionsFrom(body.regions);
          const capacity = body?.capacity === undefined ? (cur?.capacity ?? 5) : intIn(body.capacity, 'Нормальная нагрузка', 1, 50);
          const external = body?.external_load === undefined ? (cur?.external_load ?? 0) : intIn(body.external_load, 'Дела вне платформы', 0, 500);
          if (body?.onsite !== undefined && typeof body.onsite !== 'boolean') throw new HttpError(400, 'bad_input', 'Поле «Выезды на объект»: да или нет');
          const onsite = body?.onsite ?? cur?.onsite ?? false;
          await tx`
            insert into specialists (user_id, regions, capacity, external_load, onsite)
            values (${userId}, ${regions}, ${capacity}, ${external}, ${onsite})
            on conflict (user_id) do update set regions = ${regions}, capacity = ${capacity}, external_load = ${external}, onsite = ${onsite}`;
          await audit(tx, actor, 'specialist.upsert', 'user', userId, { regions, capacity, external, onsite });
          return profileView(tx, userId);
        });
        return { specialist: view };
      },
    },
    {
      id: 'specialists.permit.add', method: 'POST', path: '/api/admin/specialists/:id/permits', auth: 'user', access: { platform: 'admin' },
      async handler({ sql, actor, params, body, registry, res }) {
        const userId = uuidFrom(params.id, 'Специалист не найден');
        const def = registry.service(String(body?.module ?? ''), String(body?.service ?? ''));
        if (!def) throw new HttpError(400, 'bad_service', 'Выберите услугу');
        let until = null;
        if (body?.valid_until !== undefined && body.valid_until !== null && body.valid_until !== '') {
          until = String(body.valid_until);
          const d = new Date(`${until}T00:00:00Z`);
          if (!DATE_RE.test(until) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== until) throw new HttpError(400, 'bad_date', 'Поле «Действует до»: укажите дату');
          if (until < todayMsk() || until > addDays(todayMsk(), 10 * 365)) throw new HttpError(400, 'bad_date', 'Поле «Действует до»: не в прошлом и не дальше десяти лет');
        }
        const view = await sql.tx(async (tx) => {
          const sp = await tx.one`select 1 from specialists where user_id = ${userId}`;
          if (!sp) throw new HttpError(404, 'not_found', 'Специалист не найден');
          await tx`
            insert into specialist_permits (user_id, module, service, valid_until, granted_by)
            values (${userId}, ${def.module.id}, ${def.service.id}, ${until}, ${actor.id})
            on conflict (user_id, module, service) do update set valid_until = ${until}, granted_by = ${actor.id}`;
          await audit(tx, actor, 'specialist.permit.add', 'user', userId, { module: def.module.id, service: def.service.id, until });
          return profileView(tx, userId);
        });
        res.status(201);
        return { specialist: view };
      },
    },
    {
      id: 'specialists.permit.remove', method: 'DELETE', path: '/api/admin/specialists/:id/permits/:module/:service', auth: 'user', access: { platform: 'admin' },
      async handler({ sql, actor, params }) {
        const userId = uuidFrom(params.id, 'Специалист не найден');
        const view = await sql.tx(async (tx) => {
          const gone = await tx`delete from specialist_permits where user_id = ${userId} and module = ${params.module} and service = ${params.service} returning 1`;
          if (!gone.length) throw new HttpError(404, 'not_found', 'Допуск не найден');
          await audit(tx, actor, 'specialist.permit.remove', 'user', userId, { module: params.module, service: params.service });
          return profileView(tx, userId);
        });
        return { specialist: view };
      },
    },
    {
      // Диспетчер видит, кому можно отдать дело, и оценку по признакам.
      id: 'orders.candidates', method: 'GET', path: '/api/orders/:id/candidates', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry }) {
        requireDispatcher(actor, order);
        if (!['matching', 'awaiting_executor'].includes(order.status)) throw new HttpError(409, 'bad_transition', 'Подбор идёт только для заявок в подборе');
        return {
          candidates: await candidatesFor(sql, order, registry), current_executor_id: order.executor_user_id,
          // Организации с подходящими экспертами (2.17): дело можно предложить организации — эксперта назначит руководитель.
          orgs: await orgCandidatesFor(sql, order, registry), current_org_id: order.offer_org_id,
        };
      },
    },
    {
      // Предложить дело специалисту (из подбора) или организации (2.17: эксперта назначит её руководитель); передать
      // другому — пока первый не ответил.
      id: 'orders.offer', method: 'POST', path: '/api/orders/:id/offer', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, body, registry }) {
        requireDispatcher(actor, order);
        const toOrg = body?.org_id !== undefined && body?.org_id !== null;
        const specialistId = toOrg ? null : uuidFrom(body?.specialist_id, 'Специалист не найден');
        const orgId = toOrg ? uuidFrom(body.org_id, 'Организация не найдена') : null;
        const from = String(body?.from ?? '');
        const updated = await sql.tx(async (tx) => {
          const cur = await tx.one`select * from orders where id = ${order.id} for update`;
          if (cur.status !== from) throw new HttpError(409, 'status_changed', 'Статус заявки уже изменился, обновите страницу');
          if (!['matching', 'awaiting_executor'].includes(cur.status)) throw new HttpError(409, 'bad_transition', `Из статуса «${cur.status}» так нельзя`);
          // Исполнитель соглашается на известное вознаграждение: без цены дело не предлагается (1.6).
          if (!cur.price_kop) throw new HttpError(409, 'no_price', 'Сначала назначьте цену');
          // Заказчик платит при заказе: неоплаченное дело исполнителю не предлагается (решение Дамира 01.10.2026).
          if (!cur.paid_at) throw new HttpError(409, 'not_paid', 'Заявка ещё не оплачена заказчиком');
          let score;
          if (toOrg) {
            const g = (await orgCandidatesFor(tx, cur, registry)).find((c) => c.org_id === orgId);
            if (!g) throw new HttpError(409, 'not_eligible', 'Этой организации дело отдать нельзя: у неё нет экспертов с допуском, которые принимают дела');
            if (cur.offer_org_id === orgId && !cur.executor_user_id) throw new HttpError(409, 'already_offered', 'Дело уже у этой организации');
            score = { org: true, experts: g.experts, total: g.best };
          } else {
            const cand = (await candidatesFor(tx, cur, registry)).find((c) => c.user_id === specialistId);
            if (!cand) throw new HttpError(409, 'not_eligible', 'Этому специалисту дело отдать нельзя: нет допуска, не принимает дела, истёк аттестат или полис в досье или это его дело');
            score = cand.score;
          }
          const reassign = cur.status === 'awaiting_executor';
          if (reassign) {
            await tx`update order_offers set outcome = 'withdrawn', outcome_at = now(), reason = 'Передано другому исполнителю'
                     where order_id = ${cur.id} and outcome is null`;
          }
          await tx`insert into order_offers (order_id, specialist_id, org_id, score, offered_by)
                   values (${cur.id}, ${specialistId}, ${orgId}, ${JSON.stringify(score)}, ${actor.id})`;
          const o = await tx.one`
            update orders set status = 'awaiting_executor', executor_user_id = ${specialistId}, offer_org_id = ${orgId}, updated_at = now()
            where id = ${cur.id} returning *`;
          await tx`insert into order_status_history (order_id, from_status, to_status, actor_id, side, reason)
                   values (${cur.id}, ${cur.status}, 'awaiting_executor', ${actor.id}, 'dispatcher', ${reassign ? 'Передано другому исполнителю' : null})`;
          await audit(tx, actor, 'order.offer', 'order', cur.id, { specialist: specialistId, org: orgId, score: score.total, reassign });
          if (reassign) {
            if (cur.executor_user_id && cur.executor_user_id !== specialistId) await notify(tx, 'offer_withdrawn', { users: [cur.executor_user_id], orderId: cur.id, actor });
            if (cur.offer_org_id && cur.offer_org_id !== orgId) await notify(tx, 'org_offer_withdrawn', { users: await orgHeads(tx, cur.offer_org_id), orgId: cur.offer_org_id, actor });
          }
          if (toOrg) await notify(tx, 'org_offer', { users: await orgHeads(tx, orgId), orderId: cur.id, orgId, actor });
          else await notify(tx, 'offer', { users: [specialistId], orderId: cur.id, actor });
          return o;
        });
        return { order: { id: updated.id, status: updated.status, executor_user_id: updated.executor_user_id, offer_org_id: updated.offer_org_id } };
      },
    },
  ];
}
