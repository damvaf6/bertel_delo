// Акт осмотра (2.421): Word из осмотра дела — когда осматривали, где, кто снимал (владелец по ссылке, помощник на выезде),
// шаги осмотра с номерами фото, временем и геометкой. Номера фото — те же, что в деле и в приложении «Фотоматериалы осмотра»
// отчёта (2.96). Суд и банк просят именно акт — эксперт больше не переписывает его вручную.
// В акте и данные с объекта от помощника (экспресс, 2.4), и какие шаги доснимали по просьбе эксперта (2.237) — 2.422.
import { isStaff } from '../access/policy.mjs';
import { orderRef } from '../notify/registry.mjs';
import { todayMsk } from '../orders/workflow.mjs';
import { timeMsk, valueText } from '../analogs/analogs.mjs';
import { buildSimpleDoc } from './docx.mjs';
import { inspectionPhotos } from './photos.mjs';

const ru = (d) => String(d).slice(0, 10).split('-').reverse().join('.');
const TITLE = { document: 'Акт съёмки документа', goods: 'Акт осмотра товара', car: 'Акт осмотра автомобиля' };
const geo = (p) => (p.lat == null ? 'не определено'
  : `${Number(p.lat).toFixed(5)}, ${Number(p.lon).toFixed(5)}${p.accuracy_m != null ? ` (±${Math.round(p.accuracy_m)} м)` : ''}`);
// Время снимка — по часам телефона; телефон не передал — время получения платформой, с пометкой.
const shotTime = (p) => (p.shot_at ? timeMsk(p.shot_at) : `${timeMsk(p.received_at)} (получено)`);
const when = (p) => new Date(p.shot_at ?? p.received_at).getTime();

// Данные с объекта: подпись поля и значение (для выбора — название варианта), как в «Выездах» (onsite.get).
const visitData = (fields, data) => fields.map((f) => [f.label, valueText(f, data?.[f.id])]).filter(([, v]) => v);

// Сведения акта; null — фото осмотра в деле нет. Имя помощника — исполнителю и служебным (как в «Выездах», onsite.get).
// reshot — доснятые по просьбе эксперта шаги (reshotSteps в inspect-ops.mjs, по тем же фото).
export async function inspectionActData(sql, registry, order, actor, reshotOf = async () => ({})) {
  const steps = registry.inspectionSteps(order.module, order.service);
  const photos = await inspectionPhotos(sql, order, steps);
  if (!photos.length) return null;
  const def = registry.service(order.module, order.service);
  const names = isStaff(actor) || order.executor_user_id === actor.id;
  const links = await sql`select id, created_at, finished_at from inspection_links where order_id = ${order.id} order by id`;
  const visits = await sql`select v.id, v.planned_at, v.finished_at, v.cancelled_at, v.data, u.full_name from onsite_visits v join users u on u.id = v.helper_id
                           where v.order_id = ${order.id} order by v.id`;
  const [executor] = order.executor_user_id ? await sql`select full_name from users where id = ${order.executor_user_id}` : [];
  const helperOf = (id) => {
    const v = visits.find((x) => String(x.id) === String(id));
    return names && v?.full_name ? `помощник ${v.full_name}` : 'помощник на выезде';
  };
  const who = (p) => (p.visit_id != null ? helperOf(p.visit_id) : 'владелец по ссылке');
  const times = photos.map(when);
  const addr = def?.fields.find((f) => f.id === 'address') ?? def?.fields.find((f) => f.id === 'location');
  const ways = [
    ...links.map((l) => {
      const n = photos.filter((p) => String(p.link_id) === String(l.id)).length;
      return n ? `Владелец снимал по ссылке (выдана ${timeMsk(l.created_at)}${l.finished_at ? `, «Готово» — ${timeMsk(l.finished_at)}` : ''}): фото ${n}` : null;
    }),
    ...visits.map((v) => {
      const n = photos.filter((p) => String(p.visit_id) === String(v.id)).length;
      return n ? `Выезд на объект — ${names && v.full_name ? `помощник ${v.full_name}` : 'помощник'} (${v.finished_at ? `завершён ${timeMsk(v.finished_at)}` : `назначен на ${timeMsk(v.planned_at)}`}): фото ${n}` : null;
    }),
  ].filter(Boolean);
  // Данные с объекта — по каждому выезду, который не отменён и где помощник что-то записал.
  const fields = registry.express(order.module, order.service)?.fields ?? [];
  const onsite = visits.filter((v) => !v.cancelled_at).map((v) => ({
    who: names && v.full_name ? `помощник ${v.full_name}` : 'помощник на выезде',
    when: v.finished_at ? timeMsk(v.finished_at) : null,
    rows: visitData(fields, v.data),
  })).filter((v) => v.rows.length);
  const reshot = await reshotOf(photos);
  const reshotNo = new Set(Object.values(reshot).map((r) => r.after.no));
  const from = Math.min(...times);
  const to = Math.max(...times);
  return {
    title: TITLE[def?.service.subject] ?? 'Акт осмотра объекта',
    ref: orderRef(order.id),
    service: def?.service.name ?? order.title,
    address: addr && order.fields?.[addr.id] ? { label: addr.label, v: String(order.fields[addr.id]) } : null,
    period: from === to ? timeMsk(from) : `с ${timeMsk(from)} по ${timeMsk(to)}`,
    executor: executor?.full_name || null,
    ways,
    onsite,
    reshot: steps.filter((s) => reshot[s.id]).map((s) => ({ step: s.title, note: reshot[s.id].note,
      asked: timeMsk(reshot[s.id].requested_at), after: reshot[s.id].after.no, before: reshot[s.id].before?.no ?? null })),
    total: photos.length,
    with_geo: photos.filter((p) => p.lat != null).length,
    rows: steps.flatMap((s) => {
      const mine = photos.filter((p) => p.step === s.id);
      if (!mine.length) return [{ no: null, step: s.title, missed: s.optional ? 'не снято (шаг «если есть»)' : 'не снято' }];
      return mine.map((p) => ({ no: p.no, step: reshotNo.has(p.no) ? `${s.title} (доснято по просьбе эксперта)` : s.title, time: shotTime(p), geo: geo(p), who: who(p) }));
    }).concat(photos.filter((p) => !steps.some((s) => s.id === p.step))
      .map((p) => ({ no: p.no, step: 'Снимок вне шагов осмотра', time: shotTime(p), geo: geo(p), who: who(p) }))),
  };
}

export function inspectionActDoc(a) {
  const table = [['Фото', 'Шаг осмотра', 'Снято (МСК)', 'Место съёмки', 'Кто снимал'],
    ...a.rows.map((r) => (r.no == null ? ['—', r.step, r.missed, '—', '—'] : [`Фото ${r.no}`, r.step, r.time, r.geo, r.who]))];
  const blocks = [
    { type: 'title', text: `${a.title} · дело ${a.ref}` },
    { type: 'table', rows: [
      ['Услуга', a.service],
      ...(a.address ? [[a.address.label, a.address.v]] : []),
      ['Когда осматривали (МСК)', a.period],
      ['Эксперт', a.executor ?? '—'],
      ['Как проведён осмотр', a.ways.join('; ') || '—'],
      ['Фото', `${a.total}, с геометкой — ${a.with_geo}`],
    ] },
    { type: 'bold', text: 'Шаги осмотра' },
    { type: 'table', rows: table },
    ...a.reshot.length ? [
      { type: 'bold', text: 'Доснято по просьбе эксперта' },
      { type: 'table', rows: [['Шаг осмотра', 'Просьба эксперта', 'Новое фото', 'Прежнее фото'],
        ...a.reshot.map((r) => [r.step, `«${r.note}» (${r.asked})`, `Фото ${r.after}`, r.before == null ? 'не было' : `Фото ${r.before}`])] },
    ] : [],
    ...a.onsite.flatMap((v) => [
      { type: 'bold', text: `Данные с объекта — ${v.who}${v.when ? `, ${v.when}` : ''}` },
      { type: 'table', rows: v.rows },
    ]),
    { type: 'para', text: 'Время съёмки — по часам телефона, место — по геометке телефона. Номера фото — те же, что в деле на платформе «БЕРТЕЛ Дело» и в приложении «Фотоматериалы осмотра» к отчёту.' },
    { type: 'para', text: `Акт составлен ${ru(todayMsk())}.` },
    { type: 'sign', text: `Эксперт ____________________ / ${a.executor ?? '____________________'} /` },
  ];
  return { buf: buildSimpleDoc(blocks), filename: `${a.title} ${a.ref.replace(/^№\s*/, '')}.docx` };
}
