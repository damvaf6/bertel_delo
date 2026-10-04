// Отчёт Word из черновика (2.29): таблицы в черновике, сведения для титула и колонтитула, шаблон организации эксперта.
import { APPROACHES, BASIS_KINDS } from '../modules/index.mjs';
import { headKey } from '../dossier/dossier.mjs';
import { executorSignOrg } from '../access/policy.mjs';
import { orderRef } from '../notify/registry.mjs';
import { todayMsk } from '../orders/workflow.mjs';
import { buildReport } from './docx.mjs';
import { analogTable, hostOf, timeMsk } from '../analogs/analogs.mjs';

const GAP = '[заполнить]';
const ru = (d) => {
  if (!d) return '';
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  return s.split('-').reverse().join('.');
};
// Значение в ячейке: одной строкой и без «|» — иначе строка таблицы развалится.
const cell = (v) => String(v ?? '').replace(/\s*\n\s*/g, '; ').replace(/\|/g, '/').trim() || GAP;
const row = (cells) => `| ${cells.map(cell).join(' | ')} |`;

// Таблица «задание»: услуга, основание, срок и поля заявки — как их заполнил заказчик.
function taskTable(registry, order) {
  const def = registry.service(order.module, order.service);
  const basis = BASIS_KINDS[order.basis_kind];
  const rows = [
    ['Сведение', 'Значение'],
    ['Услуга', def ? def.service.name : order.title],
    ['Основание', basis ? [basis.name, order.basis_number ? `№ ${order.basis_number}` : '', order.basis_date ? `от ${ru(order.basis_date)}` : ''].filter(Boolean).join(' ') : GAP],
    ...(def?.fields ?? []).filter((f) => order.fields?.[f.id] !== undefined && order.fields[f.id] !== '').map((f) => {
      const v = order.fields[f.id];
      return [f.label, f.type === 'select' ? f.options.find((o) => o.id === v)?.name ?? v : v];
    }),
    ['Срок', order.deadline ? ru(order.deadline) : GAP],
  ];
  return rows.map(row);
}

// Неприменённые подходы (2.33) — строкой «Не применялся», как в настоящих отчётах; не выбраны — все с пометками.
const approachesTable = (chosen) => [
  row(['Подход', 'Стоимость, руб.', 'Вес']),
  ...Object.entries(APPROACHES).map(([id, a]) => (!chosen?.length || chosen.includes(id) ? row([a, GAP, GAP]) : row([a, 'Не применялся', '—']))),
  row(['Итоговая величина', GAP, '1']),
];

// Разделы черновика дела — с учётом подходов, которые выбрал исполнитель (2.33).
export const orderSections = (registry, order) => registry.draftSections(order.module, order.service, order.approaches ?? null);

// Разделы с пометкой table получают таблицу сразу под заголовком; эксперт правит её в черновике как строки «| … |».
export function fillTables(body, sections, registry, order) {
  let out = body;
  for (const s of sections.filter((x) => x.table)) {
    const m = [...out.matchAll(/^#{1,3}\s*(.+)$/gm)].find((h) => headKey(h[1]) === headKey(s.title));
    if (!m) continue;
    const lines = s.table === 'task' ? taskTable(registry, order) : s.table === 'analogs' ? [ANALOGS_MARK] : approachesTable(order.approaches);
    const at = m.index + m[0].length;
    out = `${out.slice(0, at)}\n${lines.join('\n')}${out.slice(at)}`;
  }
  return out;
}

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
  const list = (await sql`select * from order_analogs where order_id = ${order.id} and deleted_at is null and confirmed_at is not null order by id`);
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
    text: placeAnalogs(text, sections, analogTable(spec, list)),
    appendix: { title: 'Приложение. Скриншоты объявлений (аналоги)', items },
  };
}

export const tablesBrief = (sections) => {
  const t = sections.filter((s) => s.table && s.table !== 'analogs');
  return t.length
    ? `ТАБЛИЦЫ: программа сама вставит таблицы в разделы ${t.map((s) => `«${s.title}»`).join(', ')} — сам их не рисуй.`
    : null;
};

// Отчёт эксперта: титул и колонтитул — по заявке и услуге; шаблон — организации, от которой эксперт работает (профиль
// специалиста, 2.5а). Шаблон пропал из хранилища — собирается стандартный.
export async function reportFor(ctx, order, actor, draftText) {
  const { sql, providers, registry } = ctx;
  const { text, appendix } = await analogsPart(ctx, order, draftText);
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
    date: ru(todayMsk()),
  };
  return { buf: buildReport(text, meta, template, { appendix }), filename: `${title}.docx`, template: !!template, analogs: appendix?.items.length ?? 0 };
}
