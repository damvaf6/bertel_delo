// Свои заготовки замечаний руководителя (2.103): частые пункты, с которыми руководитель возвращает отчёт эксперту («нет даты
// осмотра», «нет корректировки на этаж»). Сохранить пункт один раз — потом вставлять в замечание одной кнопкой. Заготовки
// свои у каждого руководителя в каждой организации: другой руководитель, сотрудник, эксперт и посторонний их не видят.
import { HttpError } from '../http/core.mjs';
import { audit, text } from './util.mjs';
import { returnPoints } from './sign-ops.mjs';

// Свои заготовки фраз в «Переписке с экспертом» (2.137) — та же таблица с видом 'phrase': сообщение целиком, не пункт.
const KINDS = {
  remark: {
    path: 'remarks', key: 'remarks', label: 'Пункт замечания', max: 500, many: 'Заготовок замечаний',
    norm: (v) => returnPoints(String(v ?? '').replace(/\s+/g, ' '))[0],
  },
  phrase: {
    path: 'phrases', key: 'phrases', label: 'Заготовка фразы', max: 1000, many: 'Заготовок фраз',
    norm: (v) => String(v ?? '').split(/\r?\n/).map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n'),
  },
};
const MAX_ITEMS = 100;
const access = { resource: 'org', param: 'id', need: 'manage' };

async function view(sql, kind, orgId, userId) {
  const rows = await sql`select id, text from org_remarks where org_id = ${orgId} and user_id = ${userId} and kind = ${kind}
                         and deleted_at is null order by created_at, id`;
  return { [KINDS[kind].key]: rows.map((r) => ({ id: String(r.id), text: r.text })) };
}

function ownOps(kind) {
  const k = KINDS[kind];
  const base = `/api/orgs/:id/${k.path}`;
  return [
    {
      id: `orgs.${k.path}.list`, method: 'GET', path: base, auth: 'user', access,
      handler: ({ sql, actor, org }) => view(sql, kind, org.id, actor.id),
    },
    {
      // Замечание — одна строка (нумерация в начале снимается, как в самом замечании — 2.93); фраза — сообщение целиком.
      // Такая же уже есть — повторно не сохраняется (кнопка «Запомнить» безопасна).
      id: `orgs.${k.path}.add`, method: 'POST', path: base, auth: 'user', access,
      async handler({ sql, actor, org, body, res }) {
        const t = text(k.norm(body?.text), k.label, k.max);
        const added = await sql.tx(async (tx) => {
          await tx`select 1 from org_members where org_id = ${org.id} and user_id = ${actor.id} for update`;
          const same = await tx.one`select id from org_remarks where org_id = ${org.id} and user_id = ${actor.id} and kind = ${kind}
                                    and deleted_at is null and lower(text) = lower(${t})`;
          if (same) return false;
          const n = await tx.one`select count(*)::int as n from org_remarks where org_id = ${org.id} and user_id = ${actor.id}
                                 and kind = ${kind} and deleted_at is null`;
          if (n.n >= MAX_ITEMS) throw new HttpError(409, 'too_many', `${k.many} — не больше ${MAX_ITEMS}`);
          const row = await tx.one`insert into org_remarks (org_id, user_id, kind, text) values (${org.id}, ${actor.id}, ${kind}, ${t}) returning id`;
          await audit(tx, actor, `orgs.${k.path}.add`, 'org_remark', row.id, { org_id: org.id });
          return true;
        });
        if (added) res.status(201);
        return { added, ...(await view(sql, kind, org.id, actor.id)) };
      },
    },
    {
      // Убрать из списка. В уже отправленных замечаниях и сообщениях текст остаётся.
      id: `orgs.${k.path}.remove`, method: 'DELETE', path: `${base}/:item`, auth: 'user', access,
      async handler({ sql, actor, org, params }) {
        if (!/^\d{1,18}$/.test(String(params.item ?? ''))) throw new HttpError(404, 'not_found', 'Заготовка не найдена');
        await sql.tx(async (tx) => {
          const cur = await tx.one`select id from org_remarks where id = ${params.item} and org_id = ${org.id} and user_id = ${actor.id}
                                   and kind = ${kind} and deleted_at is null for update`;
          if (!cur) throw new HttpError(404, 'not_found', 'Заготовка не найдена');
          await tx`update org_remarks set deleted_at = now() where id = ${cur.id}`;
          await audit(tx, actor, `orgs.${k.path}.remove`, 'org_remark', cur.id, { org_id: org.id });
        });
        return view(sql, kind, org.id, actor.id);
      },
    },
  ];
}

export function remarkOps() {
  return [...ownOps('remark'), ...ownOps('phrase')];
}
