// Подпись заключения УКЭП и выдача (задачи 2.5, 2.5а). Подпись открепленная — файл не меняется, подпись хранится рядом
// отдельным файлом. По решению Дамира 03.10.2026 (DECISIONS.md):
//   — способы: подпись в кабинете через поставщика подписи или загрузка готового файла подписи (программа любого
//     удостоверяющего центра, «Госключ»); каждая подпись проверяется у поставщика, в дело попадает только верная;
//   — подписывают двое: эксперт (исполнитель, свой файл результата) и организация, от которой он работает (руководитель;
//     src/access/policy.mjs, executorSignOrg). Без организации (частная практика) — только эксперт. Организация
//     подписывает файл, уже подписанный экспертом.
// Для услуг, где модуль требует подпись, результат без всех нужных подписей на проверку не сдаётся (order-ops.mjs).
// Заказчик получает файл и подписи вместе с результатом — после проверки и оплаты (policy.mjs, seesResults) — и может сам
// проверить подписи. Поставщик подписи — src/providers/sign.mjs.
import crypto from 'node:crypto';
import { HttpError } from '../http/core.mjs';
import { orderSides, executorSignOrg } from '../access/policy.mjs';
import { ProviderError } from '../providers/fake.mjs';
import { notify } from '../notify/notify.mjs';
import { orderRef } from '../notify/registry.mjs';
import { signatureFilename } from '../providers/sign.mjs';
import { audit, text } from './util.mjs';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const MAX_SIGNATURE_BYTES = 256 * 1024;
const ROLE_RU = { expert: 'эксперта', org: 'организации' };

export const signatureView = (s) => s && {
  role: s.role,
  method: s.method,
  signer: s.certificate?.subject ?? null,
  org: s.certificate?.org ?? null,
  title: s.certificate?.title ?? null,
  issuer: s.certificate?.issuer ?? null,
  serial: s.certificate?.serial ?? null,
  valid_to: s.certificate?.valid_to ?? null,
  signed_at: s.signed_at,
  test: s.test,
  checked_at: s.checked_at,
  checked_ok: s.checked_ok,
};

// Подписи файлов заявки: document_id → { expert, org } (строки подписи или null).
export async function orderSignatures(sql, orderId) {
  const rows = await sql`select * from document_signatures where order_id = ${orderId}`;
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.document_id)) out.set(r.document_id, { expert: null, org: null });
    out.get(r.document_id)[r.role] = r;
  }
  return out;
}

export const signaturesView = (pair) => ({ expert: signatureView(pair?.expert) ?? null, org: signatureView(pair?.org) ?? null });

async function providerCall(fn) {
  try { return await fn(); } catch (e) {
    if (e instanceof ProviderError) throw new HttpError(502, 'provider', 'Сервис подписи не ответил, попробуйте позже');
    throw e;
  }
}

// Записать проверенную подпись файла. role — 'expert' или 'org'; out — { signature, certificate, test } (кабинет) или
// загруженный файл (upload), который сначала проверяется у поставщика.
async function addSignature({ sql, actor, providers }, { doc, order, role, method, org, out }) {
  const buf = await providers.storage.get(doc.storage_key);
  if (!buf) throw new HttpError(409, 'file_missing', 'Файл не найден в хранилище — загрузите его заново');
  const digest = sha256(buf);
  const signature = out ? out.signature : await (async () => {
    const r = await providerCall(() => providers.sign.sign({
      digest, filename: doc.filename, signer: { id: actor.id, name: String(actor.full_name).trim() }, org,
    }));
    return r.signature;
  })();
  // Подпись сразу проверяется: в дело попадает только верная (и своя, и загруженная).
  const check = await providerCall(() => providers.sign.verify({ digest, signature }));
  if (!check.valid) {
    throw method === 'upload'
      ? new HttpError(400, 'bad_signature', `Подпись не подходит к файлу: ${check.reason ?? 'причина неизвестна'}`)
      : new HttpError(502, 'sign_failed', `Подпись не прошла проверку: ${check.reason ?? 'причина неизвестна'}`);
  }
  // Подпись организации — сертификатом организации (в нём её название).
  if (role === 'org' && !check.certificate?.org) throw new HttpError(400, 'not_org_certificate', 'Это подпись физического лица — для подписи организации нужен сертификат организации (руководителя)');
  const key = `orders/${order.id}/${crypto.randomUUID()}.sig`;
  await providers.storage.put(key, signature, 'application/pkcs7-signature');
  try {
    return await sql.tx(async (tx) => {
      const cur = await tx.one`select status, executor_user_id from orders where id = ${order.id} for update`;
      if (cur.status !== 'in_work' || cur.executor_user_id !== order.executor_user_id) throw new HttpError(409, 'status_changed', 'Статус заявки уже изменился, обновите страницу');
      const alive = await tx.one`select 1 from documents where id = ${doc.id} and deleted_at is null`;
      if (!alive) throw new HttpError(404, 'not_found', 'Не найдено');
      if (role === 'org') {
        // Организация подписывает то, что эксперт уже подписал, и только пока исполнитель работает от неё.
        const expert = await tx.one`select 1 from document_signatures where document_id = ${doc.id} and role = 'expert'`;
        if (!expert) throw new HttpError(409, 'expert_first', 'Сначала файл подписывает эксперт');
        const now = await executorSignOrg(tx, cur.executor_user_id);
        if (now?.id !== org.id) throw new HttpError(409, 'org_changed', 'Исполнитель больше не работает от этой организации');
      }
      const s = await tx.one`
        insert into document_signatures (document_id, order_id, signer_id, provider, digest, storage_key, size_bytes, certificate, test,
                                         checked_ok, role, method, org_id)
        values (${doc.id}, ${order.id}, ${actor.id}, ${providers.sign.name}, ${digest}, ${key}, ${signature.length},
                ${JSON.stringify(check.certificate)}, ${!!(check.test ?? out?.test)}, true, ${role}, ${method}, ${org?.id ?? null})
        on conflict (document_id, role) do nothing returning *`;
      if (!s) throw new HttpError(409, 'already_signed', `Файл уже подписан от ${ROLE_RU[role]}`);
      await audit(tx, actor, role === 'org' ? 'document.sign_org' : 'document.sign', 'document', doc.id,
        { order_id: order.id, provider: providers.sign.name, method, test: s.test, ...(org ? { org_id: org.id } : {}) });
      // Эксперт подписал, а исполнитель работает от организации — руководителям: нужна подпись организации.
      if (role === 'expert') {
        const signOrg = await executorSignOrg(tx, cur.executor_user_id);
        if (signOrg) {
          const heads = (await tx`select user_id from org_members where org_id = ${signOrg.id} and role = 'head'`).map((h) => h.user_id);
          if (heads.length) await notify(tx, 'org_sign_needed', { users: heads, orderId: order.id, orgId: signOrg.id, actor });
        }
      }
      return s;
    });
  } catch (e) {
    await providers.storage.delete(key).catch(() => {});
    throw e;
  }
}

function confirmed(body) {
  if (body?.confirm !== true) throw new HttpError(400, 'confirm_required', 'Подтвердите, что Вы проверили документ и подписываете его');
}

function needName(actor) {
  if (!String(actor.full_name ?? '').trim()) throw new HttpError(400, 'no_name', 'Укажите имя в профиле — оно будет в подписи');
}

function signatureFile(body, req) {
  if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, 'empty_file', 'Файл подписи пустой');
  if (req.get('x-confirm') !== '1') throw new HttpError(400, 'confirm_required', 'Подтвердите, что Вы проверили документ и подписываете его');
  return { signature: body };
}

// Эксперт: свой файл результата, пока дело в работе.
function expertCheck(actor, doc, order) {
  if (doc.kind !== 'result') throw new HttpError(400, 'not_result', 'Подписывается только файл результата');
  if (!orderSides(actor, order).includes('executor') || doc.uploaded_by !== actor.id) throw new HttpError(403, 'forbidden', 'Подписывает исполнитель свой результат');
  if (order.status !== 'in_work') throw new HttpError(409, 'not_in_work', 'Подписать можно, пока дело в работе');
}

// Возвраты руководителя (2.27) по заявке: открытый — пока эксперт не подписал файл заново (или, если файл удалён, пока не
// загрузил новый результат после возврата). Видят только исполнитель и руководитель — заказчику и диспетчеру не отдаются.
export async function orgReturns(sql, orderId, { orgId = null } = {}) {
  const rows = await sql`
    select r.*, u.full_name as head_name, g.name as org_name,
           exists (select 1 from documents d where d.id = r.document_id and d.deleted_at is null) as doc_alive,
           exists (select 1 from document_signatures s where s.document_id = r.document_id and s.role = 'expert' and s.signed_at > r.created_at) as resigned,
           exists (select 1 from documents d where d.order_id = r.order_id and d.kind = 'result' and d.deleted_at is null
                   and d.created_at > r.created_at) as new_file
    from org_returns r join users u on u.id = r.returned_by join organizations g on g.id = r.org_id
    where r.order_id = ${orderId} and (${orgId}::uuid is null or r.org_id = ${orgId}::uuid) order by r.id`;
  return rows.map((r) => ({
    id: Number(r.id),
    at: r.created_at,
    filename: r.filename,
    comment: r.comment,
    org: r.org_name,
    by: r.head_name,
    open: r.doc_alive ? !r.resigned : !r.new_file,
  }));
}

function orgCheck(order) {
  if (order.status !== 'in_work') throw new HttpError(409, 'not_in_work', 'Подписать можно, пока дело в работе');
}

export function signOps() {
  return [
    {
      // Эксперт подписывает свой файл результата в кабинете (через поставщика подписи), с подтверждением.
      id: 'signature.sign', method: 'POST', path: '/api/documents/:id/sign', auth: 'user',
      access: { resource: 'document', param: 'id', need: 'write' },
      async handler(ctx) {
        const { actor, subject: doc, order, body, res } = ctx;
        expertCheck(actor, doc, order);
        confirmed(body);
        needName(actor);
        const row = await addSignature(ctx, { doc, order, role: 'expert', method: 'cabinet', org: null, out: null });
        res.status(201);
        return { signature: signatureView(row) };
      },
    },
    {
      // Эксперт загружает готовый файл открепленной подписи (программа любого УЦ, «Госключ»).
      id: 'signature.upload', method: 'POST', path: '/api/documents/:id/signature/upload', auth: 'user',
      access: { resource: 'document', param: 'id', need: 'write' },
      body: 'raw', limit: MAX_SIGNATURE_BYTES,
      async handler(ctx) {
        const { actor, subject: doc, order, body, req, res } = ctx;
        expertCheck(actor, doc, order);
        const out = signatureFile(body, req);
        const row = await addSignature(ctx, { doc, order, role: 'expert', method: 'upload', org: null, out });
        res.status(201);
        return { signature: signatureView(row) };
      },
    },
    {
      // Руководитель организации исполнителя: дела в работе, где нужна подпись организации, — только файлы результата.
      id: 'orgsign.list', method: 'GET', path: '/api/orgs/:id/signing', auth: 'user',
      access: { resource: 'org', param: 'id', need: 'manage' },
      async handler({ sql, org, registry }) {
        const orders = await sql`
          select o.id, o.module, o.service, o.deadline, u.full_name as executor_name
          from orders o join specialists s on s.user_id = o.executor_user_id and s.org_id = ${org.id}
          join org_members m on m.org_id = s.org_id and m.user_id = s.user_id
          join users u on u.id = o.executor_user_id
          where o.status = 'in_work' order by o.deadline nulls last, o.id`;
        const items = [];
        for (const o of orders) {
          const docs = await sql`select id, filename, size_bytes from documents where order_id = ${o.id} and kind = 'result'
                                 and deleted_at is null and uploaded_by = (select executor_user_id from orders where id = ${o.id}) order by created_at`;
          if (!docs.length) continue;
          const signs = await orderSignatures(sql, o.id);
          const returns = await orgReturns(sql, o.id, { orgId: org.id });
          items.push({
            order_ref: orderRef(o.id),
            service: registry.service(o.module, o.service)?.service.name ?? o.service,
            executor: o.executor_name,
            deadline: o.deadline,
            documents: docs.map((d) => ({ id: d.id, filename: d.filename, size_bytes: Number(d.size_bytes), signatures: signaturesView(signs.get(d.id)) })),
            // История возвратов эксперту (2.27) — только этой организации.
            returns: returns.map(({ id, at, filename, comment, by, open }) => ({ id, at, filename, comment, by, open })),
          });
        }
        return { items };
      },
    },
    {
      id: 'orgsign.link', method: 'GET', path: '/api/org-documents/:id/link', auth: 'user',
      access: { resource: 'orgDocument', param: 'id', need: 'read' },
      async handler({ sql, actor, subject: doc, providers }) {
        const url = await providers.storage.link(doc.storage_key, { filename: doc.filename });
        await audit(sql, actor, 'document.link', 'document', doc.id, { as: 'org' });
        return { url };
      },
    },
    {
      // Руководитель подписывает файл от организации в кабинете — после подписи эксперта, с подтверждением.
      id: 'orgsign.sign', method: 'POST', path: '/api/org-documents/:id/sign', auth: 'user',
      access: { resource: 'orgDocument', param: 'id', need: 'write' },
      async handler(ctx) {
        const { actor, subject: doc, order, signOrg, body, res } = ctx;
        orgCheck(order);
        confirmed(body);
        needName(actor);
        const row = await addSignature(ctx, { doc, order, role: 'org', method: 'cabinet', org: signOrg, out: null });
        res.status(201);
        return { signature: signatureView(row) };
      },
    },
    {
      // Руководитель загружает готовую подпись организации (сертификат организации из программы УЦ).
      id: 'orgsign.upload', method: 'POST', path: '/api/org-documents/:id/signature/upload', auth: 'user',
      access: { resource: 'orgDocument', param: 'id', need: 'write' },
      body: 'raw', limit: MAX_SIGNATURE_BYTES,
      async handler(ctx) {
        const { subject: doc, order, signOrg, body, req, res } = ctx;
        orgCheck(order);
        const out = signatureFile(body, req);
        const row = await addSignature(ctx, { doc, order, role: 'org', method: 'upload', org: signOrg, out });
        res.status(201);
        return { signature: signatureView(row) };
      },
    },
    {
      // Руководитель возвращает файл эксперту с замечанием до подписи организации (2.27): подпись эксперта снимается
      // (поправить и подписать заново), эксперту — уведомление; замечание и история — у эксперта в деле и в «Подписи
      // организации». Заказчик и диспетчер возвратов не видят.
      id: 'orgsign.return', method: 'POST', path: '/api/org-documents/:id/return', auth: 'user',
      access: { resource: 'orgDocument', param: 'id', need: 'write' },
      async handler({ sql, actor, subject: doc, order, signOrg, body, res }) {
        orgCheck(order);
        const comment = text(body?.comment, 'Замечание', 2000);
        const row = await sql.tx(async (tx) => {
          const cur = await tx.one`select status, executor_user_id from orders where id = ${order.id} for update`;
          if (cur.status !== 'in_work' || cur.executor_user_id !== order.executor_user_id) throw new HttpError(409, 'status_changed', 'Статус заявки уже изменился, обновите страницу');
          const alive = await tx.one`select 1 from documents where id = ${doc.id} and deleted_at is null`;
          if (!alive) throw new HttpError(404, 'not_found', 'Не найдено');
          const now = await executorSignOrg(tx, cur.executor_user_id);
          if (now?.id !== signOrg.id) throw new HttpError(409, 'org_changed', 'Исполнитель больше не работает от этой организации');
          const signs = await tx`select * from document_signatures where document_id = ${doc.id} for update`;
          if (signs.some((x) => x.role === 'org')) throw new HttpError(409, 'already_signed', 'Файл уже подписан от организации — вернуть нельзя');
          const expert = signs.find((x) => x.role === 'expert');
          if (!expert) throw new HttpError(409, 'not_signed', 'Эксперт ещё не подписал файл — возвращать нечего');
          // Подпись эксперта снимается: строка удаляется, файл подписи остаётся в хранилище (ключ — в истории возврата).
          await tx`delete from document_signatures where id = ${expert.id}`;
          const r = await tx.one`
            insert into org_returns (order_id, document_id, org_id, executor_user_id, returned_by, filename, comment, signature_key)
            values (${order.id}, ${doc.id}, ${signOrg.id}, ${cur.executor_user_id}, ${actor.id}, ${doc.filename}, ${comment}, ${expert.storage_key})
            returning *`;
          await audit(tx, actor, 'document.org_return', 'document', doc.id, { order_id: order.id, org_id: signOrg.id, return_id: Number(r.id) });
          await notify(tx, 'org_returned', { users: [cur.executor_user_id], orderId: order.id, actor });
          return r;
        });
        res.status(201);
        return { return: { id: Number(row.id), at: row.created_at, filename: row.filename, comment: row.comment } };
      },
    },
    {
      // Проверить подписи файла: файл из хранилища сверяется с каждой подписью у поставщика. Может каждый, кто видит файл.
      id: 'signature.verify', method: 'POST', path: '/api/documents/:id/signature/verify', auth: 'user',
      access: { resource: 'document', param: 'id', need: 'read' },
      async handler({ sql, actor, subject: doc, providers }) {
        const rows = await sql`select * from document_signatures where document_id = ${doc.id} order by role`;
        if (!rows.length) throw new HttpError(404, 'not_signed', 'Файл не подписан');
        const buf = await providers.storage.get(doc.storage_key);
        const results = [];
        for (const s of rows) {
          const sig = await providers.storage.get(s.storage_key);
          const r = !buf || !sig
            ? { valid: false, reason: 'Файл или подпись не найдены в хранилище' }
            : await providerCall(() => providers.sign.verify({ digest: sha256(buf), signature: sig }));
          const u = await sql.one`update document_signatures set checked_at = now(), checked_ok = ${!!r.valid} where id = ${s.id} returning *`;
          results.push({ row: u, valid: !!r.valid, reason: r.valid ? null : r.reason ?? 'Подпись неверна' });
        }
        await audit(sql, actor, 'document.verify', 'document', doc.id, { valid: results.every((x) => x.valid) });
        const bad = results.find((x) => !x.valid);
        const pair = { expert: null, org: null };
        for (const x of results) pair[x.row.role] = x.row;
        return {
          valid: !bad,
          reason: bad ? `Подпись ${ROLE_RU[bad.row.role]}: ${bad.reason}` : null,
          signatures: signaturesView(pair),
        };
      },
    },
    {
      // Скачать файл подписи (.sig) — временной ссылкой, как и сам файл. ?role=org — подпись организации.
      id: 'signature.link', method: 'GET', path: '/api/documents/:id/signature/link', auth: 'user',
      access: { resource: 'document', param: 'id', need: 'read' },
      async handler({ sql, actor, subject: doc, providers, req }) {
        const role = req.query?.role === 'org' ? 'org' : 'expert';
        const s = await sql.one`select * from document_signatures where document_id = ${doc.id} and role = ${role}`;
        if (!s) throw new HttpError(404, 'not_signed', 'Файл не подписан');
        const url = await providers.storage.link(s.storage_key, { filename: signatureFilename(doc.filename, role) });
        await audit(sql, actor, 'signature.link', 'document', doc.id, { role });
        return { url };
      },
    },
  ];
}
