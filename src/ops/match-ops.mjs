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
import { caseMoves } from './org-ops.mjs';
import { openExtends, taskMovedOrg } from './deadline-ops.mjs';
import { orderRef } from '../notify/registry.mjs';
import { audit, text, uuidFrom } from './util.mjs';
import { notify, orgHeads } from '../notify/notify.mjs';
import { BLOCKING_KINDS, dossierAlerts, loadDossier, needsValidDossier } from '../dossier/dossier.mjs';
import { expertMonthReport, orgReturnsYear, reportMonth } from '../orgs/report.mjs';
import { expertSchedule, taskDues } from '../orders/schedule.mjs';
import { scheduleIcs } from '../orders/ics.mjs';
import { AWAY_BACK_SHOW_DAYS, awayBackOf } from '../notify/away.mjs';
import { TAX_STATUSES, taxStatusFrom } from '../matching/executors.mjs';

const REGIONS = { moscow: 'Москва', mo: 'Московская область' };
const OPEN_STATUSES = ['awaiting_executor', 'in_work', 'review'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// «Не принимаю новые дела до …» (2.77): не дальше года вперёд, причина — коротко.
const AWAY_MAX_DAYS = 365;
const AWAY_NOTE_MAX = 80;
const isoDay = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// Отметка «не принимаю до …» действует, пока день возвращения не наступил; прошла — как будто её нет.
// from (2.226) — первый день «не принимаю», если он ещё не наступил; null — отметка уже действует.
export function awayOf(sp, today = todayMsk()) {
  if (!sp?.away_until) return null;
  const until = isoDay(sp.away_until);
  const from = sp.away_from ? isoDay(sp.away_from) : null;
  return until > today ? { from: from && from > today ? from : null, until, note: sp.away_note ?? null } : null;
}

// День date — в днях «не принимаю дела» отметки a (из awayOf).
export const awayOn = (a, date) => !!a && !!date && date < a.until && (!a.from || date >= a.from);

// Эксперт вернулся после дней «не принимаю дела» (2.249): день возвращения (away_until) уже наступил, не раньше недели назад
// (как блок «Пока Вас не было», 2.239) — руководителю видно, у чьих дел стоит посмотреть, что изменилось.
export function backOf(sp, today = todayMsk()) {
  if (!sp?.away_until) return null;
  const until = isoDay(sp.away_until);
  if (until > today || until <= addDays(today, -AWAY_BACK_SHOW_DAYS)) return null;
  const since = sp.away_since ? isoDay(sp.away_since) : sp.away_from ? isoDay(sp.away_from) : null;
  return { since: since && since < until ? since : null, until, today: until === today };
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

// registry — чтобы назвать языки документов о знании языка (2а.3).
async function profileView(sql, userId, registry) {
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
    // Статус исполнителя (2а.3): самозанятый, ИП, ООО/бюро; null — не указан. Правила для статуса — в профиле.
    tax_status: sp.tax_status ?? null,
    tax_status_name: TAX_STATUSES[sp.tax_status]?.name ?? null,
    tax_rules: TAX_STATUSES[sp.tax_status]?.rules ?? [],
    // Документы о знании языка (2а.3): язык, есть ли копия, проверен ли администратором — без номеров.
    languages: (await loadDossier(sql, userId, { languages: true })).filter((i) => i.kind === 'language').map((i) => ({
      id: i.id, language: i.language, language_name: registry?.languages().find((l) => l.id === i.language)?.name ?? i.language,
      title: i.title, has_copy: !!i.file, verified: i.verified,
    })),
    // Профиль перенесён из БЕРТЕЛ CRM (1.10): языки и квалификация; дела вне платформы приходят из CRM.
    crm: sp.crm_languages ? { languages: sp.crm_languages, qualification: sp.crm_qualification } : null,
    // Досье (2.14): только предупреждения о сроках — сами документы видит лишь эксперт.
    dossier_alerts: dossierAlerts(await loadDossier(sql, userId)),
  };
}

// Допущенные к услуге заявки специалисты с оценкой по признакам — по убыванию общей оценки.
// Решение Дамира 03.10.2026 (2.14, вопрос 17): по услугам оценки (где ИИ-проверка сверяет отчёт с досье —
// правило dossier_appraiser в описании модуля) эксперт с истёкшим аттестатом или полисом в подбор не попадает.
// Переводы (2а.3, executors в описании модуля): только исполнители со статусом; к нотариальным — с проверенным документом
// о знании языка заявки.
export async function candidatesFor(sql, order, registry) {
  const today = todayMsk();
  const rules = registry?.executorRules(order.module, order.service) ?? { tax_status: false, language_field: null };
  const lang = rules.language_field ? String(order.fields?.[rules.language_field] ?? '') : null;
  const rows = await sql`
    select s.user_id, s.regions, s.capacity, s.external_load, u.full_name,
      (select count(*)::int from orders o where o.executor_user_id = s.user_id and o.status = any(${OPEN_STATUSES}::text[])) as open,
      (select count(*)::int from order_offers f where f.specialist_id = s.user_id and f.outcome in ('accepted', 'declined')) as offers,
      (select count(*)::int from order_offers f where f.specialist_id = s.user_id and f.outcome = 'accepted') as accepted
    from specialists s
    join users u on u.id = s.user_id and u.is_active
    join specialist_permits p on p.user_id = s.user_id and p.module = ${order.module} and p.service = ${order.service}
         and (p.valid_until is null or p.valid_until >= ${today})
    where s.active and (s.away_until is null or s.away_until <= ${today} or s.away_from > ${today}) and s.user_id <> ${order.owner_user_id}
      and not exists (select 1 from org_members m where m.user_id = s.user_id and m.org_id = ${order.org_id})
      and (${!rules.tax_status} or s.tax_status is not null)
      -- Карточка допуска отозвана, а новой нет (задача штаба 3f817197-…-81b2) — не предлагать.
      and not (exists (select 1 from permit_cards c where c.user_id = s.user_id and c.revoked_at is not null)
               and not exists (select 1 from permit_cards c where c.user_id = s.user_id and c.revoked_at is null))
      and (${lang === null} or exists (select 1 from dossier_items d where d.user_id = s.user_id and d.kind = 'language'
           and d.language = ${lang ?? ''} and d.verified_at is not null and d.deleted_at is null))`;
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
// from (2.226) — с какого дня не принимать: завтра или позже, раньше дня возвращения; пусто — с сегодня.
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
  const from = value?.from == null || value.from === '' ? null : String(value.from);
  if (from !== null) {
    const f = new Date(`${from}T00:00:00Z`);
    if (!DATE_RE.test(from) || Number.isNaN(f.getTime()) || f.toISOString().slice(0, 10) !== from) {
      throw new HttpError(400, 'bad_date', 'Укажите день, с которого не принимаете дела');
    }
    if (from <= today) throw new HttpError(400, 'bad_date', 'День, с которого не принимаете дела, — не раньше завтра (с сегодня — оставьте пустым)');
    if (from >= until) throw new HttpError(400, 'bad_date', 'День, с которого не принимаете дела, — раньше дня, с которого снова принимаете');
  }
  return { from, until, note: raw || null };
}

// Документ о знании языка специалиста :id (2а.3) — или «не найдено».
async function languageItem(sql, params, { lock = false } = {}) {
  const userId = uuidFrom(params.id, 'Документ не найден');
  if (!/^\d{1,18}$/.test(String(params.item ?? ''))) throw new HttpError(404, 'not_found', 'Документ не найден');
  const row = lock
    ? await sql.one`select * from dossier_items where id = ${params.item} and user_id = ${userId} and kind = 'language' and deleted_at is null for update`
    : await sql.one`select * from dossier_items where id = ${params.item} and user_id = ${userId} and kind = 'language' and deleted_at is null`;
  if (!row) throw new HttpError(404, 'not_found', 'Документ не найден');
  return row;
}

function requireDispatcher(actor, order) {
  if (!orderSides(actor, order).includes('dispatcher')) throw new HttpError(403, 'forbidden', 'Недостаточно прав');
}

export function matchOps() {
  return [
    {
      // Мой профиль специалиста (если меня им сделали) — для кабинета.
      id: 'specialist.me', method: 'GET', path: '/api/specialist/me', auth: 'user', access: 'self',
      async handler({ sql, actor, registry }) {
        return { specialist: await profileView(sql, actor.id, registry) };
      },
    },
    {
      // Специалист сам включает и выключает приём предложений (на отпуск, болезнь) и выбирает, от какой своей организации
      // работает (2.5а) — пока нет дел в работе и на проверке, чтобы подпись организации не менялась посреди дела.
      // «Не принимаю новые дела до …» (2.77): away — { until: день, с которого снова принимает, note: почему } или null —
      // снять отметку. Дела, которые уже у эксперта, остаются; новые подбор не предлагает, руководитель видит до какого дня.
      id: 'specialist.me.update', method: 'PATCH', path: '/api/specialist/me', auth: 'user', access: 'self',
      async handler({ sql, actor, body, registry }) {
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
            // С какого дня считать «Пока Вас не было» (2.239): первый день отметки; продлил уже идущие дни — прежний.
            const cur = awayOf(sp);
            const going = cur && !cur.from && sp.away_since ? isoDay(sp.away_since) : null;
            const since = away ? away.from ?? going ?? todayMsk() : null;
            await tx`update specialists set away_from = ${away?.from ?? null}, away_until = ${away?.until ?? null}, away_note = ${away?.note ?? null},
                       away_since = ${since}::date
                     where user_id = ${actor.id}`;
            await audit(tx, actor, 'specialist.away', 'user', actor.id, { from: away?.from ?? null, until: away?.until ?? null });
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
        return { specialist: await profileView(sql, actor.id, registry) };
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
      // «Пока Вас не было» (2.239): неделю после дней «не принимаю дела» — что произошло с делами эксперта за эти дни.
      id: 'specialist.me.back', method: 'GET', path: '/api/specialist/me/back', auth: 'user', access: 'self',
      async handler({ sql, actor }) {
        const back = await awayBackOf(sql, actor.id);
        return { back: back && !back.empty ? back : null };
      },
    },
    {
      // «Всё посмотрел» (2.244): блок «Пока Вас не было» убирается до следующих дней «не принимаю дела». until — какие дни
      // человек видел: продлил или поставил новые — «уже изменилось».
      id: 'specialist.me.back.seen', method: 'POST', path: '/api/specialist/me/back/seen', auth: 'user', access: 'self',
      async handler({ sql, actor, body }) {
        const until = String(body?.until ?? '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new HttpError(400, 'bad_date', 'Не указано, какие дни посмотрены');
        const r = await sql.one`update specialists set away_back_seen = away_until
                                where user_id = ${actor.id} and away_until = ${until}::date returning user_id`;
        if (!r) throw new HttpError(409, 'changed', 'Дни «не принимаю дела» уже изменились — обновите страницу');
        return { ok: true };
      },
    },
    {
      // «Мои сроки на две недели» (2.109): по дням — сроки своих дел, выезды и ссылки на осмотр, просьбы о переносе срока.
      // ?format=ics (2.122) — сроки и выезды файлом для календаря телефона, без заказчика и адресов.
      id: 'specialist.me.schedule', method: 'GET', path: '/api/specialist/me/schedule', auth: 'user', access: 'self',
      async handler({ sql, actor, registry, query, res, providers }) {
        if (!(await sql.one`select 1 from specialists where user_id = ${actor.id}`)) throw new HttpError(404, 'not_found', 'Вы не специалист');
        // Срок по заданию на оценку (2.317) — из файла задания в деле.
        const schedule = await expertSchedule(sql, actor.id, registry, undefined, { storage: providers.storage });
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
      // — `org_id`, чтобы открыть дело в «Делах экспертов». Без заказчика и данных заявки. Руководителю организации эксперта —
      // «Возвраты за год» (2.156) — `returns_year`: сколько раз его организация возвращала отчёты и частые пункты замечаний.
      id: 'specialists.card', method: 'GET', path: '/api/specialists/:id/card', auth: 'user',
      access: { resource: 'specialistCard', param: 'id', need: 'read' },
      async handler({ sql, actor, specialist, signOrg, registry, providers }) {
        const id = specialist.user_id;
        const profile = await profileView(sql, id, registry);
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
          select id, module, service, status, fields, deadline, to_char(deadline, 'YYYY-MM-DD') as deadline_day, updated_at from orders
          where executor_user_id = ${id} and status = any(${OPEN_STATUSES}::text[])
          order by deadline nulls last, updated_at desc`;
        const moves = await caseMoves(sql, active.filter((o) => o.status !== 'awaiting_executor'));
        const ext = await openExtends(sql, active.map((o) => o.id));
        // Срок по заданию на оценку раньше срока дела (2.324, как в «Моих сроках», 2.317) — день и чьё задание, без файла.
        const task = await taskDues(sql, providers.storage, registry,
          active.filter((o) => o.deadline_day).map((o) => ({ ...o, deadline: o.deadline_day })));
        // Перенос согласован позже срока по заданию на оценку, а письма о переносе нет (2.342, как в «Делах экспертов» 2.332) —
        // пометка у дела; срок по заданию тогда не повторяется отдельной строкой.
        const moved = new Map();
        for (const o of active.filter((x) => ['in_work', 'review'].includes(x.status) && x.deadline_day)) {
          const m = await taskMovedOrg(sql, providers.storage, registry, { ...o, deadline: o.deadline_day });
          if (m) moved.set(o.id, m);
        }
        const headOrg = signOrg && roleIn(actor, signOrg.id) === 'head' ? signOrg.id : null;
        return {
          specialist: profile,
          dossier,
          stats,
          quality: { score: quality.score, note: quality.note },
          year: await yearStats(sql, id, { registry }),
          now: {
            org_id: headOrg,
            cases: active.map((o) => ({
              order_ref: orderRef(o.id),
              service: registry.service(o.module, o.service)?.service.name ?? o.service,
              status: o.status,
              status_name: STATUS_NAME[o.status],
              deadline: o.deadline,
              overdue: isOverdue(o, today),
              // «Горит» — как в «Делах экспертов» (2.102): в работе или на проверке, срок прошёл или через 1–2 дня.
              // Срок по заданию на оценку близко (2.324) — тоже «горит».
              hot: o.status !== 'awaiting_executor' && ((!!o.deadline && o.deadline <= addDays(today, 2))
                || (!!task.get(o.id) && task.get(o.id).day <= addDays(today, 2))),
              task_due: task.get(o.id) ? { day: task.get(o.id).day, by: task.get(o.id).by, overdue: task.get(o.id).day < today } : null,
              task_moved: moved.get(o.id) ?? null,
              idle_days: moves.get(o.id)?.days ?? null,
              idle: !!moves.get(o.id)?.idle,
              extend: ext.get(o.id) ? { new_deadline: ext.get(o.id).new_deadline } : null,
            })),
          },
          returns_year: headOrg ? await orgReturnsYear(sql, headOrg, id, today) : null,
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
      async handler({ sql, registry }) {
        const ids = await sql`select user_id from specialists order by user_id`;
        const list = await Promise.all(ids.map((r) => profileView(sql, r.user_id, registry)));
        return { specialists: list.sort((a, b) => a.full_name.localeCompare(b.full_name)) };
      },
    },
    {
      // Сделать человека специалистом или поменять его профиль (район, нормальная нагрузка, выезды на объект — 2.4,
      // статус исполнителя — 2а.3: самозанятый, ИП, ООО/бюро или null).
      id: 'specialists.upsert', method: 'PUT', path: '/api/admin/specialists/:id', auth: 'user', access: { platform: 'admin' },
      async handler({ sql, actor, params, body, registry }) {
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
          const tax = body?.tax_status === undefined ? (cur?.tax_status ?? null) : taxStatusFrom(body.tax_status);
          // Без статуса допуск к переводам не держится (2а.3): снять статус можно, когда таких допусков нет.
          if (!tax && cur?.tax_status) {
            const held = await tx`select module, service from specialist_permits where user_id = ${userId}`;
            if (held.some((p) => registry.executorRules(p.module, p.service).tax_status)) {
              throw new HttpError(409, 'tax_status_needed', 'Сначала снимите допуски к услугам, где нужен статус исполнителя');
            }
          }
          await tx`
            insert into specialists (user_id, regions, capacity, external_load, onsite, tax_status)
            values (${userId}, ${regions}, ${capacity}, ${external}, ${onsite}, ${tax})
            on conflict (user_id) do update set regions = ${regions}, capacity = ${capacity}, external_load = ${external}, onsite = ${onsite},
              tax_status = ${tax}`;
          await audit(tx, actor, 'specialist.upsert', 'user', userId, { regions, capacity, external, onsite, tax_status: tax });
          return profileView(tx, userId, registry);
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
          const sp = await tx.one`select tax_status from specialists where user_id = ${userId}`;
          if (!sp) throw new HttpError(404, 'not_found', 'Специалист не найден');
          // Физлицо без статуса к переводам не допускается (2а.3): иначе платформа — налоговый агент.
          if (!sp.tax_status && registry.executorRules(def.module.id, def.service.id).tax_status) {
            throw new HttpError(409, 'tax_status_needed', 'Сначала укажите статус исполнителя: самозанятый, ИП или ООО/бюро. Физическое лицо без статуса не допускается');
          }
          await tx`
            insert into specialist_permits (user_id, module, service, valid_until, granted_by)
            values (${userId}, ${def.module.id}, ${def.service.id}, ${until}, ${actor.id})
            on conflict (user_id, module, service) do update set valid_until = ${until}, granted_by = ${actor.id}`;
          await audit(tx, actor, 'specialist.permit.add', 'user', userId, { module: def.module.id, service: def.service.id, until });
          return profileView(tx, userId, registry);
        });
        res.status(201);
        return { specialist: view };
      },
    },
    {
      id: 'specialists.permit.remove', method: 'DELETE', path: '/api/admin/specialists/:id/permits/:module/:service', auth: 'user', access: { platform: 'admin' },
      async handler({ sql, actor, params, registry }) {
        const userId = uuidFrom(params.id, 'Специалист не найден');
        const view = await sql.tx(async (tx) => {
          const gone = await tx`delete from specialist_permits where user_id = ${userId} and module = ${params.module} and service = ${params.service} returning 1`;
          if (!gone.length) throw new HttpError(404, 'not_found', 'Допуск не найден');
          await audit(tx, actor, 'specialist.permit.remove', 'user', userId, { module: params.module, service: params.service });
          return profileView(tx, userId, registry);
        });
        return { specialist: view };
      },
    },
    {
      // Копия документа о знании языка переводчика (2а.3) — администратору, чтобы проверить документ.
      id: 'specialists.language.file', method: 'GET', path: '/api/admin/specialists/:id/languages/:item/file', auth: 'user', access: { platform: 'admin' },
      async handler({ sql, params, providers }) {
        const row = await languageItem(sql, params);
        if (!row.file_key) throw new HttpError(404, 'not_found', 'Копия не загружена');
        return { url: await providers.storage.link(row.file_key, { filename: row.file_name }) };
      },
    },
    {
      // Отметить документ о знании языка проверенным (или снять отметку) — по копии (2а.3). К нотариальным переводам
      // подбор берёт только переводчиков с проверенным документом по языку заявки.
      id: 'specialists.language.verify', method: 'PUT', path: '/api/admin/specialists/:id/languages/:item', auth: 'user', access: { platform: 'admin' },
      async handler({ sql, actor, params, body, registry }) {
        if (typeof body?.verified !== 'boolean') throw new HttpError(400, 'bad_input', 'Поле «Проверен»: да или нет');
        const view = await sql.tx(async (tx) => {
          const row = await languageItem(tx, params, { lock: true });
          if (body.verified && !row.file_key) throw new HttpError(409, 'no_copy', 'Проверить можно только по копии: переводчик ещё не загрузил её');
          await tx`update dossier_items set verified_at = ${body.verified ? new Date() : null}, verified_by = ${body.verified ? actor.id : null}
                   where id = ${row.id}`;
          await audit(tx, actor, 'specialist.language.verify', 'user', row.user_id, { item: String(row.id), language: row.language, verified: body.verified });
          return profileView(tx, row.user_id, registry);
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
