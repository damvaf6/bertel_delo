// Отчёт Word из черновика (2.29): таблицы в черновике, сведения для титула и колонтитула, шаблон организации эксперта.
import { APPROACHES, BASIS_KINDS } from '../modules/index.mjs';
import { headKey } from '../dossier/dossier.mjs';
import { executorSignOrg } from '../access/policy.mjs';
import { orderRef } from '../notify/registry.mjs';
import { todayMsk } from '../orders/workflow.mjs';
import { buildReport } from './docx.mjs';
import { analogTable, hostOf, inItemOrder, listPositions, timeMsk, valueText } from '../analogs/analogs.mjs';

const GAP = '[заполнить]';
const ru = (d) => {
  if (!d) return '';
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  return s.split('-').reverse().join('.');
};
// Значение в ячейке: одной строкой и без «|» — иначе строка таблицы развалится.
const cell = (v) => String(v ?? '').replace(/\s*\n\s*/g, '; ').replace(/\|/g, '/').trim() || GAP;
const row = (cells) => `| ${cells.map(cell).join(' | ')} |`;

// Таблица «задание»: услуга, основание, срок и поля заявки — как их заполнил заказчик. Вопросы, если для них есть свой
// раздел (2.81), в таблице не повторяются. Под таблицей — документы, которые представил заказчик (2.81): эксперт не
// переписывает их в раздел об объектах и образцах сам.
function taskTable(registry, order, { skip = [], materials = [] } = {}) {
  const def = registry.service(order.module, order.service);
  const basis = BASIS_KINDS[order.basis_kind];
  const rows = [
    ['Сведение', 'Значение'],
    ['Услуга', def ? def.service.name : order.title],
    ['Основание', basis ? [basis.name, order.basis_number ? `№ ${order.basis_number}` : '', order.basis_date ? `от ${ru(order.basis_date)}` : ''].filter(Boolean).join(' ') : GAP],
    // Числа — по-русски (2.66): «54,3», а не «54.3», как в отчёте.
    ...(def?.fields ?? []).filter((f) => !skip.includes(f.id) && order.fields?.[f.id] !== undefined && order.fields[f.id] !== '')
      .map((f) => [f.label, valueText(f, order.fields[f.id])]),
    ['Срок', order.deadline ? ru(order.deadline) : GAP],
  ];
  const got = materials.length
    ? ['', 'Документы, представленные заказчиком:', ...materials.map((m, i) => `${i + 1}. ${m.title} — файл «${m.filename}», получен ${m.day}`)]
    : [];
  return [...rows.map(row), ...got];
}

// Документы дела от заказчика (2.81): основание и всё, что он приложил сам или по запросу эксперта (тогда — название
// пункта запроса). Файлы эксперта, результат и фото осмотра — не сюда.
export async function orderMaterials(sql, order) {
  const rows = await sql`select d.filename, d.kind, d.created_at,
                                (select r.title from doc_requests r where r.document_id = d.id order by r.id limit 1) as asked
                           from documents d
                          where d.order_id = ${order.id} and d.deleted_at is null and d.kind in ('basis', 'other')
                            and d.uploaded_by is distinct from ${order.executor_user_id ?? null}
                          order by d.created_at, d.id`;
  return rows.map((r) => ({
    title: r.asked ?? (r.kind === 'basis' ? 'Документ-основание' : 'Документ'),
    filename: r.filename,
    day: ru(new Date(new Date(r.created_at).getTime() + 3 * 3600_000)),
  }));
}

// Неприменённые подходы (2.33) — строкой «Не применялся», как в настоящих отчётах; не выбраны — все с пометками.
// Применён один подход (2.66, обычно для квартиры — сравнительный) — его вес сразу 1: эксперту нечего распределять.
const approachesTable = (chosen) => [
  row(['Подход', 'Стоимость, руб.', 'Вес']),
  ...Object.entries(APPROACHES).map(([id, a]) => (!chosen?.length || chosen.includes(id) ? row([a, GAP, chosen?.length === 1 ? '1' : GAP]) : row([a, 'Не применялся', '—']))),
  row(['Итоговая величина', GAP, '1']),
];

// Перечень движимого из нескольких позиций (2.83): итог — по каждой позиции и общий, его эксперт пишет в черновике сам
// (средние цены аналогов по позициям — в таблице аналогов Word, справочно).
const itemsTable = (positions) => [
  '', 'Итог по позициям перечня:',
  row(['Позиция', 'Наименование', 'Стоимость, руб.']),
  ...positions.map((name, i) => row([String(i + 1), name, GAP])),
  row(['Итого по перечню', '—', GAP]),
];

// Вопросы эксперту (2.79) — из заявки дословно: эксперт не перепечатывает их, а модель не переформулирует. Кто поставил —
// суд (с номером и датой определения) или заказчик. Нумерация заказчика («1. …», «2) …») заменяется своей, подряд.
export function splitQuestions(text) {
  const raw = String(text ?? '').replace(/\r/g, '').trim();
  if (!raw) return [];
  const lines = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const parts = lines.length > 1 ? lines : raw.split(/\s+(?=\d{1,2}[.)]\s)/);
  return parts.map((q) => q.replace(/^\d{1,2}[.)]\s*/, '').trim()).filter(Boolean);
}

function questionsList(order) {
  const list = splitQuestions(order.fields?.questions);
  if (!list.length) return ['[заполнить: вопросы]'];
  const by = order.basis_kind === 'court'
    ? `На разрешение эксперта судом (определение${order.basis_number ? ` № ${order.basis_number}` : ''}${order.basis_date ? ` от ${ru(order.basis_date)}` : ''}) поставлены вопросы:`
    : 'На разрешение эксперта заказчиком поставлены вопросы:';
  return [by, ...list.map((q, i) => `${i + 1}. ${q}`)];
}

// Разделы черновика дела — с учётом подходов, которые выбрал исполнитель (2.33).
export const orderSections = (registry, order) => registry.draftSections(order.module, order.service, order.approaches ?? null);

// Разделы с пометкой table получают таблицу сразу под заголовком; эксперт правит её в черновике как строки «| … |».
export function fillTables(body, sections, registry, order, { materials = [] } = {}) {
  let out = body;
  const skip = sections.some((x) => x.table === 'questions') ? ['questions'] : [];
  for (const s of sections.filter((x) => x.table)) {
    const m = [...out.matchAll(/^#{1,3}\s*(.+)$/gm)].find((h) => headKey(h[1]) === headKey(s.title));
    if (!m) continue;
    const lines = s.table === 'task' ? taskTable(registry, order, { skip, materials }) : s.table === 'analogs' ? [ANALOGS_MARK]
      : s.table === 'questions' ? questionsList(order)
        : [...approachesTable(order.approaches), ...itemsTableFor(registry, order)];
    const at = m.index + m[0].length;
    out = `${out.slice(0, at)}\n${lines.join('\n')}${out.slice(at)}`;
  }
  // Экспертиза по определению суда (2.79): строка о предупреждении по ст. 307 УК РФ — в раздел сведений об эксперте,
  // как в каждом судебном заключении; подписку эксперт подписывает сам. Уже есть в тексте — второй раз не вставляется.
  const info = sections.find((x) => x.dossier === 'info');
  if (order.basis_kind === 'court' && info && !COURT_WARNING_RE.test(out)) {
    const m = [...out.matchAll(/^#{1,3}\s*(.+)$/gm)].find((h) => headKey(h[1]) === headKey(info.title));
    if (m) {
      const end = out.indexOf('\n#', m.index + m[0].length);
      const at = end < 0 ? out.length : end;
      out = `${out.slice(0, at).replace(/\s*$/, '')}\n${COURT_WARNING}${end < 0 ? '' : '\n'}${out.slice(at)}`;
    }
  }
  return out;
}

function itemsTableFor(registry, order) {
  const positions = listPositions(registry.analogs(order.module, order.service), order);
  return positions.length ? itemsTable(positions) : [];
}

export const COURT_WARNING = 'Об уголовной ответственности за дачу заведомо ложного заключения по статье 307 Уголовного кодекса Российской Федерации эксперт предупреждён. Подписка эксперта: [заполнить: подпись или подписка отдельным листом]';
const COURT_WARNING_RE = /307\s*(?:УК|Уголовного)/u;

// Таблица аналогов (2.32) в тексте черновика — строкой-меткой: сама таблица и скриншоты собираются при сборке Word из
// подтверждённых аналогов дела, поэтому всегда свежие (аналог добавили после черновика — он всё равно попадёт в файл).
export const ANALOGS_MARK = 'Таблица аналогов — из раздела «Аналоги» в деле: программа вставит её в файл Word, скриншоты объявлений — в приложение.';

function placeAnalogs(text, sections, table) {
  const s = sections.find((x) => x.table === 'analogs');
  if (!s) return text;
  const lines = table.join('\n');
  if (text.includes(ANALOGS_MARK)) return text.split(ANALOGS_MARK).join(lines);
  const m = [...text.matchAll(/^#{1,3}\s*(.+)$/gm)].find((h) => headKey(h[1]) === headKey(s.title));
  if (!m) return text;
  const at = m.index + m[0].length;
  return `${text.slice(0, at)}\n${lines}${text.slice(at)}`;
}

// Подтверждённые аналоги дела → таблица под разделом и приложение со скриншотами (дата получения платформой, ссылка, отпечаток).
async function analogsPart({ sql, providers, registry }, order, text) {
  const spec = registry.analogs(order.module, order.service);
  if (!spec) return { text, appendix: null };
  const sections = orderSections(registry, order);
  // Перечень (2.83) — по позициям: приложение со скриншотами в том же порядке и с теми же номерами, что таблица.
  const list = inItemOrder(spec, order, await sql`select * from order_analogs where order_id = ${order.id} and deleted_at is null and confirmed_at is not null order by id`);
  // Подтверждённых аналогов нет — метка просто не попадает в файл (таблицу эксперт мог написать сам; нехватку аналогов
  // показывает раздел «Аналоги» и ИИ-проверка по правилу analogs).
  if (!list.length) return { text: text.split(ANALOGS_MARK).join(''), appendix: null };
  const items = [];
  for (const [i, a] of list.entries()) {
    const image = a.file_key && /^image\/(png|jpeg)$/.test(a.file_mime) ? await providers.storage.get(a.file_key) : null;
    items.push({
      title: `Аналог ${i + 1} — ${hostOf(a.url)}`,
      lines: [
        `Ссылка: ${a.url}`,
        a.received_at ? `Скриншот получен платформой «БЕРТЕЛ Дело»: ${timeMsk(a.received_at)} (МСК)` : 'Скриншот не приложен',
        a.file_sha256 ? `Отпечаток файла (SHA-256): ${a.file_sha256}` : null,
        a.file_key && !image ? `Файл «${a.file_name}» хранится в деле на платформе (в Word не вставляется).` : null,
      ].filter(Boolean),
      image,
    });
  }
  return {
    text: placeAnalogs(text, sections, analogTable(spec, list, order)),
    appendix: { title: 'Приложение. Скриншоты объявлений (аналоги)', items },
  };
}

// Фото осмотра (2.37) → приложение «Фотоматериалы осмотра»: по шагам осмотра, у каждого — время получения платформой,
// время съёмки и место (если владелец разрешил); снимки JPEG/PNG вставляются картинкой, остальные — строкой «хранится в деле».
const PHOTOS_MAX = 40;
const PHOTOS_BYTES = 25 * 1024 * 1024;
async function photosPart({ sql, providers, registry }, order) {
  const rows = await sql`
    select d.id, d.filename, d.mime, d.size_bytes, d.storage_key, d.created_at, p.step, p.received_at, p.shot_at, p.lat, p.lon, p.accuracy_m
    from documents d left join inspection_photos p on p.document_id = d.id
    where d.order_id = ${order.id} and d.kind = 'inspection' and d.deleted_at is null order by d.created_at limit ${PHOTOS_MAX}`;
  if (!rows.length) return null;
  const steps = registry.inspectionSteps(order.module, order.service);
  const pos = (id) => { const i = steps.findIndex((x) => x.id === id); return i < 0 ? steps.length : i; };
  rows.sort((a, b) => pos(a.step) - pos(b.step) || a.created_at - b.created_at);
  let left = PHOTOS_BYTES;
  const items = [];
  for (const [i, r] of rows.entries()) {
    const fits = /^image\/(png|jpeg)$/.test(r.mime) && Number(r.size_bytes) <= left;
    const image = fits ? await providers.storage.get(r.storage_key) : null;
    if (image) left -= image.length;
    items.push({
      title: `Фото ${i + 1} — ${steps.find((x) => x.id === r.step)?.title ?? r.filename}`,
      lines: [
        `Получено платформой «БЕРТЕЛ Дело»: ${timeMsk(r.received_at ?? r.created_at)} (МСК)`,
        r.shot_at ? `Снято (по часам телефона): ${timeMsk(r.shot_at)} (МСК)` : null,
        r.lat != null ? `Место съёмки: ${Number(r.lat).toFixed(5)}, ${Number(r.lon).toFixed(5)}${r.accuracy_m != null ? ` (±${Math.round(r.accuracy_m)} м)` : ''}` : 'Место съёмки не определено',
        image ? null : `Файл «${r.filename}» хранится в деле на платформе (в Word не вставляется).`,
      ].filter(Boolean),
      image,
    });
  }
  return { title: 'Приложение. Фотоматериалы осмотра', items };
}

export const tablesBrief = (sections) => {
  const t = sections.filter((s) => s.table && s.table !== 'analogs' && s.table !== 'questions');
  const q = sections.filter((s) => s.table === 'questions');
  const src = sections.filter((s) => s.sources);
  return [
    t.length ? `ТАБЛИЦЫ: программа сама вставит таблицы в разделы ${t.map((s) => `«${s.title}»`).join(', ')} — сам их не рисуй${t.some((s) => s.table === 'task') ? '; список документов заказчика под таблицей задания программа тоже вставит сама' : ''}.` : null,
    q.length ? `ВОПРОСЫ: программа сама вставит вопросы из заявки дословно в раздел ${q.map((s) => `«${s.title}»`).join(', ')} — не переписывай их.` : null,
    src.length ? `ПЕРЕЧЕНЬ ДОКУМЕНТОВ: программа сама вставит в раздел ${src.map((s) => `«${s.title}»`).join(', ')} перечень использованных документов (документы заказчика, досье эксперта, фото осмотра, аналоги со ссылками) — сам их там не перечисляй.` : null,
  ].filter(Boolean).join('\n') || null;
};

// Отчёт эксперта: титул и колонтитул — по заявке и услуге; шаблон — организации, от которой эксперт работает (профиль
// специалиста, 2.5а). Шаблон пропал из хранилища — собирается стандартный.
export async function reportFor(ctx, order, actor, draftText) {
  const { sql, providers, registry } = ctx;
  const { text, appendix } = await analogsPart(ctx, order, draftText);
  const photos = await photosPart(ctx, order);
  const def = registry.service(order.module, order.service);
  const org = await executorSignOrg(sql, actor.id);
  const tpl = org ? await sql.one`select storage_key from org_templates where org_id = ${org.id}` : null;
  const template = tpl ? await providers.storage.get(tpl.storage_key) : null;
  const title = def?.service.paper ?? 'Заключение';
  const meta = {
    title,
    number: orderRef(order.id),
    subtitle: def ? def.service.name : order.title,
    org: template ? null : org?.name ?? null,   // в шаблоне шапка своя
    executor: actor.full_name || null,
    // На титуле заключения эксперта — «Эксперт» (2.79), у остальных документов — «Исполнитель».
    executor_role: /^Заключение эксперта/.test(title) ? 'Эксперт' : 'Исполнитель',
    date: ru(todayMsk()),
  };
  const appendices = [photos, appendix].filter(Boolean);
  return {
    buf: buildReport(text, meta, template, { appendix: appendices }), filename: `${title}.docx`, template: !!template,
    analogs: appendix?.items.length ?? 0, photos: photos?.items.length ?? 0,
  };
}
