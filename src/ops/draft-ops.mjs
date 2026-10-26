// Черновик заключения от ИИ (задача 2.2): исполнитель получает черновик по данным заявки, документам и списку фото, правит
// его в кабинете и сам прикладывает итоговый файл результата (Word). Заказчик черновика не видит; ИИ ничего не выдаёт
// заказчику сам — результат по-прежнему проходит проверку диспетчера (1.5). Разделы черновика — в описании модуля.
import { HttpError } from '../http/core.mjs';
import { editsDraft, seesDraft } from '../access/policy.mjs';
import { DRAFT_GAP, DRAFT_MAX, askAi, cleanDraftAnswer, draftMessages, orderBrief } from '../ai/ai.mjs';
import { READ_MAX_BYTES, extractPages, readableKind } from '../ai/extract.mjs';
import { DOCX_MIME } from '../docs/docx.mjs';
import { fillTables, orderMaterials, orderSections, placeCustomer, reportFor, tablesBrief } from '../docs/report.mjs';
import { APPROACHES } from '../modules/index.mjs';
import { analogsBrief } from '../analogs/analogs.mjs';
import { publicDoc, saveDocument } from './core-ops.mjs';
import { audit, sendFile } from './util.mjs';
import { fillDraft, itemLine, loadDossier } from '../dossier/dossier.mjs';
import { pastValues, reuseSections, skeleton } from '../docs/reuse.mjs';
import { orderRef } from '../notify/registry.mjs';
import { orderSources, placeSources, sourcesLines } from '../docs/sources.mjs';
import { draftDiff } from '../docs/diff.mjs';
import { assignmentAddress, assignmentBank, assignmentCustomer, assignmentDue, assignmentKinds, assignmentPurpose, assignmentValue, banksIn, customerOf, customersInText, egrnFacts, egrnRightsFacts, egrnShares, egrnUses, kindList, parseFloorField, purposeFits, purposeKinds, sameAddressText, sameCustomer, USE_NAME } from '../ai/report-checks.mjs';
import { assignmentDocs, egrnDocs, issuedNumbers, usedNumbers } from './ai-ops.mjs';
import { nextNumber } from '../orgs/numbering.mjs';
import { todayMsk } from '../orders/workflow.mjs';

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

// Таблица задания черновика против задания на оценку (2.295, 2.301, 2.311; общее с 2.328): что черновик взял бы из задания —
// дата оценки, вид стоимости, адрес, цель, заказчик, срок, пользователь результатов — и есть ли это в черновике (`ok`).
// `before` — задания, что были в деле раньше: что из них не изменилось, не в счёт (2.295; новому эксперту — пусто, в счёт
// всё). Таблицы задания в черновике нет — null: сверять не с чем.
const TASK_ROW = /^\|\s*([^|\n]+?)\s*\|\s*([^|\n]*?)\s*\|\s*$/gmu;
const bare = (cell) => cell.replace(/\s*\([^)]*\)\s*$/u, '').trim();
export function taskDraftItems(registry, o, assignment, before, body, egrn, ownerName) {
  const cells = new Map();
  for (const m of String(body ?? '').matchAll(TASK_ROW)) if (!cells.has(m[1])) cells.set(m[1], bare(m[2]));
  if (!cells.has('Сведение')) return null;
  const items = [];
  const day = valueDateFor(registry, o, assignment)?.day;
  if (day && valueDateFor(registry, o, before)?.day !== day) {
    items.push({ what: 'date', label: 'Дата оценки', v: day, was: cells.get('Дата оценки') || null, ok: !!cells.get('Дата оценки')?.includes(day) });
  }
  const kind = taskKindFor(registry, o, assignment);
  const cell = (cells.get('Вид стоимости') ?? '').toLowerCase();
  if (kind && taskKindFor(registry, o, before)?.v !== kind.v) {
    items.push({ what: 'kind', label: 'Вид стоимости', v: kind.v, was: cells.get('Вид стоимости') || null, ok: kind.v.split(' и ').every((w) => cell.includes(w)) });
  }
  const addr = taskAddressFor(registry, o, assignment, egrn);
  const label = registry.service(o.module, o.service)?.fields?.find((f) => f.id === 'address')?.label;
  if (addr && label && taskAddressFor(registry, o, before, egrn)?.v !== addr.v) {
    items.push({ what: 'address', label, v: addr.v, was: cells.get(label) || null, ok: !!(cells.get(label) && sameAddressText(assignmentAddress(assignment), cells.get(label))) });
  }
  // 2.301: цель оценки (2.291) — строка таблицы задания; совместимая цель (ипотека при покупке) не в счёт.
  const purpose = taskPurposeFor(registry, o, assignment);
  const aim = registry.service(o.module, o.service)?.fields?.find((f) => f.id === 'purpose')?.label;
  const prevAim = taskPurposeFor(registry, o, before);
  if (purpose && aim && prevAim?.kinds.join('+') !== purpose.kinds.join('+')) {
    items.push({ what: 'purpose', label: aim, v: purpose.v, was: cells.get(aim) || null, ok: purposeKinds(cells.get(aim)).some((k) => purposeFits(purpose, k)) });
  }
  // 2.301: заказчик (2.292) — строкой в разделе о заказчике. В черновике назван другой — в счёт; не назван — только если в
  // задании не владелец заявки (его черновик и так назвал бы заказчиком).
  const customer = taskCustomerFor(registry, o, assignment, ownerName);
  const prevCustomer = taskCustomerFor(registry, o, before, ownerName);
  if (customer && !(prevCustomer && sameCustomer(customerOf(prevCustomer.v), customerOf(customer.v)))) {
    const who = customerOf(customer.v);
    const named = customersInText(body);
    const mine = ownerName ? customerOf(ownerName) : null;
    items.push({ what: 'customer', label: 'Заказчик', v: customer.v, was: named[0]?.value ?? null,
      ok: named.length ? named.some((n) => sameCustomer(n, who)) : !!(mine && sameCustomer(mine, who)) });
  }
  // 2.311: срок составления отчёта (2.303) — строка «Срок»; пользователь результатов оценки при оценке для банка (2.310) —
  // только банк из задания (Сбербанк из заявки от задания не зависит); в строке назван тот же банк — не в счёт.
  const due = taskDueFor(registry, o, assignment);
  if (due && taskDueFor(registry, o, before)?.day !== due.day) {
    items.push({ what: 'due', label: 'Срок', v: due.v, was: cells.get('Срок') || null, ok: !!cells.get('Срок')?.includes(due.v) });
  }
  const user = taskUserFor(registry, o, assignment);
  const userRow = 'Предполагаемый пользователь результатов оценки';
  if (user?.name && taskUserFor(registry, o, before)?.id !== user.id) {
    items.push({ what: 'user', label: userRow, v: user.v, was: cells.get(userRow) || null, ok: banksIn(cells.get(userRow) ?? '').includes(user.id) });
  }
  return items;
}

// Свой номер отчёта (2.412): выдаётся делу при первой сборке Word по образцу эксперта из профиля, повторная сборка — тот же
// номер. Следующий — после наибольшего этого года из файлов отчётов эксперта и номеров, уже выданных его делам. Строки
// специалиста и дела блокируются — две сборки сразу не получат один номер. Образца нет — null (номер дела платформы).
export async function reportNumber(ctx, order, actor) {
  return ctx.sql.tx(async (tx) => {
    const sp = await tx.one`select report_pattern from specialists where user_id = ${actor.id} for update`;
    const o = await tx.one`select report_number, report_number_by from orders where id = ${order.id} for update`;
    if (o.report_number && o.report_number_by === actor.id) return o.report_number;
    if (!sp?.report_pattern) return null;
    const today = todayMsk();
    const used = [
      ...await usedNumbers(tx, ctx.providers.storage, { id: order.id, executor_user_id: actor.id }, today),
      ...await issuedNumbers(tx, actor.id, today, order.id),
    ];
    const { number } = nextNumber(sp.report_pattern, used, Number(today.slice(0, 4)));
    await tx`update orders set report_number = ${number}, report_number_on = ${today}, report_number_by = ${actor.id} where id = ${order.id}`;
    return number;
  });
}

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

// 2.289: правка сохранена кнопкой «Заменить на значение из выписки / из задания» (по одной или «Заменить всё»), или такая
// замена отменена, — отметка в журнале { kind: 'egrn' | 'task', n, undo }: по ней сводка за месяц считает, сколько
// расхождений эксперт исправил кнопкой до первой подписи. Без отметки или с неверной — обычная правка.
const SWAP_KINDS = ['egrn', 'task'];
function swapMark(v) {
  if (!v || !SWAP_KINDS.includes(v.kind) || !Number.isInteger(v.n) || v.n < 1 || v.n > 100) return null;
  return { kind: v.kind, n: v.n, undo: v.undo === true };
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
export function valueDateFor(registry, order, assignment) {
  if (!registry.checks(order.module, order.service).some((r) => (r.auto ?? []).includes('value_date'))) return null;
  const got = assignmentValue(assignment);
  if (got.days) return { days: got.days.map(ruDay) };
  return got.day ? { day: ruDay(got.day), name: got.name, page: got.page + 1, what: got.what } : null;
}
// 2.281: адрес объекта из задания на оценку (письма заказчика, определения суда), как его сверяет ИИ-проверка (2.277,
// правило address_match), — в таблицу задания, модели и вместо пометки «заполнить: адрес», когда в выписках ЕГРН адреса
// нет: выписка важнее задания, задание — заявки. В документах разные адреса — ничего не подставляем, эксперт выбирает сам.
const TASK_BY = { 'в задании на оценку': 'по заданию на оценку', 'в определении суда': 'по определению суда', 'в письме заказчика': 'по письму заказчика' };
export function taskAddressFor(registry, order, assignment, egrn) {
  if (egrn?.address || !registry.checks(order.module, order.service).some((r) => (r.auto ?? []).includes('address_match'))) return null;
  const a = assignmentAddress(assignment);
  if (!a) return null;
  const typed = String(order.fields?.address ?? '').trim();
  return { v: a.text, what: a.what, by: TASK_BY[a.what], name: a.name, page: a.page + 1,
    typed: typed && !sameAddressText(a, typed) ? typed : null };
}
// 2.282: вид стоимости из задания на оценку (письма заказчика, определения суда), как его сверяет ИИ-проверка (2.278,
// правило purpose_value), — в таблицу задания, модели и вместо пометки «заполнить: вид стоимости». В заявке вида стоимости
// нет; в документах разные виды — ничего не подставляем, эксперт выбирает сам.
export function taskKindFor(registry, order, assignment) {
  if (!registry.checks(order.module, order.service).some((r) => (r.auto ?? []).includes('purpose_value'))) return null;
  const k = assignmentKinds(assignment);
  return k ? { v: kindList(k.kinds), kinds: k.kinds, what: k.what, by: TASK_BY[k.what], name: k.name, page: k.page + 1 } : null;
}
// 2.291: цель оценки из задания на оценку (письма заказчика, определения суда), как её сверяет ИИ-проверка (2.287, правило
// purpose_value), — в строку «Для чего нужна оценка» таблицы задания, модели и вместо пометки «заполнить: цель оценки»:
// задание важнее заявки; цель в заявке другая (не совместимая) — видно рядом. В документах разные цели — эксперт выбирает сам.
export function taskPurposeFor(registry, order, assignment) {
  if (!registry.checks(order.module, order.service).some((r) => (r.auto ?? []).includes('purpose_value'))) return null;
  const p = assignmentPurpose(assignment);
  if (!p) return null;
  const mine = order.fields?.purpose;
  const typed = mine && !purposeFits(p, mine)
    ? registry.service(order.module, order.service)?.fields?.find((f) => f.id === 'purpose')?.options?.find((o) => o.id === mine)?.name ?? null : null;
  return { v: p.value, kinds: p.kinds, what: p.what, by: TASK_BY[p.what], name: p.name, page: p.page + 1, typed };
}
// 2.292: заказчик из задания на оценку (письма заказчика), как его сверяет ИИ-проверка (2.288, правило customer_match), —
// строкой в раздел «Сведения о заказчике…», модели и вместо пометки «заполнить: заказчик»: задание важнее заявки; владелец
// заявки — другой человек (представитель, родственник) — видно рядом. Задания с разными заказчиками, определение суда — нет.
export function taskCustomerFor(registry, order, assignment, owner) {
  if (!registry.checks(order.module, order.service).some((r) => (r.auto ?? []).includes('customer_match'))) return null;
  const c = assignmentCustomer(assignment);
  if (!c) return null;
  const mine = owner ? customerOf(owner) : null;
  const typed = mine && !mine.org && !c.who.org && !sameCustomer(c.who, mine) ? mine.value : null;
  return { v: c.who.value, org: c.who.org, what: c.what, by: TASK_BY[c.what], name: c.name, page: c.page + 1, typed };
}
// 2.303: срок составления отчёта из задания на оценку (письма заказчика, определения суда), как его сверяет ИИ-проверка
// (2.302, правило report_dates), — в строку «Срок» таблицы задания: задание важнее срока дела; срок дела позже срока по
// заданию — видно рядом. В нескольких документах — самый поздний (перенос новым заданием).
export function taskDueFor(registry, order, assignment) {
  if (!registry.checks(order.module, order.service).some((r) => (r.auto ?? []).includes('report_dates'))) return null;
  const d = assignmentDue(assignment);
  if (!d) return null;
  const mine = order.deadline ? dayOf(order.deadline) : null;
  return { v: ruDay(d.day), day: d.day, what: d.what, by: TASK_BY[d.what], name: d.name, page: d.page + 1,
    later: mine && mine > d.day ? ruDay(mine) : null };
}
// 2.310: предполагаемый пользователь результатов оценки при оценке для банка — как его сверяет ИИ-проверка (2.307, правило
// bank_user): Сбербанк из заявки, иначе банк из строки о пользователе в задании на оценку; в строку таблицы задания и модели.
// Банк не известен — ничего: эксперт пишет сам.
export function taskUserFor(registry, order, assignment) {
  if (!registry.checks(order.module, order.service).some((r) => (r.auto ?? []).includes('bank_user'))) return null;
  const f = order.fields ?? {};
  if (f.purpose !== 'bank' && !assignmentPurpose(assignment)?.kinds.includes('bank')) return null;
  if (f.bank === 'sber') return { id: 'sber', v: 'ПАО Сбербанк', by: 'по заявке', name: null, page: null };
  const b = assignmentBank(assignment);
  return b && b.value.length < 120 ? { id: b.id, v: b.value, what: b.what, by: TASK_BY[b.what], name: b.name, page: b.page + 1 } : null;
}
// 2.333: срок по заданию взят из письма о переносе срока — файла, приложенного к просьбе «Письмо банка о переносе» (2.326,
// пункт task_move), или файла задания с более поздним сроком, чем в другом файле задания. `was` — прежний срок по заданию
// (самый поздний из остальных файлов, раньше нового); его нет — только новый срок.
// Прогон 2.340: `was` сам из прежнего письма о переносе (писем два и больше) — `was_letter`: «по прежнему письму было», а не
// «по заданию было».
export function taskMoveLetter(assignment, due) {
  if (!due) return null;
  const letter = assignment.find((a) => a.name === due.name);
  const days = assignment.filter((a) => a !== letter).map((a) => ({ a, day: assignmentDue([a])?.day })).filter((x) => x.day && x.day < due.day);
  const was = days.map((x) => x.day).sort().at(-1) ?? null;
  if (!letter || !(letter.moved || was)) return null;
  const wasLetter = !!was && (days.some((x) => x.day === was && x.a.moved) || days.some((x) => x.day < was));
  return { day: due.day, was, ...(wasLetter ? { was_letter: true } : {}) };
}
// 2.343: письмо о переносе срока пришло, а строка «Срок» таблицы задания черновика — без срока из письма (черновик готовили
// до письма): что поставить в строку — срок из письма, как его поставил бы черновик заново (2.303), и что там сейчас. Строки
// «Срок» в черновике нет или срок из письма в ней уже есть — null.
const DUE_ROW = /^\|\s*Срок\s*\|\s*([^|\n]*?)\s*\|\s*$/mu;
function dueSwap(draft, due) {
  const cell = DUE_ROW.exec(String(draft?.body ?? ''))?.[1];
  if (cell === undefined || cell.includes(due.v)) return null;
  return { was: cell, now: `${due.v} (по письму о переносе срока${due.later ? `; срок дела — ${due.later}, позже срока по заданию` : ''})` };
}
const nextDay = (iso) => new Date(Date.parse(`${iso}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const dayOf = (v) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
// 2.308: руководителю у дела на подписи организации — срок по заданию на оценку (2.303) прошёл или сегодня (день — по Москве).
// Задание читается только у дел с правилом report_dates; срок позже сегодняшнего — ничего.
// 2.344: срок взят из письма о переносе (2.333) — `letter` (`was` — прежний срок): прошёл или сегодня — «срок по письму о
// переносе»; срок по письму позже сегодняшнего, а прежний уже наступил — `moved`: «срок перенесён письмом на …», не красным.
// 2.352: в подписи организации (`soon`) срок по письму о переносе завтра — `soon`: «подпишите до …», красным и первым.
export async function taskDueSign(sql, storage, registry, order, today, { soon = false } = {}) {
  if (!storage || !registry.checks(order.module, order.service).some((r) => (r.auto ?? []).includes('report_dates'))) return null;
  const assignment = await assignmentDocs(sql, storage, order);
  const d = taskDueFor(registry, order, assignment);
  if (!d) return null;
  const l = taskMoveLetter(assignment, d);
  const letter = l ? { was: l.was, ...(l.was_letter ? { was_letter: true } : {}) } : null;
  if (d.day > today) {
    if (soon && letter && d.day === nextDay(today)) return { day: d.day, soon: true, name: d.name, page: d.page, by: d.by, letter };
    return letter?.was && letter.was <= today ? { day: d.day, moved: true, name: d.name, page: d.page, by: d.by, letter } : null;
  }
  return { day: d.day, overdue: d.day < today, name: d.name, page: d.page, by: d.by, ...(letter ? { letter } : {}) };
}
const CUSTOMER_GAP = /\[(?:заполнить|указать)\s*:?\s*(?:(?:фио|имя|наименование|название)\s+)?заказчик[а-яё]*\s*\]/giu;
const PURPOSE_GAP = /\[(?:заполнить|указать)\s*:?\s*цел\S*\s+(?:проведения\s+)?оценки[^\]]*\]/giu;
const VALUE_KIND_GAP = /\[(?:заполнить|указать)\s*:?\s*вид\S*\s+стоимост[^\]]*\]/giu;
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
      // 2.305: «Что сказано в задании на оценку» — одним списком, что программа взяла из задания (письма заказчика,
      // определения суда): дата оценки, вид стоимости, цель, заказчик, адрес, срок — с файлом и страницей. Те же правила, что
      // у черновика (2.207, 2.281–2.292, 2.303): адрес — как в задании, даже если в выписке ЕГРН он есть. Задания нет — пусто.
      id: 'draft.task', method: 'GET', path: '/api/orders/:id/task', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, registry, providers }) {
        guard(actor, order);
        const assignment = await assignmentDocs(sql, providers.storage, order);
        if (!assignment.length) return { files: [], items: [] };
        const [owner] = await sql`select full_name from users where id = ${order.owner_user_id}`;
        const idOf = (name) => assignment.find((a) => a.name === name)?.id ?? null;
        const at = (x) => ({ by: x.by ?? TASK_BY[x.what] ?? null, name: x.name, page: x.page, doc_id: idOf(x.name) });
        const vd = valueDateFor(registry, order, assignment);
        const kind = taskKindFor(registry, order, assignment);
        const purpose = taskPurposeFor(registry, order, assignment);
        const customer = taskCustomerFor(registry, order, assignment, owner?.full_name);
        const address = taskAddressFor(registry, order, assignment, null);
        const due = taskDueFor(registry, order, assignment);
        const user = taskUserFor(registry, order, assignment);
        const moved = taskMoveLetter(assignment, due);
        const items = [
          vd?.day ? { id: 'value_date', label: 'Дата оценки', v: vd.day, ...at(vd) } : null,
          vd?.days ? { id: 'value_date', label: 'Дата оценки', v: vd.days.join(', '), many: true, by: null, name: null, page: null, doc_id: null } : null,
          kind ? { id: 'kind', label: 'Вид стоимости', v: kind.v, ...at(kind) } : null,
          purpose ? { id: 'purpose', label: 'Для чего нужна оценка', v: purpose.v, ...at(purpose), typed: purpose.typed } : null,
          customer ? { id: 'customer', label: 'Заказчик', v: customer.v, ...at(customer), typed: customer.typed } : null,
          address ? { id: 'address', label: 'Адрес объекта', v: address.v, ...at(address), typed: address.typed } : null,
          user?.name ? { id: 'user', label: 'Предполагаемый пользователь результатов оценки', v: user.v, ...at(user) } : null,
          due ? { id: 'due', label: 'Срок составления отчёта', v: `не позднее ${due.v}`, ...at(due), later: due.later } : null,
          moved ? { id: 'moved', label: 'Срок перенесён письмом', v: `на ${ruDay(moved.day)}`, ...at(due), was: moved.was && ruDay(moved.was), was_letter: !!moved.was_letter,
            swap: editsDraft(actor, order) ? dueSwap(await latest(sql, order.id), due) : null } : null,
        ].filter(Boolean);
        return { files: assignment.map((a) => ({ id: a.id, name: a.name })), items };
      },
    },
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
        const assignment = await assignmentDocs(sql, providers.storage, order);
        const valueDate = valueDateFor(registry, order, assignment);
        const valueBrief = valueDate?.day ? `Дата оценки: ${valueDate.day} (${valueDate.what} «${valueDate.name}», стр. ${valueDate.page}) — пиши её везде, где нужна дата оценки, без пометок` : null;
        const egrn = await egrnFor(sql, providers.storage, registry, order);
        const task = { address: taskAddressFor(registry, order, assignment, egrn), kind: taskKindFor(registry, order, assignment),
          purpose: taskPurposeFor(registry, order, assignment), due: taskDueFor(registry, order, assignment),
          user: taskUserFor(registry, order, assignment) };
        const [owner] = await sql`select full_name from users where id = ${order.owner_user_id}`;
        task.customer = taskCustomerFor(registry, order, assignment, owner?.full_name);
        const taskBrief = [
          task.address ? `Адрес объекта ${task.address.what} «${task.address.name}» (стр. ${task.address.page}): ${task.address.v} — пиши его везде, где нужен адрес объекта, без пометок` : null,
          task.purpose ? `Цель оценки ${task.purpose.what} «${task.purpose.name}» (стр. ${task.purpose.page}): ${task.purpose.v} — пиши её везде, где нужна цель оценки, без пометок` : null,
          task.customer ? `Заказчик ${task.customer.what} «${task.customer.name}» (стр. ${task.customer.page}): ${task.customer.v} — пиши его везде, где нужен заказчик, без пометок` : null,
          task.due ? `Срок составления отчёта ${task.due.what} «${task.due.name}» (стр. ${task.due.page}): не позднее ${task.due.v} — дата составления отчёта не позже него` : null,
          task.user ? `Предполагаемый пользователь результатов оценки (${task.user.by}${task.user.name ? ` «${task.user.name}», стр. ${task.user.page}` : ''}): ${task.user.v} — пиши его везде, где нужен пользователь результатов оценки, без пометок` : null,
          task.kind ? `Вид стоимости ${task.kind.what} «${task.kind.name}» (стр. ${task.kind.page}): ${task.kind.v} — пиши его везде, где нужен вид стоимости, без пометок` : null,
        ].filter(Boolean).join('\n') || null;
        const taken = ['address', 'area', 'cadastral', 'purpose'].filter((k) => egrn?.[k]?.v || task[k]?.v);
        const brief = [orderBrief(registry, order, { omit: taken }), valueBrief, egrnBrief(egrn), taskBrief, onsite, dossierBrief, spec ? analogsBrief(spec, analogs, order) : null, tablesBrief(sections)].filter(Boolean).join('\n');
        const out = await askAi(ctx, actor, 'draft', draftMessages({ brief, sections, ...inputs }));
        // Таблицы (2.29) и сведения из досье (2.14) программа вставляет сама, под заголовками разделов.
        const materials = await orderMaterials(sql, order);
        // Перечень использованных документов (2.95) — из дела, программой.
        const sources = sourcesLines(await orderSources(sql, registry, order, providers.storage));
        const answer = cleanDraftAnswer(sections, out.text);
        const named = task.customer ? answer.replace(CUSTOMER_GAP, task.customer.v) : answer;
        const aimed = task.purpose ? named.replace(PURPOSE_GAP, task.purpose.v) : named;
        const kinded = task.kind ? aimed.replace(VALUE_KIND_GAP, task.kind.v) : aimed;
        const dated = fillEgrn(valueDate?.day ? kinded.replace(VALUE_GAP, valueDate.day) : kinded, task.address ? { ...egrn, address: task.address } : egrn);
        const filled = placeCustomer(fillDraft(fillTables(dated, sections, registry, order, { materials, valueDate: valueDate?.day, egrn, task }), sections, dossier), sections, task.customer);
        const text = placeSources(filled, sections, sources).body.slice(0, DRAFT_MAX);
        const seen = {
          photos: inputs.photos.map((p) => p.name),
          docs: inputs.docs.map((d) => ({ name: d.name, read: d.text !== null, truncated: d.truncated })),
          onsite: !!onsite,
          dossier: dossier.length,
          analogs: analogs.length,
          value_date: valueDate,
          egrn,
          task_address: task.address,
          task_kind: task.kind,
          task_purpose: task.purpose,
          task_customer: task.customer,
          task_due: task.due,
          task_user: task.user,
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
        const swap = swapMark(body?.swap);
        const d = await sql.tx(async (tx) => {
          await tx`select id from orders where id = ${order.id} for update`;
          const cur = await latest(tx, order.id);
          sameBase(cur, body?.from);
          if (cur && cur.body === text) return cur;
          const row = await tx.one`insert into result_drafts (order_id, author_id, source, body, inputs)
                                   values (${order.id}, ${actor.id}, 'edit', ${text}, ${JSON.stringify(cur?.inputs ?? {})}) returning id`;
          await audit(tx, actor, 'draft.save', 'order', order.id, { draft: String(row.id), ...(swap ? { swap } : {}) });
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
        const number = await reportNumber(ctx, order, actor);
        const word = await reportFor(ctx, order, actor, cur.body, { number });
        await audit(sql, actor, 'draft.docx', 'order', order.id, { draft: String(cur.id), template: word.template, ...(number ? { number } : {}) });
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
        const number = await reportNumber(ctx, order, actor);
        const word = await reportFor(ctx, order, actor, cur.body, { number });
        const doc = await saveDocument(ctx, { filename: word.filename, mime: DOCX_MIME, buf: word.buf, kind: 'result' });
        await audit(sql, actor, 'draft.attach', 'order', order.id, { draft: String(cur.id), document: doc.id, template: word.template, analogs: word.analogs, photos: word.photos, ...(number ? { number } : {}) });
        res.status(201);
        return { document: publicDoc(doc) };
      },
    },
  ];
}
