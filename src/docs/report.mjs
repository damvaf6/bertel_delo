// Отчёт Word из черновика (2.29): таблицы в черновике, сведения для титула и колонтитула, шаблон организации эксперта.
import { BASIS_KINDS } from '../modules/index.mjs';
import { headKey } from '../dossier/dossier.mjs';
import { executorSignOrg } from '../access/policy.mjs';
import { orderRef } from '../notify/registry.mjs';
import { todayMsk } from '../orders/workflow.mjs';
import { buildReport } from './docx.mjs';

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

const APPROACHES = ['Сравнительный', 'Затратный', 'Доходный'];
const approachesTable = () => [
  row(['Подход', 'Стоимость, руб.', 'Вес']),
  ...APPROACHES.map((a) => row([a, GAP, GAP])),
  row(['Итоговая величина', GAP, '1']),
];

// Разделы с пометкой table получают таблицу сразу под заголовком; эксперт правит её в черновике как строки «| … |».
export function fillTables(body, sections, registry, order) {
  let out = body;
  for (const s of sections.filter((x) => x.table)) {
    const m = [...out.matchAll(/^#{1,3}\s*(.+)$/gm)].find((h) => headKey(h[1]) === headKey(s.title));
    if (!m) continue;
    const lines = s.table === 'task' ? taskTable(registry, order) : approachesTable();
    const at = m.index + m[0].length;
    out = `${out.slice(0, at)}\n${lines.join('\n')}${out.slice(at)}`;
  }
  return out;
}

export const tablesBrief = (sections) => {
  const t = sections.filter((s) => s.table);
  return t.length
    ? `ТАБЛИЦЫ: программа сама вставит таблицы в разделы ${t.map((s) => `«${s.title}»`).join(', ')} — сам их не рисуй.`
    : null;
};

// Отчёт эксперта: титул и колонтитул — по заявке и услуге; шаблон — организации, от которой эксперт работает (профиль
// специалиста, 2.5а). Шаблон пропал из хранилища — собирается стандартный.
export async function reportFor({ sql, providers, registry }, order, actor, text) {
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
  return { buf: buildReport(text, meta, template), filename: `${title}.docx`, template: !!template };
}
