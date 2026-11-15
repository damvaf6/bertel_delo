// Оценка для наследства (2.500): у нотариуса дата оценки — день открытия наследства (день смерти наследодателя, ст. 1114
// ГК), а не день осмотра или составления отчёта. Заказчик пишет эту дату в заявке («Если наследство — дата открытия
// наследства»); здесь — разбор даты, подсказка в деле всем, кто видит заявку, и дата оценки для таблицы задания черновика.
// Только даты: о праве на наследство и долях наследников не пишем — это дело нотариуса.
import { todayMsk } from './workflow.mjs';
import { headKey } from '../dossier/dossier.mjs';

const ru = (iso) => iso.split('-').reverse().join('.');
const fromRu = (s) => { const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(s ?? '').trim()); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const valid = (iso) => { const d = new Date(`${iso}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso; };
const SERVICES = ['realty', 'land', 'vehicle', 'movable'];

// { day (ГГГГ-ММ-ДД) | null, state } или null, когда ни цели «наследство», ни даты нет.
// state: 'ok' — цель «наследство», дата есть и не в будущем; 'missing' — цель «наследство», даты нет;
// 'bad' — дата не настоящая (31.02); 'future' — ещё не наступила; 'purpose' — дата есть, а цель оценки другая.
export function inheritanceOf(fields = {}, today = todayMsk()) {
  const raw = String(fields.death_date ?? '').trim();
  const day = fromRu(raw);
  const heir = fields.purpose === 'inheritance';
  if (!raw) return heir ? { day: null, state: 'missing' } : null;
  if (!day || !valid(day)) return { day: null, state: 'bad' };
  if (day > today) return { day, state: 'future' };
  return { day, state: heir ? 'ok' : 'purpose' };
}

// Дата оценки для таблицы задания черновика: только при цели «наследство» и настоящей прошедшей дате.
export function inheritanceValueDay(serviceId, fields = {}, today = todayMsk()) {
  if (!SERVICES.includes(serviceId)) return null;
  const h = inheritanceOf(fields, today);
  return h?.state === 'ok' ? ru(h.day) : null;
}

export function inheritanceNotices(serviceId, fields = {}, today = todayMsk()) {
  if (!SERVICES.includes(serviceId)) return [];
  const h = inheritanceOf(fields, today);
  if (!h) return [];
  const text = {
    ok: `Оценка для наследства: дата оценки — день открытия наследства ${h.day ? ru(h.day) : ''}, а не день осмотра. Цены и аналоги — на эту дату.`,
    missing: 'Оценка для наследства: нотариусу нужна стоимость на день открытия наследства (день смерти). Эта дата и есть дата оценки — укажите её в заявке.',
    bad: 'Дата открытия наследства в заявке не настоящая — проверьте её.',
    future: `Дата открытия наследства (${h.day ? ru(h.day) : ''}) ещё не наступила — проверьте дату в заявке.`,
    purpose: `В заявке указана дата открытия наследства (${h.day ? ru(h.day) : ''}), а цель оценки — не «Наследство, нотариус». Проверьте цель оценки.`,
  }[h.state];
  return [{ id: `inheritance_${h.state}`, text }, ...heirNotices(serviceId, fields)];
}

// 2.506: в составе наследства несколько объектов (квартира и машина, доля и гараж). Основной объект — из заявки, остальные —
// поле «Если наследство — другие объекты в его составе», каждый с новой строки; «общая стоимость» — поле heir_total.
// Строка «Оценивается в составе наследства: …» — в раздел «Задание на оценку» черновика (сразу под заголовком; прежняя
// заменяется), подсказкой в деле — всем, кто видит заявку. Сверка итогов в отчёте — правило heir_objects (ИИ-проверка).
export const HEIR_HEAD = 'Оценивается в составе наследства:';
const MAX_OBJECTS = 20;
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Другие объекты наследства: строки поля без нумерации и маркеров, без повторов.
export function heirObjects(fields = {}) {
  const seen = new Set();
  const out = [];
  for (const raw of String(fields.heir_objects ?? '').split(/\r?\n/)) {
    const t = oneLine(raw.replace(/^\s*(?:\d{1,2}[.)]|[-–—•*])\s*/u, '')).replace(/[.;,]+$/u, '').slice(0, 200);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= MAX_OBJECTS) break;
  }
  return out;
}

// Основной объект заявки — коротко: адрес (с долей), участок, марка и год, первая строка перечня.
export function heirMain(serviceId, fields = {}) {
  const f = (k) => oneLine(fields[k]);
  if (serviceId === 'realty') {
    const share = f('share_size');
    return [share ? `доля ${share}` : null, f('address') || f('cadastral')].filter(Boolean).join(', ') || 'объект из заявки';
  }
  if (serviceId === 'land') return `земельный участок${f('address') || f('cadastral') ? `, ${f('address') || f('cadastral')}` : ''}`;
  if (serviceId === 'vehicle') return [f('make_model'), f('year')].filter(Boolean).join(', ') || 'транспортное средство из заявки';
  if (serviceId === 'movable') return oneLine(String(fields.items ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '') || 'имущество из заявки';
  return 'объект из заявки';
}

// { main, others, total } — только цель «наследство», услуга оценки и хотя бы один другой объект; иначе null.
export function heirSet(serviceId, fields = {}) {
  if (!SERVICES.includes(serviceId) || fields.purpose !== 'inheritance') return null;
  const others = heirObjects(fields);
  if (!others.length) return null;
  return { main: heirMain(serviceId, fields), others, total: fields.heir_total === 'total' };
}

export function heirLine(serviceId, fields = {}) {
  const h = heirSet(serviceId, fields);
  if (!h) return null;
  const list = [h.main, ...h.others].map((t, i) => `${i + 1}) ${t}`).join('; ');
  return `${HEIR_HEAD} ${list}. Рыночная стоимость определяется по каждому объекту отдельно${h.total ? ' и общая — сумма стоимостей всех объектов' : ''}.`;
}

// «2 объекта», «5 объектов», «21 объект» (прогон 2.509: было «21 объектов»).
const objWord = (n) => { const a = n % 100; const b = n % 10; return a >= 11 && a <= 14 ? 'объектов' : b === 1 ? 'объект' : b >= 2 && b <= 4 ? 'объекта' : 'объектов'; };

export function heirNotices(serviceId, fields = {}) {
  const h = heirSet(serviceId, fields);
  if (!h) return [];
  const n = h.others.length + 1;
  return [{ id: 'inheritance_objects',
    text: `В составе наследства ${n} ${objWord(n)}: ${[h.main, ...h.others].join('; ')}. В отчёте — стоимость каждого${h.total ? ' и общая стоимость всех' : ''}.` }];
}

// Строку — в раздел «Задание на оценку» (таблица задания): прежняя заменяется, иначе встаёт сразу под заголовком.
export function placeHeir(body, sections, line) {
  if (!line) return body;
  const lines = body.split('\n');
  const old = lines.findIndex((l) => l.startsWith(HEIR_HEAD));
  if (old >= 0) { lines[old] = line; return lines.join('\n'); }
  const s = sections.find((x) => x.table === 'task');
  if (!s) return body;
  const m = [...body.matchAll(/^#{1,3}\s*(.+)$/gm)].find((h) => headKey(h[1]) === headKey(s.title));
  if (!m) return body;
  const at = m.index + m[0].length;
  return `${body.slice(0, at)}\n${line}${body.slice(at)}`;
}

// 2.507: к делу оценки для наследства — «Справка для нотариуса» из отчёта (тем, кому виден результат дела).
export const heirNoteCase = (order) => order.module === 'expertise' && SERVICES.includes(order.service) && order.fields?.purpose === 'inheritance';
