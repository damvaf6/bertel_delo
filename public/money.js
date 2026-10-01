// Деньги (задачи 1.6 и 1.6а): цена (диспетчер, в подборе), оплата заказчиком при заказе — до передачи исполнителю,
// выплата исполнителю (80%) при выдаче результата, возврат при отмене, закрывающие документы; раздел «Деньги» — сводка
// служебным и выплаты специалисту. Тексты — только через textContent.
import { api, el, say } from '/common.js';
import { state, show } from '/shell.js';

const $ = (id) => document.getElementById(id);
const dayRu = (s) => new Date(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const PAYMENT_RU = { pending: 'ждёт оплаты', succeeded: 'оплачено', canceled: 'оплата не прошла' };
const PAYOUT_RU = { pending: 'выплачивается', succeeded: 'выплачено', failed: 'выплата не прошла' };
const REFUND_RU = { pending: 'возвращается', succeeded: 'возвращено', failed: 'возврат не прошёл' };
const DOC_RU = { act: 'Акт', agent_report: 'Отчёт агента', refund: 'Возврат' };
let ctx = null; // { order, reload }

export function rub(kop) {
  const r = Math.floor(kop / 100).toLocaleString('ru-RU');
  const k = kop % 100;
  return k ? `${r},${String(k).padStart(2, '0')} ₽` : `${r} ₽`;
}

const fact = (dt, dd, cls) => [el('dt', { text: dt }), el('dd', { text: dd, ...(cls ? { class: cls } : {}) })];

export async function loadMoney(current, reload) {
  const { order } = current;
  ctx = { order, reload };
  say($('money-msg'), '');
  $('closing-doc').classList.add('hidden');
  const box = $('money-box');
  if (order.status === 'new') { box.classList.add('hidden'); return; }
  let { money } = await api('GET', `/api/orders/${order.id}/money`);
  // Вернулись со страницы оплаты (или оплата ещё в пути) — узнаём результат у платёжной системы.
  if (money.payment?.status === 'pending') {
    try {
      ({ money } = await api('POST', `/api/orders/${order.id}/payments/refresh`));
      if (money.paid) { await reload(); return; }
    } catch (err) { say($('money-msg'), err.message); }
  }
  const executorOnly = money.sees.executor && !money.sees.customer;
  if (order.status === 'cancelled' && !money.paid && !money.refund && !money.payout) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');

  const facts = [];
  if (money.sees.customer) {
    facts.push(...fact('Цена', money.price_kop ? rub(money.price_kop) : 'ещё не назначена — её назначит диспетчер при подборе исполнителя', money.price_kop ? 'money-sum' : undefined));
  }
  if (money.fee_kop !== null) facts.push(...fact(executorOnly ? 'Ваше вознаграждение (80% цены)' : 'Исполнителю (80%)', rub(money.fee_kop), executorOnly ? 'money-sum' : ''));
  if (money.commission_kop !== null) facts.push(...fact('Платформе (20%)', rub(money.commission_kop)));
  if (!executorOnly) {
    const pay = money.paid ? `оплачено ${dayRu(money.paid_at)}`
      : money.payment?.status === 'pending' ? PAYMENT_RU.pending
      : order.status === 'cancelled' ? 'не оплачено'
      : money.payment ? `${PAYMENT_RU[money.payment.status]} — можно оплатить снова`
      : money.price_kop ? 'нужна оплата: после неё заявку передадут исполнителю' : 'после назначения цены';
    facts.push(...fact('Оплата', pay));
    if (money.paid && !['done', 'closed', 'cancelled'].includes(order.status)) {
      facts.push(...fact('Деньги', money.sees.staff ? 'у платформы до выдачи результата заказчику'
        : 'хранятся у платформы и уйдут исполнителю, только когда результат проверен и выдан Вам'));
    }
  }
  if (money.cancel_fault) {
    facts.push(...fact('Отмена', money.cancel_fault === 'executor' ? 'по вине исполнителя' : `заказчик отказался, сделано ${money.done_percent}% работы`));
  }
  if (money.refund) {
    facts.push(...fact('Возврат заказчику', `${rub(money.refund.amount_kop)} — ${REFUND_RU[money.refund.status]}${money.refund.failure ? ` (${money.refund.failure})` : ''}`));
  }
  if (money.payout) facts.push(...fact(executorOnly ? 'Выплата' : 'Выплата исполнителю', `${rub(money.payout.amount_kop)} — ${PAYOUT_RU[money.payout.status]}${money.payout.failure ? ` (${money.payout.failure})` : ''}`));
  else if (executorOnly && order.status !== 'cancelled') facts.push(...fact('Выплата', 'автоматически, когда результат проверен и выдан заказчику'));
  $('money-facts').replaceChildren(...facts);

  $('price-form').classList.toggle('hidden', !money.can_set_price);
  if (money.can_set_price) $('price').value = money.price_kop ? String(money.price_kop / 100).replace('.', ',') : '';
  $('pay').classList.toggle('hidden', !money.can_pay);
  if (money.can_pay) $('pay').textContent = `Оплатить ${rub(money.price_kop)}`;
  $('payout-retry').classList.toggle('hidden', !money.can_retry_payout);
  $('refund-retry').classList.toggle('hidden', !money.can_retry_refund);

  $('closing-title').classList.toggle('hidden', money.documents.length === 0);
  $('closing').replaceChildren(...money.documents.map((d) => el('li', { class: 'doc' },
    el('div', {},
      el('div', { class: 'name', text: `${DOC_RU[d.kind]} № ${d.number}` }),
      el('div', { class: 'muted', text: dayRu(d.created_at) })),
    el('button', { class: 'secondary', 'data-action': 'open-doc', onclick: () => openDoc(d) }, 'Открыть'))));
}

// Закрывающий документ — текстом на странице (содержимое зафиксировано при выдаче результата или отмене).
function openDoc(d) {
  const x = d.data;
  const service = state.catalog.modules.find((m) => m.id === x.module)?.services.find((s) => s.id === x.service)?.name ?? 'Услуга';
  const p = (text, cls) => el('p', { text, ...(cls ? { class: cls } : {}) });
  const partial = x.partial_percent != null;
  const lines = d.kind === 'act'
    ? [
      p(`Акт об оказании услуг № ${d.number} от ${dayRu(d.created_at)}`, 'doc-title'),
      p(`Агент: ${x.platform}`),
      p(`Заказчик: ${x.customer}`),
      p(`Услуга: ${service}, заявка ${x.order_ref} («${x.order_title}»)`),
      p(`Стоимость: ${rub(x.price_kop)}, в том числе вознаграждение агента (${x.commission_percent}%): ${rub(x.commission_kop)}`),
      p(partial
        ? `Заказчик отказался от услуги после начала работ; оказана часть услуги (${x.partial_percent}%). Оплачено ${rub(x.paid_kop)}, остаток возвращается заказчику.`
        : 'Услуга оказана полностью, результат проверен и передан заказчику. Оплата получена.'),
    ]
    : d.kind === 'refund'
    ? [
      p(`Документ о возврате № ${d.number} от ${dayRu(d.created_at)}`, 'doc-title'),
      p(`Агент: ${x.platform}`),
      p(`Услуга: ${service}, заявка ${x.order_ref} («${x.order_title}»)`),
      p(`Оплачено заказчиком: ${rub(x.paid_kop)}`),
      p(`Возвращается заказчику: ${rub(x.refund_kop)}`),
      ...(x.reason ? [p(`Причина: ${x.reason}`)] : []),
    ]
    : [
      p(`Отчёт агента № ${d.number} от ${dayRu(d.created_at)}`, 'doc-title'),
      p(`Агент: ${x.platform}`),
      p(`Поручение: ${service}, заявка ${x.order_ref}`),
      p(`Получено от заказчика: ${rub(x.price_kop)}`),
      p(`Вознаграждение агента (${x.commission_percent}%): ${rub(x.commission_kop)}`),
      p(`К перечислению исполнителю: ${rub(x.payout_kop)}`),
      ...(partial ? [p(`Заказ отменён заказчиком после начала работ; оплачена сделанная часть (${x.partial_percent}%).`)] : []),
    ];
  if (x.test) lines.splice(1, 0, p('Проверочный документ: оплата тестовая, юридической силы не имеет.', 'doc-test'));
  $('closing-doc').replaceChildren(...lines);
  $('closing-doc').classList.remove('hidden');
  $('closing-doc').scrollIntoView({ block: 'nearest' });
}

$('price-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('price-save').disabled = true;
  try {
    await api('PUT', `/api/orders/${ctx.order.id}/price`, { price: $('price').value });
    await loadMoney({ order: ctx.order }, ctx.reload);
    say($('money-msg'), 'Цена назначена', 'ok');
  } catch (err) { say($('money-msg'), err.message); } finally { $('price-save').disabled = false; }
});

$('pay').addEventListener('click', async () => {
  $('pay').disabled = true;
  try {
    const { confirmation_url: url } = await api('POST', `/api/orders/${ctx.order.id}/payments`);
    const to = new URL(url, location.href);
    // Страница оплаты ЮKassa — переход; после оплаты она вернёт в эту же заявку.
    if (to.pathname !== location.pathname) { location.assign(to.href); return; }
    await loadMoney({ order: ctx.order }, ctx.reload);
  } catch (err) { say($('money-msg'), err.message); } finally { $('pay').disabled = false; }
});

$('refund-retry').addEventListener('click', async () => {
  $('refund-retry').disabled = true;
  try {
    await api('POST', `/api/orders/${ctx.order.id}/refund/retry`);
    await loadMoney({ order: ctx.order }, ctx.reload);
    say($('money-msg'), 'Возврат отправлен повторно', 'ok');
  } catch (err) { say($('money-msg'), err.message); } finally { $('refund-retry').disabled = false; }
});

$('payout-retry').addEventListener('click', async () => {
  $('payout-retry').disabled = true;
  try {
    await api('POST', `/api/orders/${ctx.order.id}/payout/retry`);
    await loadMoney({ order: ctx.order }, ctx.reload);
    say($('money-msg'), 'Выплата отправлена повторно', 'ok');
  } catch (err) { say($('money-msg'), err.message); } finally { $('payout-retry').disabled = false; }
});

// ——— Раздел «Деньги» ———

const openOrder = (id) => () => { location.hash = `order=${id}`; };

export async function showMoney() {
  const staff = ['dispatcher', 'admin'].includes(state.me.user.platform_role);
  show('money-view', 'money');
  $('money-payments-box').classList.toggle('hidden', !staff);
  if (staff) {
    const { totals, payments, payouts } = await api('GET', '/api/money');
    $('money-title').textContent = 'Деньги платформы';
    $('money-totals').replaceChildren(
      ...fact('Получено от заказчиков', rub(totals.received_kop), 'money-sum'),
      ...fact('Ждут выдачи результата', rub(totals.held_kop)),
      ...fact('К выплате исполнителям', rub(totals.to_pay_kop)),
      ...fact('Выплачено исполнителям', rub(totals.paid_out_kop)),
      ...fact('Возвращено заказчикам', rub(totals.refunded_kop)),
      ...(totals.to_refund_kop ? fact('К возврату заказчикам', rub(totals.to_refund_kop), 'overdue') : []),
      ...fact('Вознаграждение платформы (20%)', rub(totals.commission_kop)));
    $('money-payments').replaceChildren(...payments.map((p) => el('li', {},
      el('button', { class: 'open', onclick: openOrder(p.order_id) },
        el('div', { class: 'title', text: p.title }),
        el('div', { class: 'muted', text: `${rub(p.amount_kop)} · ${dayRu(p.paid_at)}` })))));
    $('money-payments-empty').classList.toggle('hidden', payments.length > 0);
    $('money-payouts-title').textContent = 'Выплаты исполнителям';
    renderPayouts(payouts, true);
  } else {
    const { totals, payouts } = await api('GET', '/api/payouts');
    $('money-title').textContent = 'Мои выплаты';
    $('money-totals').replaceChildren(
      ...fact('Выплачено', rub(totals.paid_out_kop), 'money-sum'),
      ...fact('Ожидает выплаты', rub(totals.to_pay_kop)));
    $('money-payouts-title').textContent = 'Выплаты по делам';
    renderPayouts(payouts, false);
  }
}

function renderPayouts(payouts, staff) {
  $('money-payouts').replaceChildren(...payouts.map((p) => el('li', {},
    el('button', { class: 'open', onclick: openOrder(p.order_id) },
      el('div', { class: 'title', text: p.title }),
      el('div', { class: `muted${p.status === 'failed' ? ' overdue' : ''}`, text: [rub(p.amount_kop), PAYOUT_RU[p.status], staff ? p.executor_name : null].filter(Boolean).join(' · ') })))));
  $('money-payouts-empty').classList.toggle('hidden', payouts.length > 0);
}
