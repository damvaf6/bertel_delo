// Фото осмотра дела (2.96): один порядок и один номер для дела и для Word — по шагам осмотра (как в описании модуля),
// внутри шага — по времени получения. Фото шага, которого уже нет в описании, — в конце. «Фото 7» в деле = «Фото 7» в отчёте.
export async function inspectionPhotos(sql, order, steps) {
  const rows = await sql`
    select p.document_id, p.link_id, p.visit_id, p.step, p.received_at, p.shot_at, p.lat, p.lon, p.accuracy_m,
           p.thumb is not null as has_thumb, d.filename, d.mime, d.size_bytes, d.storage_key
    from inspection_photos p join documents d on d.id = p.document_id
    where d.order_id = ${order.id} and d.deleted_at is null order by p.received_at, d.id`;
  const pos = (id) => { const i = steps.findIndex((x) => x.id === id); return i < 0 ? steps.length : i; };
  // sort устойчивый: внутри шага остаётся порядок получения.
  return rows.sort((a, b) => pos(a.step) - pos(b.step)).map((r, i) => ({ ...r, no: i + 1 }));
}
