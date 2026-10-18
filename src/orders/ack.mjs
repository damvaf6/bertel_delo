// Ответ заказчику сразу после отправки заявки (задача штаба 3fd17197): «Заявка № … принята. Цену назначит диспетчер — как
// правило, в течение N часов. Если понадобится больше времени — сообщим». N — настройка администратора по модулю (module_settings, module
// 'order_ack'; история — кто, когда, что), без правки кода. Пусто у модуля — ответа со сроком нет. Решение Дамира 18.10.2026:
// коротких жёстких сроков не обещать, пока не видно, как работает на деле, — пока администратор ничего не задавал, действуют
// осторожные ACK_DEFAULT (3 суток / 2 суток), а строка заказчику — «как правило», без точного часа. Как на деле — ackFacts.
// Обещанное время — снимок в заявке при отправке (orders.ack_due_at): правка настройки не сдвигает
// уже данное обещание. Первое действие по заявке — назначенная цена или любой шаг статуса после подбора (отмена тоже).
// Не успели — один раз заказчику «задерживаемся» и диспетчерам (remindAck, раз в минуту вместе с напоминаниями о сроках).
import { orderRef } from '../notify/registry.mjs';
import { customersOf, dispatchers, notify } from '../notify/notify.mjs';

export const ACK_SETTINGS = 'order_ack';
export const ACK_MAX_HOURS = 168;
export const ACK_DEFAULT = { expertise: 72, translation: 48 };
export const ACK_FACT_DAYS = 90;

// «в течение 1 часа / 21 часа / 24 часов / 3 суток» — родительный падеж после «в течение»; от 2 целых суток — сутками.
const hoursRu = (n) => (n >= 48 && n % 24 === 0 ? `${n / 24} суток` : `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'часа' : 'часов'}`);

// Действующие часы по модулям: { expertise: 72, translation: null }; администратор ещё не задавал — ACK_DEFAULT.
export async function ackHours(sql) {
  const row = await sql.one`select settings from module_settings where module = ${ACK_SETTINGS} order by id desc limit 1`;
  return row?.settings?.hours ?? ACK_DEFAULT;
}

// Как на деле за ACK_FACT_DAYS дней: от отправки до назначенной цены (первая отметка order.price в журнале) по модулю —
// сколько заявок, обычно (медиана) и дольше всего, в часах. Чтобы срок потом уточнить по факту (решение Дамира 18.10.2026).
export async function ackFacts(sql, registry, { now = new Date() } = {}) {
  const rows = await sql`select o.module, count(*)::int as n,
      percentile_cont(0.5) within group (order by extract(epoch from p.at - o.submitted_at)) as median_s,
      max(extract(epoch from p.at - o.submitted_at)) as max_s
    from orders o
    join lateral (select min(a.at) as at from audit_log a
                  where a.subject_type = 'order' and a.subject_id = o.id::text and a.action = 'order.price') p on p.at is not null
    where o.submitted_at >= ${now}::timestamptz - make_interval(days => ${ACK_FACT_DAYS}) and p.at >= o.submitted_at
    group by o.module`;
  const by = new Map(rows.map((r) => [r.module, r]));
  const h = (s) => Math.round((Number(s) / 3600) * 10) / 10;
  return registry.catalog().map((m) => {
    const r = by.get(m.id);
    return { id: m.id, name: m.name, orders: r?.n ?? 0, median_hours: r ? h(r.median_s) : null, max_hours: r ? h(r.max_s) : null };
  });
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
    fact_days: ACK_FACT_DAYS,
    modules: registry.catalog().map((m) => ({ id: m.id, name: m.name, hours: hours[m.id] ?? null })),
    facts: await ackFacts(sql, registry),
    history: rows.map((r) => ({ id: String(r.id), at: r.changed_at, by: r.full_name || r.phone || null, hours: r.settings.hours })),
  };
}

export async function saveAckHours(tx, registry, actorId, raw) {
  const next = cleanAckHours(registry, raw);
  await tx`select pg_advisory_xact_lock(hashtext(${`module_settings:${ACK_SETTINGS}`}))`;
  const prev = (await tx.one`select settings from module_settings where module = ${ACK_SETTINGS} order by id desc limit 1`)?.settings?.hours ?? ACK_DEFAULT;
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
    text: `Заявка ${orderRef(order.id)} принята. Цену назначит диспетчер — как правило, в течение ${hoursRu(hours)}. `
      + 'Если понадобится больше времени — сообщим.',
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
