// Заявка по письму (задача 1.9, устав, этап 1): письмо с вложениями на особый адрес → ИИ разбирает → заявка-черновик и
// ответ номером в ту же переписку; ответ «Отправить» отправляет заявку; готовый результат уходит ответом туда же.
//
// Кто может прислать: только человек, подключивший и подтвердивший свой адрес в профиле, и только если почтовый сервер
// подтвердил подлинность отправителя (SPF/DKIM). Неподтверждённые письма и автоответы не обрабатываются и без ответа.
// ИИ ничего не подаёт сам: заявка из письма — черновик, отправляет её человек (ответом «Отправить» или в кабинете).
// Ответ в переписку заявки принимается только от того, кто сейчас может её менять (src/access/policy.mjs).
import crypto from 'node:crypto';
import { HttpError } from '../http/core.mjs';
import { LEVEL, memberOf, messageSide, orderLevel } from '../access/policy.mjs';
import { BASIS_KINDS, cleanValues } from '../modules/index.mjs';
import { FINAL, addDays, todayMsk } from '../orders/workflow.mjs';
import { orderRef } from '../notify/registry.mjs';
import { notifyMessage } from '../notify/notify.mjs';
import { askAi, parseJsonAnswer } from '../ai/ai.mjs';
import { insertOrder, problemsForSubmit, submitDraft } from '../ops/order-ops.mjs';
import { audit } from '../ops/util.mjs';
import { actorOf, enqueueMail, mailToThread } from './outbox.mjs';

export const INBOUND = {
  batch: 10,
  maxAttempts: 5,                  // ИИ не ответил пять раз — письмо «не разобрано», человеку ответ
  retryAfterSec: 60,
  maxFiles: 10,
  maxFileBytes: 5 * 1024 * 1024,   // как у загрузки в кабинете
  bodyMax: 20_000,
};

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

// «Иван <ivan@example.ru>» → «ivan@example.ru»; не адрес — null.
export function normEmail(raw) {
  const s = String(raw ?? '').trim();
  const v = (s.match(/<([^<>]+)>\s*$/)?.[1] ?? s).trim().toLowerCase();
  return v.length <= 254 && EMAIL_RE.test(v) ? v : null;
}

// Новый текст письма — без цитаты прошлых писем и подписи.
export function freshText(body) {
  const out = [];
  for (const line of String(body ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*>/.test(line) || /^-{2,}\s*$/.test(line) || /^-{2,}.*(original|исходное|пересылаемое)/i.test(line)
        || /(пишет|wrote)\s*:\s*$/i.test(line) || /^(от|from):\s/i.test(line)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

// Ответ «Отправить» (или «Подтверждаю») — первой строкой нового текста.
export const CONFIRM_RE = /^\s*[«"]?(отправ|подтвержда)/i;

const clip = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (v) => typeof v === 'string' && DATE_RE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const dateRu = (v) => v.split('-').reverse().join('.');

// ——— Разбор письма ИИ ———

// fixed — услуга уже выбрана (ответ в переписке черновика): модель извлекает только значения полей этой услуги.
export function mailMessages(registry, { subject, body, files, fixed = null }) {
  const services = registry.catalog().flatMap((m) => m.services.map((s) => {
    const fields = s.fields.filter((f) => f.id !== 'comment').map((f) => (f.type === 'select'
      ? `${f.id} (${f.label}; один из: ${f.options.map((o) => o.id).join('|')})` : `${f.id} (${f.label}; ${f.type === 'number' ? 'число' : 'текст'})`)).join('; ');
    return `- ${m.id}/${s.id}: ${m.name} — ${s.name}. Поля: ${fields}`;
  })).join('\n');
  return [
    {
      role: 'system',
      content: [
        'Ты разбираешь письмо-заявку на платформу «БЕРТЕЛ Дело». Заполни заявку только тем, что прямо написано в письме.',
        'Ничего не выдумывай: чего нет в письме — не указывай. Если ни одна услуга не подходит — service: null.',
        `Сегодня ${todayMsk()}. Даты — в виде ГГГГ-ММ-ДД.`,
        `Услуги платформы:\n${services}`,
        fixed ? `Услуга уже выбрана: ${fixed.module.id}/${fixed.service.id} (${fixed.service.name}) — укажи её и извлеки поля для неё.` : null,
        'Основание: "contract" — договор (по умолчанию); "court" — определение суда о назначении экспертизы (тогда номер и дата).',
        'Ответь только JSON: {"service": {"module": "...", "service": "..."} | null, "title": "короткое название" | null,',
        '"fields": {"id поля": "значение"}, "deadline": "ГГГГ-ММ-ДД" | null, "basis": "contract" | "court",',
        '"basis_number": "..." | null, "basis_date": "ГГГГ-ММ-ДД" | null, "basis_file": "имя вложения с определением суда" | null}.',
      ].filter(Boolean).join('\n'),
    },
    { role: 'user', content: [`ТЕМА: ${subject}`, 'ТЕКСТ:', body, `ВЛОЖЕНИЯ: ${files.join(', ')}`].join('\n') },
  ];
}

// Ответ модели → значения заявки. Услуга, поля и даты — только допустимые; неверное отбрасывается, а не исправляется.
export function cleanMailAnswer(registry, text, fileNames, fixed = null) {
  const j = parseJsonAnswer(text) ?? {};
  const def = fixed ?? (j.service ? registry.service(String(j.service.module ?? ''), String(j.service.service ?? '')) : null);
  const fields = {};
  if (def && j.fields && typeof j.fields === 'object') {
    for (const [k, v] of Object.entries(j.fields)) {
      if (k === 'comment' || !def.fields.some((f) => f.id === k)) continue;
      try { Object.assign(fields, cleanValues(def.fields, { [k]: typeof v === 'number' ? v : String(v ?? '') })); } catch { /* неверное значение — пропускаем */ }
    }
  }
  const today = todayMsk();
  const deadline = validDate(j.deadline) && j.deadline >= today && j.deadline <= addDays(today, 2 * 365) ? j.deadline : null;
  const court = def && j.basis === 'court' && def.module.basis.includes('court');
  return {
    def,
    title: def ? clip(j.title, 300) || def.service.name : null,
    fields,
    deadline,
    basis_kind: court ? 'court' : null,
    basis_number: court ? clip(j.basis_number, 100) || null : null,
    basis_date: court && validDate(j.basis_date) && j.basis_date <= today && j.basis_date >= '2000-01-01' ? j.basis_date : null,
    basis_file: court && fileNames.includes(j.basis_file) ? j.basis_file : null,
  };
}

// ——— Приём писем у поставщика ———

const fileName = (v) => clip(String(v ?? '').replace(/[\\/\u0000-\u001f]/g, '_'), 255) || 'вложение';

// Забрать новые письма: проверить отправителя, сохранить вложения, записать письмо в очередь разбора.
export async function receiveMail(deps) {
  const letters = await deps.providers.mail.receive({ limit: INBOUND.batch });
  for (const l of letters) {
    await acceptLetter(deps, l);
    await deps.providers.mail.ack({ id: l.id });
  }
  return letters.length;
}

async function acceptLetter({ sql, providers, cfg }, l) {
  const providerId = String(l.id);
  if (await sql.one`select 1 from mail_inbound where provider_id = ${providerId}`) return;
  const from = normEmail(l.from) ?? clip(String(l.from ?? ''), 254);
  const base = {
    providerId, from, messageId: l.messageId ? clip(String(l.messageId), 500) : null,
    subject: clip(String(l.subject ?? ''), 300), body: clip(String(l.text ?? ''), INBOUND.bodyMax),
    inReplyTo: (Array.isArray(l.inReplyTo) ? l.inReplyTo : [l.inReplyTo]).filter(Boolean).map((x) => clip(String(x), 500)).slice(0, 50),
  };
  const finish = (outcome) => sql`
    insert into mail_inbound (provider_id, message_id, from_email, subject, body, in_reply_to, status, outcome, done_at)
    values (${base.providerId}, ${base.messageId}, ${base.from}, ${base.subject}, '', ${base.inReplyTo}, 'done', ${outcome}, now())
    on conflict (provider_id) do nothing`;
  // Автоответы и письма самим себе — без ответа (иначе два робота переписываются бесконечно).
  if (l.autoReply || from === cfg.mail.inbox) return finish('auto_reply');
  // Подлинность не подтверждена почтовым сервером — адрес отправителя мог быть подделан: не отвечаем вовсе.
  if (!l.authenticated || !normEmail(l.from)) return finish('not_authenticated');
  const addr = await sql.one`select a.user_id from mail_addresses a join users u on u.id = a.user_id
                             where a.email = ${from} and a.confirmed_at is not null and u.is_active`;
  if (!addr) {
    // Адрес не подключён: один ответ в сутки на адрес — подсказать, как подключить.
    const recent = await sql.one`select 1 from mail_inbound where from_email = ${from} and outcome = 'unknown_sender'
                                 and received_at > now() - interval '1 day' limit 1`;
    await finish('unknown_sender');
    if (!recent) {
      await enqueueMail(sql, {
        to: from, subject: `Re: ${base.subject || 'заявка'}`, inReplyTo: base.messageId,
        body: 'Ваш адрес почты не подключён к БЕРТЕЛ Дело, поэтому заявку по письму мы не приняли. Подключите адрес в кабинете '
          + '(раздел «Профиль» → «Почта для заявок») и пришлите письмо ещё раз.',
      });
    }
    return;
  }
  // Вложения — в хранилище сразу (у поставщика письмо будет убрано). Лишние и слишком большие — пропускаются с пометкой.
  const files = [];
  const stored = [];
  try {
    for (const [i, a] of (l.attachments ?? []).entries()) {
      const name = fileName(a.filename);
      const content = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content ?? '');
      if (i >= INBOUND.maxFiles) { files.push({ filename: name, skipped: 'больше 10 вложений' }); continue; }
      if (!content.length) { files.push({ filename: name, skipped: 'пустой файл' }); continue; }
      if (content.length > INBOUND.maxFileBytes) { files.push({ filename: name, skipped: 'больше 5 МБ' }); continue; }
      const mime = clip(String(a.contentType ?? 'application/octet-stream').split(';')[0], 100) || 'application/octet-stream';
      const key = `mail/${crypto.randomUUID()}`;
      await providers.storage.put(key, content, mime);
      stored.push(key);
      files.push({ filename: name, mime, size: content.length, key });
    }
    const row = await sql.one`
      insert into mail_inbound (provider_id, message_id, from_email, subject, body, in_reply_to, attachments, user_id)
      values (${base.providerId}, ${base.messageId}, ${base.from}, ${base.subject}, ${base.body}, ${base.inReplyTo},
              ${JSON.stringify(files)}, ${addr.user_id})
      on conflict (provider_id) do nothing returning id`;
    if (!row) throw new Error('письмо уже принято');
  } catch (e) {
    await Promise.all(stored.map((k) => providers.storage.delete(k).catch(() => {})));
    if (e.message === 'письмо уже принято') return;
    throw e;
  }
}

// ——— Разбор очереди ———

export async function processInbound(deps, { limit = INBOUND.batch } = {}) {
  const { sql } = deps;
  const claimed = await sql`
    update mail_inbound m
       set attempts = m.attempts + 1,
           next_at = now() + make_interval(secs => ${INBOUND.retryAfterSec} * power(2, m.attempts)::int)
     where m.id in (select id from mail_inbound where status = 'pending' and next_at <= now() order by id limit ${limit} for update skip locked)
     returning m.*`;
  for (const row of claimed) {
    try {
      await handleLetter(deps, row);
    } catch (e) {
      const limitHit = e instanceof HttpError && e.code === 'ai_limit';
      if (!limitHit && row.attempts < INBOUND.maxAttempts) {
        if (!(e instanceof HttpError)) console.error('письмо-заявка:', e?.message || e);
        continue; // повтор позже
      }
      await sql.tx(async (tx) => {
        await done(tx, row, 'failed', null);
        await reply(tx, row, limitHit
          ? 'Лимит разборов писем помощником на сутки исчерпан. Пришлите письмо завтра или создайте заявку в кабинете.'
          : 'Не получилось разобрать письмо: помощник сейчас недоступен. Пришлите письмо ещё раз позже или создайте заявку в кабинете.');
      });
      await dropFiles(deps, row);
    }
  }
  return claimed.length;
}

const done = (tx, row, outcome, orderId) => tx`update mail_inbound set status = 'done', outcome = ${outcome}, order_id = ${orderId}, done_at = now()
                                                where id = ${row.id}`;

// Ответ прямо на письмо (не в переписку заявки): отказы и подсказки.
const reply = (tx, row, body) => enqueueMail(tx, { to: row.from_email, subject: `Re: ${row.subject || 'заявка'}`, inReplyTo: row.message_id, body });

const savedFiles = (row) => row.attachments.filter((f) => f.key);

async function dropFiles({ providers }, row) {
  await Promise.all(savedFiles(row).map((f) => providers.storage.delete(f.key).catch(() => {})));
}

// Вложения письма → документы заявки (основание — файл определения суда, если ИИ его узнал и основание — суд).
async function attachFiles(tx, actor, order, row, basisFile) {
  for (const f of savedFiles(row)) {
    const kind = order.basis_kind === 'court' && f.filename === basisFile ? 'basis' : 'other';
    const d = await tx.one`insert into documents (order_id, uploaded_by, filename, mime, size_bytes, storage_key, kind)
                           values (${order.id}, ${actor.id}, ${f.filename}, ${f.mime}, ${f.size}, ${f.key}, ${kind}) returning id`;
    await audit(tx, actor, 'document.upload', 'document', d.id, { order_id: order.id, kind, via: 'mail' });
  }
}

async function threadOrderId(sql, ids) {
  if (!ids.length) return null;
  const r = await sql.one`
    select order_id from (
      select order_id, id from mail_outbox where message_id = any(${ids}) and order_id is not null
      union all select order_id, id from mail_inbound where message_id = any(${ids}) and order_id is not null
    ) x order by id desc limit 1`;
  return r?.order_id ?? null;
}

async function handleLetter(deps, row) {
  const { sql } = deps;
  const actor = await actorOf(sql, row.user_id);
  if (!actor) {
    await done(sql, row, 'unknown_sender', null);
    return dropFiles(deps, row);
  }
  const orderId = await threadOrderId(sql, row.in_reply_to);
  return orderId ? handleReply(deps, row, actor, orderId) : handleNew(deps, row, actor);
}

const parse = (deps, actor, row, body, fixed = null) => askAi(deps, actor, 'mail', mailMessages(deps.registry, {
  subject: row.subject, body, files: row.attachments.map((f) => f.filename), fixed,
})).then((out) => cleanMailAnswer(deps.registry, out.text, savedFiles(row).map((f) => f.filename), fixed));

// Первое письмо: новая заявка-черновик.
async function handleNew(deps, row, actor) {
  const { sql, registry } = deps;
  const addr = await sql.one`select org_id from mail_addresses where user_id = ${actor.id}`;
  const orgId = addr?.org_id ?? null;
  if (orgId && !memberOf(actor, orgId)) {
    await sql.tx(async (tx) => {
      await done(tx, row, 'no_access', null);
      await reply(tx, row, 'Заявки с Вашего адреса настроены от имени организации, в которой Вы больше не состоите. '
        + 'Выберите в кабинете («Профиль» → «Почта для заявок»), от чьего имени принимать заявки, и пришлите письмо ещё раз.');
    });
    return dropFiles(deps, row);
  }
  const body = freshText(row.body);
  const p = await parse(deps, actor, row, body);
  if (!p.def) {
    const list = registry.catalog().flatMap((m) => m.services.map((s) => `— ${s.name}`)).join('\n');
    await sql.tx(async (tx) => {
      await done(tx, row, 'no_service', null);
      await reply(tx, row, `Мы не поняли из письма, какая услуга нужна, поэтому заявку не создали. Сейчас мы принимаем заявки на:\n${list}\n`
        + 'Опишите в новом письме, что нужно оценить и для чего, — или создайте заявку в кабинете.');
    });
    return dropFiles(deps, row);
  }
  const comment = p.def.fields.find((f) => f.id === 'comment' && f.type === 'longtext');
  const fields = { ...p.fields, ...(comment && body ? { comment: body.slice(0, comment.max ?? 2000) } : {}) };
  await sql.tx(async (tx) => {
    let order = await insertOrder(tx, actor, p.def, { title: p.title, orgId, fields, via: 'mail' });
    order = await tx.one`update orders set deadline = ${p.deadline}, basis_kind = ${p.basis_kind ?? order.basis_kind},
                                basis_number = ${p.basis_number}, basis_date = ${p.basis_date}
                         where id = ${order.id} returning *`;
    await attachFiles(tx, actor, order, row, p.basis_file);
    const subject = clip(`Заявка ${orderRef(order.id)}: ${order.title}`, 300);
    await tx`insert into mail_threads (order_id, user_id, email, subject, last_message_id)
             values (${order.id}, ${actor.id}, ${row.from_email}, ${subject}, ${row.message_id})`;
    await done(tx, row, 'created', order.id);
    await mailToThread(tx, order, await draftSummary(tx, registry, order, row, 'Заявка создана по Вашему письму — пока черновиком.'));
  });
}

// Ответ в переписке заявки: дополнить черновик и, если первая строка «Отправить», отправить; после отправки — в переписку.
async function handleReply(deps, row, actor, orderId) {
  const { sql, registry } = deps;
  const order = await sql.one`select * from orders where id = ${orderId}`;
  if (orderLevel(actor, order) < LEVEL.write || FINAL.includes(order.status)) {
    await sql.tx(async (tx) => {
      await done(tx, row, 'no_access', null);
      await reply(tx, row, FINAL.includes(order.status) && orderLevel(actor, order) >= LEVEL.write
        ? `Заявка ${orderRef(order.id)} завершена — письма по ней больше не принимаются. Новую заявку пришлите новым письмом.`
        : 'Это письмо не удалось связать с Вашей заявкой. Заявки и переписка по ним — в кабинете.');
    });
    return dropFiles(deps, row);
  }
  const body = freshText(row.body);
  if (order.status !== 'new') return postToChat(deps, row, actor, order, body);

  const confirm = CONFIRM_RE.test(body.split('\n')[0] ?? '');
  const rest = (confirm ? body.split('\n').slice(1).join('\n') : body).trim();
  const p = rest ? await parse(deps, actor, row, rest, deps.registry.service(order.module, order.service)) : null;
  await sql.tx(async (tx) => {
    let cur = await tx.one`select * from orders where id = ${order.id} for update`;
    await tx`update mail_threads set last_message_id = ${row.message_id} where order_id = ${cur.id}`;
    if (cur.status !== 'new') {
      // Пока разбирали письмо, заявку отправили в кабинете — ответ уходит в переписку как сообщение.
      await done(tx, row, 'no_access', cur.id);
      return mailToThread(tx, cur, 'Заявка уже отправлена — письмо не изменило её. Написать исполнителю или диспетчеру можно ответом на это письмо.');
    }
    // Дополняется только незаполненное и только для той же услуги: исправить заполненное — в кабинете.
    const sameService = p?.def && p.def.module.id === cur.module && p.def.service.id === cur.service;
    if (sameService) {
      const fields = { ...p.fields, ...cur.fields };
      const court = cur.basis_kind === 'contract' && p.basis_kind === 'court';
      cur = await tx.one`
        update orders set fields = ${JSON.stringify(fields)}, deadline = coalesce(deadline, ${p.deadline}),
               basis_kind = ${court ? 'court' : cur.basis_kind},
               basis_number = coalesce(basis_number, ${p.basis_number}), basis_date = coalesce(basis_date, ${p.basis_date}), updated_at = now()
        where id = ${cur.id} returning *`;
      await audit(tx, actor, 'order.update', 'order', cur.id, { via: 'mail' });
    }
    await attachFiles(tx, actor, cur, row, p?.basis_file ?? null);
    if (confirm) {
      const missing = await problemsForSubmit(tx, registry, cur);
      if (!missing.length) {
        const sent = await submitDraft(tx, registry, actor, cur);
        await done(tx, row, 'submitted', cur.id);
        return mailToThread(tx, sent, 'Заявка отправлена. Диспетчер подберёт исполнителя и назначит цену — мы напишем сюда же, '
          + 'когда заявку нужно будет оплатить.');
      }
    }
    await done(tx, row, 'updated', cur.id);
    return mailToThread(tx, cur, await draftSummary(tx, registry, cur, row,
      confirm ? 'Заявку пока нельзя отправить — не всё заполнено.' : 'Заявка дополнена по Вашему письму.'));
  });
}

// Заявка уже в работе: новый текст — сообщение в переписке заявки от заказчика, вложения — документы заявки.
async function postToChat(deps, row, actor, order, body) {
  const { sql } = deps;
  await sql.tx(async (tx) => {
    await tx`update mail_threads set last_message_id = ${row.message_id} where order_id = ${order.id}`;
    const side = messageSide(actor, order);
    if (body && side === 'customer') {
      const m = await tx.one`insert into order_messages (order_id, author_id, side, body) values (${order.id}, ${actor.id}, ${side}, ${body.slice(0, 4000)}) returning id`;
      await audit(tx, actor, 'message.post', 'order', order.id, { message: String(m.id), side, via: 'mail' });
      await notifyMessage(tx, { actor, order, side });
    }
    await attachFiles(tx, actor, order, row, null);
    await done(tx, row, 'message', order.id);
  });
}

// Что поняли из письма и чего не хватает — текст ответа по черновику.
async function draftSummary(tx, registry, order, row, head) {
  const def = registry.service(order.module, order.service);
  const shown = def.fields.filter((f) => f.id !== 'comment' && order.fields[f.id] !== undefined).map((f) => {
    const v = order.fields[f.id];
    return `  — ${f.label}: ${f.type === 'select' ? f.options.find((o) => o.id === v)?.name ?? v : v}`;
  });
  const basis = BASIS_KINDS[order.basis_kind]?.name ?? '—';
  const docs = await tx`select filename from documents where order_id = ${order.id} and deleted_at is null order by created_at`;
  const skipped = row.attachments.filter((f) => f.skipped).map((f) => `${f.filename} (${f.skipped})`);
  const missing = await problemsForSubmit(tx, registry, order);
  return [
    head,
    '',
    `Услуга: ${def.module.name} — ${def.service.name}`,
    `Название: ${order.title}`,
    'Что поняли из письма:',
    ...(shown.length ? shown : ['  — пока ничего из полей заявки']),
    `  — Срок: ${order.deadline ? dateRu(order.deadline) : 'не указан'}`,
    `  — Основание: ${basis}${order.basis_number ? ` № ${order.basis_number}` : ''}${order.basis_date ? ` от ${dateRu(order.basis_date)}` : ''}`,
    `Файлы в заявке: ${docs.length ? docs.map((d) => d.filename).join(', ') : 'нет'}`,
    ...(skipped.length ? [`Не приняты вложения: ${skipped.join(', ')}`] : []),
    '',
    missing.length ? `Чтобы отправить заявку, не хватает: ${missing.join(', ')}. Допишите это ответом на письмо.`
      : 'Всё нужное для отправки есть.',
    'Чтобы отправить заявку, ответьте на это письмо словом «Отправить» в первой строке. Можно и в кабинете — кнопкой «Отправить».',
    'Заявку разобрал искусственный интеллект — проверьте, всё ли понято верно; исправить можно в кабинете.',
  ].join('\n');
}
