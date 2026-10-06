// Досье эксперта (2.14; решение Дамира 03.10.2026, в). Здесь — виды документов, как запись показывается, сроки,
// сведения для черновика и напоминания. Операции — src/ops/dossier-ops.mjs; сверка отчёта с досье —
// правила dossier_* в src/ai/report-checks.mjs.
import { addDays, todayMsk } from '../orders/workflow.mjs';
import { dispatchers, notify, orgHeads } from '../notify/notify.mjs';

// has — какие поля у вида есть (остальные не принимаются); need — обязательные; term — у документа есть срок.
export const KINDS = {
  education: { name: 'Диплом об образовании', title: 'Учебное заведение и специальность', number: 'Номер диплома', has: ['number', 'issued_on'], need: [] },
  certificate: { name: 'Квалификационный аттестат', title: 'Направление', number: 'Номер аттестата', has: ['number', 'issued_on', 'valid_until'], need: ['number', 'valid_until'], term: true },
  sro: { name: 'Членство в СРО', title: 'Название СРО', number: 'Номер в реестре', has: ['number', 'issued_on'], need: ['number'] },
  policy: { name: 'Полис страхования оценщика', title: 'Страховщик', number: 'Номер полиса', has: ['number', 'issued_on', 'valid_until', 'amount_kop'], need: ['number', 'valid_until', 'amount_kop'], term: true },
  policy_org: { name: 'Полис страхования организации', title: 'Страховщик', number: 'Номер полиса', has: ['number', 'issued_on', 'valid_until', 'amount_kop'], need: ['number', 'valid_until', 'amount_kop'], term: true },
};
export const KIND_ORDER = Object.keys(KINDS);

// Решение Дамира 03.10.2026 (вопрос 17): истёкший аттестат или полис снимает эксперта с подбора по услугам оценки —
// тем, где ИИ-проверка сверяет отчёт с досье (правило dossier_appraiser в описании модуля).
export const BLOCKING_KINDS = ['certificate', 'policy', 'policy_org'];
export function needsValidDossier(registry, order) {
  return !!registry?.checks(order.module, order.service).some((c) => c.auto?.includes('dossier_appraiser'));
}

export const headKey = (t) => t.toLowerCase().replace(/ё/g, 'е').split(/[:,(]/)[0].replace(/\s+/g, ' ').trim();
const ru = (d) => (d ? d.split('-').reverse().join('.') : '');
const rub = (kop) => `${(Number(kop) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 }).replace(/\s/g, ' ')} руб.`;

// Состояние срока: истёк, кончается в ближайшие 30 дней, действует; без срока — null.
export function termState(validUntil, today = todayMsk()) {
  if (!validUntil) return null;
  if (validUntil < today) return 'expired';
  if (validUntil <= addDays(today, 30)) return 'soon';
  return 'ok';
}

export async function loadDossier(sql, userId) {
  const rows = await sql`select *, to_char(issued_on, 'YYYY-MM-DD') as issued, to_char(valid_until, 'YYYY-MM-DD') as until
                         from dossier_items where user_id = ${userId} and deleted_at is null order by id`;
  return rows
    .map((r) => ({
      id: String(r.id), kind: r.kind, kind_name: KINDS[r.kind].name, title: r.title, number: r.number ?? null,
      issued_on: r.issued ?? null, valid_until: r.until ?? null, amount_kop: r.amount_kop === null ? null : Number(r.amount_kop),
      file: r.file_key ? { name: r.file_name, mime: r.file_mime, size_bytes: r.file_size } : null,
      state: termState(r.until ?? null),
      updated_at: r.updated_at,
    }))
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || Number(a.id) - Number(b.id));
}

// Что не так с досье — для эксперта, диспетчера в подборе и списка специалистов: истёкшие и скоро истекающие документы.
export function dossierAlerts(items) {
  return items.filter((i) => i.state === 'expired' || i.state === 'soon')
    .map((i) => ({ kind: i.kind, kind_name: i.kind_name, valid_until: i.valid_until, state: i.state }));
}

// Одна строка о документе — для черновика заключения.
export function itemLine(i, today = todayMsk()) {
  const parts = [`${i.kind_name}: ${i.title}`];
  if (i.number) parts.push(i.kind === 'sro' ? `номер в реестре ${i.number}` : `№ ${i.number}`);
  if (i.issued_on) parts.push(`от ${ru(i.issued_on)}`);
  if (i.amount_kop) parts.push(`страховая сумма ${rub(i.amount_kop)}`);
  if (i.valid_until) parts.push(`действует до ${ru(i.valid_until)}`);
  let line = parts.join(', ');
  // Истёкший документ в черновик молча не попадает: пометка не даст приложить черновик, пока эксперт её не заменит.
  if (i.valid_until && i.valid_until < today) line += ` [заполнить: срок истёк ${ru(i.valid_until)} — укажите действующий документ]`;
  return line;
}

// Подставить сведения из досье в разделы черновика с пометкой dossier (описание модуля): 'info' — сведения об эксперте,
// 'copies' — перечень копий для приложений. Строки встают сразу под заголовком раздела; без досье черновик не меняется.
export function fillDraft(body, sections, items, today = todayMsk()) {
  if (!items.length) return body;
  let out = body;
  for (const s of sections.filter((x) => x.dossier)) {
    const lines = s.dossier === 'info'
      ? ['Сведения об эксперте (из досье):', ...items.map((i) => `- ${itemLine(i, today)}`)]
      : ['Копии документов эксперта (из досье, прикладываются кнопкой «Приложить копии из досье»):',
        ...items.filter((i) => i.file).map((i, k) => `- Приложение ${k + 1}. ${i.kind_name}${i.number ? ` № ${i.number}` : ''}`)];
    if (lines.length < 2) continue;
    // Заголовок раздела узнаётся так же, как в cleanDraftAnswer (src/ai/ai.mjs): по началу названия до «:», «,» или «(».
    const m = [...out.matchAll(/^#{1,3}\s*(.+)$/gm)].find((h) => headKey(h[1]) === headKey(s.title));
    if (!m) continue;
    const at = m.index + m[0].length;
    out = `${out.slice(0, at)}\n${lines.join('\n')}${out.slice(at)}`;
  }
  return out;
}

// Напоминания о сроках документов досье: за 30 и за 7 дней — эксперту и руководителям его организации (2.63); срок
// прошёл — им же и диспетчерам. Организация эксперта — та, от которой он работает (профиль специалиста) и в которой
// состоит, как в «Делах экспертов». Каждое — один раз на документ, вид и срок (dossier_reminders); эксперт обновил
// срок — по новому придут снова. По услугам оценки истёкший аттестат или полис снимает эксперта с подбора (решение
// Дамира 03.10.2026, match-ops.mjs).
const HEAD_EVENT = { d30: 'dossier_month_head', d7: 'dossier_week_head', expired: 'dossier_expired_head' };
export async function remindDossier(sql, { today = todayMsk() } = {}) {
  let sent = 0;
  const rows = await sql`select d.id, d.user_id, to_char(d.valid_until, 'YYYY-MM-DD') as until, m.org_id from dossier_items d
                         join users u on u.id = d.user_id and u.is_active
                         left join specialists s on s.user_id = d.user_id
                         left join org_members m on m.org_id = s.org_id and m.user_id = d.user_id
                         where d.deleted_at is null and d.valid_until is not null and d.valid_until <= ${addDays(today, 30)}::date`;
  for (const r of rows) {
    const kind = r.until < today ? 'expired' : r.until <= addDays(today, 7) ? 'd7' : 'd30';
    sent += await sql.tx(async (tx) => {
      const fresh = await tx`insert into dossier_reminders (item_id, kind, valid_until) values (${r.id}, ${kind}, ${r.until})
                             on conflict do nothing returning item_id`;
      if (!fresh.length) return 0;
      let n = await notify(tx, kind === 'd30' ? 'dossier_month' : kind === 'd7' ? 'dossier_week' : 'dossier_expired', { users: [r.user_id] });
      // Руководитель сам себе эксперт — ему хватит своего напоминания.
      if (r.org_id) n += await notify(tx, HEAD_EVENT[kind], { users: (await orgHeads(tx, r.org_id)).filter((id) => id !== r.user_id), orgId: r.org_id });
      if (kind === 'expired') n += await notify(tx, 'dossier_expired_staff', { users: await dispatchers(tx) });
      return n;
    });
  }
  return sent;
}
