// Сводка руководителю за месяц по экспертам (2.78): сколько дел каждый принял, сдал (готово), из них позже срока, сколько
// раз возвращали (руководитель — до подписи организации, диспетчер — на доработку), вознаграждение за сданные и выплачено.
// Считается только то, что было с тех пор, как эксперт состоит в организации, — прошлые частные дела руководитель не видит.
// Частые пункты замечаний (2.105): пункты возвратов руководителя (2.93) за месяц — одинаковые без учёта регистра, пробелов и
// точки в конце считаются одним пунктом; по организации и по каждому эксперту.
// Скорость и сроки (2.117): сколько дней в среднем от принятия дела экспертом (принял предложение или руководитель передал
// ему дело) до сдачи и сколько дел сдано позже первоначального срока — из них сколько с одобренным переносом срока.
// Сравнение с прошлым месяцем (2.124): у каждого эксперта и в итоге — сколько сдано, из них в срок и сколько раз возвращали
// (руководитель и диспетчер вместе) в прошлом месяце; если прошлый месяц раньше создания организации — сравнения нет.
// По услугам (2.135): сколько сдано по каждой услуге за месяц, из них позже срока, вознаграждение и у скольких экспертов; у
// каждого эксперта — его сданные по услугам. Название услуги — из описания модуля. Средний срок по услуге (2.144) — дни от
// принятия до сдачи, как в общей скорости 2.117 и в карточке эксперта 2.139.
// От возврата до новой подписи (2.168): по возвратам руководителя за месяц — сколько дней (до десятых, по часам) в среднем
// прошло до следующей подписи эксперта по тому же делу; ещё не подписанные заново — отдельным числом, в среднее не входят.
// В первоначальный срок, без переносов (2.188): сдано не позже срока, на который дело принимали, и ни одного одобренного
// переноса; дела без срока сюда не входят.
// Подписано без ИИ-проверки (2.199): сколько файлов эксперт подписал за месяц и сколько из них — без ИИ-проверки этой версии
// (до подписи ни одна ИИ-проверка по делу не включала этот файл; новый файл — новая версия, как в подсказке 2.136). Файл,
// подписанный за месяц несколько раз (после возврата), — один, по последней подписи. Подсказка, не оценка эксперта.
// Расхождения с выпиской ЕГРН при первой подписи (2.265): по делам, которые эксперт впервые подписал в этом месяце, — сколько
// находок, сверенных с выпиской ЕГРН из дела (пункты «посмотрите» с `egrn`, 2.225), было в последней ИИ-проверке этого файла
// до первой подписи; в скольких делах они были; первая подпись без ИИ-проверки файла — отдельно, в число не входит. Частые
// пункты проверки с такими находками — по названию правила. Подсказка, не оценка эксперта.
// Задание на оценку от банка (2.309): просьбы «Задание на оценку от банка» (2.299), которые эксперт отправил заказчику за
// месяц, — сколько, сколько пришло и через сколько дней в среднем (до десятых, по часам), сколько ещё ждут; снятые — не в счёт.
// Месяц — по московскому времени. Сводка за год (2.408) — то же за весь год, с прошлым годом и сданными по месяцам.
// Выгрузка таблицей — CSV для Excel (точка с запятой, BOM, суммы с запятой).
import { HttpError } from '../http/core.mjs';
import { orderSplit } from '../money/money.mjs';
import { addDays, isOverdue, todayMsk } from '../orders/workflow.mjs';

export const REPORT_MONTHS_BACK = 12;
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
export const monthRu = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

// Месяцы, за которые можно взять сводку: текущий и 12 прошлых, новые — первыми.
export function reportMonths(today = todayMsk()) {
  let y = Number(today.slice(0, 4));
  let m = Number(today.slice(5, 7));
  const out = [];
  for (let i = 0; i <= REPORT_MONTHS_BACK; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (--m === 0) { m = 12; y--; }
  }
  return out;
}

export function reportMonth(value, today = todayMsk()) {
  const month = value == null || value === '' ? today.slice(0, 7) : String(value);
  if (!reportMonths(today).includes(month)) {
    throw new HttpError(400, 'bad_month', `Сводка — за текущий месяц и ${REPORT_MONTHS_BACK} прошлых (ГГГГ-ММ)`);
  }
  return month;
}

// Сводка за год (2.408): годы, за которые можно взять сводку руководителя, — текущий и прошлый, новые — первыми.
export const REPORT_YEARS_BACK = 1;
export const isYear = (p) => /^\d{4}$/.test(String(p));
export const periodRu = (p) => (isYear(p) ? `${p} год` : monthRu(p));
export function reportYears(today = todayMsk()) {
  const y = Number(today.slice(0, 4));
  return Array.from({ length: REPORT_YEARS_BACK + 1 }, (_, i) => String(y - i));
}
// Период сводки руководителя: ?year=ГГГГ — год, иначе ?month=ГГГГ-ММ (как в 2.78).
export function reportPeriod(query = {}, today = todayMsk()) {
  if (query.year == null || query.year === '') return reportMonth(query.month, today);
  const year = String(query.year);
  if (!reportYears(today).includes(year)) throw new HttpError(400, 'bad_year', 'Сводка за год — за текущий и прошлый год (ГГГГ)');
  return year;
}

export const TOP_REMARKS = 5;
export const TOP_REMARKS_EXPERT = 3;
const remarkKey = (t) => t.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').replace(/[\s.,;:!]+$/, '').trim();

// Самые частые пункты: [{ text, n, experts }] — по убыванию числа, при равенстве — что встречалось позже. Текст — как
// написан в последний раз.
export function topRemarks(items, limit) {
  const groups = new Map();
  for (const it of [...items].sort((a, b) => new Date(b.at) - new Date(a.at))) {
    const key = remarkKey(it.text);
    if (!key) continue;
    const g = groups.get(key) ?? groups.set(key, { text: it.text.trim(), n: 0, experts: new Set(), last: new Date(it.at) }).get(key);
    g.n++;
    g.experts.add(it.user_id);
  }
  return [...groups.values()].sort((a, b) => b.n - a.n || b.last - a.last).slice(0, limit)
    .map((g) => ({ text: g.text, n: g.n, experts: g.experts.size }));
}

// Возвраты за год (2.156) — руководителю в карточке эксперта: сколько раз организация возвращала отчёты этому эксперту за
// последние 365 дней по Москве (с `since` по сегодня), по скольким делам, когда в последний раз и самые частые пункты замечаний
// (как в сводке за месяц, 2.105). Только возвраты этой организации; без заказчиков, названий и полей заявки.
// От возврата до новой подписи эксперта за тот же год (2.176) — `resign_days`, `resign_n`, `resign_wait`, как в сводке (2.168).
export async function orgReturnsYear(sql, orgId, userId, today = todayMsk()) {
  const since = addDays(today, -364);
  const rows = await sql`
    select r.id, r.order_id, r.created_at as at, i.text from org_returns r
    left join org_return_items i on i.return_id = r.id
    where r.org_id = ${orgId} and r.executor_user_id = ${userId}
      and r.created_at >= (${since}::date::timestamp at time zone 'Europe/Moscow')
    order by r.created_at desc, r.id desc, i.n`;
  return {
    since,
    n: new Set(rows.map((r) => String(r.id))).size,
    cases: new Set(rows.map((r) => r.order_id)).size,
    last_day: rows.length ? todayMsk(new Date(rows[0].at)) : null,
    top_remarks: topRemarks(rows.filter((r) => r.text).map((r) => ({ user_id: userId, text: r.text, at: r.at })), TOP_REMARKS)
      .map(({ text, n }) => ({ text, n })),
    ...resign(await resignQ(sql, orgId, [userId], { start: new Date(`${since}T00:00:00+03:00`), end: new Date(Date.now() + 86_400_000) })),
  };
}

const dayMsk = (t) => todayMsk(new Date(t));
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

// Скорость и сроки по сданным делам (2.117): средние дни от принятия до сдачи (до десятых; дела без отметки о принятии —
// не в среднем) и сдано позже первоначального срока — всего и из них с одобренным переносом; в первоначальный срок без
// переносов (2.188).
function pace(done) {
  const days = done.filter((o) => o.taken_at).map((o) => Math.max(0, daysBetween(dayMsk(o.taken_at), dayMsk(o.at))));
  const firstLate = done.filter((o) => {
    const first = o.moved_from ?? o.deadline;
    return first && dayMsk(o.at) > first;
  });
  return {
    days_sum: days.reduce((s, d) => s + d, 0),
    days_n: days.length,
    late_first: firstLate.length,
    late_first_moved: firstLate.filter((o) => o.moved_from).length,
    first_kept: done.filter((o) => o.deadline && !o.moved_from && dayMsk(o.at) <= o.deadline).length,
  };
}
const avgDays = (p) => (p.days_n ? Math.round((p.days_sum / p.days_n) * 10) / 10 : null);

const feeOf = (o) => (o.payout_kop != null ? Number(o.payout_kop) : o.price_kop ? orderSplit(o).payoutKop : 0);

// Границы месяца по Москве: [начало, начало следующего); период «ГГГГ» — весь год (2.408).
async function monthBounds(sql, month) {
  const first = isYear(month) ? `${month}-01-01` : `${month}-01`;
  const step = isYear(month) ? '1 year' : '1 month';
  const [{ start, end }] = await sql`
    select (${first}::date::timestamp at time zone 'Europe/Moscow') as start,
           ((${first}::date + ${step}::interval)::timestamp at time zone 'Europe/Moscow') as "end"`;
  return { start, end };
}

// Сданные за месяц (дело впервые перешло в «готово» в этом месяце) экспертами организации — с тех пор, как они в ней. Снова
// «готово» после замечаний к отчёту или переделки — не новое сданное дело (прогон 2.440, условие h0).
// Та же выборка — в сводке (2.78) и в архиве заключений за месяц (2.89).
async function orgMonthDone(sql, orgId, ids, { start, end }) {
  if (!ids.length) return [];
  return sql`
      select distinct on (o.id) o.id, o.module, o.service, o.executor_user_id as user_id, o.deadline, o.price_kop, o.transit_kop,
             o.fields->>'purpose' as purpose,
             p.amount_kop as payout_kop, h.at,
             greatest(
               (select max(f.outcome_at) from order_offers f
                where f.order_id = o.id and f.specialist_id = o.executor_user_id and f.outcome = 'accepted'),
               (select max(a.at) from audit_log a
                where a.subject_type = 'order' and a.subject_id = o.id::text and a.action = 'org.case.transfer'
                  and a.details->>'to' = o.executor_user_id::text)) as taken_at,
             (select to_char(d.old_deadline, 'YYYY-MM-DD') from deadline_requests d
              where d.order_id = o.id and d.outcome = 'approved' order by d.decided_at, d.id limit 1) as moved_from,
             (select count(*)::int from deadline_requests d
              where d.order_id = o.id and d.outcome = 'approved' and d.org_id is null) as ext_n,
             g.org_signed_at,
             (select max(a.at) from audit_log a
              where a.action = 'document.sign' and a.actor_id = o.executor_user_id and a.details->>'order_id' = o.id::text
                and a.at <= g.org_signed_at) as expert_signed_at
      from order_status_history h join orders o on o.id = h.order_id
      join org_members m on m.org_id = ${orgId} and m.user_id = o.executor_user_id
      left join payouts p on p.order_id = o.id
      cross join lateral (select min(a.at) as org_signed_at from audit_log a
                          where a.action = 'document.sign_org' and a.details->>'order_id' = o.id::text
                            and a.details->>'org_id' = ${orgId}::text) g
      where o.executor_user_id = any(${ids}::uuid[]) and h.to_status = 'done'
        and h.at >= ${start} and h.at < ${end} and h.at >= m.created_at
        and not exists (select 1 from order_status_history h0 where h0.order_id = o.id and h0.to_status = 'done' and h0.at < h.at)
      order by o.id, h.at`;
}

// Возвраты за месяц: руководителем (до подписи организации) и диспетчером (на доработку) — по эксперту.
const headReturnsQ = (sql, orgId, ids, { start, end }) => sql`
  select executor_user_id as user_id, count(*)::int as n from org_returns
  where org_id = ${orgId} and executor_user_id = any(${ids}::uuid[]) and created_at >= ${start} and created_at < ${end}
  group by executor_user_id`;
const dispReturnsQ = (sql, orgId, ids, { start, end }) => sql`
  select o.executor_user_id as user_id, count(*)::int as n
  from order_status_history h join orders o on o.id = h.order_id
  join org_members m on m.org_id = ${orgId} and m.user_id = o.executor_user_id
  where o.executor_user_id = any(${ids}::uuid[]) and h.from_status = 'review' and h.to_status = 'in_work'
    and h.at >= ${start} and h.at < ${end} and h.at >= m.created_at
  group by o.executor_user_id`;
// Причины возвратов диспетчера за месяц (2.376): текст из шага «Вернуть на доработку», по эксперту и делу.
const dispReasonsQ = (sql, orgId, ids, { start, end }) => sql`
  select o.executor_user_id as user_id, h.order_id, h.reason as text, h.at
  from order_status_history h join orders o on o.id = h.order_id
  join org_members m on m.org_id = ${orgId} and m.user_id = o.executor_user_id
  where o.executor_user_id = any(${ids}::uuid[]) and h.from_status = 'review' and h.to_status = 'in_work'
    and h.at >= ${start} and h.at < ${end} and h.at >= m.created_at
  order by h.at desc, h.id desc`;
const casesOf = (rows) => new Set(rows.map((r) => r.order_id)).size;

// Возвраты руководителя за месяц и первая подпись эксперта по тому же делу после каждого (2.168): из журнала, потому что
// строку подписи следующий возврат снимает.
const resignQ = (sql, orgId, ids, { start, end }) => sql`
  select r.executor_user_id as user_id, r.created_at as returned_at,
         (select min(a.at) from audit_log a
          where a.action = 'document.sign' and a.actor_id = r.executor_user_id and a.details->>'order_id' = r.order_id::text
            and a.at > r.created_at) as signed_at
  from org_returns r
  where r.org_id = ${orgId} and r.executor_user_id = any(${ids}::uuid[]) and r.created_at >= ${start} and r.created_at < ${end}`;

// Подписанные экспертами за месяц файлы, без ИИ-проверки этой версии (2.199) и не отметив все пункты замечания (2.217):
// [{ user_id, signed, signed_no_ai, signed_points_left }]. Пункты — по последнему возврату руководителя по делу до подписи;
// пункт не отмечен, если на момент подписи он ещё не был отмечен исправленным.
const signedQ = (sql, orgId, ids, { start, end }) => sql`
  select x.user_id, count(*)::int as signed,
         count(*) filter (where not exists (
           select 1 from ai_reviews r where r.order_id = x.order_id and r.at <= x.at
             and r.files @> jsonb_build_array(jsonb_build_object('id', x.doc))))::int as signed_no_ai,
         count(*) filter (where exists (
           select 1 from org_return_items i
           where i.return_id = (select r.id from org_returns r where r.order_id = x.order_id and r.org_id = ${orgId}
                                  and r.created_at < x.at order by r.created_at desc, r.id desc limit 1)
             and (i.fixed_at is null or i.fixed_at > x.at)))::int as signed_points_left
  from (select a.actor_id as user_id, a.subject_id as doc, (a.details->>'order_id')::uuid as order_id, max(a.at) as at
        from audit_log a join org_members m on m.org_id = ${orgId} and m.user_id = a.actor_id
        where a.action = 'document.sign' and a.actor_id = any(${ids}::uuid[]) and a.at >= ${start} and a.at < ${end}
          and a.at >= m.created_at
        group by 1, 2, 3) x
  group by x.user_id`;

// Первая подпись эксперта по делу (за всё время) — в этом месяце, с последней ИИ-проверкой подписанного файла до неё (2.265);
// 2.289 — и сколько расхождений он до неё заменил в черновике кнопкой (по выписке и по заданию; отменённые не в счёт).
const firstSignQ = (sql, orgId, ids, { start, end }) => sql`
  select x.user_id, x.order_id, x.doc, o.module, o.service, o.fields, r.items, r.files, s.swap_egrn, s.swap_task
  from (select distinct on (a.actor_id, a.details->>'order_id') a.actor_id as user_id, (a.details->>'order_id')::uuid as order_id,
               a.subject_id as doc, a.at
        from audit_log a
        where a.action = 'document.sign' and a.actor_id = any(${ids}::uuid[])
        order by a.actor_id, a.details->>'order_id', a.at) x
  join org_members m on m.org_id = ${orgId} and m.user_id = x.user_id
  join orders o on o.id = x.order_id
  left join lateral (select r.items, r.files from ai_reviews r
                     where r.order_id = x.order_id and r.at <= x.at and r.files @> jsonb_build_array(jsonb_build_object('id', x.doc))
                     order by r.id desc limit 1) r on true
  cross join lateral (select greatest(coalesce(sum(d.n) filter (where d.kind = 'egrn'), 0), 0)::int as swap_egrn,
                             greatest(coalesce(sum(d.n) filter (where d.kind = 'task'), 0), 0)::int as swap_task
                      from (select a.details->'swap'->>'kind' as kind,
                                   (a.details->'swap'->>'n')::int * (case when (a.details->'swap'->>'undo')::boolean then -1 else 1 end) as n
                            from audit_log a
                            where a.action = 'draft.save' and a.subject_type = 'order' and a.subject_id = x.order_id::text
                              and a.actor_id = x.user_id and a.at < x.at and a.details ? 'swap') d) s
  where x.at >= ${start} and x.at < ${end} and x.at >= m.created_at`;

// Просьбы о задании на оценку от банка за месяц (2.309) — по эксперту, который просил. Пункты — как `TASK_ITEMS` в
// `ai-ops.mjs` (оттуда не берём: операции загружают этот файл).
// 2.358: то же для просьб письма о переносе срока с новым сроком (пункт `task_move`, 2.326) — `TASK_MOVE` в `ai-ops.mjs`.
const TASK_ITEMS = ['bank_task'];
const LETTER_ITEMS = ['task_move'];
const bankTaskQ = (sql, orgId, ids, { start, end }, items = TASK_ITEMS) => sql`
  select r.requested_by as user_id, r.order_id, r.requested_at, r.fulfilled_at from doc_requests r
  join org_members m on m.org_id = ${orgId} and m.user_id = r.requested_by
  where r.requested_by = any(${ids}::uuid[]) and r.item_id = any(${items}::text[]) and r.cancelled_at is null
    and r.requested_at >= ${start} and r.requested_at < ${end} and r.requested_at >= m.created_at`;

// { bank_task, bank_task_cases, bank_task_got, bank_task_days, bank_task_wait }: среднее — по пришедшим. 2.358: с `k` =
// 'letter_ask' — просьбы письма с новым сроком, и ещё `letter_ask_max` — дольше всего ждали письмо (дней).
function bankTask(rows, k = 'bank_task') {
  const got = rows.filter((r) => r.fulfilled_at);
  const days = got.map((r) => (Date.parse(r.fulfilled_at) - Date.parse(r.requested_at)) / 86_400_000);
  const round = (d) => Math.round(d * 10) / 10;
  return {
    [k]: rows.length,
    [`${k}_cases`]: new Set(rows.map((r) => r.order_id)).size,
    [`${k}_got`]: got.length,
    [`${k}_days`]: days.length ? round(days.reduce((s, d) => s + d, 0) / days.length) : null,
    [`${k}_wait`]: rows.length - got.length,
    ...(k === 'bank_task' ? {} : { [`${k}_max`]: days.length ? round(Math.max(...days)) : null }),
  };
}
const letterAsk = (rows) => bankTask(rows, 'letter_ask');

// 2.323: сданные за месяц дела с сроком по заданию на оценку (2.303) и из них сданные позже него — на сколько дней (в
// среднем и больше всего). Срок задания читает операция (`taskDue`: дело → день или null) — этот файл операции загружают.
// 2.346: срок взят из письма о переносе срока (2.333) — операция отдаёт `{ day, letter: true }`: такие дела считаются
// отдельно (`letter`), не в «позже срока по заданию».
async function taskDueRows(done, taskDue) {
  if (!taskDue) return [];
  const out = [];
  for (const o of done) {
    const got = await taskDue(o);
    const due = typeof got === 'object' && got ? got.day : got;
    if (due) out.push({ user_id: o.user_id, late: Math.max(0, daysBetween(due, dayMsk(o.at))), letter: !!got?.letter });
  }
  return out;
}
// 2.329: сданные за месяц дела для банка (цель оценки «банк») и из них те, где задание на оценку пришло уже после черновика
// (черновик пришлось сверять заново, 2.295). Пришло ли позже — решает операция (`taskAfter`: дело → true/false), она читает
// файлы задания; этот файл операции загружают.
async function bankAfterRows(done, taskAfter) {
  const out = [];
  for (const o of done.filter((x) => x.purpose === 'bank')) out.push({ user_id: o.user_id, after: taskAfter ? !!(await taskAfter(o)) : false });
  return out;
}
// { bank_cases, bank_after, bank_after_pct }: доля — целыми процентами.
function bankAfter(rows) {
  const after = rows.filter((r) => r.after).length;
  return { bank_cases: rows.length, bank_after: after, bank_after_pct: rows.length ? Math.round((after / rows.length) * 100) : null };
}

// 2.336: сданные за месяц дела, где срок переносили по просьбе эксперта (согласованные просьбы; от организации, 2.221, — не в
// счёт), и из них те, где согласованный срок позже срока по заданию на оценку (банк ждёт отчёт раньше — нужно письмо о
// переносе, 2.326), и в скольких письмо с согласованным сроком пришло. Это решает операция (`taskMove`: дело →
// { need, letter }), она читает файлы задания; этот файл операции загружают.
async function extRows(done, taskMove) {
  const out = [];
  for (const o of done.filter((x) => x.ext_n > 0)) {
    const m = taskMove ? await taskMove(o) : null;
    out.push({ user_id: o.user_id, n: o.ext_n, need: !!m?.need, letter: !!(m?.need && m.letter) });
  }
  return out;
}
// { ext_cases, ext_times, ext_need, ext_letter }
function ext(rows) {
  return {
    ext_cases: rows.length,
    ext_times: rows.reduce((s, r) => s + r.n, 0),
    ext_need: rows.filter((r) => r.need).length,
    ext_letter: rows.filter((r) => r.letter).length,
  };
}

// { task_due_cases, task_late, task_late_days, task_late_max } — по сроку из задания; 2.346: { letter_cases, letter_late,
// letter_late_days, letter_late_max } — по сроку из письма о переносе.
function lateOf(rows, k, cases) {
  const late = rows.filter((r) => r.late > 0).map((r) => r.late);
  return {
    [cases]: rows.length,
    [k]: late.length,
    [`${k}_days`]: late.length ? Math.round((late.reduce((s, d) => s + d, 0) / late.length) * 10) / 10 : null,
    [`${k}_max`]: late.length ? Math.max(...late) : null,
  };
}
// 2.366: от принятия дела до первой подписи организации по сданным за месяц делам — { org_sign_cases, org_sign_days,
// org_sign_max } (дни по Москве, как «от принятия до сдачи»; дела без отметки о принятии или без подписи организации — не в
// счёт) и сколько файл ждал подписи организации после последней подписи эксперта — org_sign_wait (до десятых, по часам).
function orgSign(done) {
  const rows = done.filter((o) => o.taken_at && o.org_signed_at);
  const days = rows.map((o) => Math.max(0, daysBetween(dayMsk(o.taken_at), dayMsk(o.org_signed_at))));
  const waits = rows.filter((o) => o.expert_signed_at)
    .map((o) => Math.max(0, (Date.parse(o.org_signed_at) - Date.parse(o.expert_signed_at)) / 86_400_000));
  const avg = (a) => (a.length ? Math.round((a.reduce((s, d) => s + d, 0) / a.length) * 10) / 10 : null);
  return {
    org_sign_cases: rows.length,
    org_sign_days: avg(days),
    org_sign_max: days.length ? Math.max(...days) : null,
    org_sign_wait: avg(waits),
  };
}

function taskLate(rows) {
  return { ...lateOf(rows.filter((r) => !r.letter), 'task_late', 'task_due_cases'), ...lateOf(rows.filter((r) => r.letter), 'letter_late', 'letter_cases') };
}

export const TOP_EGRN_RULES = 3;
// { first_signed, first_no_ai, egrn_first, egrn_first_cases, egrn_rules: [{ title, n }],
//   order_first, order_first_cases, order_first_app, order_first_task, order_rules,
//   order_task_kinds: [{ kind, title, n }], order_task_<вид>, swap_first, swap_first_cases, swap_first_egrn, swap_first_task }
//   — по строкам firstSignQ.
// 2.289: swap_* — заменено кнопкой в черновике до первой подписи (по всем впервые подписанным делам, с ИИ-проверкой и без).
// 2.275: order_* — находки, сверенные с заявкой или заданием на оценку (fix.from, без выписки, как fixShort); app — «в заявке».
const ruleTitle = (registry, x, id) => {
  let title = id;
  try { title = registry?.checks(x.module, x.service, x.fields).find((c) => c.id === id)?.title ?? id; } catch { /* услуга убрана */ }
  return title.split(':')[0].trim();
};
// 2.297: расхождения с заданием на оценку по видам — что чаще. Вид — по пункту проверки, а в «цель и вид стоимости» — по
// началу текста находки (старые проверки — тоже по тексту).
// 2.314: ещё пользователь результатов оценки (bank_user по заданию) и срок отчёта (report_dates «позже срока из …», 2.302) —
// по тексту находки (в ИИ-проверке находки лежат у пункта модуля, а не у правила). У срока замены нет (fix), но он тоже
// расхождение с заданием: в order_first и order_first_task.
export const TASK_KINDS = [['address', 'адрес'], ['date', 'дата оценки'], ['value_kind', 'вид стоимости'], ['purpose', 'цель оценки'],
  ['customer', 'заказчик'], ['user', 'пользователь результатов'], ['due', 'срок отчёта']];
const TASK_RULE_KIND = { address_match: 'address', value_date: 'date', customer_match: 'customer', bank_user: 'user' };
const DUE_TEXT = /^Дата составления отчёта .* позже срока из /u;
export function taskKindOf(id, f) {
  if (TASK_RULE_KIND[id]) return TASK_RULE_KIND[id];
  const t = String(f.text ?? '');
  return /^Дата оценки/u.test(t) ? 'date' : /^Вид стоимости/u.test(t) ? 'value_kind' : /^Цель оценки/u.test(t) ? 'purpose'
    : /^Заказчик/u.test(t) ? 'customer' : /^Адрес/u.test(t) ? 'address' : /^Предполагаемый пользователь/u.test(t) ? 'user' : null;
}
const taskKinds = (counts) => TASK_KINDS.filter(([k]) => counts[k]).map(([kind, title]) => ({ kind, title, n: counts[kind] }))
  .sort((a, b) => b.n - a.n);
const topRules = (rules) => [...rules].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru')).slice(0, TOP_EGRN_RULES)
  .map(([title, n]) => ({ title, n }));
function egrnFirst(rows, registry) {
  const rules = new Map();
  const orderRules = new Map();
  let found = 0;
  let cases = 0;
  const order = { n: 0, cases: 0, app: 0, task: 0 };
  const swap = { cases: 0, egrn: 0, task: 0 };
  const kinds = Object.fromEntries(TASK_KINDS.map(([k]) => [k, 0]));
  for (const x of rows) {
    swap.egrn += x.swap_egrn ?? 0;
    swap.task += x.swap_task ?? 0;
    if ((x.swap_egrn ?? 0) + (x.swap_task ?? 0)) swap.cases++;
    if (!x.items) continue;
    const file = (x.files ?? []).find((f) => f.id === x.doc)?.name;
    const mine = (f) => !file || f.file === file;
    let n = 0;
    let m = 0;
    for (const i of x.items) {
      if (i.hint !== 'attention') continue;
      const k = (i.found ?? []).filter((f) => f.egrn && mine(f)).length;
      if (k) {
        n += k;
        const title = ruleTitle(registry, x, i.id);
        rules.set(title, (rules.get(title) ?? 0) + k);
      }
      const due = (i.found ?? []).filter((f) => !f.fix && DUE_TEXT.test(String(f.text ?? '')) && mine(f)).length;
      kinds.due += due;
      order.task += due;
      const fixes = (i.found ?? []).filter((f) => !f.egrn && f.fix?.from && mine(f));
      m += due;
      if (fixes.length + due) {
        m += fixes.length;
        for (const f of fixes) {
          const app = String(f.fix.from).startsWith('в заявке');
          order[app ? 'app' : 'task']++;
          const kind = !app && taskKindOf(i.id, f);
          if (kind) kinds[kind]++;
        }
        const title = ruleTitle(registry, x, i.id);
        orderRules.set(title, (orderRules.get(title) ?? 0) + fixes.length + due);
      }
    }
    found += n;
    if (n) cases++;
    order.n += m;
    if (m) order.cases++;
  }
  return {
    first_signed: rows.length,
    first_no_ai: rows.filter((x) => !x.items).length,
    egrn_first: found,
    egrn_first_cases: cases,
    egrn_rules: topRules(rules),
    order_first: order.n,
    order_first_cases: order.cases,
    order_first_app: order.app,
    order_first_task: order.task,
    order_rules: topRules(orderRules),
    order_task_kinds: taskKinds(kinds),
    ...Object.fromEntries(TASK_KINDS.map(([k]) => [`order_task_${k}`, kinds[k]])),
    swap_first: swap.egrn + swap.task,
    swap_first_cases: swap.cases,
    swap_first_egrn: swap.egrn,
    swap_first_task: swap.task,
  };
}

// { resign_days, resign_n, resign_wait }: среднее (до десятых) по подписанным заново и сколько ещё ждут новой подписи.
function resign(rows) {
  const signed = rows.filter((r) => r.signed_at);
  const days = signed.map((r) => (Date.parse(r.signed_at) - Date.parse(r.returned_at)) / 86_400_000);
  return {
    resign_days: days.length ? Math.round((days.reduce((s, d) => s + d, 0) / days.length) * 10) / 10 : null,
    resign_n: signed.length,
    resign_wait: rows.length - signed.length,
  };
}

export const prevMonth = (month) => {
  if (isYear(month)) return String(Number(month) - 1);
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

// Прошлый месяц для сравнения (2.124): { experts: Map(user_id → { done, on_time, returned }), total }.
async function monthCompare(sql, orgId, ids, month) {
  const bounds = await monthBounds(sql, month);
  const [done, head, disp] = ids.length
    ? [await orgMonthDone(sql, orgId, ids, bounds), await headReturnsQ(sql, orgId, ids, bounds), await dispReturnsQ(sql, orgId, ids, bounds)]
    : [[], [], []];
  const n = (rows, u) => rows.find((r) => r.user_id === u)?.n ?? 0;
  const of = (rows, retHead, retDisp) => ({
    done: rows.length,
    on_time: rows.filter((o) => !(o.deadline && dayMsk(o.at) > o.deadline)).length,
    returned: retHead + retDisp,
  });
  const sum = (rows) => rows.reduce((s, r) => s + r.n, 0);
  return {
    experts: new Map(ids.map((u) => [u, of(done.filter((o) => o.user_id === u), n(head, u), n(disp, u))])),
    total: of(done, sum(head), sum(disp)),
  };
}

// Эксперты, которые сейчас работают от организации (выбрана в профиле специалиста и состоят в ней).
async function orgExperts(sql, orgId) {
  return sql`
    select s.user_id, m.created_at as joined_at, u.full_name from specialists s
    join org_members m on m.org_id = s.org_id and m.user_id = s.user_id join users u on u.id = s.user_id
    where s.org_id = ${orgId} order by u.full_name nulls last, s.user_id`;
}

// Дела, сданные экспертами организации за месяц (2.89), — по времени сдачи; с именем эксперта.
export async function orgMonthDoneCases(sql, orgId, month) {
  const experts = await orgExperts(sql, orgId);
  const names = new Map(experts.map((e) => [e.user_id, e.full_name || 'Без имени']));
  const rows = await orgMonthDone(sql, orgId, experts.map((e) => e.user_id), await monthBounds(sql, month));
  return rows.map((o) => ({ ...o, expert_name: names.get(o.user_id) })).sort((a, b) => new Date(a.at) - new Date(b.at));
}

// Замечания к сданному отчёту за месяц (2.437): шаг заказчика «Пришли замечания к отчёту» (`done → in_work`, 2.431) — по
// эксперту дела; круг — какой раз по делу пришли замечания (к нему — пункты `remark_items`). У «Переводов» тот же шаг —
// бесплатная переделка, поэтому только модули с замечаниями в описании.
const afterRemarksQ = (sql, orgId, ids, { start, end }) => sql`
  select o.executor_user_id as user_id, x.order_id, x.at, x.round, o.module, o.fields->>'purpose' as purpose,
         o.fields->>'bank' as bank
  from (select h.order_id, h.at, row_number() over (partition by h.order_id order by h.id)::int as round
        from order_status_history h where h.from_status = 'done' and h.to_status = 'in_work' and h.side = 'customer') x
  join orders o on o.id = x.order_id
  join org_members m on m.org_id = ${orgId} and m.user_id = o.executor_user_id
  where o.executor_user_id = any(${ids}::uuid[]) and x.at >= ${start} and x.at < ${end} and x.at >= m.created_at
  order by x.at desc`;
const remarkItemsQ = (sql, orderIds) => (orderIds.length ? sql`
  select order_id, round, body as text, created_at as at from remark_items where order_id = any(${orderIds}::uuid[])
  order by created_at desc, pos` : []);

// Пользователь отчёта по заявке: суд, Сбербанк, другой банк, остальные (нотариус, сделка и т. п.).
export const REPORT_USERS = [['court', 'Суд'], ['sber', 'Сбербанк'], ['bank', 'Другие банки'], ['other', 'Остальные']];
export const reportUserOf = (r) => (r.purpose === 'court' ? 'court' : r.purpose === 'bank' ? (r.bank === 'sber' ? 'sber' : 'bank') : 'other');

// { remarks_after, remarks_after_cases, remarks_after_items }: сколько раз приходили замечания, по скольким делам, пунктов.
function afterRemarks(rows, items) {
  return { remarks_after: rows.length, remarks_after_cases: casesOf(rows), remarks_after_items: items.length };
}
// По пользователям отчёта: [{ id, name, n, cases, items, top }] — только где были замечания, в порядке REPORT_USERS.
function afterByUser(rows, items) {
  return REPORT_USERS.map(([id, name]) => {
    const own = rows.filter((r) => reportUserOf(r) === id);
    const its = items.filter((i) => own.some((r) => r.order_id === i.order_id && r.round === i.round));
    return { id, name, n: own.length, cases: casesOf(own), items: its.length,
      top: topRemarks(its, TOP_REMARKS_EXPERT).map(({ text, n }) => ({ text, n })) };
  }).filter((g) => g.n);
}

// Сданные по услугам (2.135): [{ module, service, name, done, done_late, fee_kop, experts, avg_days }] — по убыванию числа,
// при равенстве — по названию; avg_days (2.144) — null, если ни у одного дела нет отметки о принятии.
function byService(done, registry) {
  const groups = new Map();
  for (const o of done) {
    const key = `${o.module}/${o.service}`;
    const g = groups.get(key) ?? groups.set(key, {
      module: o.module, service: o.service, name: registry?.service(o.module, o.service)?.service.name ?? o.service,
      done: 0, done_late: 0, fee_kop: 0, users: new Set(), cases: [],
    }).get(key);
    g.done++;
    g.cases.push(o);
    if (o.deadline && dayMsk(o.at) > o.deadline) g.done_late++;
    g.fee_kop += feeOf(o);
    g.users.add(o.user_id);
  }
  return [...groups.values()].sort((a, b) => b.done - a.done || a.name.localeCompare(b.name, 'ru'))
    .map(({ users, cases, ...g }) => ({ ...g, experts: users.size, avg_days: avgDays(pace(cases)) }));
}

export async function orgMonthReport(sql, orgId, month, { today = todayMsk(), registry = null, taskDue = null, taskAfter = null, taskMove = null } = {}) {
  const year = isYear(month);
  const current = month === today.slice(0, year ? 4 : 7);
  const experts = await orgExperts(sql, orgId);
  const ids = experts.map((e) => e.user_id);
  const { start, end } = await monthBounds(sql, month);
  const since = (await sql`select to_char(created_at at time zone 'Europe/Moscow', 'YYYY-MM') as m from organizations
                           where id = ${orgId}`)[0]?.m ?? '';
  const none = { accepted: [], done: [], headReturns: [], resign: [], signed: [], firstSign: [], remarkItems: [], dispReturns: [], dispReasons: [], paid: [], active: [],
    bankTask: [], letterAsk: [], afterRemarks: [] };
  const q = !ids.length ? none : {
    accepted: await sql`
      select f.specialist_id as user_id, count(distinct f.order_id)::int as n from order_offers f
      join org_members m on m.org_id = ${orgId} and m.user_id = f.specialist_id
      where f.specialist_id = any(${ids}::uuid[]) and f.outcome = 'accepted'
        and f.outcome_at >= ${start} and f.outcome_at < ${end} and f.outcome_at >= m.created_at
      group by f.specialist_id`,
    done: await orgMonthDone(sql, orgId, ids, { start, end }),
    headReturns: await headReturnsQ(sql, orgId, ids, { start, end }),
    resign: await resignQ(sql, orgId, ids, { start, end }),
    signed: await signedQ(sql, orgId, ids, { start, end }),
    firstSign: await firstSignQ(sql, orgId, ids, { start, end }),
    bankTask: await bankTaskQ(sql, orgId, ids, { start, end }),
    letterAsk: await bankTaskQ(sql, orgId, ids, { start, end }, LETTER_ITEMS),
    remarkItems: await sql`
      select r.executor_user_id as user_id, i.text, r.created_at as at from org_returns r
      join org_return_items i on i.return_id = r.id
      where r.org_id = ${orgId} and r.executor_user_id = any(${ids}::uuid[]) and r.created_at >= ${start} and r.created_at < ${end}
      order by r.created_at desc, r.id desc, i.n`,
    dispReturns: await dispReturnsQ(sql, orgId, ids, { start, end }),
    dispReasons: await dispReasonsQ(sql, orgId, ids, { start, end }),
    afterRemarks: (await afterRemarksQ(sql, orgId, ids, { start, end })).filter((r) => !registry || registry.remarks(r.module)),
    paid: await sql`
      select p.executor_user_id as user_id, coalesce(sum(p.amount_kop), 0)::bigint as kop from payouts p
      join org_members m on m.org_id = ${orgId} and m.user_id = p.executor_user_id
      where p.executor_user_id = any(${ids}::uuid[]) and p.status = 'succeeded'
        and p.paid_at >= ${start} and p.paid_at < ${end} and p.paid_at >= m.created_at
      group by p.executor_user_id`,
    // Просрочено сейчас — только в сводке за текущий месяц (и текущий год, 2.408): дела в работе, у которых срок уже прошёл.
    active: current ? await sql`
      select o.executor_user_id as user_id, o.status, o.deadline from orders o
      join org_members m on m.org_id = ${orgId} and m.user_id = o.executor_user_id
      where o.executor_user_id = any(${ids}::uuid[]) and o.status in ('awaiting_executor', 'in_work', 'review') and o.deadline is not null` : [],
  };
  // Пункты замечаний — того круга, что пришёл в этом месяце; с экспертом дела.
  const afterItems = (await remarkItemsQ(sql, [...new Set(q.afterRemarks.map((r) => r.order_id))]))
    .flatMap((i) => q.afterRemarks.filter((r) => r.order_id === i.order_id && r.round === i.round).slice(0, 1)
      .map((r) => ({ ...i, user_id: r.user_id })));
  const taskDues = await taskDueRows(q.done, taskDue);
  const bankAfters = await bankAfterRows(q.done, taskAfter);
  const exts = await extRows(q.done, taskMove);
  const count = (rows) => new Map(rows.map((r) => [r.user_id, r.n]));
  const accepted = count(q.accepted);
  const headReturns = count(q.headReturns);
  const dispReturns = count(q.dispReturns);
  const signed = new Map(q.signed.map((r) => [r.user_id, r]));
  const paid = new Map(q.paid.map((r) => [r.user_id, Number(r.kop)]));
  const prevM = prevMonth(month);
  const cmp = prevM >= since.slice(0, year ? 4 : 7) ? await monthCompare(sql, orgId, ids, prevM) : null;
  // 2.408: в сводке за год — сданные по месяцам (текущий год — по текущий месяц).
  const yearMonths = year ? Array.from({ length: current ? Number(today.slice(5, 7)) : 12 }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`) : null;
  const perMonth = (done) => yearMonths.map((m) => done.filter((o) => dayMsk(o.at).startsWith(m)).length);
  const rows = experts.map((e) => {
    const done = q.done.filter((o) => o.user_id === e.user_id);
    const p = pace(done);
    return {
      user_id: e.user_id,
      full_name: e.full_name || 'Без имени',
      accepted: accepted.get(e.user_id) ?? 0,
      done: done.length,
      done_late: done.filter((o) => o.deadline && dayMsk(o.at) > o.deadline).length,
      overdue_now: current ? q.active.filter((o) => o.user_id === e.user_id && isOverdue(o, today)).length : null,
      returned_head: headReturns.get(e.user_id) ?? 0,
      returned_dispatcher: dispReturns.get(e.user_id) ?? 0,
      returned_dispatcher_cases: casesOf(q.dispReasons.filter((r) => r.user_id === e.user_id)),
      fee_kop: done.reduce((s, o) => s + feeOf(o), 0),
      paid_kop: paid.get(e.user_id) ?? 0,
      avg_days: avgDays(p),
      late_first: p.late_first,
      late_first_moved: p.late_first_moved,
      first_kept: p.first_kept,
      ...resign(q.resign.filter((r) => r.user_id === e.user_id)),
      signed: signed.get(e.user_id)?.signed ?? 0,
      signed_no_ai: signed.get(e.user_id)?.signed_no_ai ?? 0,
      signed_points_left: signed.get(e.user_id)?.signed_points_left ?? 0,
      ...egrnFirst(q.firstSign.filter((x) => x.user_id === e.user_id), registry),
      ...bankTask(q.bankTask.filter((x) => x.user_id === e.user_id)),
      ...taskLate(taskDues.filter((x) => x.user_id === e.user_id)),
      ...bankAfter(bankAfters.filter((x) => x.user_id === e.user_id)),
      ...ext(exts.filter((x) => x.user_id === e.user_id)),
      ...letterAsk(q.letterAsk.filter((x) => x.user_id === e.user_id)),
      ...orgSign(done),
      remarks: topRemarks(q.remarkItems.filter((i) => i.user_id === e.user_id), TOP_REMARKS_EXPERT).map(({ text, n }) => ({ text, n })),
      ...afterRemarks(q.afterRemarks.filter((r) => r.user_id === e.user_id), afterItems.filter((i) => i.user_id === e.user_id)),
      after_remarks: topRemarks(afterItems.filter((i) => i.user_id === e.user_id), TOP_REMARKS_EXPERT).map(({ text, n }) => ({ text, n })),
      disp_reasons: topRemarks(q.dispReasons.filter((i) => i.user_id === e.user_id && i.text), TOP_REMARKS_EXPERT)
        .map(({ text, n }) => ({ text, n })),
      prev: cmp ? cmp.experts.get(e.user_id) : null,
      services: byService(done, registry).map(({ name, done: n }) => ({ name, n })),
      ...(year ? { by_month: perMonth(done) } : {}),
    };
  });
  const sum = (k) => (k === 'overdue_now' && !current ? null : rows.reduce((s, r) => s + r[k], 0));
  const keys = ['accepted', 'done', 'done_late', 'overdue_now', 'returned_head', 'returned_dispatcher', 'returned_dispatcher_cases', 'fee_kop', 'paid_kop',
    'late_first', 'late_first_moved', 'first_kept', 'signed', 'signed_no_ai', 'signed_points_left'];
  const all = pace(q.done);
  return {
    month,
    month_name: periodRu(month),
    year,
    current,
    // Месяцы до создания организации — заведомо пустые (2.90): в выборе только с месяца создания; годы — так же (2.408).
    months: reportMonths(today).filter((m) => m >= since || m === month),
    years: reportYears(today).filter((y) => y >= since.slice(0, 4) || y === month),
    experts: rows,
    total: { ...Object.fromEntries(keys.map((k) => [k, sum(k)])), avg_days: avgDays(all), ...resign(q.resign),
      ...egrnFirst(q.firstSign, registry), ...bankTask(q.bankTask), ...taskLate(taskDues),
      ...bankAfter(bankAfters), ...ext(exts), ...letterAsk(q.letterAsk), ...orgSign(q.done), ...afterRemarks(q.afterRemarks, afterItems),
      prev: cmp ? cmp.total : null },
    prev_month: cmp ? prevM : null,
    prev_month_name: cmp ? periodRu(prevM) : null,
    // 2.408: [{ month, name, done, done_late, fee_kop }] — сданные за год по месяцам; у месячной сводки — null.
    by_month: year ? yearMonths.map((m) => {
      const done = q.done.filter((o) => dayMsk(o.at).startsWith(m));
      return { month: m, name: monthRu(m), done: done.length, done_late: done.filter((o) => o.deadline && dayMsk(o.at) > o.deadline).length,
        fee_kop: done.reduce((s, o) => s + feeOf(o), 0) };
    }) : null,
    top_remarks: topRemarks(q.remarkItems, TOP_REMARKS),
    disp_reasons: topRemarks(q.dispReasons.filter((i) => i.text), TOP_REMARKS),
    // 2.437: замечания к сданному отчёту — по пользователям отчёта и самые частые пункты.
    after_by_user: afterByUser(q.afterRemarks, afterItems),
    after_remarks: topRemarks(afterItems, TOP_REMARKS),
    by_service: byService(q.done, registry),
  };
}

// «Мои итоги за месяц» эксперта (2.92): то же, что строка эксперта в сводке руководителя, но по всем его делам — и частным,
// и от организации; плюс список сданных за месяц дел (своих — с названием), в срок ли и выплачено ли. Месяцы — с того,
// когда человек стал специалистом.
// «Мои итоги за год» (2.409): период «ГГГГ» — весь год (текущий и прошлый, с года, когда стал специалистом); плюс по месяцам —
// сдано, в срок, возвраты, вознаграждение за сданные и выплачено (только месяцы, где что-то было).
export async function expertMonthReport(sql, userId, month, today = todayMsk()) {
  const year = isYear(month);
  const { start, end } = await monthBounds(sql, month);
  const since = (await sql`select to_char(created_at at time zone 'Europe/Moscow', 'YYYY-MM') as m from specialists
                           where user_id = ${userId}`)[0]?.m ?? '';
  const current = month === today.slice(0, year ? 4 : 7);
  const [{ n: accepted }] = await sql`
    select count(distinct order_id)::int as n from order_offers
    where specialist_id = ${userId} and outcome = 'accepted' and outcome_at >= ${start} and outcome_at < ${end}`;
  const done = await sql`
    select distinct on (o.id) o.id, o.title, o.deadline, o.price_kop, o.transit_kop, p.amount_kop as payout_kop, p.status as payout_status, h.at,
      greatest(
        (select max(f.outcome_at) from order_offers f
         where f.order_id = o.id and f.specialist_id = o.executor_user_id and f.outcome = 'accepted'),
        (select max(a.at) from audit_log a
         where a.subject_type = 'order' and a.subject_id = o.id::text and a.action = 'org.case.transfer'
           and a.details->>'to' = o.executor_user_id::text)) as taken_at,
      (select count(*)::int from order_status_history r where r.order_id = o.id and r.from_status = 'review' and r.to_status = 'in_work')
        + (select count(*)::int from org_returns r where r.order_id = o.id and r.executor_user_id = o.executor_user_id) as returns
    from order_status_history h join orders o on o.id = h.order_id left join payouts p on p.order_id = o.id
    where o.executor_user_id = ${userId} and h.to_status = 'done' and h.at >= ${start} and h.at < ${end}
      and not exists (select 1 from order_status_history h0 where h0.order_id = o.id and h0.to_status = 'done' and h0.at < h.at)
    order by o.id, h.at`;
  const headReturns = await sql`
    select created_at as at from org_returns where executor_user_id = ${userId} and created_at >= ${start} and created_at < ${end}`;
  const dispReturns = await sql`
    select h.at from order_status_history h join orders o on o.id = h.order_id
    where o.executor_user_id = ${userId} and h.from_status = 'review' and h.to_status = 'in_work' and h.at >= ${start} and h.at < ${end}`;
  const paid = await sql`
    select amount_kop, paid_at as at from payouts
    where executor_user_id = ${userId} and status = 'succeeded' and paid_at >= ${start} and paid_at < ${end}`;
  const paidKop = (rows) => rows.reduce((s, p) => s + Number(p.amount_kop), 0);
  const active = current ? await sql`
    select status, deadline from orders
    where executor_user_id = ${userId} and status in ('awaiting_executor', 'in_work', 'review') and deadline is not null` : [];
  const cases = done.sort((a, b) => new Date(a.at) - new Date(b.at)).map((o) => ({
    id: o.id,
    title: o.title,
    deadline: o.deadline,
    done_on: dayMsk(o.at),
    late: !!(o.deadline && dayMsk(o.at) > o.deadline),
    // На сколько дней позже срока, дней от принятия до сдачи и сколько раз возвращали (2.377).
    late_days: o.deadline && dayMsk(o.at) > o.deadline ? daysBetween(o.deadline, dayMsk(o.at)) : 0,
    days: o.taken_at ? Math.max(0, daysBetween(dayMsk(o.taken_at), dayMsk(o.at))) : null,
    returns: o.returns,
    fee_kop: feeOf(o),
    paid: o.payout_status === 'succeeded',
  }));
  const late = cases.filter((c) => c.late).length;
  // 2.409: по месяцам года — только где что-то сдано, возвращено или выплачено; месяц — по Москве.
  const inMonth = (m) => (r) => dayMsk(r.at).slice(0, 7) === m;
  const byMonth = year ? Array.from({ length: 12 }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`).map((m) => {
    const c = cases.filter((x) => x.done_on.slice(0, 7) === m);
    return {
      month: m,
      name: monthRu(m),
      done: c.length,
      done_late: c.filter((x) => x.late).length,
      returned_head: headReturns.filter(inMonth(m)).length,
      returned_dispatcher: dispReturns.filter(inMonth(m)).length,
      fee_kop: c.reduce((s, x) => s + x.fee_kop, 0),
      paid_kop: paidKop(paid.filter(inMonth(m))),
    };
  }).filter((m) => m.done || m.returned_head || m.returned_dispatcher || m.paid_kop) : null;
  return {
    month,
    month_name: year ? `${month} год` : monthRu(month),
    current,
    year,
    months: reportMonths(today).filter((m) => m >= since || m === month),
    years: reportYears(today).filter((y) => y >= since.slice(0, 4) || y === month),
    ...(byMonth ? { by_month: byMonth } : {}),
    total: {
      accepted,
      done: cases.length,
      done_on_time: cases.length - late,
      done_late: late,
      // В среднем дней от принятия до сдачи (2.377) — как в сводке руководителя (2.117); дела без отметки о принятии не в счёт.
      avg_days: avgDays(pace(done)),
      overdue_now: current ? active.filter((o) => isOverdue(o, today)).length : null,
      returned_head: headReturns.length,
      returned_dispatcher: dispReturns.length,
      fee_kop: cases.reduce((s, c) => s + c.fee_kop, 0),
      paid_kop: paidKop(paid),
    },
    cases,
  };
}

// Таблица для Excel: точка с запятой, BOM (иначе Excel путает кодировку), суммы — рубли с запятой. Ячейка, начинающаяся
// с «= + - @», — с апострофом, чтобы Excel не принял имя за формулу.
const daysCell = (d) => (d == null ? '' : String(d).replace('.', ','));
const rubCell = (kop) => `${Math.floor(kop / 100)},${String(kop % 100).padStart(2, '0')}`;
export function cell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function reportCsv(orgName, r) {
  const head = ['Эксперт', 'Принял дел', 'Сдано (готово)', 'Из них позже срока', ...(r.current ? ['Просрочено сейчас'] : []),
    'Возвращено руководителем', 'Возвращено на доработку', 'Вознаграждение за сданные, ₽', 'Выплачено, ₽',
    'Дней в среднем от принятия до сдачи', 'Позже первоначального срока', 'Из них с переносом срока',
    'В первоначальный срок, без переносов', 'Дней в среднем от возврата до новой подписи', 'Ждут новой подписи после возврата',
    'Подписал файлов', 'Из них без ИИ-проверки этой версии', 'Из них не отметив все пункты замечания',
    'Впервые подписал дел', 'Расхождений с выпиской ЕГРН при первой подписи', 'В скольких делах', 'Первая подпись без ИИ-проверки',
    'Расхождений с заявкой и заданием на оценку при первой подписи', 'В скольких делах', 'Из них с заявкой', 'Из них с заданием на оценку',
    ...TASK_KINDS.map(([, title]) => `С заданием: ${title}`),
    'Заменено кнопкой в черновике до первой подписи', 'В скольких делах', 'Из них по выписке ЕГРН', 'Из них по заданию на оценку'];
  const line = (name, x) => [name, x.accepted, x.done, x.done_late, ...(r.current ? [x.overdue_now] : []),
    x.returned_head, x.returned_dispatcher, rubCell(x.fee_kop), rubCell(x.paid_kop),
    daysCell(x.avg_days), x.late_first, x.late_first_moved, x.first_kept, daysCell(x.resign_days), x.resign_wait,
    x.signed, x.signed_no_ai, x.signed_points_left, x.first_signed, x.egrn_first, x.egrn_first_cases, x.first_no_ai,
    x.order_first, x.order_first_cases, x.order_first_app, x.order_first_task, ...TASK_KINDS.map(([k]) => x[`order_task_${k}`]),
    x.swap_first, x.swap_first_cases, x.swap_first_egrn, x.swap_first_task];
  const day = todayMsk();
  const lines = [
    [`Сводка по экспертам — ${orgName}`],
    [`${r.year ? 'Год' : 'Месяц'}: ${r.month_name}${r.current ? ` (по ${Number(day.slice(8, 10))} ${MONTHS_GEN[Number(day.slice(5, 7)) - 1]})` : ''}`],
    [],
    head,
    ...r.experts.map((x) => line(x.full_name, x)),
    line('Итого', r.total),
    // 2.408: в сводке за год — сданные по месяцам у каждого эксперта и в итоге.
    ...(r.by_month ? [[], ['Сдано по месяцам', ...r.by_month.map((m) => m.name)],
      ...r.experts.map((x) => [x.full_name, ...x.by_month]), ['Итого', ...r.by_month.map((m) => m.done)],
      ['Из них позже срока', ...r.by_month.map((m) => m.done_late)],
      ['Вознаграждение за сданные, ₽', ...r.by_month.map((m) => rubCell(m.fee_kop))]] : []),
    ...(r.prev_month ? [[], [`Сравнение с прошлым ${r.year ? 'годом' : 'месяцем'} (${r.prev_month_name})`, 'Сдано', `Сдано в прошлом ${r.year ? 'году' : 'месяце'}`,
      'В срок', `В срок в прошлом ${r.year ? 'году' : 'месяце'}`, 'Возвраты', `Возвраты в прошлом ${r.year ? 'году' : 'месяце'}`],
    ...[...r.experts.map((x) => [x.full_name, x]), ['Итого', r.total]].map(([name, x]) => [name, x.done, x.prev.done,
      x.done - x.done_late, x.prev.on_time, x.returned_head + x.returned_dispatcher, x.prev.returned])] : []),
    ...(r.by_service?.length ? [[], ['По услугам', 'Сдано (готово)', 'Из них позже срока', 'Вознаграждение за сданные, ₽',
      'Экспертов', 'Дней в среднем от принятия до сдачи'], ...r.by_service.map((x) => [x.name, x.done, x.done_late,
      rubCell(x.fee_kop), x.experts, daysCell(x.avg_days)])] : []),
    ...(r.total.egrn_rules?.length ? [[], ['Расхождения с выпиской ЕГРН при первой подписи — пункт проверки', 'Сколько'],
      ...r.total.egrn_rules.map((x) => [x.title, x.n])] : []),
    ...(r.total.order_rules?.length ? [[], ['Расхождения с заявкой и заданием на оценку при первой подписи — пункт проверки', 'Сколько'],
      ...r.total.order_rules.map((x) => [x.title, x.n])] : []),
    ...(r.total.order_task_kinds?.length ? [[], ['Расхождения с заданием на оценку при первой подписи — что', 'Сколько'],
      ...r.total.order_task_kinds.map((x) => [x.title, x.n])] : []),
    // 2.366: только если среди сданных за месяц есть дела с подписью организации.
    ...(r.total.org_sign_cases ? [[], ['Подпись организации', 'Сдано дел с подписью организации',
      'Дней в среднем от принятия до подписи организации', 'Больше всего дней', 'Дней в среднем от подписи эксперта до подписи организации'],
      ...[...r.experts.filter((x) => x.org_sign_cases).map((x) => [x.full_name, x]), ['Итого', r.total]]
        .map(([name, x]) => [name, x.org_sign_cases, daysCell(x.org_sign_days), x.org_sign_max, daysCell(x.org_sign_wait)])] : []),
    // 2.309: отдельным разделом — только если за месяц просили задание от банка.
    ...(r.total.bank_task ? [[], ['Задание на оценку от банка', 'Запрошено', 'В скольких делах', 'Пришло',
      'Дней в среднем до задания', 'Ещё ждут'], ...[...r.experts.filter((x) => x.bank_task).map((x) => [x.full_name, x]),
      ['Итого', r.total]].map(([name, x]) => [name, x.bank_task, x.bank_task_cases, x.bank_task_got, daysCell(x.bank_task_days),
      x.bank_task_wait])] : []),
    // 2.323: только если за месяц сданы дела со сроком по заданию на оценку.
    ...(r.total.task_due_cases ? [[], ['Срок по заданию на оценку', 'Сдано дел с таким сроком', 'Из них позже срока по заданию',
      'На сколько дней в среднем', 'Больше всего дней'], ...[...r.experts.filter((x) => x.task_due_cases).map((x) => [x.full_name, x]),
      ['Итого', r.total]].map(([name, x]) => [name, x.task_due_cases, x.task_late, daysCell(x.task_late_days), x.task_late_max])] : []),
    // 2.346: только если за месяц сданы дела со сроком из письма о переносе срока — отдельно от срока по заданию.
    ...(r.total.letter_cases ? [[], ['Срок по письму о переносе', 'Сдано дел с таким сроком', 'Из них позже срока по письму',
      'На сколько дней в среднем', 'Больше всего дней'], ...[...r.experts.filter((x) => x.letter_cases).map((x) => [x.full_name, x]),
      ['Итого', r.total]].map(([name, x]) => [name, x.letter_cases, x.letter_late, daysCell(x.letter_late_days), x.letter_late_max])] : []),
    // 2.329: только если за месяц сданы дела для банка.
    ...(r.total.bank_cases ? [[], ['Дела для банка', 'Сдано', 'Задание на оценку пришло после черновика', 'Доля, %'],
      ...[...r.experts.filter((x) => x.bank_cases).map((x) => [x.full_name, x]), ['Итого', r.total]]
        .map(([name, x]) => [name, x.bank_cases, x.bank_after, x.bank_after_pct])] : []),
    // 2.336: только если за месяц сданы дела с переносом срока по просьбе эксперта.
    ...(r.total.ext_cases ? [[], ['Переносы срока по просьбе эксперта', 'Сдано дел с переносом', 'Переносов',
      'Срок перенесён позже срока по заданию на оценку', 'Из них с письмом о переносе'],
      ...[...r.experts.filter((x) => x.ext_cases).map((x) => [x.full_name, x]), ['Итого', r.total]]
        .map(([name, x]) => [name, x.ext_cases, x.ext_times, x.ext_need, x.ext_letter])] : []),
    // 2.358: только если за месяц просили письмо о переносе с новым сроком.
    ...(r.total.letter_ask ? [[], ['Письмо о переносе с новым сроком', 'Попросили', 'В скольких делах', 'Пришло',
      'Дней в среднем до письма', 'Больше всего дней', 'Ещё ждут'],
      ...[...r.experts.filter((x) => x.letter_ask).map((x) => [x.full_name, x]), ['Итого', r.total]]
        .map(([name, x]) => [name, x.letter_ask, x.letter_ask_cases, x.letter_ask_got, daysCell(x.letter_ask_days),
          daysCell(x.letter_ask_max), x.letter_ask_wait])] : []),
    // 2.376: только если за месяц диспетчер возвращал дела на доработку.
    ...(r.total.returned_dispatcher ? [[], ['Возвраты диспетчера на доработку', 'Возвращено', 'В скольких делах', 'Частые причины'],
      ...[...r.experts.filter((x) => x.returned_dispatcher).map((x) => [x.full_name, x]), ['Итого', r.total]]
        .map(([name, x]) => [name, x.returned_dispatcher, x.returned_dispatcher_cases,
          (x.disp_reasons ?? r.disp_reasons ?? []).map((m) => `${m.text}${m.n > 1 ? ` ×${m.n}` : ''}`).join(' | ')])] : []),
    ...(r.disp_reasons?.length ? [[], ['Причины возврата диспетчером', 'Сколько раз', 'У скольких экспертов'],
      ...r.disp_reasons.map((x) => [x.text, x.n, x.experts])] : []),
    ...(r.top_remarks?.length ? [[], ['Частые замечания при возврате', 'Сколько раз', 'У скольких экспертов'],
      ...r.top_remarks.map((x) => [x.text, x.n, x.experts])] : []),
    // 2.437: только если за месяц приходили замечания к сданным отчётам.
    ...(r.total.remarks_after ? [[], ['Замечания после сдачи', 'Сколько раз пришли', 'В скольких делах', 'Пунктов', 'Частые пункты'],
      ...[...(r.after_by_user ?? []).map((x) => [x.name, x.n, x.cases, x.items, x.top]),
        ...r.experts.filter((x) => x.remarks_after).map((x) => [x.full_name, x.remarks_after, x.remarks_after_cases,
          x.remarks_after_items, x.after_remarks]),
        ['Итого', r.total.remarks_after, r.total.remarks_after_cases, r.total.remarks_after_items, []]]
        .map(([name, n, cases, items, top]) => [name, n, cases, items, top.map((m) => `${m.text}${m.n > 1 ? ` ×${m.n}` : ''}`).join(' | ')])] : []),
    ...(r.after_remarks?.length ? [[], ['Частые замечания банка и суда', 'Сколько раз', 'У скольких экспертов'],
      ...r.after_remarks.map((x) => [x.text, x.n, x.experts])] : []),
  ];
  return `﻿${lines.map((l) => l.map(cell).join(';')).join('\r\n')}\r\n`;
}
