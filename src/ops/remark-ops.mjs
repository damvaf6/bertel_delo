// Свои заготовки замечаний руководителя (2.103): частые пункты, с которыми руководитель возвращает отчёт эксперту («нет даты
// осмотра», «нет корректировки на этаж»). Сохранить пункт один раз — потом вставлять в замечание одной кнопкой. Заготовки
// свои у каждого руководителя в каждой организации: другой руководитель, сотрудник, эксперт и посторонний их не видят.
import { HttpError } from '../http/core.mjs';
import { audit, text } from './util.mjs';
import { returnPoints } from './sign-ops.mjs';

const MAX_REMARKS = 100;
const TEXT_MAX = 500;
const access = { resource: 'org', param: 'id', need: 'manage' };

async function view(sql, orgId, userId) {
  const rows = await sql`select id, text from org_remarks where org_id = ${orgId} and user_id = ${userId} and deleted_at is null
                         order by created_at, id`;
  return { remarks: rows.map((r) => ({ id: String(r.id), text: r.text })) };
}

export function remarkOps() {
  return [
    {
      id: 'orgs.remarks.list', method: 'GET', path: '/api/orgs/:id/remarks', auth: 'user', access,
      handler: ({ sql, actor, org }) => view(sql, org.id, actor.id),
    },
    {
      // Пункт — одна строка замечания (нумерация в начале снимается, как в самом замечании — 2.93). Такой же уже есть — повторно не сохраняется (кнопка «Запомнить пункты» безопасна).
      id: 'orgs.remarks.add', method: 'POST', path: '/api/orgs/:id/remarks', auth: 'user', access,
      async handler({ sql, actor, org, body, res }) {
        const t = text(returnPoints(String(body?.text ?? '').replace(/\s+/g, ' '))[0], 'Пункт замечания', TEXT_MAX);
        const added = await sql.tx(async (tx) => {
          await tx`select 1 from org_members where org_id = ${org.id} and user_id = ${actor.id} for update`;
          const same = await tx.one`select id from org_remarks where org_id = ${org.id} and user_id = ${actor.id} and deleted_at is null
                                    and lower(text) = lower(${t})`;
          if (same) return false;
          const n = await tx.one`select count(*)::int as n from org_remarks where org_id = ${org.id} and user_id = ${actor.id} and deleted_at is null`;
          if (n.n >= MAX_REMARKS) throw new HttpError(409, 'too_many', `Заготовок замечаний — не больше ${MAX_REMARKS}`);
          const row = await tx.one`insert into org_remarks (org_id, user_id, text) values (${org.id}, ${actor.id}, ${t}) returning id`;
          await audit(tx, actor, 'orgs.remarks.add', 'org_remark', row.id, { org_id: org.id });
          return true;
        });
        if (added) res.status(201);
        return { added, ...(await view(sql, org.id, actor.id)) };
      },
    },
    {
      // Убрать из списка. В уже отправленных замечаниях текст остаётся.
      id: 'orgs.remarks.remove', method: 'DELETE', path: '/api/orgs/:id/remarks/:remark', auth: 'user', access,
      async handler({ sql, actor, org, params }) {
        if (!/^\d{1,18}$/.test(String(params.remark ?? ''))) throw new HttpError(404, 'not_found', 'Заготовка не найдена');
        await sql.tx(async (tx) => {
          const cur = await tx.one`select id from org_remarks where id = ${params.remark} and org_id = ${org.id} and user_id = ${actor.id}
                                   and deleted_at is null for update`;
          if (!cur) throw new HttpError(404, 'not_found', 'Заготовка не найдена');
          await tx`update org_remarks set deleted_at = now() where id = ${cur.id}`;
          await audit(tx, actor, 'orgs.remarks.remove', 'org_remark', cur.id, { org_id: org.id });
        });
        return view(sql, org.id, actor.id);
      },
    },
  ];
}
