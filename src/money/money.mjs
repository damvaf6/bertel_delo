// Деньги (задачи 1.6 и 1.6а): агентская схема ЮKassa. Заказчик платит платформе полную цену при заказе (после
// назначения цены, до предложения исполнителю); деньги лежат у платформы, пока результат не проверен. При выдаче
// результата («готово») платформа удерживает вознаграждение агента (20%, устав) и перечисляет остальное исполнителю.
// При отмене — возврат заказчику: до начала работ и по вине исполнителя — полный; при отказе заказчика после начала
// работ — за вычетом сделанной части, за которую платится исполнителю (решения Дамира 01.10.2026).
// Одна функция расчёта, одна выплата и один возврат на заявку (Б-16), смена состояния — в транзакции.
// Поставщик оплаты не трогается внутри транзакции базы: функции settle* возвращают id выплаты и возврата, а провести
// их (runPayout, runRefund) вызывающий должен после транзакции.
import { audit } from '../ops/util.mjs';
import { customersOf, dispatchers, notify } from '../notify/notify.mjs';
import { orderRef } from '../notify/registry.mjs';

export const COMMISSION_PERCENT = 20;

// Заявка ещё не в работе: отмена — полный возврат.
export const BEFORE_WORK = ['new', 'matching', 'awaiting_executor'];

// Цена → вознаграждение платформы и выплата исполнителю, в копейках. Округление вознаграждения — до копейки.
export function splitAmount(priceKop) {
  const commissionKop = Math.round((priceKop * COMMISSION_PERCENT) / 100);
  return { priceKop, commissionKop, payoutKop: priceKop - commissionKop };
}

// Отмена оплаченной заявки: сколько оплачено за сделанную работу (из неё — 80/20) и сколько вернуть заказчику.
export function cancelSplit(paidKop, percent) {
  const workKop = Math.round((paidKop * percent) / 100);
  return { workKop, refundKop: paidKop - workKop };
}

export const rub = (kop) => `${Math.floor(kop / 100).toLocaleString('ru-RU')},${String(kop % 100).padStart(2, '0')} ₽`;

const paidPayment = (tx, orderId) => tx.one`select * from payments where order_id = ${orderId} and status = 'succeeded'`;

// Платёж по данным поставщика: «оплачен» — отметка в заявке, уведомления заказчику и диспетчерам; «отменён» — можно
// платить заново. Если заявку отменили, пока платёж шёл, — сразу полный возврат. Повторный вызов ничего не меняет.
// Возвращает { refundId } — возврат, который надо провести после транзакции.
export async function applyPaymentStatus(sql, { paymentId, status, test }) {
  if (!['succeeded', 'canceled'].includes(status)) return {};
  return sql.tx(async (tx) => {
    const p0 = await tx.one`select order_id from payments where id = ${paymentId}`;
    if (!p0) return {};
    // Сначала заявка, потом платёж — тот же порядок блокировок, что при создании платежа.
    const order = await tx.one`select * from orders where id = ${p0.order_id} for update`;
    const p = await tx.one`select * from payments where id = ${paymentId} for update`;
    if (p.status !== 'pending') return {};
    if (status === 'canceled') {
      await tx`update payments set status = 'canceled', updated_at = now() where id = ${p.id}`;
      await audit(tx, null, 'payment.canceled', 'order', order.id, { payment: p.id });
      return {};
    }
    await tx`update payments set status = 'succeeded', paid_at = now(), updated_at = now() where id = ${p.id}`;
    await audit(tx, null, 'payment.succeeded', 'order', order.id, { payment: p.id, amount_kop: String(p.amount_kop) });
    if (order.status === 'cancelled') {
      const refundId = await makeRefund(tx, order, { ...p, status: 'succeeded' }, Number(p.amount_kop), 'Заявка отменена до поступления оплаты', test);
      return { refundId };
    }
    await tx`update orders set paid_at = now(), updated_at = now() where id = ${order.id}`;
    await notify(tx, 'paid', { users: await customersOf(tx, order), orderId: order.id });
    await notify(tx, 'paid_staff', { users: await dispatchers(tx), orderId: order.id });
    return {};
  });
}

// Результат проверен и выдан («готово»): выплата исполнителю 80% оплаты, акт заказчику, отчёт агента исполнителю.
// Вызывается в транзакции шага статуса; order — заявка до шага (с исполнителем). Возвращает id выплаты.
export async function settleDone(tx, order, { test }) {
  const p = await paidPayment(tx, order.id);
  if (!p || !order.executor_user_id) return null;
  const split = splitAmount(Number(p.amount_kop));
  await makeClosingDocs(tx, order, split, { test });
  return makePayout(tx, order, split);
}

// Отмена оплаченной заявки (в транзакции шага статуса). До начала работ и по вине исполнителя — полный возврат;
// отказ заказчика после начала работ — исполнителю за сделанную долю (80% её стоимости), остаток — заказчику.
// Возвращает { payoutId, refundId }.
export async function settleCancel(tx, order, { fault, percent, reason, test }) {
  const p = await paidPayment(tx, order.id);
  if (!p) return {};
  const paid = Number(p.amount_kop);
  const share = !BEFORE_WORK.includes(order.status) && fault === 'customer' ? percent : 0;
  const { workKop, refundKop } = cancelSplit(paid, share);
  let payoutId = null;
  if (workKop > 0 && order.executor_user_id) {
    const split = splitAmount(workKop);
    await makeClosingDocs(tx, order, split, { test, partial: { percent: share, paid_kop: paid } });
    payoutId = await makePayout(tx, order, split);
  }
  const refundId = refundKop > 0 ? await makeRefund(tx, order, p, refundKop, reason, test) : null;
  return { payoutId, refundId };
}

async function makePayout(tx, order, split) {
  const payout = await tx.one`
    insert into payouts (order_id, executor_user_id, amount_kop, commission_kop)
    values (${order.id}, ${order.executor_user_id}, ${split.payoutKop}, ${split.commissionKop})
    on conflict (order_id) do nothing returning id`;
  return payout?.id ?? null;
}

async function makeRefund(tx, order, payment, amountKop, reason, test) {
  const r = await tx.one`
    insert into refunds (order_id, payment_id, amount_kop, reason) values (${order.id}, ${payment.id}, ${amountKop}, ${reason})
    on conflict (order_id) do nothing returning id`;
  if (!r) return null;
  await audit(tx, null, 'refund.create', 'order', order.id, { refund: r.id, amount_kop: String(amountKop) });
  await tx`insert into closing_documents (order_id, kind, data) values (${order.id}, 'refund', ${JSON.stringify({
    ...docBase(order, { test }), paid_kop: Number(payment.amount_kop), refund_kop: amountKop, reason: reason ?? null,
  })}) on conflict (order_id, kind) do nothing`;
  return r.id;
}

// Провести через поставщика выплату или возврат. Повтор — только у неудавшейся; успешную второй раз не провести.
// Таблицы payouts и refunds устроены одинаково; запросы — отдельные (имя таблицы параметром не передать).
const Q = {
  payout: {
    claim: (tx, id) => tx.one`select * from payouts where id = ${id} for update`,
    start: (tx, id) => tx.one`update payouts set attempts = attempts + 1, status = 'pending', failure = null, updated_at = now()
                             where id = ${id} returning *`,
    finish: (tx, id, st, pid, failure, at) => tx.one`
      update payouts set status = ${st}, provider_id = ${pid}, failure = ${failure}, paid_at = ${at}, updated_at = now()
      where id = ${id} returning *`,
  },
  refund: {
    claim: (tx, id) => tx.one`select * from refunds where id = ${id} for update`,
    start: (tx, id) => tx.one`update refunds set attempts = attempts + 1, status = 'pending', failure = null, updated_at = now()
                             where id = ${id} returning *`,
    finish: (tx, id, st, pid, failure, at) => tx.one`
      update refunds set status = ${st}, provider_id = ${pid}, failure = ${failure}, refunded_at = ${at}, updated_at = now()
      where id = ${id} returning *`,
  },
};

async function runTransfer(sql, providers, kind, id) {
  const q = Q[kind];
  const row0 = await sql.tx(async (tx) => {
    const row = await q.claim(tx, id);
    if (!row || row.status === 'succeeded') return null;
    return q.start(tx, id);
  });
  if (!row0) return null;
  let result;
  try {
    if (kind === 'payout') {
      result = await providers.payments.createPayout({
        idempotenceKey: `${row0.id}:${row0.attempts}`, executorId: row0.executor_user_id, amountKop: Number(row0.amount_kop),
        description: `Выплата исполнителю по заявке ${shortRef(row0.order_id)}`,
      });
    } else {
      const pay = await sql.one`select provider_id from payments where id = ${row0.payment_id}`;
      result = await providers.payments.createRefund({
        idempotenceKey: `${row0.id}:${row0.attempts}`, paymentId: pay?.provider_id ?? null, amountKop: Number(row0.amount_kop),
        description: `Возврат по заявке ${shortRef(row0.order_id)}`,
      });
    }
  } catch (e) {
    result = { status: 'failed', failure: String(e?.message || 'отказ поставщика').slice(0, 500) };
  }
  const ok = result.status === 'succeeded';
  return sql.tx(async (tx) => {
    const row = await q.finish(tx, row0.id, ok ? 'succeeded' : 'failed', result.id ?? null,
      ok ? null : result.failure || 'перевод не прошёл', ok ? new Date() : null);
    if (kind === 'payout') {
      await notify(tx, ok ? 'payout_succeeded' : 'payout_failed', { users: [row0.executor_user_id], orderId: row0.order_id });
      if (!ok) await notify(tx, 'payout_failed_staff', { users: await dispatchers(tx), orderId: row0.order_id });
    } else {
      const order = await tx.one`select * from orders where id = ${row0.order_id}`;
      await notify(tx, ok ? 'refund_succeeded' : 'refund_failed', { users: await customersOf(tx, order), orderId: row0.order_id });
      if (!ok) await notify(tx, 'refund_failed_staff', { users: await dispatchers(tx), orderId: row0.order_id });
    }
    return row;
  });
}

export const runPayout = (sql, providers, payoutId) => runTransfer(sql, providers, 'payout', payoutId);
export const runRefund = (sql, providers, refundId) => runTransfer(sql, providers, 'refund', refundId);

// После транзакции: провести выплату и возврат, если они появились.
export async function runSettlement(sql, providers, { payoutId, refundId } = {}) {
  if (payoutId) await runPayout(sql, providers, payoutId);
  if (refundId) await runRefund(sql, providers, refundId);
}

export const shortRef = orderRef;

const PLATFORM = 'Платформа «БЕРТЕЛ Дело» (агент)';

const docBase = (order, { test }) => ({
  order_ref: shortRef(order.id), order_title: order.title, module: order.module, service: order.service,
  platform: PLATFORM, commission_percent: COMMISSION_PERCENT, test: !!test,
});

// Акт заказчику и отчёт агента исполнителю. Содержимое — снимок на момент выдачи результата (или отмены с частичной
// оплатой — partial); имя заказчика исполнителю не попадает.
async function makeClosingDocs(tx, order, split, { test, partial = null }) {
  const who = await tx.one`
    select u.full_name, o.name as org_name from users u left join organizations o on o.id = ${order.org_id}
    where u.id = ${order.owner_user_id}`;
  const base = {
    ...docBase(order, { test }), price_kop: split.priceKop, commission_kop: split.commissionKop, payout_kop: split.payoutKop,
    ...(partial ? { partial_percent: partial.percent, paid_kop: partial.paid_kop } : {}),
  };
  const customer = who?.org_name ? `Организация «${who.org_name}»` : who?.full_name || 'Заказчик';
  await tx`insert into closing_documents (order_id, kind, data) values (${order.id}, 'act', ${JSON.stringify({ ...base, customer })})
           on conflict (order_id, kind) do nothing`;
  await tx`insert into closing_documents (order_id, kind, data) values (${order.id}, 'agent_report', ${JSON.stringify(base)})
           on conflict (order_id, kind) do nothing`;
}
