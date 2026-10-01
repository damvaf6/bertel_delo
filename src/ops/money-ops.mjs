// Деньги по заявке (задача 1.6): цена (назначает диспетчер в подборе), оплата заказчиком после проверки результата,
// автоматическая выплата исполнителю после оплаты, закрывающие документы, сводка «Деньги» для служебных.
// Агентская схема ЮKassa, вознаграждение платформы 20% — src/money/money.mjs. Пока поставщик оплаты поддельный.
import { HttpError } from '../http/core.mjs';
import { moneyView, orderSides } from '../access/policy.mjs';
import { ProviderError } from '../providers/fake.mjs';
import { applyPaymentStatus, runPayout, shortRef, splitAmount } from '../money/money.mjs';
import { audit } from './util.mjs';

const PRICE_RE = /^\d{1,8}([.,]\d{1,2})?$/;
const num = (v) => (v == null ? null : Number(v));

// Цена в рублях («15000», «15000,50») → копейки; от 1 рубля до 10 000 000.
function priceFrom(value) {
  const v = String(value ?? '').trim().replace(/\s/g, '');
  if (!PRICE_RE.test(v)) throw new HttpError(400, 'bad_price', 'Цена: число рублей, копейки — через запятую');
  const [r, k = ''] = v.split(/[.,]/);
  const kop = Number(r) * 100 + Number(k.padEnd(2, '0'));
  if (kop < 100 || kop > 1_000_000_000) throw new HttpError(400, 'bad_price', 'Цена: от 1 до 10 000 000 рублей');
  return kop;
}

const payView = (p) => p && ({ id: p.id, status: p.status, amount_kop: num(p.amount_kop), created_at: p.created_at, paid_at: p.paid_at });
const payoutView = (p) => p && ({
  status: p.status, amount_kop: num(p.amount_kop), commission_kop: num(p.commission_kop), failure: p.failure,
  attempts: p.attempts, paid_at: p.paid_at, created_at: p.created_at,
});
const docView = (d) => ({ id: d.id, kind: d.kind, number: `${d.kind === 'act' ? 'А' : 'О'}-${String(d.number).padStart(6, '0')}`, created_at: d.created_at, data: d.data });

// Проверить у поставщика незавершённый платёж и применить исход; после оплаты — провести выплату исполнителю.
async function syncPayment(sql, providers, cfg, payment) {
  if (!payment?.provider_id || payment.status !== 'pending') return;
  let remote;
  try {
    remote = await providers.payments.getPayment({ id: payment.provider_id });
  } catch (e) {
    if (e instanceof ProviderError) throw new HttpError(502, 'provider', 'Не удалось узнать состояние оплаты, попробуйте позже');
    throw e;
  }
  const payoutId = await applyPaymentStatus(sql, { paymentId: payment.id, status: remote.status, test: cfg.providers.payments === 'fake' });
  if (payoutId) await runPayout(sql, providers, payoutId);
}

export function moneyOps() {
  // Деньги по заявке глазами вошедшего: заказчик — цена, оплата, акт; исполнитель — своё вознаграждение, выплата,
  // отчёт агента; служебные — всё (правила — policy.mjs, moneyView).
  async function view(sql, actor, orderId) {
    const order = await sql.one`select * from orders where id = ${orderId}`;
    const see = moneyView(actor, order);
    const sides = orderSides(actor, order);
    const price = num(order.price_kop);
    const split = price ? splitAmount(price) : null;
    const out = {
      sees: { customer: see.customer, executor: see.executor, staff: see.staff },
      price_kop: see.customer ? price : null,
      paid: !!order.paid_at,
      paid_at: order.paid_at,
      can_set_price: sides.includes('dispatcher') && order.status === 'matching',
      can_pay: sides.includes('customer') && order.status === 'done' && !!price && !order.paid_at,
      payment: null,
      fee_kop: see.executor && split ? split.payoutKop : null,
      commission_kop: see.staff && split ? split.commissionKop : null,
      payout: null,
      can_retry_payout: false,
      documents: [],
    };
    if (see.customer) {
      out.payment = payView(await sql.one`select * from payments where order_id = ${order.id} order by created_at desc limit 1`);
    }
    if (see.executor) {
      const p = await sql.one`select * from payouts where order_id = ${order.id}`;
      out.payout = payoutView(p);
      out.can_retry_payout = !!p && p.status === 'failed' && sides.includes('dispatcher');
    }
    const kinds = [...(see.customer ? ['act'] : []), ...(see.executor ? ['agent_report'] : [])];
    if (kinds.length) {
      const docs = await sql`select * from closing_documents where order_id = ${order.id} and kind = any(${kinds}) order by number`;
      out.documents = docs.map(docView);
    }
    return out;
  }

  return [
    {
      id: 'orders.money', method: 'GET', path: '/api/orders/:id/money', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order }) { return { money: await view(sql, actor, order.id) }; },
    },
    {
      // Цену назначает диспетчер, пока заявка в подборе: исполнитель соглашается уже на известное вознаграждение.
      id: 'orders.price', method: 'PUT', path: '/api/orders/:id/price', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, body }) {
        if (!orderSides(actor, order).includes('dispatcher')) throw new HttpError(403, 'forbidden', 'Недостаточно прав');
        const kop = priceFrom(body?.price);
        await sql.tx(async (tx) => {
          const cur = await tx.one`select status from orders where id = ${order.id} for update`;
          if (cur.status !== 'matching') throw new HttpError(409, 'price_locked', 'Цену можно менять только в подборе, до предложения исполнителю');
          await tx`update orders set price_kop = ${kop}, updated_at = now() where id = ${order.id}`;
          await audit(tx, actor, 'order.price', 'order', order.id, { price_kop: kop });
        });
        return { money: await view(sql, actor, order.id) };
      },
    },
    {
      // Оплата заказчиком — после проверки результата («готово»). Незавершённый платёж не создаётся второй раз.
      id: 'payments.create', method: 'POST', path: '/api/orders/:id/payments', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'write' },
      async handler({ sql, actor, order, cfg, providers, registry, res }) {
        if (!orderSides(actor, order).includes('customer')) throw new HttpError(403, 'forbidden', 'Недостаточно прав');
        const created = await sql.tx(async (tx) => {
          const cur = await tx.one`select * from orders where id = ${order.id} for update`;
          if (cur.paid_at) throw new HttpError(409, 'already_paid', 'Заявка уже оплачена');
          if (cur.status !== 'done') throw new HttpError(409, 'not_payable', 'Оплатить можно, когда результат проверен');
          if (!cur.price_kop) throw new HttpError(409, 'no_price', 'Цена ещё не назначена');
          const open = await tx.one`select * from payments where order_id = ${cur.id} and status = 'pending'`;
          if (open) return { payment: open, fresh: false, order: cur };
          const p = await tx.one`insert into payments (order_id, amount_kop, created_by) values (${cur.id}, ${cur.price_kop}, ${actor.id}) returning *`;
          await audit(tx, actor, 'payment.create', 'order', cur.id, { payment: p.id, amount_kop: String(p.amount_kop) });
          return { payment: p, fresh: true, order: cur };
        });
        let payment = created.payment;
        if (created.fresh || !payment.confirmation_url) {
          const def = registry.service(created.order.module, created.order.service);
          const description = `${def?.service.name ?? 'Услуга'}, заявка ${shortRef(order.id)}`.slice(0, 128);
          try {
            const r = await providers.payments.createPayment({
              idempotenceKey: payment.id, orderId: order.id, amountKop: Number(payment.amount_kop), description,
              returnUrl: `${cfg.publicUrl}/kabinet.html#order=${order.id}`,
              // Чек (54-ФЗ) формирует ЮKassa: одна позиция — услуга по агентской схеме.
              receipt: { items: [{ description, amountKop: Number(payment.amount_kop), agent: true }] },
            });
            payment = await sql.one`update payments set provider_id = ${r.id}, confirmation_url = ${r.confirmationUrl}, updated_at = now()
                                    where id = ${payment.id} returning *`;
          } catch (e) {
            if (!(e instanceof ProviderError)) throw e;
            await sql`update payments set status = 'canceled', updated_at = now() where id = ${payment.id} and status = 'pending'`;
            throw new HttpError(502, 'provider', 'Оплата сейчас недоступна, попробуйте позже');
          }
        }
        if (created.fresh) res.status(201);
        return { confirmation_url: payment.confirmation_url, payment: payView(payment) };
      },
    },
    {
      // Заказчик вернулся со страницы оплаты: узнаём у поставщика, чем кончилось (данным из адреса не верим).
      id: 'payments.refresh', method: 'POST', path: '/api/orders/:id/payments/refresh', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, cfg, providers }) {
        const see = moneyView(actor, order);
        if (!see.customer) throw new HttpError(403, 'forbidden', 'Недостаточно прав');
        const p = await sql.one`select * from payments where order_id = ${order.id} and status = 'pending'`;
        await syncPayment(sql, providers, cfg, p);
        return { money: await view(sql, actor, order.id) };
      },
    },
    {
      id: 'payments.notify', method: 'POST', path: '/api/payments/notify', auth: 'public', csrf: false,
      publicReason: 'уведомление ЮKassa о платеже; содержимому не верим — состояние платежа запрашивается у поставщика',
      async handler({ sql, cfg, providers, body }) {
        const pid = String(body?.object?.id ?? '');
        if (!pid || pid.length > 100) return {};
        const p = await sql.one`select * from payments where provider_id = ${pid}`;
        await syncPayment(sql, providers, cfg, p);
        return {};
      },
    },
    {
      // Повтор неудавшейся выплаты исполнителю — диспетчер. Успешную выплату повторить нельзя.
      id: 'payouts.retry', method: 'POST', path: '/api/orders/:id/payout/retry', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler({ sql, actor, order, providers }) {
        if (!orderSides(actor, order).includes('dispatcher')) throw new HttpError(403, 'forbidden', 'Недостаточно прав');
        const p = await sql.one`select * from payouts where order_id = ${order.id}`;
        if (!p || p.status !== 'failed') throw new HttpError(409, 'payout_not_failed', 'Повторять нечего: выплата не числится неудавшейся');
        await audit(sql, actor, 'payout.retry', 'order', order.id, { payout: p.id });
        await runPayout(sql, providers, p.id);
        return { money: await view(sql, actor, order.id) };
      },
    },
    {
      // Сводка для диспетчера и администратора: получено / к выплате / выплачено / вознаграждение платформы.
      id: 'money.summary', method: 'GET', path: '/api/money', auth: 'user', access: { platform: 'staff' },
      async handler({ sql }) {
        const t = await sql.one`
          select (select coalesce(sum(amount_kop), 0) from payments where status = 'succeeded') as received,
                 (select coalesce(sum(amount_kop), 0) from payouts where status <> 'succeeded') as to_pay,
                 (select coalesce(sum(amount_kop), 0) from payouts where status = 'succeeded') as paid_out,
                 (select coalesce(sum(commission_kop), 0) from payouts) as commission`;
        const payments = await sql`
          select p.*, o.title from payments p join orders o on o.id = p.order_id
          where p.status = 'succeeded' order by p.paid_at desc limit 50`;
        const payouts = await sql`
          select p.*, o.title, u.full_name from payouts p join orders o on o.id = p.order_id join users u on u.id = p.executor_user_id
          order by p.created_at desc limit 50`;
        return {
          totals: { received_kop: num(t.received), to_pay_kop: num(t.to_pay), paid_out_kop: num(t.paid_out), commission_kop: num(t.commission) },
          payments: payments.map((p) => ({ ...payView(p), order_id: p.order_id, title: p.title })),
          payouts: payouts.map((p) => ({ ...payoutView(p), order_id: p.order_id, title: p.title, executor_name: p.full_name })),
        };
      },
    },
    {
      // Выплаты исполнителю — только свои.
      id: 'payouts.mine', method: 'GET', path: '/api/payouts', auth: 'user', access: 'self',
      async handler({ sql, actor }) {
        const rows = await sql`
          select p.*, o.title from payouts p join orders o on o.id = p.order_id
          where p.executor_user_id = ${actor.id} order by p.created_at desc limit 100`;
        const sum = (st) => rows.filter((r) => st(r.status)).reduce((a, r) => a + Number(r.amount_kop), 0);
        return {
          totals: { paid_out_kop: sum((s) => s === 'succeeded'), to_pay_kop: sum((s) => s !== 'succeeded') },
          payouts: rows.map((p) => ({ ...payoutView(p), order_id: p.order_id, title: p.title })),
        };
      },
    },
  ];
}
