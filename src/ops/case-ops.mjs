// Журнал действий по делу и выгрузка дела архивом (задача 2.55).
// Журнал — из журнала действий платформы (audit_log): шаги по заявке и по её файлам, кто и когда. Служебные видят всё
// и с именами; стороны дела — только то, что им и так видно (без черновика, проверки, аналогов, внутренней переписки
// организации, выплат), а вместо имён — кто это по делу. Правила — journalView и exportsCase в src/access/policy.mjs.
// Архив (ZIP) — для суда или заказчика: «Карточка дела.docx» (данные, ход, журнал, переписка, перечень файлов с
// контрольными суммами SHA-256), файлы дела, подписи УКЭП с протоколом их проверки (2.69), закрывающие документы. Большой архив отдаётся временной
// ссылкой из хранилища (src/ops/util.mjs, sendFile).
import crypto from 'node:crypto';
import { HttpError } from '../http/core.mjs';
import { exportsCase, journalView, moneyView, seesResults } from '../access/policy.mjs';
import { STATUS_NAME, todayMsk } from '../orders/workflow.mjs';
import { orderRef } from '../notify/registry.mjs';
import { buildSimpleDoc, zip, DOCX_MIME } from '../docs/docx.mjs';
import { closingDoc } from '../money/papers.mjs';
import { signatureFilename } from '../providers/sign.mjs';
import { sha256 } from './sign-ops.mjs';
import { docView } from './money-ops.mjs';
import { audit, sendFile } from './util.mjs';

// Что стороны дела видят в журнале (остальное — только служебным).
const PARTY_ACTIONS = new Set(['order.create', 'order.update', 'order.status', 'order.price', 'payment.create', 'payment.succeeded',
  'payment.canceled', 'order.offer', 'message.post', 'document.upload', 'document.direct_upload', 'document.delete', 'document.sign',
  'document.sign_org', 'document.verify', 'refund.create', 'inspection.issue', 'inspection.sms', 'inspection.retake', 'inspect.finish',
  'onsite.assign', 'onsite.finish', 'order.transfer', 'closing.download', 'invoice.download', 'case.export',
  'doc_request.create', 'doc_request.attach', 'doc_request.cancel',
  'deadline.request', 'deadline.withdraw', 'deadline.approve', 'deadline.decline']);

const SIDE_RU = { customer: 'заказчик', dispatcher: 'диспетчер', executor: 'исполнитель' };
const rub = (kop) => `${(Number(kop) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
const ruDay = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso ?? '') ? iso.split('-').reverse().join('.') : '—');
const KIND_RU = { result: 'результат', basis: 'основание', other: 'документ' };

function what(a, doc) {
  const d = a.details || {};
  const f = doc ? `«${doc.filename}»` : 'файл';
  switch (a.action) {
    case 'order.create': return 'Создана заявка';
    case 'order.update': return 'Изменены данные заявки';
    case 'order.status': return `Состояние: ${STATUS_NAME[d.from] ?? d.from} → ${STATUS_NAME[d.to] ?? d.to}`;
    case 'order.price': return `Назначена цена ${rub(d.price_kop)}`;
    case 'payment.create': return 'Заказчик начал оплату';
    case 'payment.succeeded': return `Оплата получена${d.amount_kop ? `: ${rub(d.amount_kop)}` : ''}`;
    case 'payment.canceled': return 'Оплата не прошла';
    case 'order.offer': return d.org ? 'Дело предложено экспертной организации' : 'Дело предложено исполнителю';
    case 'org.case.assign': return 'Руководитель организации назначил эксперта';
    case 'org.case.reassign': return `${d.to ? 'Руководитель организации предложил дело другому эксперту' : 'Руководитель организации забрал дело у эксперта до ответа'}${d.reason ? `: ${d.reason}` : ''}`;
    case 'org.case.decline': return 'Организация отказалась от дела';
    case 'org.case.transfer': return `Руководитель организации передал дело другому эксперту${d.reason ? `: ${d.reason}` : ''}`;
    case 'message.post': return 'Сообщение в переписке';
    case 'org_chat.post': return 'Сообщение во внутренней переписке организации';
    case 'document.upload': case 'document.direct_upload':
      return doc?.kind === 'result' ? `Приложен результат ${f}` : `Добавлен ${KIND_RU[doc?.kind] ?? 'документ'} ${f}`;
    case 'document.delete': return `Удалён ${f}`;
    case 'document.sign': return `${f}: подпись эксперта`;
    case 'document.sign_org': return `${f}: подпись организации`;
    case 'document.verify': return `${f}: проверена подпись${d.valid === false ? ' — не прошла' : ''}`;
    case 'document.link': return `Скачан ${f}`;
    case 'signature.link': return `Скачан файл подписи ${f}`;
    case 'document.org_return': case 'order.org_returned': return `Руководитель вернул эксперту ${f}`;
    case 'closing.download': return 'Скачан закрывающий документ';
    case 'invoice.download': return 'Скачан счёт для бухгалтерии';
    case 'refund.create': return 'Возврат заказчику';
    case 'refund.retry': return 'Повтор возврата';
    case 'payout.retry': return 'Повтор выплаты исполнителю';
    case 'inspection.issue': return 'Выдана ссылка на дистанционный осмотр';
    case 'inspection.sms': return 'Ссылка на осмотр отправлена СМС';
    case 'inspection.revoke': return 'Ссылка на осмотр закрыта';
    case 'inspection.retake': return 'Владельца попросили переснять шаг осмотра';
    case 'inspection.retake_cancel': return 'Просьба переснять отменена';
    case 'inspect.finish': return `Владелец объекта завершил осмотр${d.photos ? ` (${d.photos} фото)` : ''}`;
    case 'onsite.assign': return 'Назначен выезд помощника';
    case 'onsite.data': return 'Помощник записал данные с объекта';
    case 'onsite.finish': return 'Помощник завершил выезд';
    case 'onsite.cancel': return 'Выезд помощника отменён';
    case 'order.transfer': return 'Заявка передана другому сотруднику';
    case 'draft.ai': return 'ИИ подготовил черновик заключения';
    case 'draft.save': return 'Черновик сохранён';
    case 'draft.past': return 'В черновик взяты методические разделы из своего прошлого дела';
    case 'draft.attach': return 'Черновик приложен как результат';
    case 'draft.docx': return 'Черновик скачан файлом Word';
    case 'draft.approaches': return 'Выбраны подходы к оценке';
    case 'review.ai': return 'ИИ-проверка результата';
    case 'review.mark': return 'Отметка по правилу проверки';
    case 'analogs.add': return 'Добавлен аналог';
    case 'analogs.update': return 'Аналог изменён';
    case 'analogs.remove': return 'Аналог удалён';
    case 'analogs.file': return 'Скриншот аналога';
    case 'analogs.ai': return 'ИИ предложил признаки аналога';
    case 'dossier.attach': return 'Приложены копии из досье эксперта';
    case 'doc_request.create': return `Исполнитель запросил документы: ${(d.titles ?? []).join('; ')}`;
    case 'doc_request.attach': return `Заказчик приложил запрошенный документ: ${d.title ?? ''}`;
    case 'doc_request.cancel': return `Исполнитель снял просьбу о документе: ${d.title ?? ''}`;
    case 'deadline.request': return `Исполнитель попросил перенести срок с ${ruDay(d.from)} на ${ruDay(d.to)}: ${d.reason ?? ''}`;
    case 'deadline.withdraw': return 'Исполнитель отозвал просьбу о переносе срока';
    case 'deadline.approve': return `Срок перенесён с ${ruDay(d.from)} на ${ruDay(d.to)}${d.answer ? `: ${d.answer}` : ''}`;
    case 'deadline.decline': return `В переносе срока на ${ruDay(d.to)} отказано${d.answer ? `: ${d.answer}` : ''}`;
    case 'case.export': return 'Дело выгружено архивом';
    default: return a.action;
  }
}

async function loadEntries(sql, order) {
  const docs = new Map((await sql`select id, filename, kind, size_bytes from documents where order_id = ${order.id}`).map((d) => [String(d.id), d]));
  const rows = await sql`
    select a.id, a.actor_id, a.action, a.subject_type, a.subject_id, a.details, a.at, u.full_name, u.phone, u.platform_role
    from audit_log a left join users u on u.id = a.actor_id
    where (a.subject_type = 'order' and a.subject_id = ${String(order.id)})
       or (a.subject_type = 'document' and a.subject_id = any(${[...docs.keys()]}::text[]))
    order by a.id limit 2000`;
  return { rows, docs };
}

// Кто это по делу — для сторон (без имён посторонних им людей).
function partyWho(a, actor, order, customerIds) {
  if (a.actor_id && a.actor_id === actor.id) return 'Вы';
  if (!a.actor_id) return a.action === 'inspect.finish' ? 'Владелец объекта (по ссылке)' : 'Платформа';
  if (a.platform_role) return 'Платформа';
  if (customerIds.has(a.actor_id)) return a.full_name && customerIds.has(actor.id) ? `Заказчик (${a.full_name})` : 'Заказчик';
  if (a.action === 'document.sign_org') return 'Организация исполнителя';
  return 'Исполнитель';
}

function staffWho(a) {
  if (!a.actor_id) return a.action === 'inspect.finish' ? 'Владелец объекта (по ссылке)' : 'Платформа (автоматически)';
  const role = a.platform_role === 'admin' ? 'администратор' : a.platform_role === 'dispatcher' ? 'диспетчер' : (SIDE_RU[a.details?.side] ?? '');
  return `${a.full_name || a.phone}${role ? `, ${role}` : ''}`;
}

export async function caseJournal(sql, actor, order) {
  const view = journalView(actor, order);
  if (!view) return [];
  const { rows, docs } = await loadEntries(sql, order);
  const results = seesResults(actor, order);
  const customerIds = new Set([order.owner_user_id]);
  if (order.org_id) for (const m of await sql`select user_id from org_members where org_id = ${order.org_id}`) customerIds.add(m.user_id);
  const out = [];
  for (const a of rows) {
    const doc = a.subject_type === 'document' ? docs.get(String(a.subject_id)) : null;
    if (view === 'party') {
      if (!PARTY_ACTIONS.has(a.action)) continue;
      if (doc?.kind === 'result' && !results) continue;
    }
    out.push({ id: String(a.id), at: a.at, who: view === 'full' ? staffWho(a) : partyWho(a, actor, order, customerIds), what: what(a, doc) });
  }
  return out;
}

const dt = (d) => new Date(d).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const day = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('.') : '—');
const sizeRu = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);
const safeName = (s) => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 150) || 'файл';
// Сколько файлов кладём в архив: облаку хватает памяти на ~120 МБ; остальное — перечнем в карточке.
export const EXPORT_MAX_BYTES = 120 * 1024 * 1024;

// Протокол проверки подписей (2.69): каждая подпись в архиве заново проверяется у поставщика подписи по файлу из
// хранилища в момент выгрузки — кто, чем, когда и как подписал, верна ли подпись сейчас. Записи о проверке в деле не
// меняет (это делает только «Проверить подпись» в кабинете).
async function checkSignature(providers, buf, sig) {
  try {
    const r = await providers.sign.verify({ digest: sha256(buf), signature: sig });
    return r.valid ? { valid: true } : { valid: false, reason: r.reason ?? 'Подпись неверна' };
  } catch {
    return { valid: false, reason: 'Сервис подписи не ответил — проверьте подпись в кабинете позже' };
  }
}

const SIGN_METHOD_RU = (s) => (s.method === 'cabinet' ? 'в кабинете «БЕРТЕЛ Дело»'
  : s.certificate?.app ? `готовым файлом из приложения «${s.certificate.app}»` : 'готовым файлом из программы удостоверяющего центра');

function signatureProtocol({ ref, actor, checks }) {
  const ok = checks.filter((c) => c.r.valid).length;
  const test = checks.some((c) => c.s.test);
  return buildSimpleDoc([
    { type: 'title', text: `Протокол проверки подписей · дело № ${ref}` },
    { type: 'para', text: `Проверено ${dt(new Date())} (время московское) при выгрузке дела архивом. Выгрузил(а): ${actor.full_name || actor.phone}.` },
    { type: 'para', text: 'Каждая подпись — открепленный файл рядом с подписанным файлом в папке «Документы». Подпись проверена по файлу в том виде, в каком он лежит в архиве: если файл изменить хотя бы на один знак, подпись перестанет сходиться.' },
    { type: 'bold', text: `Подписей: ${checks.length}; верны: ${ok}${ok < checks.length ? `; не прошли проверку: ${checks.length - ok}` : ''}.` },
    ...(test ? [{ type: 'note', text: 'Тестовые подписи площадки — юридической силы не имеют.' }] : []),
    ...checks.flatMap((c) => {
      const cert = c.s.certificate ?? {};
      return [
        { type: 'bold', text: `${c.file.replace(/^Документы\//, '')} — подпись ${c.s.role === 'org' ? 'организации' : 'эксперта'}` },
        { type: 'table', rows: [
          ['Результат проверки', c.r.valid ? 'Подпись верна' : `Не прошла: ${c.r.reason}`],
          ['Подписал(а)', cert.org ? `${cert.org} — ${String(cert.title ?? 'руководитель').toLowerCase()} ${cert.subject}` : String(cert.subject ?? '—')],
          ['Когда подписано', c.s.signed_at ? dt(c.s.signed_at) : '—'],
          ['Как подписано', SIGN_METHOD_RU(c.s)],
          ['Сертификат', `№ ${cert.serial ?? '—'}, действует до ${day(cert.valid_to)}`],
          ['Выдан', String(cert.issuer ?? '—')],
          ['Файл подписи', c.sigFile.replace(/^Документы\//, '')],
          ['SHA-256 подписанного файла', c.digest],
          ['Последняя проверка в кабинете', c.s.checked_at ? `${dt(c.s.checked_at)} — ${c.s.checked_ok ? 'верна' : 'не прошла'}` : '—'],
          ...(c.s.test ? [['Отметка', 'тестовая подпись площадки']] : []),
        ] },
      ];
    }),
  ]);
}

async function buildArchive({ sql, actor, order, registry, providers, cfg }) {
  const ref = orderRef(order.id).replace('№ ', '');
  const def = registry.service(order.module, order.service);
  const results = seesResults(actor, order);
  const docs = (await sql`select * from documents where order_id = ${order.id} and deleted_at is null order by created_at`)
    .filter((d) => d.kind !== 'result' || results);
  const signs = results ? await sql`select * from document_signatures where order_id = ${order.id} order by id` : [];
  const used = new Set();
  const place = (dir, name) => {
    let n = `${dir}/${safeName(name)}`;
    for (let i = 2; used.has(n); i += 1) n = `${dir}/${safeName(name).replace(/(\.[^.]*)?$/, ` (${i})$1`)}`;
    used.add(n);
    return n;
  };
  const files = [];
  const listed = [];
  const checks = [];
  let total = 0;
  for (const d of docs) {
    const size = Number(d.size_bytes);
    if (total + size > EXPORT_MAX_BYTES) { listed.push([d.filename, KIND_RU[d.kind] ?? 'документ', sizeRu(size), 'не вошёл в архив — скачайте в кабинете']); continue; }
    const buf = await providers.storage.get(d.storage_key);
    if (!buf) { listed.push([d.filename, KIND_RU[d.kind] ?? 'документ', sizeRu(size), 'файл не найден в хранилище']); continue; }
    total += buf.length;
    const name = place('Документы', d.filename);
    files.push([name, buf]);
    listed.push([name, KIND_RU[d.kind] ?? 'документ', sizeRu(buf.length), crypto.createHash('sha256').update(buf).digest('hex')]);
    for (const s of signs.filter((x) => x.document_id === d.id)) {
      const sb = await providers.storage.get(s.storage_key);
      if (!sb) continue;
      const sn = place('Документы', signatureFilename(d.filename, s.role));
      files.push([sn, sb]);
      listed.push([sn, s.role === 'org' ? 'подпись организации' : 'подпись эксперта', sizeRu(sb.length), sha256(sb)]);
      checks.push({ file: name, sigFile: sn, digest: sha256(buf), s, r: await checkSignature(providers, buf, sb) });
    }
  }
  // Закрывающие документы: заказчику — акт и документ о возврате; служебным — и отчёт агента.
  const see = moneyView(actor, order);
  const kinds = [...(see.customer ? ['act', 'refund'] : []), ...(see.staff ? ['agent_report'] : [])];
  for (const c of kinds.length ? await sql`select * from closing_documents where order_id = ${order.id} and kind = any(${kinds}) order by created_at` : []) {
    const w = closingDoc({ doc: c, number: docView(c).number, registry, op: cfg.operator });
    const name = place('Закрывающие документы', w.filename);
    files.push([name, w.buf]);
    listed.push([name, 'закрывающий документ', sizeRu(w.buf.length), crypto.createHash('sha256').update(w.buf).digest('hex')]);
  }

  const fields = (def?.fields ?? []).filter((f) => order.fields?.[f.id] !== undefined && order.fields[f.id] !== '')
    .map((f) => [f.label, f.type === 'select' ? f.options.find((o) => o.id === order.fields[f.id])?.name ?? String(order.fields[f.id]) : String(order.fields[f.id])]);
  const history = await sql`select from_status, to_status, side, reason, at from order_status_history where order_id = ${order.id} order by id`;
  const staff = see.staff;
  const msgs = await sql`select m.side, m.body, m.at, u.full_name from order_messages m join users u on u.id = m.author_id
                         where m.order_id = ${order.id} order by m.id limit 2000`;
  const journal = await caseJournal(sql, actor, order);
  const card = buildSimpleDoc([
    { type: 'title', text: `Дело № ${ref}` },
    { type: 'para', text: `Выгрузка из «БЕРТЕЛ Дело» ${dt(new Date())} (время московское). Сделал(а): ${actor.full_name || actor.phone}.` },
    { type: 'bold', text: order.title },
    { type: 'table', rows: [
      ['Услуга', def ? `${def.module.name} · ${def.service.name}` : order.service],
      ['Состояние', STATUS_NAME[order.status] ?? order.status],
      ['Создана', dt(order.created_at)],
      ['Срок', day(order.deadline)],
      ...(order.price_kop ? [['Цена', rub(order.price_kop)]] : []),
      ['Оплата', order.paid_at ? `получена ${dt(order.paid_at)}` : 'нет'],
    ] },
    ...(fields.length ? [{ type: 'bold', text: 'Данные заявки' }, { type: 'table', rows: fields }] : []),
    { type: 'bold', text: 'Ход заявки' },
    { type: 'table', rows: [['Когда', 'Шаг', 'Кто', 'Причина'], ...history.map((h) => [dt(h.at), `${STATUS_NAME[h.from_status] ?? '—'} → ${STATUS_NAME[h.to_status]}`, SIDE_RU[h.side] ?? h.side ?? '', h.reason ?? ''])] },
    { type: 'bold', text: 'Журнал действий' },
    { type: 'table', rows: [['Когда', 'Кто', 'Что'], ...journal.map((j) => [dt(j.at), j.who, j.what])] },
    { type: 'bold', text: 'Переписка по заявке' },
    ...(msgs.length ? [{ type: 'table', rows: [['Когда', 'Кто', 'Сообщение'], ...msgs.map((m) => [dt(m.at), `${SIDE_RU[m.side] ?? m.side}${staff && m.full_name ? ` (${m.full_name})` : ''}`, m.body])] }]
      : [{ type: 'para', text: 'Сообщений нет.' }]),
    { type: 'bold', text: 'Файлы в архиве' },
    { type: 'para', text: 'Контрольная сумма SHA-256 подтверждает, что файл не менялся после выгрузки: её можно посчитать заново любой программой и сравнить.' },
    { type: 'table', rows: [['Файл', 'Что это', 'Размер', 'SHA-256 или примечание'], ...listed] },
    ...(checks.length ? [{ type: 'para', text: `Подписи проверены при выгрузке — «Протокол проверки подписей № ${ref}.docx» в этом архиве.` }] : []),
  ]);
  const protocol = checks.length ? [[`Протокол проверки подписей № ${ref}.docx`, signatureProtocol({ ref, actor, checks })]] : [];
  const archive = zip([[`Карточка дела № ${ref}.docx`, card], ...protocol, ...files], { store: true });
  return { buf: archive, filename: `Дело № ${ref} (${new Date().toISOString().slice(0, 10)}).zip`, files: files.length };
}

export function caseOps() {
  return [
    {
      id: 'case.journal', method: 'GET', path: '/api/orders/:id/journal', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order }) {
        return { journal: await caseJournal(sql, actor, order), full: journalView(actor, order) === 'full', can_export: exportsCase(actor, order) };
      },
    },
    {
      id: 'case.export', method: 'GET', path: '/api/orders/:id/export', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler(ctx) {
        const { sql, actor, order, res, providers } = ctx;
        if (!exportsCase(actor, order)) throw new HttpError(403, 'forbidden', 'Выгрузить дело может заказчик или платформа');
        const a = await buildArchive(ctx);
        await audit(sql, actor, 'case.export', 'order', order.id, { files: a.files, bytes: a.buf.length });
        await sendFile(res, providers, { buf: a.buf, filename: a.filename, mime: 'application/zip' });
      },
    },
  ];
}

// Архив сданных за месяц заключений организации (2.89) — руководителю, по образцу выгрузки дела. Только дела экспертов,
// которые сейчас работают от организации, сданные с тех пор, как они в ней (та же выборка, что в сводке 2.78). В архиве —
// файлы результата эксперта с подписями УКЭП (эксперта и организации), разложенные по экспертам и делам, и «Опись» —
// перечень дел с датой сдачи и сроком, файлы с SHA-256 и проверка подписей в момент выгрузки. Заказчик, название заявки,
// её данные и переписка в архив не попадают: руководитель видит только работу своих экспертов.
export async function buildOrgMonthArchive({ sql, actor, org, registry, providers }, cases, monthName) {
  const used = new Set();
  const place = (dir, name) => {
    let n = `${dir}/${safeName(name)}`;
    for (let i = 2; used.has(n); i += 1) n = `${dir}/${safeName(name).replace(/(\.[^.]*)?$/, ` (${i})$1`)}`;
    used.add(n);
    return n;
  };
  const SIGN_RU = (r) => (!r ? 'нет' : r.valid ? 'верна' : 'не прошла проверку');
  const files = [];
  const listed = [];
  const rows = [];
  let total = 0;
  let test = false;
  for (const o of cases) {
    const ref = orderRef(o.id).replace('№ ', '');
    const dir = `${safeName(o.expert_name)}/Дело № ${ref}`;
    const docs = await sql`select * from documents where order_id = ${o.id} and kind = 'result' and deleted_at is null
                           and uploaded_by = ${o.user_id} order by created_at`;
    const signs = await sql`select * from document_signatures where order_id = ${o.id} order by id`;
    const service = registry.service(o.module, o.service)?.service.name ?? o.service;
    if (!docs.length) rows.push([ref, service, o.expert_name, dt(o.at), day(o.deadline), 'файла результата нет', '—', '—']);
    for (const d of docs) {
      const size = Number(d.size_bytes);
      const buf = total + size > EXPORT_MAX_BYTES ? null : await providers.storage.get(d.storage_key);
      if (!buf) {
        const why = total + size > EXPORT_MAX_BYTES ? 'не вошёл в архив — скачайте в «Подписи организации»' : 'файл не найден в хранилище';
        rows.push([ref, service, o.expert_name, dt(o.at), day(o.deadline), `${d.filename} (${why})`, '—', '—']);
        continue;
      }
      total += buf.length;
      const name = place(dir, d.filename);
      files.push([name, buf]);
      listed.push([name, sizeRu(buf.length), sha256(buf)]);
      const by = {};
      for (const s of signs.filter((x) => x.document_id === d.id)) {
        const sb = await providers.storage.get(s.storage_key);
        if (!sb) continue;
        test ||= Boolean(s.test);
        const sn = place(dir, signatureFilename(d.filename, s.role));
        files.push([sn, sb]);
        listed.push([sn, sizeRu(sb.length), sha256(sb)]);
        by[s.role === 'org' ? 'org' : 'expert'] = await checkSignature(providers, buf, sb);
      }
      rows.push([ref, service, o.expert_name, dt(o.at), day(o.deadline), d.filename, SIGN_RU(by.expert), SIGN_RU(by.org)]);
    }
  }
  const late = cases.filter((o) => o.deadline && todayMsk(new Date(o.at)) > o.deadline).length;
  const inventory = buildSimpleDoc([
    { type: 'title', text: `Сданные заключения · ${monthName}` },
    { type: 'para', text: `${org.name}. Выгрузка из «БЕРТЕЛ Дело» ${dt(new Date())} (время московское). Сделал(а): ${actor.full_name || actor.phone}.` },
    { type: 'bold', text: `Сдано дел: ${cases.length}${late ? `; из них позже срока: ${late}` : ''}.` },
    { type: 'para', text: 'Дела экспертов, которые работают от организации, сданные в этом месяце с тех пор, как эксперт вступил в организацию. Файлы — в папках «Эксперт / Дело №»; подпись — открепленный файл рядом с подписанным. Подписи проверены при выгрузке.' },
    ...(test ? [{ type: 'note', text: 'Тестовые подписи площадки — юридической силы не имеют.' }] : []),
    { type: 'table', rows: [['Дело', 'Услуга', 'Эксперт', 'Сдано', 'Срок', 'Файл', 'Подпись эксперта', 'Подпись организации'], ...rows] },
    { type: 'bold', text: 'Файлы в архиве' },
    { type: 'para', text: 'Контрольная сумма SHA-256 подтверждает, что файл не менялся после выгрузки: её можно посчитать заново любой программой и сравнить.' },
    { type: 'table', rows: [['Файл', 'Размер', 'SHA-256'], ...listed] },
  ]);
  const archive = zip([[`Опись · ${safeName(monthName)}.docx`, inventory], ...files], { store: true });
  return { buf: archive, filename: `Заключения за ${monthName}.zip`, files: files.length };
}
