// Шаблон отчёта организации (2.29): руководитель загружает .docx (стили, шапка, логотип, реквизиты) — черновик эксперта,
// работающего от организации, собирается в нём (src/docs/report.mjs). Только .docx без макросов, не больше 3 МБ;
// видят и скачивают руководитель и сотрудники организации, служебные платформы и посторонние — «не найдено».
import crypto from 'node:crypto';
import { HttpError } from '../http/core.mjs';
import { roleIn } from '../access/policy.mjs';
import { DOCX_MIME, TEMPLATE_MAX_BYTES, TEMPLATE_MARK, checkTemplate } from '../docs/docx.mjs';
import { audit, text } from './util.mjs';

const view = (t) => t && { filename: t.filename, size_bytes: t.size_bytes, marked: t.marked, uploaded_at: t.uploaded_at };

export function templateOps() {
  return [
    {
      id: 'orgs.template.get', method: 'GET', path: '/api/orgs/:id/template', auth: 'user',
      access: { resource: 'orgTemplate', param: 'id', need: 'read' },
      async handler({ sql, actor, org }) {
        const t = await sql.one`select * from org_templates where org_id = ${org.id}`;
        return { template: view(t), manage: roleIn(actor, org.id) === 'head', mark: TEMPLATE_MARK, max_bytes: TEMPLATE_MAX_BYTES };
      },
    },
    {
      // Загрузить шаблон; прежний заменяется (его файл убирается из хранилища после записи нового).
      id: 'orgs.template.put', method: 'POST', path: '/api/orgs/:id/template', auth: 'user',
      access: { resource: 'orgTemplate', param: 'id', need: 'manage' },
      body: 'raw', limit: TEMPLATE_MAX_BYTES + 1024,
      async handler({ sql, actor, org, req, body, providers, res }) {
        let filename;
        try { filename = decodeURIComponent(req.get('x-file-name') || ''); } catch { filename = ''; }
        const name = text(String(filename).replace(/[\\/\u0000-\u001f]/g, '_'), 'Имя файла', 255);
        const { marked } = checkTemplate(body, name);
        const key = `orgs/${org.id}/template/${crypto.randomUUID()}`;
        await providers.storage.put(key, body, DOCX_MIME);
        let old;
        try {
          old = await sql.tx(async (tx) => {
            await tx`select 1 from organizations where id = ${org.id} for update`;
            const prev = await tx.one`select storage_key from org_templates where org_id = ${org.id}`;
            await tx`insert into org_templates (org_id, storage_key, filename, size_bytes, marked, uploaded_by)
                     values (${org.id}, ${key}, ${name}, ${body.length}, ${marked}, ${actor.id})
                     on conflict (org_id) do update set storage_key = excluded.storage_key, filename = excluded.filename,
                       size_bytes = excluded.size_bytes, marked = excluded.marked, uploaded_by = excluded.uploaded_by, uploaded_at = now()`;
            await audit(tx, actor, 'org.template.put', 'org', org.id, { filename: name, size: body.length });
            return prev;
          });
        } catch (e) {
          await providers.storage.delete(key).catch(() => {});
          throw e;
        }
        if (old) await providers.storage.delete(old.storage_key).catch(() => {});
        res.status(201);
        return { template: view(await sql.one`select * from org_templates where org_id = ${org.id}`) };
      },
    },
    {
      id: 'orgs.template.delete', method: 'DELETE', path: '/api/orgs/:id/template', auth: 'user',
      access: { resource: 'orgTemplate', param: 'id', need: 'manage' },
      async handler({ sql, actor, org, providers }) {
        const old = await sql.tx(async (tx) => {
          const t = await tx.one`delete from org_templates where org_id = ${org.id} returning storage_key`;
          if (!t) throw new HttpError(404, 'not_found', 'Шаблон не загружен');
          await audit(tx, actor, 'org.template.delete', 'org', org.id);
          return t;
        });
        await providers.storage.delete(old.storage_key).catch(() => {});
      },
    },
    {
      id: 'orgs.template.file', method: 'GET', path: '/api/orgs/:id/template/file', auth: 'user',
      access: { resource: 'orgTemplate', param: 'id', need: 'read' },
      async handler({ sql, actor, org, providers }) {
        const t = await sql.one`select * from org_templates where org_id = ${org.id}`;
        if (!t) throw new HttpError(404, 'not_found', 'Шаблон не загружен');
        await audit(sql, actor, 'org.template.link', 'org', org.id);
        return { url: await providers.storage.link(t.storage_key, { filename: t.filename }) };
      },
    },
  ];
}
