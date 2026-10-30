// Аккредитации организации в банках (2.451): отчёт для ипотеки или залога банк принимает только от оценщика или
// организации, аккредитованных в нём. Руководитель вносит банк, номер и дату решения, срок и копию; сотрудники видят
// список и скачивают копии; служебные платформы и посторонние — «не найдено». Аккредитации самого эксперта — в его
// досье (вид bank, src/dossier/dossier.mjs). Запись не удаляется, а скрывается: по ней могли сдать отчёт.
import crypto from 'node:crypto';
import { HttpError } from '../http/core.mjs';
import { roleIn } from '../access/policy.mjs';
import { bankList, termState } from '../dossier/dossier.mjs';
import { accreditationFrom } from './dossier-ops.mjs';
import { audit, text } from './util.mjs';

const MAX_FILE_BYTES = 3 * 1024 * 1024; // как у копий досье (2.49)
const MAX_ITEMS = 50;

async function view(sql, actor, org, registry) {
  const rows = await sql`select *, to_char(issued_on, 'YYYY-MM-DD') as issued, to_char(valid_until, 'YYYY-MM-DD') as until
                         from org_accreditations where org_id = ${org.id} and deleted_at is null order by title, id`;
  return {
    items: rows.map((r) => ({
      id: String(r.id), bank: r.bank, title: r.title, number: r.number ?? null, issued_on: r.issued ?? null,
      valid_until: r.until ?? null, state: termState(r.until ?? null),
      file: r.file_key ? { name: r.file_name, mime: r.file_mime, size_bytes: r.file_size } : null,
    })),
    banks: bankList(registry),
    manage: roleIn(actor, org.id) === 'head',
  };
}

// Своя запись организации — или «не найдено».
async function orgItem(sql, org, id, { lock = false } = {}) {
  if (!/^\d{1,18}$/.test(String(id ?? ''))) throw new HttpError(404, 'not_found', 'Аккредитация не найдена');
  const row = lock
    ? await sql.one`select * from org_accreditations where id = ${id} and org_id = ${org.id} and deleted_at is null for update`
    : await sql.one`select * from org_accreditations where id = ${id} and org_id = ${org.id} and deleted_at is null`;
  if (!row) throw new HttpError(404, 'not_found', 'Аккредитация не найдена');
  return row;
}

export function accreditationOps() {
  return [
    {
      id: 'orgs.accreditations.get', method: 'GET', path: '/api/orgs/:id/accreditations', auth: 'user',
      access: { resource: 'orgTemplate', param: 'id', need: 'read' },
      handler: ({ sql, actor, org, registry }) => view(sql, actor, org, registry),
    },
    {
      id: 'orgs.accreditations.add', method: 'POST', path: '/api/orgs/:id/accreditations', auth: 'user',
      access: { resource: 'orgTemplate', param: 'id', need: 'manage' },
      async handler({ sql, actor, org, body, res, registry }) {
        const f = accreditationFrom(body, bankList(registry));
        const id = await sql.tx(async (tx) => {
          await tx`select 1 from organizations where id = ${org.id} for update`;
          const n = await tx.one`select count(*)::int as n from org_accreditations where org_id = ${org.id} and deleted_at is null`;
          if (n.n >= MAX_ITEMS) throw new HttpError(409, 'too_many', `Аккредитаций — не больше ${MAX_ITEMS}`);
          const row = await tx.one`insert into org_accreditations (org_id, bank, title, number, issued_on, valid_until, created_by)
                                   values (${org.id}, ${f.bank}, ${f.title}, ${f.number}, ${f.issued_on}, ${f.valid_until}, ${actor.id}) returning id`;
          await audit(tx, actor, 'org.accreditation.add', 'org', org.id, { item: String(row.id), bank: f.bank });
          return String(row.id);
        });
        res.status(201);
        return { id, ...(await view(sql, actor, org, registry)) };
      },
    },
    {
      // Продлили аккредитацию — новый номер и срок.
      id: 'orgs.accreditations.update', method: 'PUT', path: '/api/orgs/:id/accreditations/:acc', auth: 'user',
      access: { resource: 'orgTemplate', param: 'id', need: 'manage' },
      async handler({ sql, actor, org, params, body, registry }) {
        await sql.tx(async (tx) => {
          // Сначала — своя ли запись: чужая выглядит как несуществующая, что бы ни пришло в теле.
          const cur = await orgItem(tx, org, params.acc, { lock: true });
          const f = accreditationFrom(body, bankList(registry));
          await tx`update org_accreditations set bank = ${f.bank}, title = ${f.title}, number = ${f.number}, issued_on = ${f.issued_on},
                   valid_until = ${f.valid_until}, updated_at = now() where id = ${cur.id}`;
          await audit(tx, actor, 'org.accreditation.update', 'org', org.id, { item: String(cur.id), bank: f.bank });
        });
        return view(sql, actor, org, registry);
      },
    },
    {
      id: 'orgs.accreditations.remove', method: 'DELETE', path: '/api/orgs/:id/accreditations/:acc', auth: 'user',
      access: { resource: 'orgTemplate', param: 'id', need: 'manage' },
      async handler({ sql, actor, org, params, registry }) {
        await sql.tx(async (tx) => {
          const cur = await orgItem(tx, org, params.acc, { lock: true });
          await tx`update org_accreditations set deleted_at = now() where id = ${cur.id}`;
          await audit(tx, actor, 'org.accreditation.remove', 'org', org.id, { item: String(cur.id) });
        });
        return view(sql, actor, org, registry);
      },
    },
    {
      // Копия решения банка или письма об аккредитации; новая заменяет прежнюю.
      id: 'orgs.accreditations.file', method: 'POST', path: '/api/orgs/:id/accreditations/:acc/file', auth: 'user',
      access: { resource: 'orgTemplate', param: 'id', need: 'manage' },
      body: 'raw', limit: MAX_FILE_BYTES,
      async handler({ sql, actor, org, params, req, body, providers, registry }) {
        const cur = await orgItem(sql, org, params.acc);
        if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, 'empty_file', 'Файл пустой');
        let filename;
        try { filename = decodeURIComponent(req.get('x-file-name') || ''); } catch { filename = ''; }
        const name = text(String(filename).replace(/[\\/\u0000-\u001f]/g, '_'), 'Имя файла', 255);
        const mime = (req.get('content-type') || 'application/octet-stream').split(';')[0].trim().slice(0, 100);
        const key = `orgs/${org.id}/accreditations/${crypto.randomUUID()}`;
        await providers.storage.put(key, body, mime);
        let old;
        try {
          old = await sql.tx(async (tx) => {
            const row = await orgItem(tx, org, cur.id, { lock: true });
            await tx`update org_accreditations set file_key = ${key}, file_name = ${name}, file_mime = ${mime}, file_size = ${body.length},
                     updated_at = now() where id = ${row.id}`;
            await audit(tx, actor, 'org.accreditation.file', 'org', org.id, { item: String(row.id), size: body.length });
            return row.file_key;
          });
        } catch (e) {
          await providers.storage.delete(key).catch(() => {});
          throw e;
        }
        if (old) await providers.storage.delete(old).catch(() => {});
        return view(sql, actor, org, registry);
      },
    },
    {
      id: 'orgs.accreditations.file.link', method: 'GET', path: '/api/orgs/:id/accreditations/:acc/file', auth: 'user',
      access: { resource: 'orgTemplate', param: 'id', need: 'read' },
      async handler({ sql, org, params, providers }) {
        const cur = await orgItem(sql, org, params.acc);
        if (!cur.file_key) throw new HttpError(404, 'not_found', 'Копия не загружена');
        return { url: await providers.storage.link(cur.file_key, { filename: cur.file_name }) };
      },
    },
  ];
}
