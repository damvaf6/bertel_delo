// Подпись заключения УКЭП и выдача (задача 2.5). Исполнитель подписывает свой файл результата, пока дело в работе;
// подпись открепленная — файл не меняется, подпись хранится рядом отдельным файлом. Для услуг, где модуль требует подпись,
// результат без подписи на проверку не сдаётся (order-ops.mjs). Заказчик получает файл и подпись вместе с результатом —
// после проверки и оплаты (policy.mjs, seesResults) — и может сам проверить подпись. Поставщик подписи — src/providers/sign.mjs.
import crypto from 'node:crypto';
import { HttpError } from '../http/core.mjs';
import { orderSides } from '../access/policy.mjs';
import { ProviderError } from '../providers/fake.mjs';
import { audit } from './util.mjs';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export const signatureView = (s) => s && {
  signer: s.certificate?.subject ?? null,
  issuer: s.certificate?.issuer ?? null,
  serial: s.certificate?.serial ?? null,
  valid_to: s.certificate?.valid_to ?? null,
  signed_at: s.signed_at,
  test: s.test,
  checked_at: s.checked_at,
  checked_ok: s.checked_ok,
};

// Подписи файлов заявки: document_id → строка подписи.
export async function orderSignatures(sql, orderId) {
  const rows = await sql`select * from document_signatures where order_id = ${orderId}`;
  return new Map(rows.map((r) => [r.document_id, r]));
}

async function signatureOf(sql, docId) {
  const s = await sql.one`select * from document_signatures where document_id = ${docId}`;
  if (!s) throw new HttpError(404, 'not_signed', 'Файл не подписан');
  return s;
}

async function providerCall(fn) {
  try { return await fn(); } catch (e) {
    if (e instanceof ProviderError) throw new HttpError(502, 'provider', 'Сервис подписи не ответил, попробуйте позже');
    throw e;
  }
}

export function signOps() {
  return [
    {
      // Подписать файл результата. Только исполнитель, свой файл, пока дело в работе, с подтверждением.
      id: 'signature.sign', method: 'POST', path: '/api/documents/:id/sign', auth: 'user',
      access: { resource: 'document', param: 'id', need: 'write' },
      async handler({ sql, actor, subject: doc, order, providers, body, res }) {
        if (doc.kind !== 'result') throw new HttpError(400, 'not_result', 'Подписывается только файл результата');
        if (!orderSides(actor, order).includes('executor') || doc.uploaded_by !== actor.id) throw new HttpError(403, 'forbidden', 'Подписывает исполнитель свой результат');
        if (order.status !== 'in_work') throw new HttpError(409, 'not_in_work', 'Подписать можно, пока дело в работе');
        if (body?.confirm !== true) throw new HttpError(400, 'confirm_required', 'Подтвердите, что Вы проверили документ и подписываете его');
        const name = String(actor.full_name ?? '').trim();
        if (!name) throw new HttpError(400, 'no_name', 'Укажите имя в профиле — оно будет в подписи');
        if (await sql.one`select 1 from document_signatures where document_id = ${doc.id}`) throw new HttpError(409, 'already_signed', 'Файл уже подписан');
        const buf = await providers.storage.get(doc.storage_key);
        if (!buf) throw new HttpError(409, 'file_missing', 'Файл не найден в хранилище — загрузите его заново');
        const digest = sha256(buf);
        const out = await providerCall(() => providers.sign.sign({ digest, filename: doc.filename, signer: { id: actor.id, name } }));
        // Подпись сразу проверяется: в дело попадает только верная.
        const check = await providerCall(() => providers.sign.verify({ digest, signature: out.signature }));
        if (!check.valid) throw new HttpError(502, 'sign_failed', `Подпись не прошла проверку: ${check.reason ?? 'причина неизвестна'}`);
        const key = `orders/${order.id}/${crypto.randomUUID()}.sig`;
        await providers.storage.put(key, out.signature, out.mime);
        try {
          const row = await sql.tx(async (tx) => {
            const cur = await tx.one`select status, executor_user_id from orders where id = ${order.id} for update`;
            if (cur.status !== 'in_work' || cur.executor_user_id !== actor.id) throw new HttpError(409, 'status_changed', 'Статус заявки уже изменился, обновите страницу');
            const alive = await tx.one`select 1 from documents where id = ${doc.id} and deleted_at is null`;
            if (!alive) throw new HttpError(404, 'not_found', 'Не найдено');
            const s = await tx.one`
              insert into document_signatures (document_id, order_id, signer_id, provider, digest, storage_key, size_bytes, certificate, test, checked_ok)
              values (${doc.id}, ${order.id}, ${actor.id}, ${providers.sign.name}, ${digest}, ${key}, ${out.signature.length},
                      ${JSON.stringify(out.certificate)}, ${!!out.test}, true)
              on conflict (document_id) do nothing returning *`;
            if (!s) throw new HttpError(409, 'already_signed', 'Файл уже подписан');
            await audit(tx, actor, 'document.sign', 'document', doc.id, { order_id: order.id, provider: providers.sign.name, test: !!out.test });
            return s;
          });
          res.status(201);
          return { signature: signatureView(row) };
        } catch (e) {
          await providers.storage.delete(key).catch(() => {});
          throw e;
        }
      },
    },
    {
      // Проверить подпись: файл из хранилища сверяется с подписью у поставщика. Может каждый, кто видит файл.
      id: 'signature.verify', method: 'POST', path: '/api/documents/:id/signature/verify', auth: 'user',
      access: { resource: 'document', param: 'id', need: 'read' },
      async handler({ sql, actor, subject: doc, providers }) {
        const s = await signatureOf(sql, doc.id);
        const [buf, sig] = await Promise.all([providers.storage.get(doc.storage_key), providers.storage.get(s.storage_key)]);
        const r = !buf || !sig
          ? { valid: false, reason: 'Файл или подпись не найдены в хранилище' }
          : await providerCall(() => providers.sign.verify({ digest: sha256(buf), signature: sig }));
        const row = await sql.tx(async (tx) => {
          const u = await tx.one`update document_signatures set checked_at = now(), checked_ok = ${!!r.valid} where id = ${s.id} returning *`;
          await audit(tx, actor, 'document.verify', 'document', doc.id, { valid: !!r.valid });
          return u;
        });
        return { valid: !!r.valid, reason: r.valid ? null : r.reason ?? 'Подпись неверна', signature: signatureView(row) };
      },
    },
    {
      // Скачать файл подписи (.sig) — временной ссылкой, как и сам файл.
      id: 'signature.link', method: 'GET', path: '/api/documents/:id/signature/link', auth: 'user',
      access: { resource: 'document', param: 'id', need: 'read' },
      async handler({ sql, actor, subject: doc, providers }) {
        const s = await signatureOf(sql, doc.id);
        const url = await providers.storage.link(s.storage_key, { filename: `${doc.filename}.sig` });
        await audit(sql, actor, 'signature.link', 'document', doc.id);
        return { url };
      },
    },
  ];
}
