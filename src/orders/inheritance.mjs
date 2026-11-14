// Оценка для наследства (2.500): у нотариуса дата оценки — день открытия наследства (день смерти наследодателя, ст. 1114
// ГК), а не день осмотра или составления отчёта. Заказчик пишет эту дату в заявке («Если наследство — дата открытия
// наследства»); здесь — разбор даты, подсказка в деле всем, кто видит заявку, и дата оценки для таблицы задания черновика.
// Только даты: о праве на наследство и долях наследников не пишем — это дело нотариуса.
import { todayMsk } from './workflow.mjs';

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
  return [{ id: `inheritance_${h.state}`, text }];
}
