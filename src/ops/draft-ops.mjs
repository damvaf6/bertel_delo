// Черновик заключения от ИИ (задача 2.2): исполнитель получает черновик по данным заявки, документам и списку фото, правит
// его в кабинете и сам прикладывает итоговый файл результата (Word). Заказчик черновика не видит; ИИ ничего не выдаёт
// заказчику сам — результат по-прежнему проходит проверку диспетчера (1.5). Разделы черновика — в описании модуля.
import { HttpError } from '../http/core.mjs';
import { editsDraft, seesDraft } from '../access/policy.mjs';
import { DRAFT_GAP, DRAFT_MAX, askAi, cleanDraftAnswer, draftMessages, orderBrief } from '../ai/ai.mjs';
import { READ_MAX_BYTES, extractPages, readableKind } from '../ai/extract.mjs';
import { DOCX_MIME } from '../docs/docx.mjs';
import { fillTables, orderMaterials, orderSections, reportFor, tablesBrief } from '../docs/report.mjs';
import { APPROACHES } from '../modules/index.mjs';
import { analogsBrief } from '../analogs/analogs.mjs';
import { publicDoc, saveDocument } from './core-ops.mjs';
import { audit, sendFile } from './util.mjs';
import { fillDraft, itemLine, loadDossier } from '../dossier/dossier.mjs';
import { pastValues, reuseSections, skeleton } from '../docs/reuse.mjs';
import { orderRef } from '../notify/registry.mjs';
import { orderSources, placeSources, sourcesLines } from '../docs/sources.mjs';
import { draftDiff } from '../docs/diff.mjs';
import { assignmentValue, egrnFacts, egrnRightsFacts, egrnShares, egrnUses, parseFloorField, sameAddressText, USE_NAME } from '../ai/report-checks.mjs';
import { assignmentDocs, egrnDocs } from './ai-ops.mjs';

const PHOTOS_MAX = 40;
const DOCS_MAX = 5;
const DOC_CHARS = 10_000;
const DOCS_CHARS = 20_000;

const isPhoto = (d) => /^image\//.test(d.mime) || /\.(jpe?g|png|heic|heif|webp)$/i.test(d.filename);
const dayRu = (t) => new Date(t).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });

const PAST_MAX = 10;

// Свои прошлые дела той же услуги (2.65): исполнитель — этот эксперт, есть его собственная версия черновика (не написанная
// прежним экспертом до передачи дела). Последние сначала.
const pastCases = (sql, actor, order, pastId = null) => sql`
  select o.id, o.title, o.module, o.service, o.fields, o.basis_number, o.basis_date, o.deadline, o.created_at, o.status,
         o.owner_user_id, o.org_id, d.id as draft_id, d.body, d.at
  from orders o
  join lateral (select x.id, x.body, x.at from result_drafts x where x.order_id = o.id and x.author_id = ${actor.id}
                order by x.id desc limit 1) d on true
  where o.executor_user_id = ${actor.id} and o.module = ${order.module} and o.service = ${order.service} and o.id <> ${order.id}
    and (${pastId}::uuid is null or o.id = ${pastId}::uuid)
  order by d.at desc limit ${PAST_MAX}`;

export async function latest(sql, orderId) {
  return sql.one`select d.*, (select count(*)::int from result_drafts x where x.order_id = d.order_id) as versions
                 from result_drafts d where d.order_id = ${orderId} order by d.id desc limit 1`;
}

// Заготовка черновика без ИИ, когда своего черновика ещё нет: разделы с пометками «заполнить», таблицы из заявки, досье,
// перечень документов дела.
export async function emptyDraft(sql, actor, order, registry, sections, storage) {
  const dossier = sections.some((s) => s.dossier) ? await loadDossier(sql, actor.id) : [];
  const materials = await orderMaterials(sql, order);
  const sources = sourcesLines(await orderSources(sql, registry, order, storage));
  return placeSources(fillDraft(fillTables(skeleton(sections), sections, registry, order, { materials }), sections, dossier), sections, sources).body;
}

const VERSIONS_MAX = 100;
const versionView = (d, actor) => ({ id: String(d.id), source: d.source, at: d.at, mine: d.author_id === actor.id, chars: d.chars });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const draftView = (d, actor) => d && {
  id: String(d.id), source: d.source, body: d.body, model: d.model, inputs: d.inputs, at: d.at, versions: d.versions,
  mine: d.author_id === actor.id,
};

function guard(actor, order) {
  if (!seesDraft(actor, order)) throw new HttpError(403, 'forbidden', 'Черновик заключения видят исполнитель и диспетчер');
}

function guardEdit(actor, order) {
  guard(actor, order);
  if (!editsDraft(actor, order)) throw new HttpError(403, 'forbidden', 'Черновик готовит и правит исполнитель, пока дело в работе');
}

// Человек правил ту версию, которую видел: если с тех пор появилась другая — «уже изменился» (в соседней вкладке и т. п.).
export function sameBase(cur, from) {
  const seen = from === null || from === undefined || from === '' ? null : String(from);
  if ((cur ? String(cur.id) : null) !== seen) throw new HttpError(409, 'draft_changed', 'Черновик уже изменился, обновите страницу');
}

// Что ИИ получает: фото (только имена и даты — сами снимки модель не видит) и текст документов заказчика (основание и прочее).
async function draftInputs(sql, storage, order) {
  const docs = await sql`select * from documents where order_id = ${order.id} and deleted_at is null order by created_at`;
  const photos = docs.filter(isPhoto).slice(0, PHOTOS_MAX).map((d) => ({ id: d.id, name: d.filename, at: dayRu(d.created_at) }));
  const texts = [];
  let left = DOCS_CHARS;
  for (const d of docs.filter((x) => x.kind !== 'result' && !isPhoto(x)).slice(0, DOCS_MAX)) {
    let got = null;
    if (readableKind(d.filename, d.mime) && d.size_bytes <= READ_MAX_BYTES && left > 0) {
      const buf = await storage.get(d.storage_key);
      if (buf) got = await extractPages(buf, d.filename, d.mime);
    }
    const full = got ? got.pages.join('\n') : null;
    const t = full === null ? null : full.slice(0, Math.min(DOC_CHARS, left));
    if (t !== null) left -= t.length;
    texts.push({ id: d.id, name: d.filename, text: t, truncated: full !== null && full.length > t.length });
  }
  return { photos, docs: texts };
}

// Данные с объекта от помощника (экспресс, 2.4): последний завершённый выезд — строками «подпись: значение».
async function onsiteBrief(sql, registry, order) {
  const ex = registry.express(order.module, order.service);
  if (!ex) return null;
  const v = await sql.one`select data, finished_at from onsite_visits where order_id = ${order.id} and finished_at is not null
                          order by finished_at desc limit 1`;
  if (!v) return null;
  const lines = ex.fields.filter((f) => v.data?.[f.id] !== undefined).map((f) => {
    const x = v.data[f.id];
    return `${f.label}: ${f.type === 'select' ? f.options.find((o) => o.id === x)?.name ?? x : x}`;
  });
  return [`ДАННЫЕ С ОБЪЕКТА (выезд помощника ${dayRu(v.finished_at)}):`, ...lines].join('\n');
}

// Дата оценки (2.207) — из приложенного к делу задания на оценку, письма заказчика или определения суда, как её ищет
// ИИ-проверка (2.198, правило value_date): только для услуг с этим правилом. Ровно одна дата — она идёт в таблицу задания,
// модели и вместо пометок «заполнить: дата оценки»; разные даты — ничего не подставляем, эксперт выбирает сам.
async function valueDateFor(sql, storage, registry, order) {
  if (!registry.checks(order.module, order.service).some((r) => (r.auto ?? []).includes('value_date'))) return null;
  const got = assignmentValue(await assignmentDocs(sql, storage, order));
  if (got.days) return { days: got.days.map(ruDay) };
  return got.day ? { day: ruDay(got.day), name: got.name, page: got.page + 1, what: got.what } : null;
}
const ruDay = (d) => d.split('-').reverse().join('.');
// Пометка модели про дату оценки: «[заполнить: дата оценки]», «[заполнить: дату оценки из задания]».
const VALUE_GAP = /\[(?:заполнить|указать)\s*:?\s*дат[аыу]\s+оценки[^\]]*\]/giu;

// Площадь и кадастровый номер (2.211) — из выписок ЕГРН дела, как их сверяет ИИ-проверка (2.202, 2.203, правила area_match и
// cadastral_match): только для услуг с этими правилами. Одно значение — в таблицу задания (вместо того, что написал
// заказчик; другое в заявке — видно рядом), модели и вместо пометок «заполнить: площадь / кадастровый номер»; в выписках
// разные — ничего не подставляем, эксперт выбирает сам.
// 2.222: так же этаж с этажностью (floor_match, 2.212) и адрес (address_match, 2.213).
// 2.243: правообладатель, вид права и обременения (rights_match, encumbrance_match; 2.241, 2.242) — в заявке их нет, поэтому
// в таблицу задания отдельными строками; видов права в выписках несколько — эксперт выбирает сам.
// 2.254: размер доли (share_egrn_match, 2.253) — в строку «Размер доли» таблицы задания, как площадь: доля в выписках одна —
// она (другая в заявке — рядом); у собственников разные доли — та, что в заявке, если она среди них, иначе эксперт выбирает сам.
// 2.261: назначение помещения или дома (use_match, 2.259) — отдельной строкой «Назначение помещения»; в заявке оно —
// из «Что оцениваем» (нежилое помещение — нежилое, остальное — жилое): другое — рядом; в выписках разные — эксперт выбирает сам.
async function egrnFor(sql, storage, registry, order) {
  const auto = registry.checks(order.module, order.service).flatMap((r) => r.auto ?? []);
  if (!['area_match', 'cadastral_match', 'floor_match', 'address_match', 'rights_match', 'encumbrance_match', 'share_egrn_match', 'use_match'].some((k) => auto.includes(k))) return null;
  const docs = await egrnDocs(sql, storage, order);
  if (!docs.length) return null;
  const facts = egrnFacts(docs, { service: order.service, fields: order.fields ?? {} });
  const typedArea = Number(String(order.fields?.area ?? '').replace(',', '.'));
  const typedCad = String(order.fields?.cadastral ?? '').trim();
  const area = !auto.includes('area_match') ? null : facts.area?.values ? { values: facts.area.values.map(ruNum) }
    : facts.area ? { v: ruNum(facts.area.v), name: facts.area.name, page: facts.area.page + 1,
      typed: typedArea > 0 && Math.abs(typedArea - facts.area.v) >= 0.05 ? ruNum(typedArea) : null } : null;
  const cadastral = !auto.includes('cadastral_match') ? null : facts.cadastral?.values ? { values: facts.cadastral.values }
    : facts.cadastral ? { v: facts.cadastral.v, name: facts.cadastral.name, page: facts.cadastral.page + 1,
      typed: typedCad && typedCad !== facts.cadastral.v ? typedCad : null } : null;
  const floor = auto.includes('floor_match') ? egrnFloorFact(facts, order.fields?.floor) : null;
  const typedAddr = String(order.fields?.address ?? '').trim();
  const address = !auto.includes('address_match') ? null : facts.address?.values ? { values: facts.address.values }
    : facts.address ? { v: facts.address.text, name: facts.address.name, page: facts.address.page + 1,
      typed: typedAddr && !sameAddressText(facts.address, typedAddr) ? typedAddr : null } : null;
  const r = auto.includes('rights_match') || auto.includes('encumbrance_match') ? egrnRightsFacts(docs, { service: order.service, fields: order.fields ?? {} }) : null;
  const rights = r && (r.holders || r.kind || r.enc) ? {
    holders: auto.includes('rights_match') ? r.holders : null,
    kind: auto.includes('rights_match') ? r.kind : null,
    enc: auto.includes('encumbrance_match') ? r.enc : null,
  } : null;
  const share_size = auto.includes('share_egrn_match') ? egrnShareFact(docs, order) : null;
  const use = auto.includes('use_match') ? egrnUseFact(docs, order) : null;
  return area || cadastral || floor || address || rights || share_size || use ? { area, cadastral, floor, address, rights, share_size, use } : null;
}
function egrnUseFact(docs, order) {
  const values = egrnUses(docs, { service: order.service, fields: order.fields ?? {} });
  if (!values?.size) return null;
  const type = order.fields?.object_type;
  const of = type === 'house' ? 'дома' : 'помещения';
  if (values.size > 1) return { of, values: [...values.keys()].map((k) => USE_NAME[k]) };
  const [[kind, at]] = [...values];
  const mine = type === 'commercial' ? 'non' : type ? 'living' : null;
  return { v: USE_NAME[kind], of, name: at.name, page: at.page + 1, typed: mine && mine !== kind ? USE_NAME[mine] : null };
}
function egrnShareFact(docs, order) {
  const shares = [...egrnShares(docs, { service: order.service, fields: order.fields ?? {} }).values()];
  if (!shares.length) return null;
  const raw = String(order.fields?.share_size ?? '').trim();
  const t = raw.match(/^(\d{1,3})\s*\/\s*(\d{1,4})$/);
  const same = (x) => { const [a, b] = x.v.split('/').map(Number); return t && Number(t[2]) > 0 && a * Number(t[2]) === b * Number(t[1]); };
  const at = shares.length === 1 ? shares[0] : shares.find(same);
  if (!at) return { values: shares.map((x) => x.v) };
  return { v: at.v, name: at.name, page: at.page + 1, typed: raw && !same(at) ? raw : null,
    ...(shares.length > 1 ? { others: shares.filter((x) => x !== at).map((x) => x.v) } : {}) };
}
// Этаж и этажность (2.222): в таблицу задания — «6 / 10, надземных 9», когда этаж помещения в выписках один; одна
// этажность (выписка только на здание) — модели и вместо пометки «этажность»; разные — эксперт выбирает сам.
function egrnFloorFact(facts, typedText) {
  const f = facts.floor, n = facts.floors;
  if (f?.values || n?.values) return { values: [...(f?.values ?? []).map((v) => `этаж ${v}`), ...(n?.values ?? []).map((v) => `этажей ${v}`)] };
  if (!f && !n) return null;
  const at = f ?? n;
  const floors = n ? (n.above != null ? `${n.v}, надземных ${n.above}` : `${n.v}`) : null;
  const typed = parseFloorField(typedText);
  const differs = typed && ((f && typed.floor !== f.v) || (n && typed.floors != null && typed.floors !== n.v && typed.floors !== n.above));
  return { v: f ? (floors ? `${f.v} / ${floors}` : `${f.v}`) : null, floor: f ? f.v : null, floors: n ? n.v : null,
    above: n?.above ?? null, name: at.name, page: at.page + 1, typed: differs ? String(typedText).trim() : null };
}
const ruNum = (v) => String(v).replace('.', ',');
// Пометки модели: «[заполнить: площадь]», «[заполнить: общую площадь объекта]», «[заполнить: кадастровый номер]».
const AREA_GAP = /\[(?:заполнить|указать)\s*:?\s*(?:общ\S*\s+)?площад[ьи][^\]]*\]/giu;
const CAD_GAP = /\[(?:заполнить|указать)\s*:?\s*кадастров\S*\s+номер[^\]]*\]/giu;
// Пометку площади заменяем числом; «кв. м» дописываем, если его нет сразу после пометки.
// 2.222: «[заполнить: этаж]» — этаж, «[заполнить: этажность дома]», «[заполнить: количество этажей]» — этажей в доме,
// «[заполнить: этаж / этажность]» — оба; «[заполнить: адрес объекта]» — адрес (адрес аналога, заказчика, эксперта — нет).
const FLOOR_GAP = /\[(?:заполнить|указать)\s*:?\s*((?:количеств\S*\s+)?этаж[^\]]*)\]/giu;
const ADDR_GAP = /\[(?:заполнить|указать)\s*:?\s*(?:полн\S*\s+|точн\S*\s+)?адрес([^\]]*)\]/giu;
// 2.243: «[заполнить: правообладатель]», «[заполнить: собственник]», «[заполнить: вид права]», «[заполнить: обременения]».
const HOLDER_GAP = /\[(?:заполнить|указать)\s*:?\s*(?:правообладател|собственник)[^\]]*\]/giu;
const KIND_GAP = /\[(?:заполнить|указать)\s*:?\s*(?:вид\S*\s+(?:зарегистрированн\S*\s+)?прав|оцениваем\S*\s+(?:имущественн\S*\s+)?прав)[^\]]*\]/giu;
// 2.254: «[заполнить: размер доли]», «[заполнить: доля в праве]», «[заполнить: оцениваемая доля]» (не «доля рынка»).
const SHARE_GAP = /\[(?:заполнить|указать)\s*:?\s*(?:размер\S*\s+)?(?:оцениваем\S*\s+)?дол(?:я|и|ю|ей)(?:\s+в\s+праве(?:\s+собственности)?)?\s*\]/giu;
// 2.261: «[заполнить: назначение помещения]», «[заполнить: назначение]», «[заполнить: назначение объекта]» (не участка, не аналога).
const USE_GAP = /\[(?:заполнить|указать)\s*:?\s*назначени\S*(?:\s+(?:помещени|объект|дома|здани)\S*(?:\s+оценки)?)?\s*\]/giu;
const ENC_GAP = /\[(?:заполнить|указать)\s*:?\s*(?:ограничени|обременени)[^\]]*\]/giu;
const ADDR_NOT_OBJECT = /аналог|заказчик|оценщик|эксперт|исполнител|организац|регистрац|проживан|почтов|электрон/iu;
function floorGap(m, inner, f) {
  const both = /этаж(?!ност|ей|н).*этаж(?:ност|ей)/iu.test(inner);
  const floorsOnly = !both && /^(?:количеств\S*\s+)?этаж(?:ност|ей)/iu.test(inner);
  const floors = f.floors == null ? null : f.above != null ? `${f.floors} (надземных ${f.above})` : `${f.floors}`;
  if (both) return f.floor != null && floors ? `${f.floor} / ${floors}` : m;
  if (floorsOnly) return floors ?? m;
  return f.floor != null ? `${f.floor}` : m;
}
function fillEgrn(text, egrn) {
  let out = text;
  if (egrn?.area?.v) out = out.replace(AREA_GAP, (m, at, all) => (/^\s*(?:кв\.?\s*м|м2|м²)/iu.test(all.slice(at + m.length)) ? egrn.area.v : `${egrn.area.v} кв. м`));
  if (egrn?.cadastral?.v) out = out.replace(CAD_GAP, egrn.cadastral.v);
  if (egrn?.floor && !egrn.floor.values) out = out.replace(FLOOR_GAP, (m, inner) => floorGap(m, inner, egrn.floor));
  if (egrn?.address?.v) out = out.replace(ADDR_GAP, (m, rest) => (ADDR_NOT_OBJECT.test(rest) ? m : egrn.address.v));
  if (egrn?.rights?.holders?.v) out = out.replace(HOLDER_GAP, egrn.rights.holders.v);
  if (egrn?.rights?.kind?.v) out = out.replace(KIND_GAP, egrn.rights.kind.v);
  if (egrn?.rights?.enc?.v) out = out.replace(ENC_GAP, egrn.rights.enc.v);
  if (egrn?.share_size?.v) out = out.replace(SHARE_GAP, egrn.share_size.v);
  if (egrn?.use?.v) out = out.replace(USE_GAP, egrn.use.v);
  return out;
}
const egrnBrief = (egrn) => [
  egrn?.area?.v ? `Площадь объекта по выписке ЕГРН: ${egrn.area.v} кв. м (выписка «${egrn.area.name}», стр. ${egrn.area.page}) — пиши её везде, где нужна площадь объекта, без пометок` : null,
  egrn?.cadastral?.v ? `Кадастровый номер по выписке ЕГРН: ${egrn.cadastral.v} (выписка «${egrn.cadastral.name}», стр. ${egrn.cadastral.page}) — пиши его везде, где нужен кадастровый номер, без пометок` : null,
  egrn?.floor && !egrn.floor.values ? `${[egrn.floor.floor != null ? `Этаж объекта по выписке ЕГРН: ${egrn.floor.floor}` : null, egrn.floor.floors != null ? `этажей в доме: ${egrn.floor.floors}${egrn.floor.above != null ? `, из них надземных ${egrn.floor.above}` : ''}` : null].filter(Boolean).join(', ')} (выписка «${egrn.floor.name}», стр. ${egrn.floor.page}) — пиши так везде, без пометок` : null,
  egrn?.address?.v ? `Адрес объекта по выписке ЕГРН: ${egrn.address.v} (выписка «${egrn.address.name}», стр. ${egrn.address.page}) — пиши его везде, где нужен адрес объекта, без пометок` : null,
  egrn?.rights?.holders?.v ? `Правообладатель по выписке ЕГРН: ${egrn.rights.holders.v} (выписка «${egrn.rights.holders.name}», стр. ${egrn.rights.holders.page}) — пиши так в разделе о правах, без пометок` : null,
  egrn?.rights?.kind?.v ? `Вид права по выписке ЕГРН: ${egrn.rights.kind.v} (выписка «${egrn.rights.kind.name}», стр. ${egrn.rights.kind.page}) — пиши так в разделе о правах, без пометок` : null,
  egrn?.share_size?.v ? `Размер оцениваемой доли по выписке ЕГРН: ${egrn.share_size.v} (выписка «${egrn.share_size.name}», стр. ${egrn.share_size.page}) — пиши её везде, где нужен размер доли объекта оценки, без пометок` : null,
  egrn?.use?.v ? `Назначение ${egrn.use.of} по выписке ЕГРН: ${egrn.use.v} (выписка «${egrn.use.name}», стр. ${egrn.use.page}) — пиши так везде, где нужно назначение объекта оценки, без пометок` : null,
  egrn?.rights?.enc?.v ? `Ограничения и обременения по выписке ЕГРН: ${egrn.rights.enc.v} (выписка «${egrn.rights.enc.name}», стр. ${egrn.rights.enc.page}) — назови их в разделе о правах и обременениях, без пометок` : null,
].filter(Boolean).join('\n') || null;

export function draftOps() {
  return [
    {
      id: 'draft.get', method: 'GET', path: '/api/orders/:id/draft', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry }) {
        guard(actor, order);
        const sections = orderSections(registry, order);
        return {
          draft: draftView(await latest(sql, order.id), actor),
          sections,
          can_edit: editsDraft(actor, order),
          can_ai: editsDraft(actor, order) && sections.length > 0,
          // Подходы к оценке (2.33): список — если исполнитель их выбирает для этой услуги; chosen — что отмечено.
          approaches: registry.approachesFor(order.module, order.service)
            ? { list: Object.entries(APPROACHES).map(([id, name]) => ({ id, name })), chosen: order.approaches ?? null }
            : null,
        };
      },
    },
    {
      // Подготовить черновик с помощью ИИ. Прежние версии остаются в истории; текущей становится новая.
      id: 'draft.ai', method: 'POST', path: '/api/orders/:id/draft/ai', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler(ctx) {
        const { sql, actor, order, registry, providers, body, res } = ctx;
        guardEdit(actor, order);
        const sections = orderSections(registry, order);
        if (!sections.length) throw new HttpError(400, 'no_draft', 'Для этой услуги черновик от ИИ не готовится');
        sameBase(await latest(sql, order.id), body?.from);
        const inputs = await draftInputs(sql, providers.storage, order);
        const onsite = await onsiteBrief(sql, registry, order);
        // Досье эксперта (2.14): сведения подставляются в разделы с пометкой dossier сами — модели они даны для связности.
        const dossier = sections.some((s) => s.dossier) ? await loadDossier(sql, actor.id) : [];
        const dossierBrief = dossier.length
          ? ['СВЕДЕНИЯ ОБ ЭКСПЕРТЕ (из досье; программа сама вставит их в нужные разделы — не повторяй и не ставь про них пометки):', ...dossier.map((i) => `- ${itemLine(i)}`)].join('\n')
          : null;
        // Подтверждённые аналоги (2.32) — модели для текста о корректировках; таблицу программа вставит в Word сама.
        const spec = registry.analogs(order.module, order.service);
        const analogs = spec ? await sql`select * from order_analogs where order_id = ${order.id} and deleted_at is null and confirmed_at is not null order by id` : [];
        const valueDate = await valueDateFor(sql, providers.storage, registry, order);
        const valueBrief = valueDate?.day ? `Дата оценки: ${valueDate.day} (${valueDate.what} «${valueDate.name}», стр. ${valueDate.page}) — пиши её везде, где нужна дата оценки, без пометок` : null;
        const egrn = await egrnFor(sql, providers.storage, registry, order);
        const brief = [orderBrief(registry, order), valueBrief, egrnBrief(egrn), onsite, dossierBrief, spec ? analogsBrief(spec, analogs, order) : null, tablesBrief(sections)].filter(Boolean).join('\n');
        const out = await askAi(ctx, actor, 'draft', draftMessages({ brief, sections, ...inputs }));
        // Таблицы (2.29) и сведения из досье (2.14) программа вставляет сама, под заголовками разделов.
        const materials = await orderMaterials(sql, order);
        // Перечень использованных документов (2.95) — из дела, программой.
        const sources = sourcesLines(await orderSources(sql, registry, order, providers.storage));
        const answer = cleanDraftAnswer(sections, out.text);
        const dated = fillEgrn(valueDate?.day ? answer.replace(VALUE_GAP, valueDate.day) : answer, egrn);
        const filled = fillDraft(fillTables(dated, sections, registry, order, { materials, valueDate: valueDate?.day, egrn }), sections, dossier);
        const text = placeSources(filled, sections, sources).body.slice(0, DRAFT_MAX);
        const seen = {
          photos: inputs.photos.map((p) => p.name),
          docs: inputs.docs.map((d) => ({ name: d.name, read: d.text !== null, truncated: d.truncated })),
          onsite: !!onsite,
          dossier: dossier.length,
          analogs: analogs.length,
          value_date: valueDate,
          egrn,
        };
        const d = await sql.tx(async (tx) => {
          await tx`select id from orders where id = ${order.id} for update`;
          sameBase(await latest(tx, order.id), body?.from);
          const row = await tx.one`insert into result_drafts (order_id, author_id, source, body, model, inputs)
                                   values (${order.id}, ${actor.id}, 'ai', ${text}, ${out.model}, ${JSON.stringify(seen)}) returning id`;
          await audit(tx, actor, 'draft.ai', 'order', order.id, { draft: String(row.id) });
          return latest(tx, order.id);
        });
        res.status(201);
        return { draft: draftView(d, actor) };
      },
    },
    {
      // Версии черновика (2.104): кто и когда (ИИ, правка, разделы из прошлого дела), последние сначала. Видят те же, кто
      // видит черновик, — исполнитель и диспетчер.
      id: 'draft.versions', method: 'GET', path: '/api/orders/:id/draft/versions', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order }) {
        guard(actor, order);
        const rows = await sql`select id, source, at, author_id, length(body)::int as chars from result_drafts
                               where order_id = ${order.id} order by id desc limit ${VERSIONS_MAX}`;
        return { versions: rows.map((d) => versionView(d, actor)) };
      },
    },
    {
      // Что изменилось (2.104): от прошлой версии from до версии to (по умолчанию — текущей) — по разделам добавленные и
      // убранные абзацы. Версия чужого дела — «не найдено».
      id: 'draft.diff', method: 'GET', path: '/api/orders/:id/draft/diff', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, query }) {
        guard(actor, order);
        const version = async (v) => {
          const id = /^\d{1,18}$/.test(String(v ?? '')) ? String(v) : null;
          const d = id && await sql.one`select id, source, at, author_id, body, length(body)::int as chars from result_drafts
                                        where order_id = ${order.id} and id = ${id}`;
          if (!d) throw new HttpError(404, 'not_found', 'Версия черновика не найдена');
          return d;
        };
        const from = await version(query.from);
        const cur = await latest(sql, order.id);
        const to = query.to === undefined || query.to === '' ? cur : await version(query.to);
        return { from: versionView(from, actor), to: versionView({ ...to, chars: to.body.length }, actor), ...draftDiff(from.body, to.body) };
      },
    },
    {
      // Свои прошлые дела той же услуги, из которых можно взять методические разделы (2.65). Без данных заказчика: номер
      // дела, дата черновика и какие методические разделы в нём есть.
      id: 'draft.past.list', method: 'GET', path: '/api/orders/:id/draft/past', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry }) {
        guardEdit(actor, order);
        const reuse = orderSections(registry, order).filter((s) => s.reuse);
        if (!reuse.length) return { sections: [], cases: [] };
        const rows = await pastCases(sql, actor, order);
        return {
          sections: reuse.map((s) => s.title),
          cases: rows.map((r) => {
            const has = reuseSections('', reuse, r.body, []).used;
            return { id: r.id, ref: orderRef(r.id), at: r.at, sections: has.length };
          }).filter((c) => c.sections > 0),
        };
      },
    },
    {
      // Взять методические разделы из своего прошлого дела (2.65) — новой версией черновика: остальные разделы остаются как
      // были (или пустыми с пометками, если черновика ещё нет), данные прошлого заказчика и объекта вычищены.
      id: 'draft.past', method: 'POST', path: '/api/orders/:id/draft/past', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry, providers, body, res }) {
        guardEdit(actor, order);
        const sections = orderSections(registry, order);
        if (!sections.some((s) => s.reuse)) throw new HttpError(400, 'no_reuse', 'Для этой услуги методических разделов нет');
        const pastId = typeof body?.past_id === 'string' && UUID.test(body.past_id) ? body.past_id : null;
        // Не своё дело, другая услуга или нет своего черновика — для эксперта «не найдено», как чужое.
        const [past] = pastId ? await pastCases(sql, actor, order, pastId) : [];
        if (!past) throw new HttpError(404, 'not_found', 'Прошлое дело не найдено');
        const [names] = await sql`select (select full_name from users where id = ${past.owner_user_id}) as owner,
                                         (select name from organizations where id = ${past.org_id}) as org`;
        // То, что совпадает с этим делом (тот же город, тот же заказчик), — не чужие данные: остаётся как есть.
        const own = new Set(pastValues(registry, order, []).map((v) => v.toLowerCase()));
        const values = pastValues(registry, past, [names?.owner, names?.org]).filter((v) => !own.has(v.toLowerCase()));
        const empty = await emptyDraft(sql, actor, order, registry, sections, providers.storage);
        const d = await sql.tx(async (tx) => {
          await tx`select id from orders where id = ${order.id} for update`;
          const cur = await latest(tx, order.id);
          sameBase(cur, body?.from);
          const base = cur?.body ?? empty;
          const got = reuseSections(base, sections, past.body, values);
          if (!got.used.length) throw new HttpError(409, 'no_reuse', 'В том деле нет методических разделов — выберите другое');
          const text = got.body.slice(0, DRAFT_MAX);
          const row = await tx.one`insert into result_drafts (order_id, author_id, source, body, inputs)
                                   values (${order.id}, ${actor.id}, 'past', ${text},
                                           ${JSON.stringify({ ...(cur?.inputs ?? {}), past: { sections: got.used, marks: got.marks } })}) returning id`;
          await audit(tx, actor, 'draft.past', 'order', order.id, { draft: String(row.id), sections: got.used.length });
          return latest(tx, order.id);
        });
        res.status(201);
        return { draft: draftView(d, actor) };
      },
    },
    {
      // Подходы к оценке, которые применяет исполнитель (2.33): от них зависят разделы черновика, таблица подходов и
      // нужны ли аналоги. Меняет только исполнитель, пока дело в работе; уже готовый черновик не переписывается.
      id: 'draft.approaches', method: 'PUT', path: '/api/orders/:id/approaches', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry, body }) {
        guardEdit(actor, order);
        if (!registry.approachesFor(order.module, order.service)) throw new HttpError(400, 'no_approaches', 'Для этой услуги подходы не выбираются');
        const list = Array.isArray(body?.approaches) ? [...new Set(body.approaches)] : null;
        if (!list?.length || list.some((a) => !Object.hasOwn(APPROACHES, a))) {
          throw new HttpError(400, 'bad_input', 'Отметьте хотя бы один подход: сравнительный, затратный или доходный');
        }
        const chosen = Object.keys(APPROACHES).filter((a) => list.includes(a));
        await sql`update orders set approaches = ${chosen} where id = ${order.id}`;
        await audit(sql, actor, 'draft.approaches', 'order', order.id, { approaches: chosen });
        return { approaches: chosen, sections: orderSections(registry, { ...order, approaches: chosen }) };
      },
    },
    {
      // Обновить перечень использованных документов (2.95) — новой версией черновика: блок перечня собирается заново из
      // того, что сейчас в деле (заказчик прислал документ, добавлены аналоги, пришли фото); остальной текст не меняется.
      id: 'draft.sources', method: 'POST', path: '/api/orders/:id/draft/sources', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry, providers, body }) {
        guardEdit(actor, order);
        const sections = orderSections(registry, order);
        if (!sections.some((s) => s.sources)) throw new HttpError(400, 'no_sources', 'Для этой услуги перечня документов в черновике нет');
        const lines = sourcesLines(await orderSources(sql, registry, order, providers.storage));
        const d = await sql.tx(async (tx) => {
          await tx`select id from orders where id = ${order.id} for update`;
          const cur = await latest(tx, order.id);
          if (!cur) throw new HttpError(400, 'no_draft', 'Черновика ещё нет');
          sameBase(cur, body?.from);
          const got = placeSources(cur.body, sections, lines);
          if (!got.placed) {
            throw new HttpError(409, 'no_sources', lines.length
              ? 'В черновике нет раздела для перечня — верните заголовок раздела приложений или подготовьте черновик заново'
              : 'В деле пока нет документов для перечня');
          }
          const text = got.body.slice(0, DRAFT_MAX);
          if (text === cur.body) return cur;
          const row = await tx.one`insert into result_drafts (order_id, author_id, source, body, inputs)
                                   values (${order.id}, ${actor.id}, 'edit', ${text}, ${JSON.stringify(cur.inputs ?? {})}) returning id`;
          await audit(tx, actor, 'draft.sources', 'order', order.id, { draft: String(row.id), lines: Math.max(lines.length - 1, 0) });
          return latest(tx, order.id);
        });
        return { draft: draftView(d, actor), items: lines.filter((l) => /^\d+\. /.test(l)).length };
      },
    },
    {
      // Сохранить правку эксперта — новой версией (видно, что написал ИИ и что поправил человек).
      id: 'draft.save', method: 'PUT', path: '/api/orders/:id/draft', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, body }) {
        guardEdit(actor, order);
        const text = typeof body?.body === 'string' ? body.body.replace(/\r\n?/g, '\n').trim() : '';
        if (!text) throw new HttpError(400, 'bad_input', 'Черновик пустой');
        if (text.length > DRAFT_MAX) throw new HttpError(400, 'bad_input', `Черновик — не длиннее ${DRAFT_MAX} символов`);
        const d = await sql.tx(async (tx) => {
          await tx`select id from orders where id = ${order.id} for update`;
          const cur = await latest(tx, order.id);
          sameBase(cur, body?.from);
          if (cur && cur.body === text) return cur;
          const row = await tx.one`insert into result_drafts (order_id, author_id, source, body, inputs)
                                   values (${order.id}, ${actor.id}, 'edit', ${text}, ${JSON.stringify(cur?.inputs ?? {})}) returning id`;
          await audit(tx, actor, 'draft.save', 'order', order.id, { draft: String(row.id) });
          return latest(tx, order.id);
        });
        return { draft: draftView(d, actor) };
      },
    },
    {
      // Скачать черновик готовым файлом Word (2.29): титул, оглавление, разделы, таблицы, колонтитул; в шаблоне организации,
      // если он есть. Только сам исполнитель — дальше он правит файл в Word и прикладывает как результат. Пометки
      // «[заполнить …]» остаются в файле — их видно и в Word.
      id: 'draft.docx', method: 'GET', path: '/api/orders/:id/draft/docx', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler(ctx) {
        const { sql, actor, order, res } = ctx;
        guard(actor, order);
        if (order.executor_user_id !== actor.id) throw new HttpError(403, 'forbidden', 'Файл Word черновика скачивает исполнитель');
        const cur = await latest(sql, order.id);
        if (!cur) throw new HttpError(404, 'no_draft', 'Черновика ещё нет');
        const word = await reportFor(ctx, order, actor, cur.body);
        await audit(sql, actor, 'draft.docx', 'order', order.id, { draft: String(cur.id), template: word.template });
        // Word с фото осмотра и скриншотами бывает больше 3,5 МБ — тогда временной ссылкой из хранилища (2.49).
        await sendFile(res, ctx.providers, { buf: word.buf, filename: word.filename, mime: DOCX_MIME });
      },
    },
    {
      // Приложить черновик файлом результата (Word). Только когда эксперт заполнил все пометки «[заполнить …]» и
      // подтвердил, что проверил текст и отвечает за него. Дальше — обычная сдача на проверку диспетчеру.
      id: 'draft.attach', method: 'POST', path: '/api/orders/:id/draft/result', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler(ctx) {
        const { sql, actor, order, body, res } = ctx;
        guardEdit(actor, order);
        const cur = await latest(sql, order.id);
        if (!cur) throw new HttpError(400, 'no_draft', 'Черновика ещё нет');
        sameBase(cur, body?.from);
        const gap = cur.body.match(DRAFT_GAP);
        if (gap) throw new HttpError(409, 'draft_gaps', `В черновике остались незаполненные места, например: ${gap[0].slice(0, 120)}`);
        if (body?.confirm !== true) throw new HttpError(400, 'confirm_required', 'Подтвердите, что Вы проверили текст и отвечаете за него');
        const word = await reportFor(ctx, order, actor, cur.body);
        const doc = await saveDocument(ctx, { filename: word.filename, mime: DOCX_MIME, buf: word.buf, kind: 'result' });
        await audit(sql, actor, 'draft.attach', 'order', order.id, { draft: String(cur.id), document: doc.id, template: word.template, analogs: word.analogs, photos: word.photos });
        res.status(201);
        return { document: publicDoc(doc) };
      },
    },
  ];
}
