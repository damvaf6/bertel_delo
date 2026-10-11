// Нотариусы-партнёры (задача 2а.4, задача штаба 3f617197): справочник ведёт администратор (добавить, поправить, выключить —
// не удалять: старые заказы могли идти через нотариуса). Переводчику — окна нотариусов на две недели и пачка: свои
// нотариальные заказы в работе (src/translation/notaries.mjs).
import { HttpError } from '../http/core.mjs';
import { audit, uuidFrom } from './util.mjs';
import { notaryDesk, notaryFrom, notaryView } from '../translation/notaries.mjs';

export function notaryOps() {
  return [
    {
      id: 'admin.notaries.list', method: 'GET', path: '/api/admin/notaries', auth: 'user', access: { platform: 'admin' },
      async handler({ sql }) {
        const rows = await sql`select * from notaries order by active desc, full_name`;
        return { notaries: rows.map(notaryView) };
      },
    },
    {
      id: 'admin.notaries.create', method: 'POST', path: '/api/admin/notaries', auth: 'user', access: { platform: 'admin' },
      async handler({ sql, actor, body, res }) {
        const n = notaryFrom(body);
        const row = await sql.tx(async (tx) => {
          const r = await tx.one`insert into notaries (full_name, address, contacts, windows, file_for_identity, payment)
            values (${n.full_name}, ${n.address}, ${n.contacts}, ${JSON.stringify(n.windows)}, ${n.file_for_identity}, ${n.payment})
            returning *`;
          await audit(tx, actor, 'notary.create', 'notary', r.id);
          return r;
        });
        res.status(201);
        return { notary: notaryView(row) };
      },
    },
    {
      id: 'admin.notaries.update', method: 'PUT', path: '/api/admin/notaries/:id', auth: 'user', access: { platform: 'admin' },
      async handler({ sql, actor, params, body }) {
        const id = uuidFrom(params.id, 'Нотариус не найден');
        const n = notaryFrom(body, true);
        const row = await sql.tx(async (tx) => {
          const cur = await tx.one`select * from notaries where id = ${id} for update`;
          if (!cur) throw new HttpError(404, 'not_found', 'Нотариус не найден');
          const v = { ...cur, ...n };
          const r = await tx.one`update notaries set full_name = ${v.full_name}, address = ${v.address}, contacts = ${v.contacts},
              windows = ${JSON.stringify(v.windows)}, file_for_identity = ${v.file_for_identity}, payment = ${v.payment},
              active = ${v.active}, updated_at = now()
            where id = ${id} returning *`;
          await audit(tx, actor, 'notary.update', 'notary', id, { fields: Object.keys(n) });
          return r;
        });
        return { notary: notaryView(row) };
      },
    },
    {
      id: 'specialist.me.notary', method: 'GET', path: '/api/specialist/me/notary', auth: 'user', access: 'self',
      async handler({ sql, actor, registry }) {
        return { desk: await notaryDesk(sql, actor.id, registry) };
      },
    },
  ];
}
