// Повторная оценка того же объекта (задача 2.118). Эксперт снова оценивает объект, который уже оценивал (новая дата, другая
// цель, другой заказчик): в деле — «Взять из моего дела №…». Свои прошлые дела той же услуги, где он исполнитель и объект
// тот же (src/orders/repeat.mjs), — и из выбранного он берёт:
//   — разделы описания объекта (repeat.sections в модуле) новой версией черновика: приметы объекта остаются, данные прошлого
//     заказчика (имена, основание, даты, телефоны, суммы) и то, что изменилось с прошлого раза (площадь, пробег), —
//     пометкой «[заполнить: данные этого дела]»;
//   — аналоги: копия ссылки, признаков, корректировок и скриншота (время получения и отпечаток прежние), без подтверждения —
//     эксперт сверяет, годится ли объявление на новую дату; повторы ссылок не копируются;
//   — запрос у заказчика тех же документов из списка услуги, что он просил в прошлый раз (выписка ЕГРН, ПТС): сами файлы
//     прошлого заказчика в новое дело не переходят.
// Видит и делает только исполнитель, пока дело в работе. Чужое дело, другая услуга или другой объект — «не найдено».
import crypto from 'node:crypto';
import { HttpError } from '../http/core.mjs';
import { editsDraft } from '../access/policy.mjs';
import { DRAFT_MAX } from '../ai/ai.mjs';
import { orderSections } from '../docs/report.mjs';
import { pastValues, reuseSections } from '../docs/reuse.mjs';
import { compareObject } from '../orders/repeat.mjs';
import { orderRef } from '../notify/registry.mjs';
import { customersOf, notify } from '../notify/notify.mjs';
import { MAX_ANALOGS } from './analog-ops.mjs';
import { emptyDraft, latest, sameBase } from './draft-ops.mjs';
import { audit, uuidFrom } from './util.mjs';

const LOOK_BACK = 50;
const SHOW = 5;
const MAX_OPEN_DOCS = 30;

function guard(actor, order) {
  if (!editsDraft(actor, order)) throw new HttpError(403, 'forbidden', 'Взять данные из прошлого дела может исполнитель, пока дело в работе');
}

// Свои прошлые дела той же услуги (исполнитель — этот эксперт), последние сначала.
const ownCases = (sql, actor, order, pastId = null) => sql`
  select o.id, o.title, o.module, o.service, o.fields, o.basis_number, o.basis_date, o.deadline, o.created_at, o.status,
         o.owner_user_id, o.org_id
  from orders o
  where o.executor_user_id = ${actor.id} and o.module = ${order.module} and o.service = ${order.service} and o.id <> ${order.id}
    and (${pastId}::uuid is null or o.id = ${pastId}::uuid)
  order by o.created_at desc limit ${LOOK_BACK}`;

// Что изменилось с прошлого раза: прочие поля услуги (кроме полей узнавания объекта), заполненные в прошлом деле иначе.
function changes(registry, spec, past, order) {
  const def = registry.service(order.module, order.service);
  const own = new Set(def.service.fields?.map((f) => f.id) ?? []);
  const match = new Set(spec.match.map((f) => f.id));
  const shown = (f, v) => {
    if (v === null || v === undefined || v === '') return null;
    if (f.type === 'select') return f.options.find((o) => o.id === v)?.name ?? String(v);
    return String(v);
  };
  return def.fields.filter((f) => own.has(f.id) && !match.has(f.id) && f.type !== 'longtext')
    .map((f) => ({ id: f.id, label: f.label, past: shown(f, past.fields?.[f.id]), now: shown(f, order.fields?.[f.id]) }))
    .filter((c) => c.past !== null && c.past !== c.now);
}

async function lastOwnDraft(sql, actor, orderId) {
  return sql.one`select id, body from result_drafts where order_id = ${orderId} and author_id = ${actor.id} order by id desc limit 1`;
}

// Документы из списка услуги, которые эксперт просил в прошлом деле и которых в этом ещё не просил и не получил.
async function docsToAsk(sql, registry, past, order) {
  const catalog = registry.requestDocs(order.module, order.service, order.basis_kind).filter((c) => !c.basis);
  const was = new Set((await sql`select distinct item_id from doc_requests where order_id = ${past.id} and cancelled_at is null and item_id is not null`).map((r) => r.item_id));
  const here = new Set((await sql`select item_id from doc_requests where order_id = ${order.id} and cancelled_at is null and item_id is not null`).map((r) => r.item_id));
  return catalog.filter((c) => was.has(c.id) && !here.has(c.id));
}

async function analogsToCopy(sql, registry, past, order) {
  if (!registry.analogs(order.module, order.service)) return [];
  const here = new Set((await sql`select url_key from order_analogs where order_id = ${order.id} and deleted_at is null`).map((r) => r.url_key));
  const rows = await sql`select * from order_analogs where order_id = ${past.id} and deleted_at is null order by id`;
  const seen = new Set();
  return rows.filter((a) => !here.has(a.url_key) && !seen.has(a.url_key) && seen.add(a.url_key));
}

// Свои дела с тем же объектом и что из каждого можно взять.
async function sameObjectCases(sql, actor, order, registry, spec, pastId = null) {
  const sections = orderSections(registry, order).filter((s) => spec.sections.includes(s.id));
  const out = [];
  for (const past of await ownCases(sql, actor, order, pastId)) {
    const cmp = compareObject(spec, past, order);
    if (!cmp.same) continue;
    const draft = await lastOwnDraft(sql, actor, past.id);
    out.push({
      past,
      draft,
      sections: draft ? reuseSections('', sections, draft.body, [], { pick: () => true }).used : [],
      analogs: await analogsToCopy(sql, registry, past, order),
      docs: await docsToAsk(sql, registry, past, order),
      fields: cmp.fields,
      changed: changes(registry, spec, past, order),
    });
    if (out.length >= SHOW) break;
  }
  return out;
}

const caseView = (c) => ({
  id: c.past.id, ref: orderRef(c.past.id), created_at: c.past.created_at, status: c.past.status,
  fields: c.fields, changed: c.changed,
  sections: c.sections, analogs: c.analogs.length, docs: c.docs.map((d) => d.title),
});

export function repeatOps() {
  return [
    {
      id: 'orders.repeat', method: 'GET', path: '/api/orders/:id/repeat', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry }) {
        // Не исполнитель или дело не в работе — брать нечего (страница блок не показывает).
        if (!editsDraft(actor, order)) return { cases: [] };
        const spec = registry.repeat(order.module, order.service);
        if (!spec) return { cases: [] };
        const list = await sameObjectCases(sql, actor, order, registry, spec);
        return { cases: list.map(caseView).filter((c) => c.sections.length || c.analogs || c.docs.length) };
      },
    },
    {
      // Взять из своего прошлого дела с тем же объектом: take — что именно (sections, analogs, docs); from — версия черновика,
      // которую эксперт видел (нужна, если берутся разделы).
      id: 'orders.repeat.take', method: 'POST', path: '/api/orders/:id/repeat', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry, providers, body }) {
        guard(actor, order);
        const spec = registry.repeat(order.module, order.service);
        if (!spec) throw new HttpError(400, 'no_repeat', 'Для этой услуги повторной оценки нет');
        const pastId = uuidFrom(body?.past_id, 'Прошлое дело не найдено');
        const [c] = await sameObjectCases(sql, actor, order, registry, spec, pastId);
        if (!c) throw new HttpError(404, 'not_found', 'Прошлое дело не найдено');
        const take = body?.take ?? {};
        for (const k of ['sections', 'analogs', 'docs']) {
          if (take[k] !== undefined && typeof take[k] !== 'boolean') throw new HttpError(400, 'bad_input', 'Отметьте, что взять: да или нет');
        }
        if (!take.sections && !take.analogs && !take.docs) throw new HttpError(400, 'nothing_selected', 'Отметьте, что взять из прошлого дела');
        const ref = orderRef(c.past.id);

        // Скриншоты аналогов копируются до записи в базу; если запись не прошла — копии удаляются.
        const copies = [];
        if (take.analogs) {
          for (const a of c.analogs) {
            let key = null;
            const buf = a.file_key ? await providers.storage.get(a.file_key) : null;
            if (buf) {
              key = `analogs/${order.id}/${crypto.randomUUID()}`;
              await providers.storage.put(key, buf, a.file_mime);
            }
            copies.push({ a, key: buf ? key : null });
          }
        }
        const sections = orderSections(registry, order);
        const empty = take.sections && c.draft ? await emptyDraft(sql, actor, order, registry, sections) : null;
        const [names] = await sql`select (select full_name from users where id = ${c.past.owner_user_id}) as owner,
                                         (select name from organizations where id = ${c.past.org_id}) as org`;
        try {
          const got = await sql.tx(async (tx) => {
            await tx`select id from orders where id = ${order.id} for update`;
            const done = { sections: [], marks: 0, analogs: 0, docs: [] };
            if (take.sections) {
              if (!c.draft || !c.sections.length) throw new HttpError(409, 'no_sections', `В деле ${ref} нет Вашего описания объекта`);
              const cur = await latest(tx, order.id);
              sameBase(cur, body?.from);
              // Приметы того же объекта (адрес, кадастровый номер, VIN) и то, что совпадает с этим делом, остаются; данные
              // прошлого заказчика и изменившиеся поля — пометкой «заполнить».
              const matchIds = new Set(spec.match.map((f) => f.id));
              const objectFields = Object.fromEntries(Object.entries(c.past.fields ?? {}).filter(([k]) => matchIds.has(k)));
              const keep = new Set([...pastValues(registry, order, []), ...pastValues(registry, { ...c.past, title: null, basis_number: null, basis_date: null, deadline: null, created_at: null, fields: objectFields }, [])]
                .map((v) => v.toLowerCase()));
              const values = pastValues(registry, c.past, [names?.owner, names?.org]).filter((v) => !keep.has(v.toLowerCase()));
              const res = reuseSections(cur?.body ?? empty, sections.filter((s) => spec.sections.includes(s.id)), c.draft.body, values, { pick: () => true, keepObject: true });
              if (!res.used.length) throw new HttpError(409, 'no_sections', `В деле ${ref} нет Вашего описания объекта`);
              await tx`insert into result_drafts (order_id, author_id, source, body, inputs)
                       values (${order.id}, ${actor.id}, 'past', ${res.body.slice(0, DRAFT_MAX)},
                               ${JSON.stringify({ ...(cur?.inputs ?? {}), repeat: { ref, sections: res.used, marks: res.marks } })})`;
              done.sections = res.used;
              done.marks = res.marks;
            }
            if (take.analogs && copies.length) {
              const here = await tx`select url_key from order_analogs where order_id = ${order.id} and deleted_at is null`;
              const keys = new Set(here.map((r) => r.url_key));
              let room = MAX_ANALOGS - here.length;
              for (const { a, key } of copies) {
                if (room <= 0 || keys.has(a.url_key)) continue;
                await tx`insert into order_analogs (order_id, author_id, url, url_key, fields, adjustments, file_key, file_name, file_mime,
                                                    file_size, file_sha256, received_at, copied_from)
                         values (${order.id}, ${actor.id}, ${a.url}, ${a.url_key}, ${JSON.stringify(a.fields ?? {})}, ${JSON.stringify(a.adjustments ?? [])},
                                 ${key}, ${key ? a.file_name : null}, ${key ? a.file_mime : null}, ${key ? a.file_size : null},
                                 ${key ? a.file_sha256 : null}, ${key ? a.received_at : null}, ${a.id})`;
                keys.add(a.url_key);
                room -= 1;
                done.analogs += 1;
              }
              if (take.analogs && !done.analogs && room <= 0) throw new HttpError(409, 'too_many', `В деле — не больше ${MAX_ANALOGS} аналогов`);
            }
            if (take.docs && c.docs.length) {
              const open = await tx.one`select count(*)::int as n from doc_requests where order_id = ${order.id} and cancelled_at is null and fulfilled_at is null`;
              if (open.n + c.docs.length > MAX_OPEN_DOCS) throw new HttpError(409, 'too_many', `Не больше ${MAX_OPEN_DOCS} неполученных документов в деле`);
              for (const d of c.docs) {
                await tx`insert into doc_requests (order_id, item_id, title, requested_by) values (${order.id}, ${d.id}, ${d.title}, ${actor.id})`;
              }
              await audit(tx, actor, 'doc_request.create', 'order', order.id, { titles: c.docs.map((d) => d.title) });
              await notify(tx, 'docs_requested', { users: await customersOf(tx, order), orderId: order.id, actor });
              done.docs = c.docs.map((d) => d.title);
            }
            if (!done.sections.length && !done.analogs && !done.docs.length) {
              throw new HttpError(409, 'nothing_to_take', `Из дела ${ref} брать уже нечего: всё отмеченное уже есть в этом деле`);
            }
            await audit(tx, actor, 'order.repeat', 'order', order.id, { past: c.past.id, sections: done.sections.length, analogs: done.analogs, docs: done.docs.length });
            return done;
          });
          // Скопированные, но не записанные скриншоты (повтор ссылки, нет места) не нужны.
          const used = new Set((await sql`select file_key from order_analogs where order_id = ${order.id} and file_key is not null`).map((r) => r.file_key));
          await Promise.all(copies.filter((x) => x.key && !used.has(x.key)).map((x) => providers.storage.delete(x.key).catch(() => {})));
          return { ref, taken: got };
        } catch (e) {
          await Promise.all(copies.filter((x) => x.key).map((x) => providers.storage.delete(x.key).catch(() => {})));
          throw e;
        }
      },
    },
  ];
}
