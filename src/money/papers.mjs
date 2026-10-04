// Документы по деньгам файлом Word (задача 2.46): счёт на оплату (организации — для бухгалтерии), акт, отчёт агента,
// документ о возврате. Содержимое акта, отчёта и возврата — снимок, сделанный при выдаче результата или отмене
// (closing_documents); счёт — по текущей цене заявки. Агент — оператор платформы (реквизиты — настройки, cfg.operator).
// Пока оплата поддельная — в каждом документе пометка «проверочный, без юридической силы».
import { buildSimpleDoc } from '../docs/docx.mjs';
import { orderRef } from '../notify/registry.mjs';
import { COMMISSION_PERCENT, rub } from './money.mjs';

const dayRu = (d) => new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' });
const TEST_NOTE = 'Проверочный документ: оплата тестовая, юридической силы не имеет.';
const LATER = '[будут указаны после заключения договоров оператора]';

function operatorLines(op) {
  return [
    `Агент: ${op.name} (оператор платформы «БЕРТЕЛ Дело»)`,
    `ИНН ${op.inn || LATER}${op.kpp ? `, КПП ${op.kpp}` : ''}${op.ogrn ? `, ОГРН ${op.ogrn}` : ''}`,
    `Адрес: ${op.address || LATER}`,
  ];
}

function customerLines(c) {
  if (!c) return ['Заказчик: —'];
  return [
    `Заказчик: ${c.name}`,
    ...(c.inn ? [`ИНН ${c.inn}${c.kpp ? `, КПП ${c.kpp}` : ''}`] : []),
    ...(c.address ? [`Адрес: ${c.address}`] : []),
  ];
}

const serviceName = (registry, module, service) => registry.service(module, service)?.service.name ?? 'Услуга';
const fileSafe = (s) => s.replace(/[^\p{L}\p{N} ._-]/gu, '').trim();

// Счёт на оплату: номер — короткий номер заявки (не меняется), дата — сегодня, сумма — цена заявки.
export function invoiceDoc({ order, customer, registry, op, test }) {
  const ref = orderRef(order.id).replace('№ ', '');
  const service = serviceName(registry, order.module, order.service);
  const price = Number(order.price_kop);
  const blocks = [
    { type: 'title', text: `Счёт на оплату № СЧ-${ref} от ${dayRu(new Date())}` },
    ...(test ? [{ type: 'note', text: TEST_NOTE }] : []),
    ...operatorLines(op).map((text) => ({ type: 'para', text })),
    { type: 'para', text: `Банковские реквизиты: ${op.bank || LATER}` },
    ...customerLines(customer).map((text) => ({ type: 'para', text })),
    { type: 'table', rows: [['№', 'Услуга', 'Кол-во', 'Цена', 'Сумма'], ['1', `${service}, заявка ${orderRef(order.id)} («${order.title}»)`, '1', rub(price), rub(price)]] },
    { type: 'bold', text: `Итого к оплате: ${rub(price)}` },
    { type: 'para', text: 'НДС — по системе налогообложения оператора (будет указан в договоре).' },
    { type: 'para', text: `Назначение платежа: оплата по заявке ${orderRef(order.id)} на платформе «БЕРТЕЛ Дело».` },
    { type: 'para', text: 'Оплатить можно картой или со счёта организации через ЮKassa — кнопкой «Оплатить» в кабинете заявки. '
      + `Платёж принимает агент; вознаграждение агента — ${COMMISSION_PERCENT}%, остальное перечисляется исполнителю после выдачи результата.` },
    { type: 'sign', text: 'Агент ______________________ (подпись)' },
  ];
  return { buf: buildSimpleDoc(blocks), filename: fileSafe(`Счёт СЧ-${ref}`) + '.docx' };
}

// Акт, отчёт агента, документ о возврате — по снимку closing_documents.data.
export function closingDoc({ doc, number, registry, op }) {
  const x = doc.data;
  const service = serviceName(registry, x.module, x.service);
  const partial = x.partial_percent != null;
  const head = (title) => [{ type: 'title', text: `${title} № ${number} от ${dayRu(doc.created_at)}` }, ...(x.test ? [{ type: 'note', text: TEST_NOTE }] : [])];
  const p = (text) => ({ type: 'para', text });
  let blocks;
  let name;
  if (doc.kind === 'act') {
    name = `Акт ${number}`;
    blocks = [
      ...head('Акт об оказании услуг'),
      ...operatorLines(op).map(p),
      ...customerLines(x.customer_details ?? { name: x.customer }).map(p),
      { type: 'table', rows: [['Услуга', 'Заявка', 'Стоимость'], [service, `${x.order_ref} («${x.order_title}»)`, rub(x.price_kop)]] },
      p(`В том числе вознаграждение агента (${x.commission_percent}%): ${rub(x.commission_kop)}.`),
      p(partial
        ? `Заказчик отказался от услуги после начала работ; оказана часть услуги (${x.partial_percent}%). Оплачено ${rub(x.paid_kop)}, остаток возвращается заказчику.`
        : 'Услуга оказана полностью, результат проверен и передан заказчику. Оплата получена. Претензий по объёму, качеству и срокам нет.'),
      { type: 'sign', text: 'Агент ______________________          Заказчик ______________________' },
    ];
  } else if (doc.kind === 'refund') {
    name = `Возврат ${number}`;
    blocks = [
      ...head('Документ о возврате'),
      ...operatorLines(op).map(p),
      p(`Услуга: ${service}, заявка ${x.order_ref} («${x.order_title}»)`),
      p(`Оплачено заказчиком: ${rub(x.paid_kop)}`),
      { type: 'bold', text: `Возвращается заказчику: ${rub(x.refund_kop)}` },
      ...(x.reason ? [p(`Причина: ${x.reason}`)] : []),
      p('Деньги возвращаются тем же способом, которым была оплата.'),
    ];
  } else {
    name = `Отчёт агента ${number}`;
    blocks = [
      ...head('Отчёт агента'),
      ...operatorLines(op).map(p),
      p(`Поручение: ${service}, заявка ${x.order_ref}`),
      { type: 'table', rows: [['Получено от заказчика', 'Вознаграждение агента', 'К перечислению исполнителю'],
        [rub(x.price_kop), `${rub(x.commission_kop)} (${x.commission_percent}%)`, rub(x.payout_kop)]] },
      ...(partial ? [p(`Заказ отменён заказчиком после начала работ; оплачена сделанная часть (${x.partial_percent}%).`)] : []),
      p('Перечисление исполнителю — на реквизиты, указанные им на платформе.'),
      { type: 'sign', text: 'Агент ______________________' },
    ];
  }
  return { buf: buildSimpleDoc(blocks), filename: `${fileSafe(name)}.docx` };
}
