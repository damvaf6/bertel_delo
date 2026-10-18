// Ответ заказчику сразу после отправки заявки (задача штаба 3fd17197): «Заявка № … принята. Обычно диспетчер назначает
// цену в течение N ч. Если не успеем — сообщим». N — настройка администратора по модулю (module_settings, module
// 'order_ack'; история — кто, когда, что), без правки кода. Нет числа у модуля — ответа со сроком нет (до решения Дамира
// все выключены). Обещанное время — снимок в заявке при отправке (orders.ack_due_at): правка настройки не сдвигает
// уже данное обещание. Первое действие по заявке — назначенная цена или любой шаг статуса после подбора (отмена тоже).
// Не успели — один раз заказчику «задерживаемся» и диспетчерам (remindAck, раз в минуту вместе с напоминаниями о сроках).
import { orderRef } from '../notify/registry.mjs';
import { customersOf, dispatchers, notify } from '../notify/notify.mjs';

export const ACK_SETTINGS = 'order_ack';
export const ACK_MAX_HOURS = 168;

// «в течение 1 часа / 21 часа / 24 часов» — родительный падеж после «в течение».
const hoursRu = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'часа' : 'часов'}`;
const mskWhen = (t) => new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
}).format(new Date(t)).replace(',', ' в');

// Действующие часы по модулям: { expertise: 24, translation: null }; нет строки — все выключены.
export async function ackHours(sql) {
  const row = await sql.one`select settings from module_settings where module = ${ACK_SETTINGS} order by id desc limit 1`;
  return row?.settings?.hours ?? {};
}

// Проверка значений от администратора: по каждому модулю — целое от 1 до ACK_MAX_HOURS или пусто (выключено).
export function cleanAckHours(registry, raw) {
  const out = {};
  for (const m of registry.catalog()) {
    const v = raw?.[m.id];
    if (v === null || v === undefined || v === '') { out[m.id] = null; continue; }
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > ACK_MAX_HOURS) {
      const e = new Error(`«${m.name}»: срок — целое число часов от 1 до ${ACK_MAX_HOURS} или пусто`);
      e.settings = true;
      throw e;
    }
    out[m.id] = n;
  }
  return out;
}

// Для кабинета администратора: модули с часами и история изменений.
export async function ackView(sql, registry) {
  const hours = await ackHours(sql);
  const rows = await sql`select s.id, s.settings, s.changed_at, u.full_name, u.phone
    from module_settings s left join users u on u.id = s.changed_by
    where s.module = ${ACK_SETTINGS} order by s.id desc limit 20`;
  return {
    max_hours: ACK_MAX_HOURS,
    modules: registry.catalog().map((m) => ({ id: m.id, name: m.name, hours: hours[m.id] ?? null })),
    history: rows.map((r) => ({ id: String(r.id), at: r.changed_at, by: r.full_name || r.phone || null, hours: r.settings.hours })),
  };
}

export async function saveAckHours(tx, registry, actorId, raw) {
  const next = cleanAckHours(registry, raw);
  await tx`select pg_advisory_xact_lock(hashtext(${`module_settings:${ACK_SETTINGS}`}))`;
  const prev = (await tx.one`select settings from module_settings where module = ${ACK_SETTINGS} order by id desc limit 1`)?.settings?.hours ?? {};
  const changed = Object.keys(next).filter((k) => (prev[k] ?? null) !== next[k]);
  if (changed.length) {
    await tx`insert into module_settings (module, settings, changed_by) values (${ACK_SETTINGS}, ${JSON.stringify({ hours: next })}, ${actorId})`;
  }
  return changed;
}

// Заявка только что отправлена (из «новой» в подбор): обещанное время, если у модуля срок включён. Только один раз.
export async function startAck(tx, order) {
  const n = (await ackHours(tx))[order.module];
  if (!n) return null;
  const r = await tx.one`update orders set ack_due_at = coalesce(submitted_at, now()) + make_interval(hours => ${n})
                         where id = ${order.id} and ack_due_at is null returning ack_due_at`;
  return r?.ack_due_at ?? null;
}

// Первое действие по заявке уже было: цена назначена или заявка ушла из подбора.
const answered = (o) => o.price_kop != null || o.status !== 'matching';

// Строка для заказчика (страница заявки, письмо): пока ответа нет. null — обещания нет или ответ уже был.
export function ackLine(order) {
  if (!order.ack_due_at || answered(order)) return null;
  const hours = Math.max(1, Math.round((new Date(order.ack_due_at) - new Date(order.submitted_at)) / 3_600_000));
  if (order.ack_late_at) {
    return { late: true, text: `Заявка ${orderRef(order.id)}: задерживаемся с ценой — диспетчер уже видит заявку, ответим в ближайшее время.` };
  }
  return {
    late: false,
    due_at: order.ack_due_at,
    text: `Заявка ${orderRef(order.id)} принята. Обычно диспетчер назначает цену в течение ${hoursRu(hours)} — `
      + `до ${mskWhen(order.ack_due_at)} МСК. Если не успеем — сообщим.`,
  };
}

// Обещанное время прошло, а ответа нет: заказчику «задерживаемся», диспетчерам — сигнал. Один раз на заявку.
export async function remindAck(sql, { now = new Date() } = {}) {
  const due = await sql`select id from orders where ack_due_at <= ${now} and ack_late_at is null
                          and status = 'matching' and price_kop is null`;
  let sent = 0;
  for (const { id } of due) {
    sent += await sql.tx(async (tx) => {
      const o = await tx.one`update orders set ack_late_at = now() where id = ${id} and ack_late_at is null
                               and status = 'matching' and price_kop is null returning *`;
      if (!o) return 0;
      return (await notify(tx, 'ack_late', { users: await customersOf(tx, o), orderId: o.id }))
        + (await notify(tx, 'ack_late_staff', { users: await dispatchers(tx), orderId: o.id }));
    });
  }
  return sent;
}
