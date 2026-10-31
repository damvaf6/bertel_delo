// Продление аккредитации в банке одним архивом (2.456). Банк при продлении просит документы оценщика и перечень отчётов за
// последний год — эксперт выгружает их по кнопке у аккредитации в досье. В архиве: «Сведения для продления аккредитации»
// (Word: эксперт, банк и прежнее решение, документы досье с номерами и сроками, отметки «срок истёк» и «копии нет»,
// перечень отчётов за 12 месяцев), тот же перечень таблицей для Excel и копии документов из досье (диплом, аттестат, СРО,
// полисы и копия прежнего решения банка). Заказчиков, переписки и файлов дел в архиве нет — только номер, дата, объект,
// услуга, цель и стоимость из перечня для СРО (2.401).
import { addDays, todayMsk } from '../orders/workflow.mjs';
import { buildSimpleDoc, zip } from '../docs/docx.mjs';
import { expertRegistry } from '../orgs/registry.mjs';
import { KINDS, loadDossier, termState } from './dossier.mjs';

// Какие документы досье банк смотрит при продлении — в этом порядке.
export const RENEWAL_KINDS = ['education', 'certificate', 'sro', 'policy', 'policy_org'];

const ru = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('.') : '—');
const safe = (s) => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'файл';
const extOf = (name) => (String(name).match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? '').toLowerCase();
const rub = (kop) => `${(Number(kop) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 }).replace(/\s/g, ' ')} руб.`;
const money = (v) => (v == null ? '—' : `${Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 }).replace(/\s/g, ' ')} ₽`);

// Последние 12 месяцев до сегодняшнего дня включительно (по Москве).
export function lastYearPeriod(today = todayMsk()) {
  const from = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`.replace(/-02-29$/, '-03-01');
  return { year: Number(today.slice(0, 4)), quarter: 0, months: 12, from: addDays(from, 1), to: addDays(today, 1), name: `12 месяцев: с ${ru(addDays(from, 1))} по ${ru(today)}`, years: [] };
}

// Ячейка таблицы для Excel: «;», кавычки и переносы — в кавычках; формулы не исполняются.
const cell = (v) => {
  let t = String(v ?? '');
  if (/^[=+\-@]/.test(t)) t = `'${t}`;
  return /[;"\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

const STATE_RU = { expired: 'срок истёк', soon: 'срок кончается в 30 дней', ok: 'действует' };

function docRow(i, inPack, today) {
  const state = termState(i.valid_until, today);
  return [KINDS[i.kind].name, i.title || '—', i.number ? (i.kind === 'sro' ? `в реестре ${i.number}` : `№ ${i.number}`) : '—',
    ru(i.issued_on), i.valid_until ? ru(i.valid_until) : 'бессрочно',
    [state ? STATE_RU[state] : null, i.amount_kop ? `сумма ${rub(i.amount_kop)}` : null].filter(Boolean).join('; ') || '—',
    inPack ?? 'копии в досье нет'];
}

// item — запись досье вида bank (своя, проверена операцией): как в loadDossier и file_key, file_name. Возвращает архив и что в нём для журнала.
export async function buildRenewalPack({ sql, providers, registry, actor }, item, today = todayMsk()) {
  const name = actor.full_name || actor.phone;
  const docs = (await loadDossier(sql, actor.id)).filter((i) => RENEWAL_KINDS.includes(i.kind))
    .sort((a, b) => RENEWAL_KINDS.indexOf(a.kind) - RENEWAL_KINDS.indexOf(b.kind) || Number(a.id) - Number(b.id));
  const files = [];
  const used = new Set();
  const copy = async (row, label) => {
    if (!row.file_key) return null;
    const buf = await providers.storage.get(row.file_key).catch(() => null);
    if (!buf) return 'копию не удалось взять — скачайте в досье';
    let path = `Копии документов/${String(files.length + 1).padStart(2, '0')} ${safe(label)}${extOf(row.file_name) ? `.${extOf(row.file_name)}` : ''}`;
    while (used.has(path)) path = path.replace(/(\.[a-z0-9]+)?$/i, ' (2)$1');
    used.add(path);
    files.push([path, buf]);
    return path.slice(path.indexOf('/') + 1);
  };
  const rows = [];
  for (const i of docs) {
    const row = await sql.one`select file_key, file_name from dossier_items where id = ${i.id}`;
    rows.push(docRow(i, await copy(row, KINDS[i.kind].name), today));
  }
  const bankFile = await copy(item, `Решение банка ${item.title}`);
  const missing = RENEWAL_KINDS.filter((k) => ['certificate', 'sro', 'policy'].includes(k) && !docs.some((i) => i.kind === k));
  const expired = docs.filter((i) => termState(i.valid_until, today) === 'expired');
  const noCopy = rows.filter((r) => r[6] === 'копии в досье нет').map((r) => r[0]);

  const period = lastYearPeriod(today);
  const list = await expertRegistry(sql, providers.storage, registry, actor.id, period);
  const table = [['№', 'Номер отчёта', 'Дата составления', 'Объект оценки', 'Услуга', 'Цель оценки', 'Стоимость', 'Сдано'],
    ...list.rows.map((x, n) => [String(n + 1), x.number ?? 'не найден', ru(x.made_on), x.object, x.service_name, x.purpose ?? '—', money(x.value_rub), ru(x.done_on)])];
  const csv = Buffer.from(`\ufeff${[[`Перечень отчётов об оценке — ${name}`], [`Период: ${period.name}`], [], ...table].map((l) => l.map(cell).join(';')).join('\r\n')}\r\n`, 'utf8');
  const until = item.valid_until;
  const issued = item.issued_on;
  const doc = buildSimpleDoc([
    { type: 'title', text: `Документы для продления аккредитации · ${item.title}` },
    { type: 'para', text: `Оценщик: ${name}. Выгрузка из «БЕРТЕЛ Дело» ${ru(today)}.` },
    { type: 'para', text: `Аккредитация в банке «${item.title}»${item.number ? `: решение № ${item.number}` : ''}${issued ? ` от ${ru(issued)}` : ''}${until ? `, срок до ${ru(until)}` : ''}${bankFile && !bankFile.startsWith('копию') ? ` — копия в архиве (${bankFile})` : ''}.` },
    ...(missing.length ? [{ type: 'note', text: `В досье нет: ${missing.map((k) => KINDS[k].name).join(', ')} — банк обычно просит эти документы; внесите их в досье и выгрузите архив заново.` }] : []),
    ...(expired.length ? [{ type: 'note', text: `Срок истёк: ${expired.map((i) => KINDS[i.kind].name).join(', ')} — банк не продлит аккредитацию по истёкшим документам; внесите новые в досье.` }] : []),
    ...(noCopy.length ? [{ type: 'note', text: `Копии не загружены: ${noCopy.join(', ')} — загрузите их в досье, чтобы они попали в архив.` }] : []),
    { type: 'bold', text: 'Документы оценщика' },
    { type: 'table', rows: [['Документ', 'Кем выдан / что', 'Номер', 'Выдан', 'Действует до', 'Состояние', 'Копия в архиве'], ...rows] },
    { type: 'bold', text: `Перечень отчётов об оценке за ${period.name.replace('12 месяцев: ', '12 месяцев ')}` },
    { type: 'para', text: list.rows.length
      ? `Сдано отчётов: ${list.total}${list.total > list.shown ? `; в перечне — первые ${list.shown}` : ''}. Номер, дата и стоимость — из файла отчёта в деле; тот же перечень — таблицей для Excel рядом.`
      : 'За эти 12 месяцев сданных отчётов об оценке в «БЕРТЕЛ Дело» нет.' },
    ...(list.rows.length ? [{ type: 'table', rows: table }] : []),
  ]);
  const title = `Продление аккредитации · ${safe(item.title)}`;
  const buf = zip([[`${title}.docx`, doc], [`Перечень отчётов за 12 месяцев.csv`, csv], ...files], { store: true });
  return { buf, filename: `${title}.zip`, files: files.length, reports: list.total, missing, expired: expired.map((i) => i.kind), no_copy: noCopy.length };
}
