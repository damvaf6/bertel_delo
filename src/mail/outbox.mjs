// Исходящие письма (задача 1.9): ответы на письма-заявки и письма о ходе заявки в ту же переписку.
// Как СМС-уведомления: запись — в той же транзакции, что и событие; отправка — после неё (deliverMail), с повторами.
// Письмо в переписку заявки уходит, только пока адрес подтверждён у того же человека и он по-прежнему заказчик заявки
// (передали дело коллеге, отключили адрес, ушёл из организации — письма прекращаются, остаются уведомления в кабинете).
import crypto from 'node:crypto';
import { EVENTS, orderRef } from '../notify/registry.mjs';
import { LEVEL, orderLevel, seesResults } from '../access/policy.mjs';
import { signatureFilename } from '../providers/sign.mjs';

export const OUTBOX = {
  maxAttempts: 5,                      // после пятой неудачи письмо больше не повторяется
  retryAfterSec: 60,                   // пауза растёт: 1, 2, 4, 8 минут
  batch: 10,
  attachMaxBytes: 10 * 1024 * 1024,    // больше — файлы результата только в кабинете
};

export const newMessageId = () => `<${crypto.randomUUID()}@bertel-delo>`;

// Учётная запись как «вошедший» (с организациями) — для проверок доступа вне запроса из кабинета.
export async function actorOf(sql, userId) {
  const u = await sql.one`select id, phone, full_name, platform_role, is_active from users where id = ${userId}`;
  if (!u || !u.is_active) return null;
  u.orgs = await sql`select org_id, role from org_members where user_id = ${userId}`;
  return u;
}

// Переписка заявки и её адресат, если писать туда ещё можно.
export async function threadRecipient(sql, order) {
  const t = await sql.one`select t.*, a.email as current_email, a.confirmed_at
                          from mail_threads t left join mail_addresses a on a.user_id = t.user_id where t.order_id = ${order.id}`;
  if (!t || !t.confirmed_at || t.current_email !== t.email) return null;
  const actor = await actorOf(sql, t.user_id);
  if (!actor || orderLevel(actor, order) < LEVEL.write) return null;
  return { thread: t, actor };
}

export async function enqueueMail(tx, { orderId = null, to, subject, body, inReplyTo = null, resultFiles = false }) {
  await tx`insert into mail_outbox (order_id, to_email, subject, body, message_id, in_reply_to, result_files)
           values (${orderId}, ${to}, ${subject}, ${body}, ${newMessageId()}, ${inReplyTo}, ${resultFiles})`;
}

// Письмо в переписку заявки (ответом на последнее письмо человека). false — писать некуда.
export async function mailToThread(tx, order, body, { resultFiles = false } = {}) {
  const r = await threadRecipient(tx, order);
  if (!r) return false;
  await enqueueMail(tx, { orderId: order.id, to: r.thread.email, subject: r.thread.subject, body, inReplyTo: r.thread.last_message_id, resultFiles });
  return true;
}

const rub = (kop) => `${(Number(kop) / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;

// Текст письма о событии заявки; по умолчанию — строка события из реестра уведомлений.
const EVENT_TEXT = {
  priced: (o) => `Цена заявки — ${rub(o.price_kop)}. Оплатите её в кабинете: после оплаты заявку передадим исполнителю.`,
  done: () => 'Результат проверен. Файлы результата — во вложении к этому письму; они же доступны в кабинете.',
};

// Событие из реестра уведомлений (notify.mjs): если у события есть письмо и заявка пришла по письму — письмо в её переписку.
export async function mailOnEvent(tx, eventId, orderId) {
  const e = EVENTS[eventId];
  if (!e?.mail || !orderId) return false;
  const order = await tx.one`select * from orders where id = ${orderId}`;
  if (!order) return false;
  const text = EVENT_TEXT[eventId]?.(order) ?? `${e.title}.`;
  return mailToThread(tx, order, text, { resultFiles: eventId === 'done' });
}

function letterText(row, order, cfg) {
  const link = cfg.publicUrl && order ? `${cfg.publicUrl}/kabinet#order=${order.id}` : null;
  return [
    'Здравствуйте!',
    '',
    row.body,
    '',
    order ? `Заявка ${orderRef(order.id)}: «${order.title}».` : null,
    link ? `Открыть в кабинете: ${link}` : 'Кабинет — на сайте БЕРТЕЛ Дело, вход по номеру телефона.',
    '',
    '— БЕРТЕЛ Дело. Письмо отправлено автоматически; ответить можно прямо на него.',
  ].filter((x) => x !== null).join('\n');
}

// Файлы результата — только если адресат и сейчас их видит (проверено и оплачено, src/access/policy.mjs).
async function resultAttachments(sql, storage, order) {
  const r = await threadRecipient(sql, order);
  if (!r || !seesResults(r.actor, order)) return { files: [], note: null };
  const docs = await sql`select * from documents where order_id = ${order.id} and kind = 'result' and deleted_at is null
                         and uploaded_by = ${order.executor_user_id} order by created_at`;
  const total = docs.reduce((n, d) => n + Number(d.size_bytes), 0);
  if (total > OUTBOX.attachMaxBytes) return { files: [], note: 'Файлы результата слишком большие для письма — скачайте их в кабинете.' };
  const files = [];
  // Подписи УКЭП (2.5, 2.5а) — отдельными файлами рядом с файлом: «имя.sig» (эксперт), «имя.org.sig» (организация).
  const signs = await sql`select document_id, role, storage_key from document_signatures where order_id = ${order.id} order by role`;
  for (const d of docs) {
    const content = await storage.get(d.storage_key);
    if (!content) continue;
    files.push({ filename: d.filename, contentType: d.mime, content });
    for (const s of signs.filter((x) => x.document_id === d.id)) {
      const sig = await storage.get(s.storage_key);
      if (sig) files.push({ filename: signatureFilename(d.filename, s.role), contentType: 'application/pkcs7-signature', content: sig });
    }
  }
  return { files, note: null };
}

// Отправить накопившиеся письма. Строки «занимаются» (сдвигается время следующей попытки) — две копии сервера одно письмо
// не отправят. Неудача — повтор позже, после maxAttempts — «не отправлено».
export async function deliverMail(sql, providers, cfg, { limit = OUTBOX.batch } = {}) {
  const claimed = await sql`
    update mail_outbox m
       set attempts = m.attempts + 1,
           next_at = now() + make_interval(secs => ${OUTBOX.retryAfterSec} * power(2, m.attempts)::int)
     where m.id in (select id from mail_outbox where status = 'pending' and next_at <= now() order by id limit ${limit} for update skip locked)
     returning m.*`;
  let sent = 0;
  for (const m of claimed) {
    try {
      const order = m.order_id ? await sql.one`select * from orders where id = ${m.order_id}` : null;
      let body = m.body;
      let attachments = [];
      if (m.result_files && order) {
        const r = await resultAttachments(sql, providers.storage, order);
        attachments = r.files;
        if (r.note) body = `${body}\n${r.note}`;
      }
      const out = await providers.mail.send({
        to: m.to_email, subject: m.subject, text: letterText({ body }, order, cfg),
        messageId: m.message_id, inReplyTo: m.in_reply_to, attachments,
      });
      await sql`update mail_outbox set status = 'sent', sent_at = now(), error = null, provider_id = ${out?.id ?? null} where id = ${m.id}`;
      sent += 1;
    } catch (e) {
      const error = String(e?.message || 'отказ поставщика').slice(0, 500);
      await sql`update mail_outbox set error = ${error}, status = ${m.attempts >= OUTBOX.maxAttempts ? 'failed' : 'pending'} where id = ${m.id}`;
    }
  }
  return { claimed: claimed.length, sent };
}
