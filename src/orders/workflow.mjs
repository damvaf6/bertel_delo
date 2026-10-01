// Статусы заявки и переходы между ними (устав, этап 1):
//   новая → подбор → ждёт исполнителя → в работе → проверка → готово → закрыто; отменена.
// «Новая» — заявку заполняет заказчик и может править; «Отправить» переводит её в подбор.
// Переходы — данные: откуда, куда, чья сторона, нужна ли причина. Кто к какой стороне относится —
// только src/access/policy.mjs (orderSides).
//
// Шаги исполнителя (принять, отказаться, сдать) делает сам специалист (1.4). Сдать — только с файлом результата;
// «Проверено, готово» — только когда все правила проверки текущего круга отмечены «в порядке» (1.5, order-ops.mjs).

export const STATUSES = [
  { id: 'new', name: 'Новая' },
  { id: 'matching', name: 'Подбор исполнителя' },
  { id: 'awaiting_executor', name: 'Ждёт исполнителя' },
  { id: 'in_work', name: 'В работе' },
  { id: 'review', name: 'Проверка результата' },
  { id: 'done', name: 'Готово' },
  { id: 'closed', name: 'Закрыта' },
  { id: 'cancelled', name: 'Отменена' },
];
export const STATUS_NAME = Object.fromEntries(STATUSES.map((s) => [s.id, s.name]));

// После этих статусов срок больше не контролируется.
export const DEADLINE_OFF = ['done', 'closed', 'cancelled'];
// Заявка завершена: файлы не добавляются и не удаляются.
export const FINAL = ['closed', 'cancelled'];
// Работа начата: отмена — только диспетчером и с указанием, по чьей причине (исполнитель / заказчик и сделанная доля).
export const WORK_STARTED = ['in_work', 'review'];

// Отмена заказчиком — только до начала работ; после — через диспетчера, с причиной (решение Дамира 30.09.2026).
// Отмена диспетчером после начала работ — с указанием, по чьей причине (деньги — src/money/money.mjs, settleCancel).
const CUSTOMER_CANCEL_FROM = ['new', 'matching', 'awaiting_executor'];
const DISPATCHER_CANCEL_FROM = ['matching', 'awaiting_executor', 'in_work', 'review'];

export const TRANSITIONS = [
  { from: 'new', to: 'matching', by: 'customer', name: 'Отправить заявку' },
  // «Подбор → ждёт исполнителя» — не шаг статуса, а предложение конкретному специалисту (orders.offer, src/ops/match-ops.mjs).
  { from: 'awaiting_executor', to: 'in_work', by: 'executor', name: 'Принять дело' },
  { from: 'awaiting_executor', to: 'matching', by: 'executor', name: 'Отказаться', reason: true },
  { from: 'awaiting_executor', to: 'matching', by: 'dispatcher', name: 'Вернуть в подбор', reason: true },
  { from: 'in_work', to: 'review', by: 'executor', name: 'Сдать на проверку' },
  { from: 'review', to: 'in_work', by: 'dispatcher', name: 'Вернуть на доработку', reason: true },
  // Исполнитель не справляется — дело другому; оплата заказчика остаётся в силе (решение Дамира 01.10.2026).
  { from: 'in_work', to: 'matching', by: 'dispatcher', name: 'Передать другому исполнителю', reason: true },
  { from: 'review', to: 'matching', by: 'dispatcher', name: 'Передать другому исполнителю', reason: true },
  { from: 'review', to: 'done', by: 'dispatcher', name: 'Проверено, готово' },
  { from: 'done', to: 'closed', by: 'customer', name: 'Принять и закрыть' },
  { from: 'done', to: 'closed', by: 'dispatcher', name: 'Закрыть заявку' },
  ...CUSTOMER_CANCEL_FROM.map((from) => ({ from, to: 'cancelled', by: 'customer', name: 'Отменить заявку' })),
  ...DISPATCHER_CANCEL_FROM.map((from) => ({ from, to: 'cancelled', by: 'dispatcher', name: 'Отменить заявку', reason: true })),
];

// Переход из статуса from в to для вошедшего со сторонами sides. Если подходят обе стороны, берётся сторона заказчика
// (у неё меньше требований — например, причина отмены не обязательна).
export function findTransition(from, to, sides) {
  for (const side of ['customer', 'dispatcher', 'executor']) {
    if (!sides.includes(side)) continue;
    const t = TRANSITIONS.find((x) => x.from === from && x.to === to && x.by === side);
    if (t) return t;
  }
  return null;
}

// Что вошедший может сделать с заявкой сейчас (для кнопок в кабинете).
export function availableActions(status, sides) {
  const seen = new Set();
  const out = [];
  for (const side of ['customer', 'dispatcher', 'executor']) {
    if (!sides.includes(side)) continue;
    for (const t of TRANSITIONS) {
      if (t.from !== status || t.by !== side || seen.has(t.to)) continue;
      seen.add(t.to);
      out.push({ to: t.to, name: t.name, reason: !!t.reason });
    }
  }
  return out;
}

// Сегодняшняя дата по Москве (сроки считаются по московскому времени): 'ГГГГ-ММ-ДД'.
export function todayMsk(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const isOverdue = (order, today = todayMsk()) => !!order.deadline && !DEADLINE_OFF.includes(order.status) && order.deadline < today;
