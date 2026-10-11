// Сертификат платформы к переводу без нотариуса (задача 2а.5, задача штаба 3f617197). Переводчик, пока дело у него в работе,
// выдаёт сертификат к своему файлу перевода: номер, отпечаток файла (SHA-256), QR со ссылкой на открытую страницу
// проверки (public/proverka.html). Выдать можно только с проверенным администратором документом о знании языка заявки —
// «квалификация переводчика проверена». Лист «Сертификат перевода» (Word) видят те, кому виден сам файл перевода.
// На странице проверки — только номер, дата, языки, ФИО переводчика и отпечаток; без заказчика, имени файла и текста.
import crypto from 'node:crypto';
import { HttpError, rateLimiter } from '../http/core.mjs';
import { orderSides } from '../access/policy.mjs';
import { DOCX_MIME } from '../docs/docx.mjs';
import { audit, sendFile } from './util.mjs';
import {
  caseCertificate, certificateNumber, certificateSheet, codeFrom, newCode, publicCertificate, verifyUrl,
} from '../translation/certificate.mjs';

// Адрес площадки для ссылки в QR: PUBLIC_URL, а без него (стенд, автотесты) — адрес, с которого пришёл запрос.
export const siteOrigin = (cfg, req) => cfg?.publicUrl || `${req.protocol}://${req.get('host')}`;

// Сертификаты файлов дела: document_id → запись (последняя по файлу).
export async function orderCertificates(sql, orderId) {
  const rows = await sql`select * from certificates where order_id = ${orderId}`;
  return new Map(rows.map((r) => [r.document_id, r]));
}

// Можно ли выдать сертификат к файлу: услуга с сертификатом, дело в работе у вошедшего, файл — его результат.
// Возвращает правило услуги (язык, направление) или причину отказа.
export function certificateRule(registry, actor, order, doc) {
  const rule = registry.certificate(order.module, order.service, order.fields);
  if (!rule) return { error: 'К этой услуге сертификат платформы не выдаётся' };
  if (doc.kind !== 'result' || doc.uploaded_by !== actor.id || order.executor_user_id !== actor.id
      || !orderSides(actor, order).includes('executor')) return { error: 'Сертификат выдаёт переводчик к своему файлу перевода' };
  if (order.status !== 'in_work') return { error: 'Сертификат выдаётся, пока дело в работе' };
  return { rule };
}

// Проверенный документ о знании языка заявки у переводчика (2а.3) — его название и номер для листа.
async function languageDoc(sql, userId, language) {
  return sql.one`select title, number from dossier_items where user_id = ${userId} and kind = 'language' and language = ${language}
                 and verified_at is not null and deleted_at is null order by verified_at desc limit 1`;
}

export function certificateOps() {
  const checkLimit = rateLimiter({ windowMs: 10 * 60_000, max: 120 });
  return [
    {
      id: 'certificates.issue', method: 'POST', path: '/api/documents/:id/certificate', auth: 'user',
      access: { resource: 'document', param: 'id', need: 'write' },
      async handler({ sql, actor, subject: doc, order, registry, providers, cfg, req, res }) {
        const { rule, error } = certificateRule(registry, actor, order, doc);
        if (error) throw new HttpError(409, 'certificate_unavailable', error);
        const lang = await languageDoc(sql, actor.id, rule.language);
        if (!lang) throw new HttpError(409, 'language_unverified', `Нужен проверенный документ о знании языка («${rule.language_name}»): добавьте его в досье — администратор проверит`);
        const name = String(actor.full_name ?? '').trim();
        if (!name) throw new HttpError(409, 'no_name', 'Укажите в профиле фамилию, имя и отчество — они будут на сертификате');
        const buf = await providers.storage.get(doc.storage_key);
        if (!buf) throw new HttpError(409, 'file_missing', 'Файл перевода не найден в хранилище — загрузите его заново');
        const sha = crypto.createHash('sha256').update(buf).digest('hex');
        const qualification = [lang.title, lang.number ? `№ ${lang.number}` : ''].filter(Boolean).join(' ').slice(0, 400);
        const row = await sql.tx(async (tx) => {
          const had = await tx.one`select * from certificates where document_id = ${doc.id}`;
          if (had) return { cert: had, fresh: false };
          const { n } = await tx.one`select nextval('certificate_seq')::int as n`;
          const cert = await tx.one`insert into certificates (number, code, document_id, order_id, translator_id, translator_name,
                language, direction, qualification, sha256)
            values (${certificateNumber(n)}, ${newCode()}, ${doc.id}, ${order.id}, ${actor.id}, ${name.slice(0, 200)},
                    ${rule.language_name}, ${rule.direction}, ${qualification}, ${sha})
            returning *`;
          await audit(tx, actor, 'certificate.issue', 'document', doc.id, { number: cert.number });
          return { cert, fresh: true };
        });
        if (row.fresh) res.status(201);
        return { certificate: caseCertificate(row.cert, siteOrigin(cfg, req)) };
      },
    },
    {
      // Лист «Сертификат перевода» (Word): тем, кому виден файл перевода (переводчику, заказчику после проверки, платформе).
      id: 'certificates.sheet', method: 'GET', path: '/api/documents/:id/certificate', auth: 'user',
      access: { resource: 'document', param: 'id', need: 'read' },
      async handler({ sql, actor, subject: doc, providers, cfg, req, res }) {
        const cert = await sql.one`select * from certificates where document_id = ${doc.id}`;
        if (!cert) throw new HttpError(404, 'not_found', 'Сертификата к этому файлу нет');
        if (cert.revoked_at) throw new HttpError(409, 'revoked', 'Сертификат отозван');
        const buf = certificateSheet(cert, { url: verifyUrl(siteOrigin(cfg, req), cert.code), filename: doc.filename });
        await audit(sql, actor, 'certificate.sheet', 'document', doc.id);
        return sendFile(res, providers, { buf, filename: `Сертификат ${cert.number}.docx`, mime: DOCX_MIME });
      },
    },
    {
      id: 'certificates.check', method: 'GET', path: '/api/certificates/:code', auth: 'public',
      publicReason: 'Страница проверки сертификата перевода: открывает любой, у кого лист или QR-код (без входа)',
      rateLimit: (ip) => checkLimit(ip),
      async handler({ sql, params }) {
        const code = codeFrom(params.code);
        const cert = code && await sql.one`select * from certificates where code = ${code}`;
        if (!cert) throw new HttpError(404, 'not_found', 'Сертификат с таким кодом не найден');
        return { certificate: publicCertificate(cert) };
      },
    },
  ];
}
