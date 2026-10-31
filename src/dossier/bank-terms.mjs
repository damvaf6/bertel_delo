// Срок аккредитации в банке кончается (2.454). Аккредитация эксперта — запись досье вида bank (2.451), организации —
// org_accreditations. За 30 дней до конца срока и 30 дней после — строкой в «Сегодня» эксперта (своя и организации, от
// которой он работает) и руководителя (организации и её экспертов); в декабре, до последнего рабочего дня перед
// каникулами, — и те, что кончаются до 15 января (как досье 2.405): в каникулы банк решения не принимает. Уведомления —
// своя аккредитация в remindDossier (dossier.mjs), аккредитация организации — remindOrgAccreditations ниже.
import { addDays, todayMsk } from '../orders/workflow.mjs';
import { newYearRun } from '../orders/holidays.mjs';
import { notify, orgHeads } from '../notify/notify.mjs';
import { NEW_YEAR_TERM_DAY } from './dossier.mjs';

export const BANK_TERM_DAYS = 30;

// Каникулы впереди (декабрь, до последнего рабочего дня перед ними) — { by, from, to, limit }; иначе null.
function newYearWindow(today) {
  if (today.slice(5, 7) !== '12') return null;
  const ny = newYearRun(Number(today.slice(0, 4)) + 1);
  if (today > ny.work_before) return null;
  return { by: ny.work_before, from: ny.from, to: ny.to, limit: `${Number(today.slice(0, 4)) + 1}-${NEW_YEAR_TERM_DAY}` };
}

// Одна и та же аккредитация: банк из списка — по банку, свой банк — по названию.
const sameBank = (a, b) => a.bank === b.bank && (a.bank !== 'other' || a.title.trim().toLowerCase() === b.title.trim().toLowerCase());

// Какие из записей (одного владельца) показать: кончаются в окне или истекли не раньше 30 дней назад; рядом внесена новая
// аккредитация в том же банке со сроком позже окна или без срока — продлена, не показывать.
export function pickBankTerms(rows, today = todayMsk()) {
  const ny = newYearWindow(today);
  const soon = addDays(today, BANK_TERM_DAYS);
  const limit = ny && ny.limit > soon ? ny.limit : soon;
  const from = addDays(today, -BANK_TERM_DAYS);
  return rows
    .filter((r) => r.valid_until && r.valid_until >= from && r.valid_until <= limit)
    .filter((r) => !rows.some((x) => x !== r && sameBank(x, r) && (!x.valid_until || x.valid_until > limit)))
    .map((r) => ({ id: String(r.id), bank: r.bank, title: r.title, number: r.number ?? null, valid_until: r.valid_until,
      expired: r.valid_until < today, ...(r.valid_until > soon ? { new_year: true } : {}) }));
}

const ownRows = (sql, userIds) => sql`
  select id, user_id, bank, title, number, to_char(valid_until, 'YYYY-MM-DD') as valid_until from dossier_items
  where kind = 'bank' and deleted_at is null and user_id = any(${userIds}::uuid[]) order by id`;
const orgRows = (sql, orgId) => sql`
  select id, bank, title, number, to_char(valid_until, 'YYYY-MM-DD') as valid_until from org_accreditations
  where org_id = ${orgId} and deleted_at is null order by id`;

const result = (items, today) => {
  if (!items.length) return null;
  const ny = newYearWindow(today);
  items.sort((a, b) => a.valid_until.localeCompare(b.valid_until));
  return { ...(ny ? { new_year: { by: ny.by, from: ny.from, to: ny.to } } : { new_year: null }), items };
};

// Эксперту: своя аккредитация (продлевает сам — в досье) и организации, от которой работает и где состоит (продлевает
// руководитель).
export async function bankTermsOf(sql, userId, today = todayMsk()) {
  const items = pickBankTerms(await ownRows(sql, [userId]), today).map((i) => ({ ...i, source: 'own' }));
  const [org] = await sql`select o.id, o.name from specialists s join org_members m on m.org_id = s.org_id and m.user_id = s.user_id
                          join organizations o on o.id = s.org_id where s.user_id = ${userId}`;
  if (org) items.push(...pickBankTerms(await orgRows(sql, org.id), today).map((i) => ({ ...i, source: 'org', org_id: org.id, org_name: org.name })));
  return result(items, today);
}

// Руководителю: аккредитации организации и свои аккредитации её экспертов (только банк и срок, без номеров и копий).
export async function orgBankTerms(sql, orgId, experts, today = todayMsk()) {
  const items = pickBankTerms(await orgRows(sql, orgId), today).map((i) => ({ ...i, source: 'org' }));
  const own = experts.length ? await ownRows(sql, experts.map((x) => x.user_id)) : [];
  for (const x of experts) {
    for (const i of pickBankTerms(own.filter((r) => r.user_id === x.user_id), today)) {
      items.push({ source: 'own', expert: x.full_name || 'Без имени', title: i.title, valid_until: i.valid_until, expired: i.expired,
        ...(i.new_year ? { new_year: true } : {}) });
    }
  }
  return result(items, today);
}

// Напоминания о сроке аккредитации организации: за 30 и за 7 дней и при истёкшем — руководителям; за 30 дней и при
// истёкшем — и её экспертам (в подборе и в делах для банка они без неё). Каждое один раз на запись, вид и срок; продлена
// (новая запись в том же банке со сроком позже) — не напоминать; истёкшая больше 30 дней назад — уже не напоминать.
const ORG_EVENT = { d30: 'org_accr_month', d7: 'org_accr_week', expired: 'org_accr_expired' };
const STAFF_EVENT = { d30: 'org_accr_month_staff', expired: 'org_accr_expired_staff' };
export async function remindOrgAccreditations(sql, { today = todayMsk() } = {}) {
  let sent = 0;
  const rows = await sql`
    select a.id, a.org_id, a.bank, a.title, to_char(a.valid_until, 'YYYY-MM-DD') as valid_until from org_accreditations a
    where a.deleted_at is null and a.valid_until between ${addDays(today, -BANK_TERM_DAYS)}::date and ${addDays(today, BANK_TERM_DAYS)}::date`;
  for (const r of rows) {
    const renewed = await sql`select 1 from org_accreditations where org_id = ${r.org_id} and id <> ${r.id} and deleted_at is null
      and bank = ${r.bank} and (${r.bank} <> 'other' or lower(trim(title)) = lower(trim(${r.title})))
      and (valid_until is null or valid_until > ${addDays(today, BANK_TERM_DAYS)}::date) limit 1`;
    if (renewed.length) continue;
    const kind = r.valid_until < today ? 'expired' : r.valid_until <= addDays(today, 7) ? 'd7' : 'd30';
    sent += await sql.tx(async (tx) => {
      const fresh = await tx`insert into org_accreditation_reminders (item_id, kind, valid_until) values (${r.id}, ${kind}, ${r.valid_until})
                             on conflict do nothing returning item_id`;
      if (!fresh.length) return 0;
      const heads = await orgHeads(tx, r.org_id);
      let n = await notify(tx, ORG_EVENT[kind], { users: heads, orgId: r.org_id });
      if (STAFF_EVENT[kind]) {
        const staff = (await tx`select s.user_id from specialists s join org_members m on m.org_id = s.org_id and m.user_id = s.user_id
                               join users u on u.id = s.user_id and u.is_active where s.org_id = ${r.org_id}`).map((x) => x.user_id);
        n += await notify(tx, STAFF_EVENT[kind], { users: staff.filter((id) => !heads.includes(id)), orgId: r.org_id });
      }
      return n;
    });
  }
  return sent;
}
