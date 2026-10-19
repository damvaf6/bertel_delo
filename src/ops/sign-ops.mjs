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
import { orderSides, executorSignOrg, isStaff } from '../access/policy.mjs';
import { ProviderError } from '../providers/fake.mjs';
import { notify } from '../notify/notify.mjs';
import { orderRef } from '../notify/registry.mjs';
import { signatureFilename } from '../providers/sign.mjs';
import { aiSignHints, egrnLinks, egrnLinkOf, egrnLinkState } from '../ai/ai.mjs';
import { audit, text } from './util.mjs';
import { latest, taskDueSign } from './draft-ops.mjs';
import { todayMsk } from '../orders/workflow.mjs';

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const MAX_SIGNATURE_BYTES = 256 * 1024;
const ROLE_RU = { expert: 'эксперта', org: 'организации' };
const MANUAL_REASON = { pending: 'ещё не проверена платформой на Госуслугах', bad: 'не подтвердилась при проверке платформой' };

export const signatureView = (s) => s && {
  role: s.role,
  method: s.method,
  signer: s.certificate?.subject ?? null,
  org: s.certificate?.org ?? null,
  title: s.certificate?.title ?? null,
  issuer: s.certificate?.issuer ?? null,
  // Программа подписи, если узнана по сертификату («Госключ», 2.69).
  app: s.certificate?.app ?? null,
  serial: s.certificate?.serial ?? null,
  valid_to: s.certificate?.valid_to ?? null,
  signed_at: s.signed_at,
  test: s.test,
  checked_at: s.checked_at,
  checked_ok: s.checked_ok,
  // Ручная проверка на Госуслугах (SIGN_PROVIDER=manual): 'pending' — ждёт, 'ok' — «подписано КЭП, проверено», 'bad' — нет.
  ...(s.manual_check ? { manual_check: s.manual_check, manual_checked_at: s.manual_checked_at ?? null, manual_note: s.manual_note ?? null } : {}),
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
  if (method === 'cabinet') cabinetOn(providers);
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
  // Ручная проверка: файл подписи разобран, верна ли подпись — проверит сотрудник платформы на Госуслугах.
  const manual = !!check.manual;
  // Подпись организации — сертификатом организации (в нём её название); при ручной проверке это смотрит сотрудник платформы.
  if (role === 'org' && !manual && !check.certificate?.org) {
    throw new HttpError(400, 'not_org_certificate', `${check.certificate?.app ? `Подпись из приложения «${check.certificate.app}» — это подпись физического лица` : 'Это подпись физического лица'} — для подписи организации нужен сертификат организации (руководителя)`);
  }
  const key = `orders/${order.id}/${crypto.randomUUID()}.sig`;
  await providers.storage.put(key, signature, 'application/pkcs7-signature');
  const replaced = [];
  try {
    const row = await sql.tx(async (tx) => {
      const cur = await tx.one`select status, executor_user_id from orders where id = ${order.id} for update`;
      if (cur.status !== 'in_work' || cur.executor_user_id !== order.executor_user_id) throw new HttpError(409, 'status_changed', 'Статус заявки уже изменился, обновите страницу');
      const alive = await tx.one`select 1 from documents where id = ${doc.id} and deleted_at is null`;
      if (!alive) throw new HttpError(404, 'not_found', 'Не найдено');
      if (role === 'org') {
        // Организация подписывает то, что эксперт уже подписал, и только пока исполнитель работает от неё.
        const expert = await tx.one`select 1 from document_signatures where document_id = ${doc.id} and role = 'expert'
                                    and manual_check is distinct from 'bad'`;
        if (!expert) throw new HttpError(409, 'expert_first', 'Сначала файл подписывает эксперт');
        const now = await executorSignOrg(tx, cur.executor_user_id);
        if (now?.id !== org.id) throw new HttpError(409, 'org_changed', 'Исполнитель больше не работает от этой организации');
      }
      // Подпись, которая не подтвердилась при ручной проверке, заменяется новой.
      for (const old of await tx`delete from document_signatures where document_id = ${doc.id} and role = ${role} and manual_check = 'bad' returning storage_key`) replaced.push(old.storage_key);
      const s = await tx.one`
        insert into document_signatures (document_id, order_id, signer_id, provider, digest, storage_key, size_bytes, certificate, test,
                                         checked_ok, role, method, org_id, manual_check)
        values (${doc.id}, ${order.id}, ${actor.id}, ${providers.sign.name}, ${digest}, ${key}, ${signature.length},
                ${JSON.stringify(check.certificate)}, ${!!(check.test ?? out?.test)}, ${!manual}, ${role}, ${method}, ${org?.id ?? null},
                ${manual ? 'pending' : null})
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
    for (const k of replaced) await providers.storage.delete(k).catch(() => {});
    return row;
  } catch (e) {
    await providers.storage.delete(key).catch(() => {});
    throw e;
  }
}

// Ручная проверка (SIGN_PROVIDER=manual): в кабинете не подписывают — только загрузкой своего файла подписи.
function cabinetOn(providers) {
  if (providers.sign.manual) throw new HttpError(409, 'cabinet_off', 'Подпись в кабинете пока не подключена — подпишите файл своей программой подписи и загрузите файл подписи (.sig)');
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
// подписал новый результат, загруженный после возврата, — 2.159: до подписи новой версии отметки «исправлено» ещё ставятся). Видят только исполнитель и руководитель — заказчику и диспетчеру не отдаются.
export async function orgReturns(sql, orderId, { orgId = null } = {}) {
  const rows = await sql`
    select r.*, u.full_name as head_name, g.name as org_name,
           exists (select 1 from documents d where d.id = r.document_id and d.deleted_at is null) as doc_alive,
           exists (select 1 from document_signatures s where s.document_id = r.document_id and s.role = 'expert' and s.signed_at > r.created_at) as resigned,
           exists (select 1 from documents d join document_signatures s on s.document_id = d.id and s.role = 'expert'
                   where d.order_id = r.order_id and d.kind = 'result' and d.deleted_at is null
                     and d.created_at > r.created_at and s.signed_at > r.created_at)
           -- новая версия уже подписана и снова возвращена — прежний возврат закрыт ею
           or exists (select 1 from org_returns r2 join documents d on d.id = r2.document_id
                      where r2.order_id = r.order_id and r2.id > r.id and d.created_at > r.created_at) as new_signed,
           f.filename as fresh_name, f.created_at as fresh_at
    from org_returns r join users u on u.id = r.returned_by join organizations g on g.id = r.org_id
    -- Возвращённый файл удалён, исправленный загружен и ждёт подписи эксперта (2.170 — в «Сегодня», как в деле, 2.163).
    left join lateral (select d.filename, d.created_at from documents d
                       where d.order_id = r.order_id and d.kind = 'result' and d.deleted_at is null and d.created_at > r.created_at
                         and d.uploaded_by = r.executor_user_id
                         and not exists (select 1 from document_signatures s where s.document_id = d.id and s.role = 'expert')
                       order by d.created_at desc limit 1) f on true
    where r.order_id = ${orderId} and (${orgId}::uuid is null or r.org_id = ${orgId}::uuid) order by r.id`;
  const items = rows.length
    ? await sql`select return_id, n, text, fixed_at, egrn from org_return_items where return_id = any(${rows.map((r) => r.id)}::bigint[]) order by return_id, n`
    : [];
  return rows.map((r) => {
    // 2.262: пункт из расхождения с выпиской ЕГРН — правило и верное значение: у эксперта в замечании «Заменить по выписке»
    // Пункт по заявке и заданию на оценку (2.271) — fix: «Заменить на значение из задания», если та же находка в ИИ-проверке
    // заменяется одной кнопкой (2.285; по заявке — только пользователь результатов оценки, 2.313).
    const link = (l) => ({ rule: l.rule, ...(l.right ? { right: l.right } : {}) });
    const points = items.filter((i) => String(i.return_id) === String(r.id)).map((i) => ({ n: i.n, text: i.text, fixed: !!i.fixed_at, fixed_at: i.fixed_at,
      ...(i.egrn?.rule ? { [i.egrn.kind === 'order' ? 'fix' : 'egrn']: link(i.egrn) } : {}) }));
    const ret = {
      id: Number(r.id),
      at: r.created_at,
      document_id: r.document_id,
      filename: r.filename,
      comment: r.comment,
      org: r.org_name,
      by: r.head_name,
      open: r.doc_alive ? !r.resigned : !r.new_signed,
      // Пункты замечания (2.93): эксперт отмечает исправленные; left — сколько ещё не отмечено.
      items: points,
      left: points.filter((i) => !i.fixed).length,
      fresh_file: !r.doc_alive && r.fresh_name ? { filename: r.fresh_name, at: r.fresh_at } : null,
    };
    // 2.247: из каких расхождений с выпиской ЕГРН подставлены пункты — только для «Подписи организации», в ответы не уходит.
    Object.defineProperty(ret, 'links', { value: items.filter((i) => String(i.return_id) === String(r.id) && i.egrn).map((i) => ({ n: i.n, ...i.egrn })) });
    return ret;
  });
}

// Последняя ИИ-проверка дела, где был этот файл (2.247) — по ней пункты возврата связываются с расхождениями.
async function lastReview(sql, orderId, docIds, after = null) {
  return sql.one`select items, files, at from ai_reviews where order_id = ${orderId}
                 and (${after}::timestamptz is null or at > ${after}::timestamptz)
                 and exists (select 1 from jsonb_array_elements(files) f where f->>'id' = any(${docIds}::text[]))
                 order by id desc limit 1`;
}

// Пункты возврата из расхождений с выпиской (2.247): по новой ИИ-проверке эксперта (после возврата, по файлу, к которому
// относится возврат, — возвращённому или новой версии) — ушло ли расхождение. С 2.257 — и для утренней сводки руководителя.
export async function returnEgrn(sql, orderId, r, docs) {
  if (!r.links.length) return new Map();
  // Новая версия после возврата (2.159) — по ней; нет — по самому возвращённому файлу.
  const newer = docs.filter((d) => new Date(d.created_at) > new Date(r.at)).map((d) => d.id);
  const ids = newer.length ? newer : docs.filter((d) => d.id === r.document_id).map((d) => d.id);
  const review = ids.length ? await lastReview(sql, orderId, ids, r.at) : null;
  return new Map(r.links.map((l) => [l.n, review ? egrnLinkState(l, review, ids) : 'none']));
}

// Замечание руководителя по пунктам (2.93): каждая непустая строка — пункт; нумерация «1.», «2)», «-», «•» в начале снимается.
export const MAX_RETURN_ITEMS = 30;
export function returnPoints(comment) {
  const lines = String(comment).split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:\d{1,2}\s*[.)]|[-–—•*])\s*/, '').trim())
    .filter(Boolean);
  if (lines.length > MAX_RETURN_ITEMS) throw new HttpError(400, 'too_many_items', `Не больше ${MAX_RETURN_ITEMS} пунктов в одном возврате`);
  return lines;
}

// Очередь подписи эксперта (2.99): файлы результата исполнителя, которые он подписал, а организация ещё нет; с какого времени
// ждут (самая ранняя подпись эксперта среди них) и когда эксперт последний раз напоминал руководителю. Напоминать — не чаще
// раза в сутки по делу. null — ждать нечего.
export const REMIND_EVERY_HOURS = 24;
export async function signWait(sql, order) {
  const r = await sql.one`
    select count(*)::int as files, min(s.signed_at) as since
    from documents d join document_signatures s on s.document_id = d.id and s.role = 'expert'
    where d.order_id = ${order.id} and d.kind = 'result' and d.deleted_at is null and d.uploaded_by = ${order.executor_user_id}
      and not exists (select 1 from document_signatures g where g.document_id = d.id and g.role = 'org')`;
  if (!r?.files) return null;
  // Напоминания — только с тех пор, как файл ждёт (2.100): после возврата и новой подписи прежнее напоминание не в счёт.
  const last = await sql.one`select max(created_at) as at, count(*)::int as n from sign_reminders
                             where order_id = ${order.id} and created_at >= ${r.since}`;
  const next = last?.at ? new Date(new Date(last.at).getTime() + REMIND_EVERY_HOURS * 3600_000) : null;
  return {
    files: r.files,
    since: r.since,
    reminded_at: last?.at ?? null,
    reminders: last?.n ?? 0,
    can_remind: !next || next <= new Date(),
    next_remind_at: next && next > new Date() ? next : null,
  };
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
        cabinetOn(ctx.providers);
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
      async handler({ sql, org, registry, providers }) {
        const orders = await sql`
          select o.id, o.module, o.service, o.deadline, o.executor_user_id, o.status, o.review_round, u.full_name as executor_name
          from orders o join specialists s on s.user_id = o.executor_user_id and s.org_id = ${org.id}
          join org_members m on m.org_id = s.org_id and m.user_id = s.user_id
          join users u on u.id = o.executor_user_id
          where o.status = 'in_work' order by o.deadline nulls last, o.id`;
        const items = [];
        for (const o of orders) {
          const docs = await sql`select id, filename, size_bytes, created_at from documents where order_id = ${o.id} and kind = 'result'
                                 and deleted_at is null and uploaded_by = (select executor_user_id from orders where id = ${o.id}) order by created_at`;
          if (!docs.length) continue;
          const signs = await orderSignatures(sql, o.id);
          const returns = await orgReturns(sql, o.id, { orgId: org.id });
          const wait = await signWait(sql, o);
          // 2.186: файл подписан экспертом и ждёт подписи организации — запускал ли эксперт ИИ-проверку этой версии и что в ней
          // осталось «посмотрите». Подсказка руководителю, подпись не держит.
          // 2.263: черновик эксперта — заменил ли он расхождения с выпиской уже после того, как загрузил подписанный файл.
          const draft = await latest(sql, o.id);
          const ai = await aiSignHints(sql, registry, o, docs.filter((d) => signs.get(d.id)?.expert && !signs.get(d.id)?.org).map((d) => d.id),
            { ok: true, draft, created: new Map(docs.map((d) => [d.id, d.created_at])) });
          items.push({
            order_ref: orderRef(o.id),
            service: registry.service(o.module, o.service)?.service.name ?? o.service,
            executor: o.executor_name,
            deadline: o.deadline,
            documents: docs.map((d) => ({ id: d.id, filename: d.filename, size_bytes: Number(d.size_bytes), created_at: d.created_at, signatures: signaturesView(signs.get(d.id)), ...(ai.has(d.id) ? { ai_check: ai.get(d.id) } : {}) })),
            // Эксперт напоминал о подписи (2.99) — когда последний раз, пока файл ждёт (после возврата прежнее не показывается).
            reminded_at: wait?.reminded_at ?? null,
            // С какого времени файлы ждут подписи организации (2.148) — самая ранняя подпись эксперта среди них.
            waiting_since: wait?.since ?? null,
            // 2.308: срок по заданию на оценку прошёл или сегодня — пока файлы ждут подписи организации.
            task_due: docs.some((d) => signs.get(d.id)?.expert && !signs.get(d.id)?.org) ? await taskDueSign(sql, providers.storage, registry, o, todayMsk()) : null,
            // История возвратов эксперту (2.27) — только этой организации.
            // 2.247: у пункта из расхождения с выпиской — ушло ли оно в ИИ-проверке после возврата (egrn: gone / kept / none).
            returns: await Promise.all(returns.map(async (r) => {
              const st = await returnEgrn(sql, o.id, r, docs);
              const { id, at, document_id, filename, comment, by, open, left } = r;
              // 2.271: пункт из расхождения с заявкой или заданием на оценку — order: gone / kept / none.
              const kind = new Map(r.links.map((l) => [l.n, l.kind === 'order' ? 'order' : 'egrn']));
              return { id, at, document_id, filename, comment, by, open, left,
                items: r.items.map((p) => (st.has(p.n) ? { ...p, [kind.get(p.n)]: st.get(p.n) } : p)) };
            })),
          });
        }
        return { items, sign_mode: providers.sign.manual ? 'manual' : 'cabinet' };
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
        cabinetOn(ctx.providers);
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
        const points = returnPoints(comment);
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
          // 2.247: пункты, подставленные из расхождений с выпиской ЕГРН последней ИИ-проверки этого файла, — с привязкой
          // (2.271 — и из расхождений с заявкой и заданием на оценку).
          const links = egrnLinks(await lastReview(tx, order.id, [doc.id]), doc.id);
          const r = await tx.one`
            insert into org_returns (order_id, document_id, org_id, executor_user_id, returned_by, filename, comment, signature_key)
            values (${order.id}, ${doc.id}, ${signOrg.id}, ${cur.executor_user_id}, ${actor.id}, ${doc.filename}, ${comment}, ${expert.storage_key})
            returning *`;
          for (const [i, t] of points.entries()) {
            const link = egrnLinkOf(t, links);
            await tx`insert into org_return_items (return_id, n, text, egrn) values (${r.id}, ${i + 1}, ${t}, ${link ? JSON.stringify(link) : null}::jsonb)`;
          }
          await audit(tx, actor, 'document.org_return', 'document', doc.id, { order_id: order.id, org_id: signOrg.id, return_id: Number(r.id) });
          await notify(tx, 'org_returned', { users: [cur.executor_user_id], orderId: order.id, actor });
          return r;
        });
        res.status(201);
        return { return: { id: Number(row.id), at: row.created_at, filename: row.filename, comment: row.comment,
          items: points.map((t, i) => ({ n: i + 1, text: t, fixed: false, fixed_at: null })) } };
      },
    },
    {
      // Эксперт отмечает пункт замечания руководителя исправленным (или снимает отметку) — пока возврат открыт, то есть
      // до новой подписи эксперта (2.93). Руководитель в «Подписи организации» видит, что осталось.
      id: 'orgreturn.item', method: 'PUT', path: '/api/orders/:id/org-returns/:rid/items/:n', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, params, body }) {
        if (order.executor_user_id !== actor.id || !orderSides(actor, order).includes('executor')) {
          throw new HttpError(403, 'forbidden', 'Отмечает исполнитель дела');
        }
        if (typeof body?.fixed !== 'boolean') throw new HttpError(400, 'bad_fixed', 'Укажите, исправлен ли пункт');
        const rid = String(params.rid ?? '');
        const n = String(params.n ?? '');
        const ret = /^\d{1,18}$/.test(rid) ? (await orgReturns(sql, order.id)).find((r) => String(r.id) === rid) : null;
        const item = ret && /^\d{1,3}$/.test(n) ? ret.items.find((i) => i.n === Number(n)) : null;
        if (!item) throw new HttpError(404, 'not_found', 'Пункт замечания не найден');
        if (order.status !== 'in_work') throw new HttpError(409, 'not_in_work', 'Отмечать можно, пока дело в работе');
        if (!ret.open) throw new HttpError(409, 'return_closed', 'Файл уже подписан заново — отметки по этому возврату закрыты');
        await sql`update org_return_items set fixed_at = ${body.fixed ? new Date() : null}, fixed_by = ${body.fixed ? actor.id : null}
                  where return_id = ${rid} and n = ${item.n}`;
        await audit(sql, actor, body.fixed ? 'org_return.item_fixed' : 'org_return.item_unfixed', 'order', order.id, { return_id: Number(rid), n: item.n });
        const fresh = (await orgReturns(sql, order.id)).find((r) => String(r.id) === rid);
        return { return: fresh };
      },
    },
    {
      // Эксперт напоминает руководителям своей организации о подписи (2.99): он подписал, организация ещё нет. Не чаще раза в
      // сутки по делу; руководителю — уведомление, ведёт к делу в «Подписи организации».
      id: 'orgsign.remind', method: 'POST', path: '/api/orders/:id/sign-reminder', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, res }) {
        if (order.executor_user_id !== actor.id || !orderSides(actor, order).includes('executor')) {
          throw new HttpError(403, 'forbidden', 'Напоминает исполнитель дела');
        }
        if (order.status !== 'in_work') throw new HttpError(409, 'not_in_work', 'Напомнить можно, пока дело в работе');
        const wait = await sql.tx(async (tx) => {
          const cur = await tx.one`select status, executor_user_id from orders where id = ${order.id} for update`;
          if (cur.status !== 'in_work' || cur.executor_user_id !== actor.id) throw new HttpError(409, 'status_changed', 'Статус заявки уже изменился, обновите страницу');
          const signOrg = await executorSignOrg(tx, actor.id);
          if (!signOrg) throw new HttpError(409, 'no_org', 'Вы работаете без организации — подпись организации не нужна');
          const w = await signWait(tx, order);
          if (!w) throw new HttpError(409, 'nothing_waiting', 'Нет файлов, которые ждут подписи организации');
          if (!w.can_remind) throw new HttpError(409, 'too_often', 'Напомнить можно раз в сутки — руководитель уже получил напоминание');
          const heads = (await tx`select user_id from org_members where org_id = ${signOrg.id} and role = 'head'`).map((h) => h.user_id);
          if (!heads.length) throw new HttpError(409, 'no_head', 'В организации нет руководителя — напомнить некому');
          await tx`insert into sign_reminders (order_id, org_id, user_id) values (${order.id}, ${signOrg.id}, ${actor.id})`;
          await notify(tx, 'org_sign_reminder', { users: heads, orderId: order.id, orgId: signOrg.id, actor });
          await audit(tx, actor, 'org_sign.remind', 'order', order.id, { org_id: signOrg.id, files: w.files });
          return signWait(tx, order);
        });
        res.status(201);
        return { sign_wait: wait };
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
          // Ручная проверка: файл сверяется с отпечатком при загрузке подписи, сама подпись — отметкой сотрудника платформы.
          if (s.manual_check) {
            const same = !!buf && sha256(buf) === s.digest;
            results.push({ row: s, valid: same && s.manual_check === 'ok',
              reason: !same ? 'Файл изменён после подписи' : MANUAL_REASON[s.manual_check] ?? null });
            continue;
          }
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
      // Ручная проверка подписи (SIGN_PROVIDER=manual): диспетчер заявки проверил файл и подпись на Госуслугах и отмечает
      // итог. ok: true — «подписано КЭП, проверено»; ok: false — с причиной, исполнитель получает уведомление и загружает
      // подпись заново (пока дело в работе). Файл, изменённый после подписи, не отмечается.
      id: 'signature.check', method: 'POST', path: '/api/documents/:id/signature/check', auth: 'user',
      access: { resource: 'document', param: 'id', need: 'read' },
      async handler({ sql, actor, subject: doc, order, providers, body }) {
        if (!isStaff(actor)) throw new HttpError(403, 'forbidden', 'Подпись отмечает сотрудник платформы');
        const role = body?.role === 'org' ? 'org' : 'expert';
        if (typeof body?.ok !== 'boolean') throw new HttpError(400, 'bad_ok', 'Укажите итог проверки');
        const note = String(body?.note ?? '').trim();
        if (note.length > 500) throw new HttpError(400, 'bad_input', 'Причина — не длиннее 500 символов');
        if (!body.ok && note.length < 3) throw new HttpError(400, 'note_required', 'Напишите, что не так с подписью — исполнитель это увидит');
        const s = await sql.one`select * from document_signatures where document_id = ${doc.id} and role = ${role}`;
        if (!s) throw new HttpError(404, 'not_signed', 'Файл не подписан');
        if (!s.manual_check) throw new HttpError(409, 'not_manual', 'Эту подпись платформа проверяет сама');
        if (s.manual_check !== 'pending') throw new HttpError(409, 'already_checked', 'Подпись уже отмечена');
        const buf = await providers.storage.get(doc.storage_key);
        if (!buf || sha256(buf) !== s.digest) throw new HttpError(409, 'file_changed', 'Файл изменён после подписи — отметить нельзя');
        const row = await sql.tx(async (tx) => {
          const u = await tx.one`update document_signatures set manual_check = ${body.ok ? 'ok' : 'bad'}, manual_note = ${body.ok ? null : note},
                                   manual_checked_by = ${actor.id}, manual_checked_at = now(), checked_at = now(), checked_ok = ${body.ok}
                                 where id = ${s.id} and manual_check = 'pending' returning *`;
          if (!u) throw new HttpError(409, 'changed', 'Подпись уже отметили, обновите страницу');
          await audit(tx, actor, 'signature.check', 'document', doc.id, { order_id: order.id, role, ok: body.ok });
          if (!body.ok) await notify(tx, 'signature_rejected', { users: [s.signer_id], orderId: order.id, actor });
          return u;
        });
        return { signature: signatureView(row) };
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
