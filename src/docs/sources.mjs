// Перечень использованных документов (2.95): программа собирает его сама из дела — документы заказчика (основание и всё,
// что он приложил, в том числе по запросу эксперта), документы эксперта из досье, фото осмотра и объявления-аналоги со
// ссылкой и временем, когда платформа получила скриншот. Встаёт в раздел с пометкой sources (описание модуля) одним
// блоком без пустых строк; эксперт правит его как обычный текст, кнопка «Обновить перечень» собирает блок заново.
import { headKey, itemLine, loadDossier } from '../dossier/dossier.mjs';
import { hostOf, inItemOrder, timeMsk } from '../analogs/analogs.mjs';
import { orderMaterials } from './report.mjs';
import { egrnRefs } from '../ai/report-checks.mjs';
import { egrnDocs } from '../ops/ai-ops.mjs';
import { actTitle } from './inspection-act.mjs';

export const SOURCES_HEAD = 'Перечень использованных документов (собран программой по делу — проверьте и поправьте):';
const dayMsk = (t) => new Date(t).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric' });
const photosWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'снимок' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'снимка' : 'снимков');

// Что есть в деле. Досье — исполнителя дела (не того, кто смотрит); аналоги — только подтверждённые, в порядке таблицы Word.
// 2.273: у выписки ЕГРН заказчика — номер и дата из самой выписки (как их читает сверка 2.264, `egrnRefs`); без хранилища
// или правил о выписке в модуле — как раньше, только имя файла.
export async function orderSources(sql, registry, order, storage) {
  const materials = await orderMaterials(sql, order);
  const auto = registry.checks(order.module, order.service).flatMap((r) => r.auto ?? []);
  if (storage && materials.length && auto.includes('egrn_doc_match')) {
    const refs = new Map(egrnRefs(await egrnDocs(sql, storage, order)).map((r) => [String(r.doc), r]));
    for (const m of materials) {
      const r = refs.get(String(m.id));
      if (r) m.egrn = { num: r.num, day: r.day };
    }
  }
  const dossier = order.executor_user_id ? await loadDossier(sql, order.executor_user_id) : [];
  const [ph] = await sql`select count(*)::int as n, min(created_at) as first, max(created_at) as last from documents
                         where order_id = ${order.id} and kind = 'inspection' and deleted_at is null`;
  const spec = registry.analogs(order.module, order.service);
  const analogs = spec ? inItemOrder(spec, order, await sql`select url, received_at, fields from order_analogs where order_id = ${order.id}
                                                            and deleted_at is null and confirmed_at is not null order by id`) : [];
  // Акт осмотра (2.424) — есть, когда есть фото осмотра; отметка владельца «С актом ознакомлен» (2.423) — последняя.
  const act = ph.n ? {
    title: actTitle(registry.service(order.module, order.service)),
    acked: (await sql`select max(acked_at) as t from inspection_links where order_id = ${order.id}`)[0].t,
  } : null;
  return { materials, dossier, photos: ph, analogs, act };
}

// Выписка ЕГРН: «Выписка из ЕГРН № КУВИ-001/2026-12345678 от 02.10.2026»; название из запроса эксперта, если в нём есть ЕГРН.
const ruDay = (d) => d.split('-').reverse().join('.');
function egrnTitle(m) {
  if (!m.egrn) return m.title;
  const title = /ЕГРН|ЕГРП/u.test(m.title) ? m.title : 'Выписка из ЕГРН';
  return [title, m.egrn.num ? `№ ${m.egrn.num}` : null, m.egrn.day ? `от ${ruDay(m.egrn.day)}` : null].filter(Boolean).join(' ');
}

// Строки блока; в деле ничего нет — пусто (блок не вставляется). Нумерация сквозная, как в перечне настоящего отчёта.
export function sourcesLines({ materials, dossier, photos, analogs, act = null }) {
  const out = [];
  let n = 0;
  const group = (title, lines) => { if (lines.length) out.push(title, ...lines.map((l) => `${++n}. ${l}`)); };
  group('Документы, представленные заказчиком:', materials.map((m) => `${egrnTitle(m)} — файл «${m.filename}», получен ${m.day}`));
  group('Документы эксперта:', dossier.map((i) => itemLine(i)));
  if (photos?.n) {
    const from = dayMsk(photos.first);
    const to = dayMsk(photos.last);
    group('Материалы осмотра:', [
      ...act ? [`${act.title} — составлен платформой «БЕРТЕЛ Дело» по фото осмотра${act.acked ? `, владелец ознакомлен ${dayMsk(act.acked)}` : ''} (приложение к отчёту)`] : [],
      `Фотоматериалы осмотра — ${photos.n} ${photosWord(photos.n)}, получены платформой «БЕРТЕЛ Дело» ${from === to ? from : `с ${from} по ${to}`}`]);
  }
  group('Объявления-аналоги:', analogs.map((a, i) => `Аналог ${i + 1} — ${hostOf(a.url) || 'объявление'}: ${a.url}, ${a.received_at ? `скриншот получен ${timeMsk(a.received_at)} (МСК)` : 'скриншот не приложен'}`));
  return out.length ? [SOURCES_HEAD, ...out] : [];
}

// Блок в тексте: от строки-заголовка до первой пустой строки или заголовка раздела.
function blockAt(body) {
  const at = body.indexOf(SOURCES_HEAD);
  if (at < 0 || (at > 0 && body[at - 1] !== '\n')) return null;
  const rest = body.slice(at);
  const m = rest.match(/\n(?:[ \t]*\n|#)/);
  return { start: at, end: m ? at + m.index : body.length };
}

// Поставить перечень: есть блок — заменить его; нет — под заголовок раздела с пометкой sources. Раздела нет — как было.
export function placeSources(body, sections, lines) {
  const s = sections.find((x) => x.sources);
  if (!s) return { body, placed: false };
  const b = blockAt(body);
  if (b) {
    const text = lines.join('\n');
    // Перечень опустел (заказчик удалил файлы) — убирается и строка, на которой он стоял.
    const end = !text && body[b.end] === '\n' ? b.end + 1 : b.end;
    return { body: `${body.slice(0, b.start)}${text}${body.slice(end)}`, placed: true };
  }
  if (!lines.length) return { body, placed: false };
  const m = [...body.matchAll(/^#{1,3}\s*(.+)$/gm)].find((h) => headKey(h[1]) === headKey(s.title));
  if (!m) return { body, placed: false };
  // После блока — пустая строка: по ней блок и узнаётся, текст эксперта ниже при обновлении не задевается.
  const at = m.index + m[0].length;
  const tail = body.slice(at).replace(/^\n*/, '');
  return { body: `${body.slice(0, at)}\n${lines.join('\n')}\n${tail ? `\n${tail}` : ''}`, placed: true };
}
