// Свои заготовки абзацев у эксперта (2.87): допущения, оговорки, формулировки выводов. Эксперт сохраняет абзац один раз
// (или выделяет его в черновике) и потом вставляет в черновик любого своего дела одной кнопкой — в то место, где стоит
// курсор. Заготовки видит и меняет только сам эксперт; в дело попадает только то, что он вставил и сохранил сам.
import { HttpError } from '../http/core.mjs';
import { audit, oneOf, text } from './util.mjs';

export const SNIPPET_KINDS = {
  assumption: 'Допущения',
  reservation: 'Оговорки и ограничения',
  conclusion: 'Формулировки выводов',
  other: 'Другое',
};
const MAX_SNIPPETS = 100;
const TITLE_MAX = 120;
const BODY_MAX = 5000;

async function requireSpecialist(sql, actor) {
  const sp = await sql.one`select 1 from specialists where user_id = ${actor.id}`;
  if (!sp) throw new HttpError(404, 'not_found', 'Вы не специалист');
}

// Своя заготовка — или «не найдено» (чужая выглядит так же, как несуществующая).
async function ownSnippet(sql, actor, id) {
  if (!/^\d{1,18}$/.test(String(id ?? ''))) throw new HttpError(404, 'not_found', 'Заготовка не найдена');
  const row = await sql.one`select * from snippets where id = ${id} and user_id = ${actor.id} and deleted_at is null for update`;
  if (!row) throw new HttpError(404, 'not_found', 'Заготовка не найдена');
  return row;
}

const fieldsFrom = (body) => ({
  kind: oneOf(String(body?.kind ?? ''), Object.keys(SNIPPET_KINDS), 'Вид'),
  title: text(body?.title, 'Название', TITLE_MAX),
  body: text(String(body?.body ?? '').replace(/\r\n/g, '\n'), 'Текст', BODY_MAX),
});

async function view(sql, userId) {
  const rows = await sql`select id, kind, title, body, updated_at from snippets where user_id = ${userId} and deleted_at is null
                         order by array_position(array['assumption','reservation','conclusion','other'], kind), lower(title), id`;
  return {
    snippets: rows.map((r) => ({ ...r, id: String(r.id), kind_name: SNIPPET_KINDS[r.kind] })),
    kinds: Object.entries(SNIPPET_KINDS).map(([id, name]) => ({ id, name })),
  };
}

export function snippetOps() {
  return [
    {
      id: 'snippets.list', method: 'GET', path: '/api/specialist/me/snippets', auth: 'user', access: 'self',
      async handler({ sql, actor }) {
        await requireSpecialist(sql, actor);
        return view(sql, actor.id);
      },
    },
    {
      id: 'snippets.add', method: 'POST', path: '/api/specialist/me/snippets', auth: 'user', access: 'self',
      async handler({ sql, actor, body, res }) {
        await requireSpecialist(sql, actor);
        const f = fieldsFrom(body);
        const id = await sql.tx(async (tx) => {
          await tx`select 1 from specialists where user_id = ${actor.id} for update`;
          const n = await tx.one`select count(*)::int as n from snippets where user_id = ${actor.id} and deleted_at is null`;
          if (n.n >= MAX_SNIPPETS) throw new HttpError(409, 'too_many', `Заготовок — не больше ${MAX_SNIPPETS}`);
          const row = await tx.one`insert into snippets (user_id, kind, title, body) values (${actor.id}, ${f.kind}, ${f.title}, ${f.body}) returning id`;
          await audit(tx, actor, 'snippets.add', 'snippet', row.id, { kind: f.kind });
          return String(row.id);
        });
        res.status(201);
        return { id, ...(await view(sql, actor.id)) };
      },
    },
    {
      id: 'snippets.update', method: 'PUT', path: '/api/specialist/me/snippets/:snippet', auth: 'user', access: 'self',
      async handler({ sql, actor, params, body }) {
        const f = fieldsFrom(body);
        await sql.tx(async (tx) => {
          const cur = await ownSnippet(tx, actor, params.snippet);
          await tx`update snippets set kind = ${f.kind}, title = ${f.title}, body = ${f.body}, updated_at = now() where id = ${cur.id}`;
          await audit(tx, actor, 'snippets.update', 'snippet', cur.id, { kind: f.kind });
        });
        return view(sql, actor.id);
      },
    },
    {
      // Убрать заготовку из списка. В делах, куда её уже вставили, текст остаётся — он часть черновика.
      id: 'snippets.remove', method: 'DELETE', path: '/api/specialist/me/snippets/:snippet', auth: 'user', access: 'self',
      async handler({ sql, actor, params }) {
        await sql.tx(async (tx) => {
          const cur = await ownSnippet(tx, actor, params.snippet);
          await tx`update snippets set deleted_at = now() where id = ${cur.id}`;
          await audit(tx, actor, 'snippets.remove', 'snippet', cur.id, { kind: cur.kind });
        });
        return view(sql, actor.id);
      },
    },
  ];
}
