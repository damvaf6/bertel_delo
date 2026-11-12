// Повреждённые детали таблицей (задача 2.471, «Ущерб автомобилю после ДТП»). Эксперт дела, пока дело в работе, записывает
// деталь, повреждение, ремонтное воздействие (замена, ремонт, окраска — parts.actions в модуле) и номера фото осмотра.
// Таблица — в раздел «Исследование повреждений» черновика (src/orders/parts.mjs) и оттуда в Word. Видят все, кто видит дело;
// пишет только эксперт дела.
import { HttpError } from '../http/core.mjs';
import { orderSides } from '../access/policy.mjs';
import { inspectionPhotos } from '../docs/photos.mjs';
import { DAMAGE_MAX, PARTS_MAX, PART_MAX, loadParts, partsTable, photoNos } from '../orders/parts.mjs';
import { audit, text } from './util.mjs';

const isExecutor = (actor, order) => order.executor_user_id === actor.id && orderSides(actor, order).includes('executor');
const canWrite = (spec, actor, order) => !!spec && order.status === 'in_work' && isExecutor(actor, order);
const specOf = (registry, order) => (order.module ? registry.parts(order.module, order.service) : null);

function writable(spec, actor, order) {
  if (!spec) throw new HttpError(409, 'not_supported', 'Таблица повреждённых деталей — только для ущерба автомобилю после ДТП');
  if (!isExecutor(actor, order)) throw new HttpError(403, 'forbidden', 'Таблицу повреждённых деталей ведёт эксперт дела');
  if (order.status !== 'in_work') throw new HttpError(409, 'status_changed', 'Таблицу повреждённых деталей правят, пока дело в работе');
}

// Фото осмотра дела: номер → id документа и обратно (номер — как в деле и в Word, src/docs/photos.mjs).
async function photoMaps(sql, registry, order) {
  const steps = registry.inspectionSteps(order.module, order.service);
  const rows = await inspectionPhotos(sql, order, steps);
  return {
    list: rows.map((r) => ({ no: r.no, step: steps.find((s) => s.id === r.step)?.title ?? 'Снимок вне шагов осмотра' })),
    byNo: new Map(rows.map((r) => [r.no, String(r.document_id)])),
    noOf: new Map(rows.map((r) => [String(r.document_id), r.no])),
  };
}

export async function partsView(sql, registry, actor, order) {
  const spec = specOf(registry, order);
  if (!spec) return { available: false };
  const [list, photos] = await Promise.all([loadParts(sql, order.id), photoMaps(sql, registry, order)]);
  const name = (id) => spec.actions.find((a) => a.id === id)?.name ?? id;
  return {
    available: true, can_write: canWrite(spec, actor, order),
    actions: spec.actions, part_max: PART_MAX, damage_max: DAMAGE_MAX, max: PARTS_MAX,
    photos: photos.list,
    parts: list.map((p, i) => {
      const nos = photoNos(p, photos.noOf);
      return { id: String(p.id), no: i + 1, part: p.part, damage: p.damage, actions: p.actions, action_names: p.actions.map(name), photos: nos };
    }),
    table: partsTable(list, spec.actions, photos.noOf),
  };
}

// Тело записи: { part, damage, actions: [id…], photos: [номер фото…] }.
async function readBody(sql, registry, order, spec, body) {
  const part = text(body?.part, 'Деталь', PART_MAX);
  const damage = text(body?.damage, 'Повреждение', DAMAGE_MAX);
  const actions = Array.isArray(body?.actions) ? [...new Set(body.actions.map(String))] : [];
  if (!actions.length) throw new HttpError(400, 'bad_input', 'Выберите ремонтное воздействие: замена, ремонт или окраска');
  for (const a of actions) if (!spec.actions.some((x) => x.id === a)) throw new HttpError(400, 'bad_input', 'Неизвестное ремонтное воздействие');
  const raw = body?.photos ?? [];
  if (!Array.isArray(raw) || raw.length > 30) throw new HttpError(400, 'bad_input', 'Номера фото — списком, не больше 30');
  const { byNo } = await photoMaps(sql, registry, order);
  const ids = [];
  for (const v of raw) {
    const no = Number(v);
    if (!Number.isInteger(no) || !byNo.has(no)) throw new HttpError(400, 'bad_input', `В деле нет фото осмотра № ${String(v).slice(0, 10)}`);
    if (!ids.includes(byNo.get(no))) ids.push(byNo.get(no));
  }
  // Порядок ремонтных воздействий — как в описании модуля (замена, ремонт, окраска).
  return { part, damage, actions: spec.actions.map((a) => a.id).filter((id) => actions.includes(id)), ids };
}

async function partOf(sql, order, raw) {
  const id = /^\d{1,15}$/.test(String(raw ?? '')) ? String(raw) : null;
  const p = id ? await sql.one`select * from damaged_parts where id = ${id} and order_id = ${order.id}` : null;
  if (!p) throw new HttpError(404, 'not_found', 'Деталь не найдена в этом деле');
  return p;
}

export function partsOps() {
  const access = { resource: 'order', param: 'id', need: 'read' };
  return [
    {
      id: 'parts.list', method: 'GET', path: '/api/orders/:id/parts', auth: 'user', access,
      handler: ({ sql, registry, actor, order }) => partsView(sql, registry, actor, order),
    },
    {
      id: 'parts.add', method: 'POST', path: '/api/orders/:id/parts', auth: 'user', access,
      async handler({ sql, registry, actor, order, body, res }) {
        const spec = specOf(registry, order);
        writable(spec, actor, order);
        const v = await readBody(sql, registry, order, spec, body);
        await sql.tx(async (tx) => {
          await tx`select id from orders where id = ${order.id} for update`;
          const [{ n }] = await tx`select count(*)::int as n from damaged_parts where order_id = ${order.id}`;
          if (n >= PARTS_MAX) throw new HttpError(409, 'too_many', `В таблице уже ${PARTS_MAX} деталей`);
          const row = await tx.one`insert into damaged_parts (order_id, part, damage, actions, photo_ids, created_by)
                                   values (${order.id}, ${v.part}, ${v.damage}, ${v.actions}, ${v.ids}, ${actor.id}) returning id`;
          await audit(tx, actor, 'parts.add', 'order', order.id, { part: String(row.id) });
        });
        res.status(201);
        return partsView(sql, registry, actor, order);
      },
    },
    {
      id: 'parts.edit', method: 'PUT', path: '/api/orders/:id/parts/:part', auth: 'user', access,
      async handler({ sql, registry, actor, order, body, params }) {
        const spec = specOf(registry, order);
        writable(spec, actor, order);
        const p = await partOf(sql, order, params.part);
        const v = await readBody(sql, registry, order, spec, body);
        await sql.tx(async (tx) => {
          await tx`update damaged_parts set part = ${v.part}, damage = ${v.damage}, actions = ${v.actions}, photo_ids = ${v.ids}, updated_at = now()
                   where id = ${p.id}`;
          await audit(tx, actor, 'parts.edit', 'order', order.id, { part: String(p.id) });
        });
        return partsView(sql, registry, actor, order);
      },
    },
    {
      id: 'parts.delete', method: 'DELETE', path: '/api/orders/:id/parts/:part', auth: 'user', access,
      async handler({ sql, registry, actor, order, params }) {
        const spec = specOf(registry, order);
        writable(spec, actor, order);
        const p = await partOf(sql, order, params.part);
        await sql.tx(async (tx) => {
          await tx`delete from damaged_parts where id = ${p.id}`;
          await audit(tx, actor, 'parts.delete', 'order', order.id, { part: String(p.id) });
        });
        return partsView(sql, registry, actor, order);
      },
    },
  ];
}
