// «Сообщить о проблеме» (задача 2.54): кнопка в кабинете записывает сообщение в журнал (problem_reports и журнал
// действий) и уведомляет диспетчеров; диспетчер или администратор видит журнал в разделе «Проблемы» и отмечает
// разобранные. Человек пишет своими словами; раздел кабинета и экран подставляются сами.
import { HttpError, rateLimiter } from '../http/core.mjs';
import { notify, dispatchers } from '../notify/notify.mjs';
import { audit, text } from './util.mjs';

// Раздел кабинета, где была проблема: только адреса кабинета («#order=…», «#money»), иначе пусто.
const PLACE = /^#[a-z]+(=[0-9a-f-]{36})?$/i;
const limit = rateLimiter({ windowMs: 60 * 60_000, max: 20 });

export function problemOps() {
  return [
    {
      id: 'problems.report', method: 'POST', path: '/api/problems', auth: 'user', access: 'self',
      async handler({ sql, actor, body, res }) {
        limit(`problem:${actor.id}`);
        const what = text(body?.text, 'Опишите проблему', 2000);
        const place = PLACE.test(String(body?.place ?? '')) ? String(body.place) : '';
        const client = String(body?.client ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 300);
        const row = await sql.tx(async (tx) => {
          const r = await tx.one`insert into problem_reports (user_id, body, place, client)
                                 values (${actor.id}, ${what}, ${place}, ${client}) returning id, created_at`;
          await audit(tx, actor, 'problem.report', 'problem', String(r.id), { place });
          const admins = (await tx`select id from users where platform_role = 'admin' and is_active`).map((x) => x.id);
          await notify(tx, 'problem_report', { users: [...(await dispatchers(tx)), ...admins], actor });
          return r;
        });
        res.status(201);
        return { id: String(row.id), created_at: row.created_at };
      },
    },
    {
      id: 'problems.list', method: 'GET', path: '/api/problems', auth: 'user', access: { platform: 'staff' },
      async handler({ sql }) {
        const rows = await sql`
          select p.*, u.phone, u.full_name, c.full_name as closed_name
          from problem_reports p join users u on u.id = p.user_id left join users c on c.id = p.closed_by
          order by (p.closed_at is null) desc, p.created_at desc limit 200`;
        const open = await sql.one`select count(*)::int as n from problem_reports where closed_at is null`;
        return {
          open: open.n,
          problems: rows.map((r) => ({
            id: String(r.id), text: r.body, place: r.place, client: r.client, created_at: r.created_at,
            who: { phone: r.phone, name: r.full_name || '' },
            closed_at: r.closed_at, closed_by: r.closed_name || null, note: r.note,
          })),
        };
      },
    },
    {
      id: 'problems.close', method: 'POST', path: '/api/problems/:id/close', auth: 'user', access: { platform: 'staff' },
      async handler({ sql, actor, params, body }) {
        if (!/^\d{1,18}$/.test(params.id)) throw new HttpError(404, 'not_found', 'Сообщение не найдено');
        const note = body?.note == null || String(body.note).trim() === '' ? null : text(body.note, 'Что сделано', 1000);
        await sql.tx(async (tx) => {
          const r = await tx.one`update problem_reports set closed_at = now(), closed_by = ${actor.id}, note = ${note}
                                 where id = ${params.id} and closed_at is null returning id`;
          if (!r) throw new HttpError(404, 'not_found', 'Сообщение не найдено или уже разобрано');
          await audit(tx, actor, 'problem.close', 'problem', String(r.id), {});
        });
        return { ok: true };
      },
    },
  ];
}
