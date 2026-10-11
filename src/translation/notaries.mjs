// Нотариусы-партнёры (задача 2а.4, задача штаба 3f617197): справочник и «окна» — дни и часы, когда нотариус принимает
// переводчиков пачкой (подпись переводчика, ст. 80, 81 Основ о нотариате). Переводчику — ближайшие окна на две недели и
// список документов пачки: свои нотариальные заказы в работе. Удалённое заверение через ЕИС — не делаем.
import { HttpError } from '../http/core.mjs';
import { text } from '../ops/util.mjs';
import { addDays, todayMsk } from '../orders/workflow.mjs';
import { orderRef } from '../notify/registry.mjs';

export const NOTARY_PAYMENT = Object.freeze({ invoice: 'по счёту от платформы', on_site: 'на месте при подписании' });
export const WEEKDAYS = Object.freeze(['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс']);
export const WINDOWS_MAX = 7;
export const WINDOW_DAYS = 14;
const NOTARIAL = ['notary_paper', 'notary_file'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const bad = (msg) => new HttpError(400, 'bad_input', msg);

function windowsFrom(value) {
  if (!Array.isArray(value)) throw bad('Окна: список');
  if (value.length > WINDOWS_MAX) throw bad(`Окон — не больше ${WINDOWS_MAX}`);
  const out = value.map((w, i) => {
    const n = `Окно ${i + 1}`;
    if (!Number.isInteger(w?.weekday) || w.weekday < 1 || w.weekday > 7) throw bad(`${n}: день недели`);
    if (!TIME_RE.test(w.from ?? '') || !TIME_RE.test(w.to ?? '')) throw bad(`${n}: время в виде 10:00`);
    if (w.from >= w.to) throw bad(`${n}: начало раньше конца`);
    return { weekday: w.weekday, from: w.from, to: w.to };
  });
  return out.sort((a, b) => a.weekday - b.weekday || a.from.localeCompare(b.from));
}

// Карточка нотариуса из запроса администратора; partial — только переданные поля (правка).
export function notaryFrom(body, partial = false) {
  const b = body ?? {};
  const out = {};
  const has = (k) => !partial || b[k] !== undefined;
  if (has('full_name')) out.full_name = text(b.full_name, 'ФИО нотариуса', 200);
  if (has('address')) out.address = text(b.address, 'Адрес', 300);
  if (has('contacts')) {
    const c = String(b.contacts ?? '').trim();
    if (c.length > 300) throw bad('Поле «Контакты»: до 300 символов');
    out.contacts = c;
  }
  if (has('windows')) out.windows = windowsFrom(b.windows ?? []);
  if (has('file_for_identity')) {
    if (typeof (b.file_for_identity ?? false) !== 'boolean') throw bad('Поле «Электронный файл для паспортов»: да или нет');
    out.file_for_identity = b.file_for_identity ?? false;
  }
  if (has('payment')) {
    const p = b.payment ?? 'invoice';
    if (!NOTARY_PAYMENT[p]) throw bad('Поле «Оплата нотариусу»: недопустимое значение');
    out.payment = p;
  }
  if (partial && b.active !== undefined) {
    if (typeof b.active !== 'boolean') throw bad('Поле «Работаем с нотариусом»: да или нет');
    out.active = b.active;
  }
  return out;
}

export const windowText = (w) => `${WEEKDAYS[w.weekday - 1]} ${w.from}–${w.to}`;

export const notaryView = (n) => ({
  id: n.id, full_name: n.full_name, address: n.address, contacts: n.contacts, windows: n.windows,
  windows_text: n.windows.map(windowText).join(', '), file_for_identity: n.file_for_identity,
  payment: n.payment, payment_name: NOTARY_PAYMENT[n.payment], active: n.active,
});

// День недели 1–7 (пн–вс) для даты YYYY-MM-DD.
const isoWeekday = (iso) => ((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

// Окна работающих нотариусов с сегодняшнего дня на WINDOW_DAYS дней (по Москве), по порядку. Сегодняшнее окно, которое уже
// закончилось, не показывается.
export function upcomingWindows(notaries, today = todayMsk(), nowTime = mskTime()) {
  const out = [];
  for (let i = 0; i < WINDOW_DAYS; i += 1) {
    const date = addDays(today, i);
    const wd = isoWeekday(date);
    for (const n of notaries) {
      for (const w of n.windows) {
        if (w.weekday !== wd || (i === 0 && w.to <= nowTime)) continue;
        out.push({ date, weekday: WEEKDAYS[wd - 1], from: w.from, to: w.to,
          notary: { id: n.id, full_name: n.full_name, address: n.address, contacts: n.contacts, file_for_identity: n.file_for_identity } });
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.from.localeCompare(b.from) || a.notary.full_name.localeCompare(b.notary.full_name));
}

function mskTime(now = new Date()) {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
}

// Окна нотариусов и пачка переводчика: свои нотариальные заказы «Переводов» в работе — что нести нотариусу.
// translator — у человека есть допуск к нотариальному переводу или такие заказы; иначе блок в кабинете не показывается.
export async function notaryDesk(sql, userId, registry, today = todayMsk(), nowTime = mskTime()) {
  const orders = await sql`
    select o.id, o.title, o.service, o.fields, to_char(o.deadline, 'YYYY-MM-DD') as deadline
    from orders o
    where o.executor_user_id = ${userId} and o.module = 'translation' and o.service = any(${NOTARIAL}::text[]) and o.status = 'in_work'
    order by o.deadline nulls last, o.created_at`;
  const [permit] = await sql`
    select 1 from specialist_permits where user_id = ${userId} and module = 'translation' and service = any(${NOTARIAL}::text[])
      and (valid_until is null or valid_until >= ${today}::date) limit 1`;
  if (!permit && !orders.length) return { translator: false };
  const notaries = await sql`select * from notaries where active order by full_name`;
  const option = (fields, id, value) => fields.find((f) => f.id === id)?.options?.find((o) => o.id === value)?.name ?? null;
  const batch = orders.map((o) => {
    const s = registry.service('translation', o.service);
    const f = o.fields ?? {};
    const lang = option(s.fields, 'language', f.language);
    return {
      order_id: o.id, ref: orderRef(o.id), title: o.title, service: s.service.name, deadline: o.deadline,
      doc_kind: option(s.fields, 'doc_kind', f.doc_kind),
      language: lang && (f.direction === 'from_ru' ? `с русского на ${lang.toLowerCase()}` : `${lang.toLowerCase()} → русский`),
      docs: f.docs ?? null, pages: f.pages ?? null, urgent: f.urgent === 'yes',
      original: option(s.fields, 'original', f.original),
    };
  });
  return {
    translator: true,
    from: today, to: addDays(today, WINDOW_DAYS - 1),
    windows: upcomingWindows(notaries, today, nowTime),
    notaries: notaries.length,
    batch,
    totals: { orders: batch.length, docs: batch.reduce((s, b) => s + (b.docs ?? 0), 0) },
  };
}
