// Недостатки товара таблицей (задача 2.482, товароведческая экспертиза). Эксперт дела, пока дело в работе, записывает
// недостаток, где он и какой размер, характер (defects.natures в модуле), признаки и номера фото осмотра. Таблица — в раздел
// «5. Исследование» черновика (src/orders/defects.mjs) и оттуда в Word. Недостатки из заявки, которых ещё нет в таблице, —
// подсказкой эксперту. Видят все, кто видит дело; пишет только эксперт дела.
import { HttpError } from '../http/core.mjs';
import { orderSides } from '../access/policy.mjs';
import { inspectionPhotos } from '../docs/photos.mjs';
import { photoNos } from '../orders/parts.mjs';
import { DEFECTS_MAX, DEFECT_MAX, PLACE_MAX, SIGNS_MAX, claimedLeft, defectsTable, loadDefects } from '../orders/defects.mjs';
import { audit, text } from './util.mjs';

const isExecutor = (actor, order) => order.executor_user_id === actor.id && orderSides(actor, order).includes('executor');
const canWrite = (spec, actor, order) => !!spec && order.status === 'in_work' && isExecutor(actor, order);
const specOf = (registry, order) => (order.module ? registry.defects(order.module, order.service) : null);

function writable(spec, actor, order) {
  if (!spec) throw new HttpError(409, 'not_supported', 'Таблица недостатков — только для товароведческой экспертизы');
  if (!isExecutor(actor, order)) throw new HttpError(403, 'forbidden', 'Таблицу недостатков ведёт эксперт дела');
  if (order.status !== 'in_work') throw new HttpError(409, 'status_changed', 'Таблицу недостатков правят, пока дело в работе');
}

// Фото осмотра дела: номер → id документа и обратно (номер — как в деле и в Word, src/docs/photos.mjs).
async function photoMaps(sql, registry, order) {
  const steps = registry.inspectionSteps(order.module, order.service, order.fields);
  const rows = await inspectionPhotos(sql, order, steps);
  return {
    list: rows.map((r) => ({ no: r.no, step: steps.find((s) => s.id === r.step)?.title ?? 'Снимок вне шагов осмотра' })),
    byNo: new Map(rows.map((r) => [r.no, String(r.document_id)])),
    noOf: new Map(rows.map((r) => [String(r.document_id), r.no])),
  };
}

export async function defectsView(sql, registry, actor, order) {
  const spec = specOf(registry, order);
  if (!spec) return { available: false };
  const [list, photos] = await Promise.all([loadDefects(sql, order.id), photoMaps(sql, registry, order)]);
  const name = (id) => spec.natures.find((a) => a.id === id)?.name ?? id;
  return {
    available: true, can_write: canWrite(spec, actor, order),
    natures: spec.natures, defect_max: DEFECT_MAX, place_max: PLACE_MAX, signs_max: SIGNS_MAX, max: DEFECTS_MAX,
    photos: photos.list,
    claimed: claimedLeft(order.fields?.defects, list),
    defects: list.map((d, i) => ({ id: String(d.id), no: i + 1, defect: d.defect, place: d.place, nature: d.nature, nature_name: name(d.nature),
      signs: d.signs, photos: photoNos(d, photos.noOf) })),
    table: defectsTable(list, spec.natures, photos.noOf),
  };
}

// Тело записи: { defect, place, nature, signs?, photos: [номер фото…] }.
async function readBody(sql, registry, order, spec, body) {
  const defect = text(body?.defect, 'Недостаток', DEFECT_MAX);
  const place = text(body?.place, 'Где и какой размер', PLACE_MAX);
  const nature = String(body?.nature ?? '');
  if (!nature) throw new HttpError(400, 'bad_input', `Выберите характер недостатка: ${spec.natures.map((a) => a.name).join(', ')}`);
  if (!spec.natures.some((a) => a.id === nature)) throw new HttpError(400, 'bad_input', 'Неизвестный характер недостатка');
  const signs = body?.signs == null || String(body.signs).trim() === '' ? '' : text(body.signs, 'Признаки', SIGNS_MAX);
  const raw = body?.photos ?? [];
  if (!Array.isArray(raw) || raw.length > 30) throw new HttpError(400, 'bad_input', 'Номера фото — списком, не больше 30');
  const { byNo } = await photoMaps(sql, registry, order);
  const ids = [];
  for (const v of raw) {
    const no = Number(v);
    if (!Number.isInteger(no) || !byNo.has(no)) throw new HttpError(400, 'bad_input', `В деле нет фото осмотра № ${String(v).slice(0, 10)}`);
    if (!ids.includes(byNo.get(no))) ids.push(byNo.get(no));
  }
  return { defect, place, nature, signs, ids };
}

async function defectOf(sql, order, raw) {
  const id = /^\d{1,15}$/.test(String(raw ?? '')) ? String(raw) : null;
  const d = id ? await sql.one`select * from goods_defects where id = ${id} and order_id = ${order.id}` : null;
  if (!d) throw new HttpError(404, 'not_found', 'Недостаток не найден в этом деле');
  return d;
}

export function defectOps() {
  const access = { resource: 'order', param: 'id', need: 'read' };
  return [
    {
      id: 'defects.list', method: 'GET', path: '/api/orders/:id/defects', auth: 'user', access,
      handler: ({ sql, registry, actor, order }) => defectsView(sql, registry, actor, order),
    },
    {
      id: 'defects.add', method: 'POST', path: '/api/orders/:id/defects', auth: 'user', access,
      async handler({ sql, registry, actor, order, body, res }) {
        const spec = specOf(registry, order);
        writable(spec, actor, order);
        const v = await readBody(sql, registry, order, spec, body);
        await sql.tx(async (tx) => {
          await tx`select id from orders where id = ${order.id} for update`;
          const [{ n }] = await tx`select count(*)::int as n from goods_defects where order_id = ${order.id}`;
          if (n >= DEFECTS_MAX) throw new HttpError(409, 'too_many', `В таблице уже ${DEFECTS_MAX} недостатков`);
          const row = await tx.one`insert into goods_defects (order_id, defect, place, nature, signs, photo_ids, created_by)
                                   values (${order.id}, ${v.defect}, ${v.place}, ${v.nature}, ${v.signs}, ${v.ids}, ${actor.id}) returning id`;
          await audit(tx, actor, 'defects.add', 'order', order.id, { defect: String(row.id) });
        });
        res.status(201);
        return defectsView(sql, registry, actor, order);
      },
    },
    {
      id: 'defects.edit', method: 'PUT', path: '/api/orders/:id/defects/:defect', auth: 'user', access,
      async handler({ sql, registry, actor, order, body, params }) {
        const spec = specOf(registry, order);
        writable(spec, actor, order);
        const d = await defectOf(sql, order, params.defect);
        const v = await readBody(sql, registry, order, spec, body);
        await sql.tx(async (tx) => {
          await tx`update goods_defects set defect = ${v.defect}, place = ${v.place}, nature = ${v.nature}, signs = ${v.signs},
                   photo_ids = ${v.ids}, updated_at = now() where id = ${d.id}`;
          await audit(tx, actor, 'defects.edit', 'order', order.id, { defect: String(d.id) });
        });
        return defectsView(sql, registry, actor, order);
      },
    },
    {
      id: 'defects.delete', method: 'DELETE', path: '/api/orders/:id/defects/:defect', auth: 'user', access,
      async handler({ sql, registry, actor, order, params }) {
        const spec = specOf(registry, order);
        writable(spec, actor, order);
        const d = await defectOf(sql, order, params.defect);
        await sql.tx(async (tx) => {
          await tx`delete from goods_defects where id = ${d.id}`;
          await audit(tx, actor, 'defects.delete', 'order', order.id, { defect: String(d.id) });
        });
        return defectsView(sql, registry, actor, order);
      },
    },
  ];
}
