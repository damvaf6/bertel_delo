// Оплата по счёту (2.464): заказчику — счёт и «Я оплатил(а)», диспетчеру — «Оплата поступила» и возврат вручную.
// Деньги (задачи 1.6 и 1.6а): цена (диспетчер, в подборе), оплата заказчиком при заказе — до передачи исполнителю,
// выплата исполнителю (80%) при выдаче результата, возврат при отмене, закрывающие документы; раздел «Деньги» — сводка
// служебным и выплаты специалисту. Тексты — только через textContent.
import { api, el, say } from '/common.js';
import { state, show } from '/shell.js';
import { setNext } from '/next.js';

const $ = (id) => document.getElementById(id);
const dayRu = (s) => new Date(s).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric' });
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
  // Перевод: цена по таблице цен (задача штаба 3f617197) — подставляется диспетчеру, пока цена не назначена.
  const quote = 'quote' in current ? current.quote : ctx?.order.id === order.id ? ctx.quote : null;
  ctx = { order, reload, quote };
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
  // Перевод (2а.2): тарифы нотариуса и доставка — транзитом, 80/20 — только от услуг.
  const ofServices = money.transit_kop ? ' от услуг' : '';
  if (money.transit_kop) facts.push(...fact('Нотариус и доставка', `${rub(money.transit_kop)} — по тарифам, без вознаграждения платформы`));
  // Экспертиза (2.463): эксперту — 100% его цены, платформе — 20% сверх неё.
  const onTop = money.fee_on_top;
  if (money.fee_kop !== null) {
    facts.push(...fact(onTop ? (executorOnly ? 'Ваша цена (100%)' : 'Эксперту (его цена, 100%)')
      : executorOnly ? `Ваше вознаграждение (80% ${ofServices ? 'от услуг' : 'цены'})` : `Исполнителю (80%${ofServices})`, rub(money.fee_kop), executorOnly ? 'money-sum' : ''));
  }
  if (money.commission_kop !== null) facts.push(...fact(onTop ? 'Платформе (20% сверх цены эксперта)' : `Платформе (20%${ofServices})`, rub(money.commission_kop)));
  if (!executorOnly) {
    // Оплата по счёту (2.464): «оплачено по счёту», служебным — с пометкой; до поступления — сообщил ли заказчик об оплате.
    const byInvoice = money.payment?.method === 'invoice';
    const claimed = money.invoice_claimed_at
      ? (money.sees.staff ? `заказчик сообщил об оплате ${dayRu(money.invoice_claimed_at)}${money.invoice_claim_note ? ` (${money.invoice_claim_note})` : ''} — проверьте поступление`
        : `Вы сообщили об оплате ${dayRu(money.invoice_claimed_at)} — диспетчер проверит поступление`) : null;
    const pay = money.paid ? `оплачено${byInvoice ? ' по счёту' : ''} ${dayRu(money.paid_at)}${byInvoice && money.sees.staff && money.payment.note ? ` (${money.payment.note})` : ''}`
      : money.payment?.status === 'pending' ? PAYMENT_RU.pending
      : money.pay_invoice && claimed ? claimed
      : money.pay_invoice ? `нужна оплата ${money.can_pay ? 'картой или по счёту' : 'по счёту'}: после поступления денег заявку передадут эксперту`
      : order.status === 'cancelled' ? 'не оплачено'
      : money.payment ? `${PAYMENT_RU[money.payment.status]} — можно оплатить снова`
      : money.price_kop ? 'нужна оплата: после неё заявку передадут исполнителю' : 'после назначения цены';
    facts.push(...fact('Оплата', pay));
    if (money.paid && !['done', 'closed', 'cancelled'].includes(order.status)) {
      facts.push(...fact('Деньги', money.sees.staff ? 'у платформы до выдачи результата заказчику'
        : 'хранятся у платформы и уйдут исполнителю, только когда результат проверен и выдан Вам'));
    }
  }
  if (money.refund_quality) {
    facts.push(...fact('Отмена', money.refund_quality === 'bad'
      ? 'после выдачи: результат признан плохим — возврат заказчику, выплаченное удерживается у исполнителя'
      : 'после выдачи: результат нормальный — возврат за счёт платформы, у исполнителя не удерживается'));
  } else if (money.cancel_fault) {
    facts.push(...fact('Отмена', money.cancel_fault === 'executor' ? 'по вине исполнителя' : `заказчик отказался, сделано ${money.done_percent}% работы`));
  }
  if (money.refund) {
    // Возврат по оплате по счёту (2.464) — вручную: до отметки диспетчера — «ждёт возврата вручную».
    const rst = money.refund.manual && money.refund.status !== 'succeeded' ? 'ждёт возврата вручную' : REFUND_RU[money.refund.status];
    const rnote = money.refund.manual && money.refund.manual_note && money.sees.staff ? ` (${money.refund.manual_note})` : '';
    facts.push(...fact('Возврат заказчику', `${rub(money.refund.amount_kop)} — ${rst}${money.refund.failure && !money.refund.manual ? ` (${money.refund.failure})` : ''}${rnote}`));
  }
  if (money.payout) {
    // Выплата вручную (2.463): до отметки диспетчера — «ждёт выплаты вручную», после — с пометкой.
    const st = money.payout.manual && money.payout.status !== 'succeeded' ? 'ждёт выплаты вручную' : PAYOUT_RU[money.payout.status];
    const note = money.payout.manual && money.payout.manual_note && !executorOnly ? ` (${money.payout.manual_note})` : '';
    facts.push(...fact(executorOnly ? 'Выплата' : 'Выплата исполнителю', `${rub(money.payout.amount_kop)} — ${st}${money.payout.failure && !money.payout.manual ? ` (${money.payout.failure})` : ''}${note}`));
  }
  if (money.payout?.withheld_kop) facts.push(...fact('Удержано из выплаты', `${rub(money.payout.withheld_kop)} — в счёт возврата по плохому переводу`));
  if (money.clawback) {
    facts.push(...fact(executorOnly ? 'Удержание с Вас' : 'Удержание у исполнителя', money.clawback.closed
      ? `${rub(money.clawback.amount_kop)} — удержано полностью`
      : `${rub(money.clawback.amount_kop)} — из следующих выплат, удержано ${rub(money.clawback.withheld_kop)}`, money.clawback.closed ? '' : 'overdue'));
  }
  if (money.payout?.receipt_url) facts.push(...fact('Чек самозанятого', `приложен ${dayRu(money.payout.receipt_at)}`));
  else if (money.payout?.receipt_needed) facts.push(...fact('Чек самозанятого', 'нужен: выдайте чек в «Мой налог» и приложите ссылку', 'overdue'));
  else if (executorOnly && order.status !== 'cancelled' && !money.payout) {
    facts.push(...fact('Выплата', onTop ? 'когда результат проверен и выдан заказчику — платформа перечислит Вашу цену' : 'автоматически, когда результат проверен и выдан заказчику'));
  }
  $('money-facts').replaceChildren(...facts);

  $('price-form').classList.toggle('hidden', !money.can_set_price);
  const quoted = !money.price_kop && ctx.quote ? ctx.quote.total_kop : null;
  // Экспертиза (2.463): диспетчер вводит цену эксперта, под полем — сколько заплатит заказчик.
  ctx.onTop = !!money.price_on_top;
  $('price-label').textContent = ctx.onTop ? 'Цена эксперта, рублей' : 'Цена, рублей';
  $('price-rule').textContent = ctx.onTop
    ? 'Эксперту — 100% его цены, платформе — 20% сверх неё: заказчик платит цену эксперта ×1,2. Цену можно менять, пока заказчик не оплатил заявку.'
    : 'Исполнителю — 80%, платформе — 20% (у перевода — от услуг, тарифы нотариуса и доставка — без вознаграждения). Цену можно менять, пока заказчик не оплатил заявку.';
  const setKop = money.expert_kop ?? money.price_kop;
  if (money.can_set_price) $('price').value = setKop ? String(setKop / 100).replace('.', ',') : quoted ? String(quoted / 100).replace('.', ',') : '';
  showOnTop();
  $('price-quoted').classList.toggle('hidden', !(money.can_set_price && quoted));
  $('price-quoted').textContent = quoted ? `Подставлена цена по таблице цен перевода — проверьте и назначьте.${ctx.quote.transit_kop ? ` Из неё ${rub(ctx.quote.transit_kop)} — тарифы нотариуса и доставка: без вознаграждения, 80/20 делится только остальное.` : ''}` : '';
  $('pay').classList.toggle('hidden', !money.can_pay);
  if (money.can_pay) $('pay').textContent = `Оплатить ${rub(money.price_kop)}`;
  $('payout-retry').classList.toggle('hidden', !money.can_retry_payout);
  $('payout-mark-form').classList.toggle('hidden', !money.can_mark_payout);
  if (money.can_mark_payout) $('payout-note').value = '';
  // Чек самозанятого на выплату (2а.3): приложить или заменить ссылку «Мой налог».
  $('receipt-form').classList.toggle('hidden', !money.can_add_receipt);
  if (money.can_add_receipt) $('receipt-url').value = money.payout.receipt_url ?? '';
  $('refund-retry').classList.toggle('hidden', !money.can_retry_refund);
  $('refund-mark-form').classList.toggle('hidden', !money.can_mark_refund);
  if (money.can_mark_refund) $('refund-note').value = '';
  // Оплата по счёту (2.464): заказчику — как платить и «Я оплатил(а)», диспетчеру — «Оплата поступила».
  $('invoice-pay').classList.toggle('hidden', !(money.pay_invoice && money.sees.customer));
  $('invoice-claim-form').classList.toggle('hidden', !money.can_claim_invoice);
  if (money.can_claim_invoice) $('invoice-claim-note').value = '';
  $('invoice-mark-form').classList.toggle('hidden', !money.can_mark_paid);
  if (money.can_mark_paid) $('invoice-mark-note').value = '';

  $('closing-title').classList.toggle('hidden', money.documents.length === 0);
  $('closing').replaceChildren(...money.documents.map((d) => el('li', { class: 'doc' },
    el('div', {},
      el('div', { class: 'name', text: `${DOC_RU[d.kind]} № ${d.number}` }),
      el('div', { class: 'muted', text: dayRu(d.created_at) })),
    el('div', { class: 'row' },
      el('button', { class: 'secondary', 'data-action': 'open-doc', onclick: () => openDoc(d) }, 'Открыть'),
      // Файлом Word (2.46) — для бухгалтерии и архива.
      el('button', { class: 'secondary', 'data-action': 'doc-word', onclick: () => { location.href = `/api/orders/${order.id}/closing/${d.id}`; } }, 'Word')))));
  // Счёт для бухгалтерии (2.46) — заявке организации, когда цена назначена; при оплате по счёту (2.464) — всем заказчикам.
  const invoice = money.sees.customer && !!money.price_kop && (!!order.org_id || money.pay_invoice) && order.status !== 'cancelled';
  $('invoice').classList.toggle('hidden', !invoice);
  $('invoice').textContent = money.pay_invoice ? 'Скачать счёт на оплату (Word)' : 'Счёт для бухгалтерии (Word)';
  $('invoice').classList.toggle('wide', !!money.pay_invoice && !money.can_pay);
  $('invoice').classList.toggle('secondary', !(money.pay_invoice && !money.can_pay));
  $('invoice').onclick = () => { location.href = `/api/orders/${order.id}/invoice`; };
  setNext({ money }); // «Что дальше» заказчику: оплатить, акт (2.41)
}

// Закрывающий документ — текстом на странице (содержимое зафиксировано при выдаче результата или отмене).
// Транзит (2а.2): услуги и тарифы нотариуса / доставка — отдельными строками.
function transitParas(x, p) {
  if (!x.transit_kop) return [];
  return [
    p(`Услуги (перевод, организация заверения, сертификат): ${rub(x.services_kop)}`),
    p(`Тарифы нотариуса и доставка — оплачиваются агентом нотариусу и курьеру, без вознаграждения: ${rub(x.transit_kop)}`),
    ...(x.transit_lines ?? []).map((l) => p(`· ${l.title} — ${rub(l.kop)}`)),
  ];
}

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
      p(x.fee_on_top
        ? `Стоимость: ${rub(x.price_kop)}, в том числе цена эксперта ${rub(x.payout_kop)} и вознаграждение агента (${x.commission_percent}% сверх цены эксперта): ${rub(x.commission_kop)}`
        : `Стоимость: ${rub(x.price_kop)}, в том числе вознаграждение агента (${x.commission_percent}%${x.transit_kop ? ' от услуг' : ''}): ${rub(x.commission_kop)}`),
      ...transitParas(x, p),
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
      ...transitParas(x, p),
      p(`Вознаграждение агента (${x.commission_percent}%${x.fee_on_top ? ' сверх цены эксперта' : x.transit_kop ? ' от услуг' : ''}): ${rub(x.commission_kop)}`),
      ...(x.withheld_kop ? [
        p(`Удержано в счёт возврата заказчику по плохому переводу: ${rub(x.withheld_kop)} (${x.withheld.map((w) => `заявка ${w.order_ref} — ${rub(w.kop)}`).join('; ')})`),
        p(`К перечислению исполнителю: ${rub(x.payout_kop - x.withheld_kop)}`),
      ] : [p(`К перечислению исполнителю: ${rub(x.payout_kop)}`)]),
      ...(partial ? [p(`Заказ отменён заказчиком после начала работ; оплачена сделанная часть (${x.partial_percent}%).`)] : []),
    ];
  if (x.test) lines.splice(1, 0, p('Проверочный документ: оплата тестовая, юридической силы не имеет.', 'doc-test'));
  $('closing-doc').replaceChildren(...lines);
  $('closing-doc').classList.remove('hidden');
  $('closing-doc').scrollIntoView({ block: 'nearest' });
}

// Цена эксперта → цена для заказчика (2.463): та же формула, что на сервере (priceOnTop), — подсказка, считает сервер.
function kopOf(text) {
  const m = /^(\d{1,8})(?:[.,](\d{1,2}))?$/.exec(String(text).replace(/\s/g, ''));
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
}
function showOnTop() {
  const kop = ctx?.onTop ? kopOf($('price').value) : null;
  $('price-ontop').classList.toggle('hidden', !kop);
  if (kop) {
    const fee = Math.round(kop * 0.2);
    $('price-ontop').textContent = `Заказчик заплатит ${rub(kop + fee)}: цена эксперта ${rub(kop)} и платформе ${rub(fee)}.`;
  }
}
$('price').addEventListener('input', showOnTop);

$('payout-mark-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('payout-mark').disabled = true;
  try {
    await api('POST', `/api/orders/${ctx.order.id}/payout/paid`, { note: $('payout-note').value.trim() });
    await loadMoney({ order: ctx.order }, ctx.reload);
    say($('money-msg'), 'Выплата отмечена', 'ok');
  } catch (err) { say($('money-msg'), err.message); } finally { $('payout-mark').disabled = false; }
});

// Оплата по счёту (2.464): отправка формы — одна операция, после неё карточка перечитывается.
function moneyForm(form, button, run, done) {
  $(form).addEventListener('submit', async (e) => {
    e.preventDefault();
    $(button).disabled = true;
    try {
      await run();
      await loadMoney({ order: ctx.order }, ctx.reload);
      say($('money-msg'), done, 'ok');
    } catch (err) { say($('money-msg'), err.message); } finally { $(button).disabled = false; }
  });
}
moneyForm('invoice-claim-form', 'invoice-claim', () => api('POST', `/api/orders/${ctx.order.id}/payments/claim`, { note: $('invoice-claim-note').value.trim() }),
  'Спасибо — диспетчер проверит поступление и отметит оплату');
moneyForm('invoice-mark-form', 'invoice-mark', () => api('POST', `/api/orders/${ctx.order.id}/payments/invoice`, { note: $('invoice-mark-note').value.trim() }),
  'Оплата отмечена');
moneyForm('refund-mark-form', 'refund-mark', () => api('POST', `/api/orders/${ctx.order.id}/refund/paid`, { note: $('refund-note').value.trim() }),
  'Возврат отмечен');

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

$('receipt-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('receipt-save').disabled = true;
  try {
    await api('PUT', `/api/orders/${ctx.order.id}/payout/receipt`, { url: $('receipt-url').value.trim() });
    await loadMoney({ order: ctx.order }, ctx.reload);
    say($('money-msg'), 'Чек приложен', 'ok');
  } catch (err) { say($('money-msg'), err.message); } finally { $('receipt-save').disabled = false; }
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
  $('money-manual-box').classList.add('hidden');
  $('money-invoices-box').classList.add('hidden');
  $('money-refunds-box').classList.add('hidden');
  if (staff) {
    const { totals, payments, payouts, manual, manual_kop: manualKop, invoices, refunds_manual: refundsManual } = await api('GET', '/api/money');
    renderManual(manual, manualKop);
    renderInvoices(invoices ?? []);
    renderRefunds(refundsManual ?? []);
    $('money-title').textContent = 'Деньги платформы';
    $('money-totals').replaceChildren(
      ...fact('Получено от заказчиков', rub(totals.received_kop), 'money-sum'),
      ...fact('Ждут выдачи результата', rub(totals.held_kop)),
      ...fact('К выплате исполнителям', rub(totals.to_pay_kop)),
      ...fact('Выплачено исполнителям', rub(totals.paid_out_kop)),
      ...fact('Возвращено заказчикам', rub(totals.refunded_kop)),
      ...(totals.to_refund_kop ? fact('К возврату заказчикам', rub(totals.to_refund_kop), 'overdue') : []),
      ...(totals.refunds_after_payout_kop ? fact('Возвраты после выплаты исполнителю', rub(totals.refunds_after_payout_kop)) : []),
      ...(totals.clawback_open_kop ? fact('Удержать у исполнителей (плохие переводы)', rub(totals.clawback_open_kop), 'overdue') : []),
      ...(totals.transit_kop ? fact('Нотариусу и за доставку (транзит)', rub(totals.transit_kop)) : []),
      ...(totals.receipts_missing ? fact('Выплаты самозанятым без чека', String(totals.receipts_missing), 'overdue') : []),
      ...fact('Вознаграждение платформы (20%)', rub(totals.commission_kop)),
      ...(manualKop ? fact('Выплатить вручную', rub(manualKop), 'overdue') : []));
    $('money-payments').replaceChildren(...payments.map((p) => el('li', {},
      el('button', { class: 'open', onclick: openOrder(p.order_id) },
        el('div', { class: 'title', text: p.title }),
        el('div', { class: 'muted', text: [rub(p.amount_kop), dayRu(p.paid_at), p.method === 'invoice' ? 'по счёту' : null, p.note].filter(Boolean).join(' · ') })))));
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

// Выплатить вручную (2.463): эксперт, телефон, заявка, сумма; «Выплачено» — отметка без пометки, с пометкой — в карточке заявки.
function renderManual(rows, sumKop) {
  say($('money-manual-msg'), '');
  $('money-manual-box').classList.toggle('hidden', rows.length === 0);
  $('money-manual-sum').textContent = `${rows.length} ${rows.length === 1 ? 'выплата' : rows.length < 5 ? 'выплаты' : 'выплат'} на ${rub(sumKop)} — перечислите экспертам и отметьте.`;
  $('money-manual').replaceChildren(...rows.map((p) => el('li', { class: 'manual-payout' },
    el('button', { class: 'open', onclick: openOrder(p.order_id) },
      el('div', { class: 'title', text: `${p.executor_name || 'Эксперт'} — ${rub(p.amount_kop)}` }),
      el('div', { class: 'muted', text: [p.executor_phone, `заявка ${p.order_ref}`, p.title, `с ${dayRu(p.created_at)}`].filter(Boolean).join(' · ') })),
    el('button', { class: 'secondary', 'data-action': 'manual-paid', onclick: async (e) => {
      e.target.disabled = true;
      try {
        await api('POST', `/api/orders/${p.order_id}/payout/paid`, {});
        await showMoney();
        say($('money-manual-msg'), 'Выплата отмечена', 'ok');
      } catch (err) { say($('money-manual-msg'), err.message); e.target.disabled = false; }
    } }, 'Выплачено'))));
}

const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);

// Ждут оплаты по счёту (2.464): заявки с назначенной ценой; сообщившие «оплатил» — первыми. «Оплата поступила» — отметка без
// пометки; с пометкой — в карточке заявки.
function renderInvoices(rows) {
  say($('money-invoices-msg'), '');
  $('money-invoices-box').classList.toggle('hidden', rows.length === 0);
  const claimed = rows.filter((r) => r.claimed_at).length;
  $('money-invoices-sum').textContent = `${rows.length} ${plural(rows.length, 'заявка', 'заявки', 'заявок')}${claimed ? `, ${claimed} — заказчик сообщил об оплате` : ''}. Проверьте поступление на счёт и отметьте.`;
  $('money-invoices').replaceChildren(...rows.map((r) => el('li', { class: `invoice-wait${r.claimed_at ? ' claimed' : ''}` },
    el('button', { class: 'open', onclick: openOrder(r.order_id) },
      el('div', { class: 'title', text: `${r.title} — ${rub(r.amount_kop)}` }),
      el('div', { class: `muted${r.claimed_at ? ' ok' : ''}`, text: [`заявка ${r.order_ref}`, `счёт СЧ-${r.order_ref.replace('№ ', '')}`,
        r.claimed_at ? `заказчик: «оплатил» ${dayRu(r.claimed_at)}` : 'заказчик об оплате не сообщал', r.claim_note].filter(Boolean).join(' · ') })),
    el('button', { class: 'secondary', 'data-action': 'invoice-paid', onclick: async (e) => {
      e.target.disabled = true;
      try {
        await api('POST', `/api/orders/${r.order_id}/payments/invoice`, {});
        await showMoney();
        say($('money-invoices-msg'), 'Оплата отмечена', 'ok');
      } catch (err) { say($('money-invoices-msg'), err.message); e.target.disabled = false; }
    } }, 'Оплата поступила'))));
}

// Вернуть вручную (2.464): возвраты по заявкам, оплаченным по счёту, — заказчик, телефон, сумма.
function renderRefunds(rows) {
  say($('money-refunds-msg'), '');
  $('money-refunds-box').classList.toggle('hidden', rows.length === 0);
  const sum = rows.reduce((a, r) => a + r.amount_kop, 0);
  $('money-refunds-sum').textContent = `${rows.length} ${plural(rows.length, 'возврат', 'возврата', 'возвратов')} на ${rub(sum)} — верните заказчикам и отметьте.`;
  $('money-refunds').replaceChildren(...rows.map((r) => el('li', { class: 'manual-refund' },
    el('button', { class: 'open', onclick: openOrder(r.order_id) },
      el('div', { class: 'title', text: `${r.customer_name || 'Заказчик'} — ${rub(r.amount_kop)}` }),
      el('div', { class: 'muted', text: [r.customer_phone, `заявка ${r.order_ref}`, r.title, `с ${dayRu(r.created_at)}`].filter(Boolean).join(' · ') })),
    el('button', { class: 'secondary', 'data-action': 'refund-paid', onclick: async (e) => {
      e.target.disabled = true;
      try {
        await api('POST', `/api/orders/${r.order_id}/refund/paid`, {});
        await showMoney();
        say($('money-refunds-msg'), 'Возврат отмечен', 'ok');
      } catch (err) { say($('money-refunds-msg'), err.message); e.target.disabled = false; }
    } }, 'Возвращено'))));
}

function renderPayouts(payouts, staff) {
  $('money-payouts').replaceChildren(...payouts.map((p) => el('li', {},
    el('button', { class: 'open', onclick: openOrder(p.order_id) },
      el('div', { class: 'title', text: p.title }),
      el('div', { class: `muted${p.status === 'failed' ? ' overdue' : ''}`, text: [rub(p.amount_kop), p.manual && p.status !== 'succeeded' ? 'ждёт выплаты вручную' : PAYOUT_RU[p.status], p.receipt_needed ? 'нет чека' : null, staff ? p.executor_name : null].filter(Boolean).join(' · ') })))));
  $('money-payouts-empty').classList.toggle('hidden', payouts.length > 0);
}
