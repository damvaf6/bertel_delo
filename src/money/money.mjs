// Деньги (задача 1.6): агентская схема ЮKassa. Заказчик платит платформе полную цену; платформа удерживает
// вознаграждение агента (20%, устав) и перечисляет остальное исполнителю. Одна функция расчёта, одна выплата на заявку
// (Б-16), смена состояния платежа — в транзакции. Поставщик оплаты не трогается внутри транзакции базы.
import { audit } from '../ops/util.mjs';
import { customersOf, dispatchers, notify } from '../notify/notify.mjs';
import { orderRef } from '../notify/registry.mjs';

export const COMMISSION_PERCENT = 20;

// Цена → вознаграждение платформы и выплата исполнителю, в копейках. Округление вознаграждения — до копейки.
export function splitAmount(priceKop) {
  const commissionKop = Math.round((priceKop * COMMISSION_PERCENT) / 100);
  return { priceKop, commissionKop, payoutKop: priceKop - commissionKop };
}

export const rub = (kop) => `${Math.floor(kop / 100).toLocaleString('ru-RU')},${String(kop % 100).padStart(2, '0')} ₽`;

// Платёж по данным поставщика: «оплачен» — отметка в заявке, закрывающие документы и выплата исполнителю;
// «отменён» — можно платить заново. Повторный вызов ничего не меняет. Возвращает id выплаты, которую надо провести.
export async function applyPaymentStatus(sql, { paymentId, status, test }) {
  if (!['succeeded', 'canceled'].includes(status)) return null;
  return sql.tx(async (tx) => {
    const p0 = await tx.one`select order_id from payments where id = ${paymentId}`;
    if (!p0) return null;
    // Сначала заявка, потом платёж — тот же порядок блокировок, что при создании платежа.
    const order = await tx.one`select * from orders where id = ${p0.order_id} for update`;
    const p = await tx.one`select * from payments where id = ${paymentId} for update`;
    if (p.status !== 'pending') return null;
    if (status === 'canceled') {
      await tx`update payments set status = 'canceled', updated_at = now() where id = ${p.id}`;
      await audit(tx, null, 'payment.canceled', 'order', order.id, { payment: p.id });
      return null;
    }
    await tx`update payments set status = 'succeeded', paid_at = now(), updated_at = now() where id = ${p.id}`;
    await tx`update orders set paid_at = now(), updated_at = now() where id = ${order.id}`;
    await audit(tx, null, 'payment.succeeded', 'order', order.id, { payment: p.id, amount_kop: String(p.amount_kop) });
    const split = splitAmount(Number(p.amount_kop));
    await makeClosingDocs(tx, order, split, test);
    await notify(tx, 'paid', { users: await customersOf(tx, order), orderId: order.id });
    if (!order.executor_user_id) return null;
    const payout = await tx.one`
      insert into payouts (order_id, executor_user_id, amount_kop, commission_kop)
      values (${order.id}, ${order.executor_user_id}, ${split.payoutKop}, ${split.commissionKop})
      on conflict (order_id) do nothing returning id`;
    return payout?.id ?? null;
  });
}

// Выплата исполнителю через поставщика. Повтор — только у неудавшейся; успешную второй раз не провести.
export async function runPayout(sql, providers, payoutId) {
  const p = await sql.tx(async (tx) => {
    const row = await tx.one`select * from payouts where id = ${payoutId} for update`;
    if (!row || row.status === 'succeeded') return null;
    return tx.one`update payouts set attempts = attempts + 1, status = 'pending', failure = null, updated_at = now()
                  where id = ${payoutId} returning *`;
  });
  if (!p) return null;
  let result;
  try {
    result = await providers.payments.createPayout({
      idempotenceKey: `${p.id}:${p.attempts}`, executorId: p.executor_user_id, amountKop: Number(p.amount_kop),
      description: `Выплата исполнителю по заявке ${shortRef(p.order_id)}`,
    });
  } catch (e) {
    result = { status: 'failed', failure: String(e?.message || 'отказ поставщика').slice(0, 500) };
  }
  const ok = result.status === 'succeeded';
  return sql.tx(async (tx) => {
    const row = await tx.one`
      update payouts set status = ${ok ? 'succeeded' : 'failed'}, provider_id = ${result.id ?? null},
             failure = ${ok ? null : result.failure || 'выплата не прошла'}, paid_at = ${ok ? new Date() : null}, updated_at = now()
      where id = ${p.id} returning *`;
    await notify(tx, ok ? 'payout_succeeded' : 'payout_failed', { users: [p.executor_user_id], orderId: p.order_id });
    if (!ok) await notify(tx, 'payout_failed_staff', { users: await dispatchers(tx), orderId: p.order_id });
    return row;
  });
}

export const shortRef = orderRef;

const PLATFORM = 'Платформа «БЕРТЕЛ Дело» (агент)';

// Акт заказчику и отчёт агента исполнителю. Содержимое — снимок на момент оплаты; имя заказчика исполнителю не попадает.
async function makeClosingDocs(tx, order, split, test) {
  const who = await tx.one`
    select u.full_name, o.name as org_name from users u left join organizations o on o.id = ${order.org_id}
    where u.id = ${order.owner_user_id}`;
  const base = {
    order_ref: shortRef(order.id), order_title: order.title, module: order.module, service: order.service,
    platform: PLATFORM, price_kop: split.priceKop, commission_kop: split.commissionKop, payout_kop: split.payoutKop,
    commission_percent: COMMISSION_PERCENT, test: !!test,
  };
  const customer = who?.org_name ? `Организация «${who.org_name}»` : who?.full_name || 'Заказчик';
  await tx`insert into closing_documents (order_id, kind, data) values (${order.id}, 'act', ${JSON.stringify({ ...base, customer })})
           on conflict (order_id, kind) do nothing`;
  if (order.executor_user_id) {
    await tx`insert into closing_documents (order_id, kind, data) values (${order.id}, 'agent_report', ${JSON.stringify(base)})
             on conflict (order_id, kind) do nothing`;
  }
}
