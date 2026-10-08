// Мои похожие дела (задача 2.129). Исполнителю в деле — свои сданные дела той же услуги и того же вида объекта за последний
// год (квартира к квартире, легковой автомобиль к легковому): открыть своё прошлое заключение как образец. Вид объекта —
// первое поле выбора из полей самой услуги (object_type, vehicle_type, land_use…); у услуги без такого поля — вся услуга.
// В списке нет данных прошлого заказчика: ни названия заявки, ни адреса, ни имён, ни имени файла — только номер дела, дата
// сдачи, вид объекта, цель и место оценки и сколько файлов заключения. В новое дело ничего не переносится: файл открывается
// по обычной ссылке на документ своего прошлого дела (documents.link — проверка доступа та же, что в том деле).
// Видит только исполнитель, пока дело в работе; остальным — пустой список.
import { editsDraft } from '../access/policy.mjs';
import { orderRef } from '../notify/registry.mjs';

const SHOW = 10;
const DAYS = 365;

// Поле «вид объекта» услуги: первое поле выбора среди полей самой услуги (не общих полей модуля).
export function kindField(def) {
  return (def?.service.fields ?? []).find((f) => f.type === 'select') ?? null;
}

const optionName = (field, v) => (field && v ? field.options.find((o) => o.id === v)?.name ?? null : null);

// Сданные (готово или закрыто) свои дела той же услуги: дата сдачи — последний переход в «Готово» не раньше чем год назад.
export async function similarCases(sql, registry, actor, order) {
  const def = registry.service(order.module, order.service);
  if (!def) return { kind: null, cases: [] };
  const kf = kindField(def);
  const kind = kf ? order.fields?.[kf.id] ?? null : null;
  const rows = await sql`
    select o.id, o.fields, o.status, d.at as done_at,
           (select count(*)::int from documents x where x.order_id = o.id and x.kind = 'result' and x.deleted_at is null) as files
    from orders o
    join lateral (select max(h.at) as at from order_status_history h where h.order_id = o.id and h.to_status = 'done') d on true
    where o.executor_user_id = ${actor.id} and o.module = ${order.module} and o.service = ${order.service} and o.id <> ${order.id}
      and o.status in ('done', 'closed') and d.at >= now() - make_interval(days => ${DAYS})
      and (${kf && kind ? kf.id : null}::text is null or o.fields ->> ${kf?.id ?? ''} = ${kind ?? ''})
    order by d.at desc limit ${SHOW * 3}`;
  const purpose = def.fields.find((f) => f.id === 'purpose');
  const region = def.fields.find((f) => f.id === 'region');
  const docs = await sql`select id, order_id, filename, size_bytes from documents
                         where order_id = any(${rows.map((r) => r.id)}::uuid[]) and kind = 'result' and deleted_at is null
                         order by created_at`;
  // Сначала дела с той же целью оценки (для суда — к суду), внутри — последние сданные.
  const same = (r) => !!order.fields?.purpose && r.fields?.purpose === order.fields.purpose;
  const cases = rows.filter((r) => r.files > 0)
    .sort((a, b) => Number(same(b)) - Number(same(a)) || b.done_at - a.done_at)
    .slice(0, SHOW)
    .map((r) => ({
      id: r.id, ref: orderRef(r.id), done_at: r.done_at,
      kind: optionName(kf, r.fields?.[kf?.id]),
      purpose: optionName(purpose, r.fields?.purpose),
      region: optionName(region, r.fields?.region),
      same_purpose: same(r),
      files: docs.filter((d) => d.order_id === r.id).map((d) => ({ id: d.id, type: fileType(d.filename), size_bytes: d.size_bytes })),
    }));
  return { kind: optionName(kf, kind), cases };
}

// Вид файла по расширению — вместо имени файла (в имени бывают фамилия и адрес прошлого заказчика).
function fileType(name) {
  const ext = String(name).toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1];
  return { pdf: 'PDF', doc: 'Word', docx: 'Word', sig: 'подпись', p7s: 'подпись', zip: 'архив', jpg: 'фото', jpeg: 'фото', png: 'фото' }[ext] ?? 'файл';
}

export function similarOps() {
  return [
    {
      id: 'orders.similar', method: 'GET', path: '/api/orders/:id/similar', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry }) {
        if (!editsDraft(actor, order)) return { kind: null, cases: [] };
        return similarCases(sql, registry, actor, order);
      },
    },
  ];
}
