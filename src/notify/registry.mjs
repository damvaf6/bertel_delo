// Реестр уведомлений (задача 1.7): виды (по ним человек настраивает СМС) и события (что случилось).
// Новое уведомление = строка в EVENTS (и при необходимости вид в TYPES) + вызов notify() там, где событие происходит.
// Тексты — здесь, а не в базе: формулировку можно поменять, старые уведомления покажутся по-новому.
// В СМС нет персональных данных и названия заявки — только короткий номер; подробности — в кабинете.

// for — кому вид показывается в настройках: всем, специалистам или диспетчерам.
export const TYPES = [
  { id: 'order_progress', name: 'Ход моих заявок', hint: 'назначена цена, исполнитель принял дело, результат готов, заявку отменили или передали другому исполнителю', for: 'all', sms: true },
  { id: 'messages', name: 'Сообщения в переписке', hint: 'новое сообщение по Вашей заявке или делу', for: 'all', sms: false },
  { id: 'money', name: 'Оплата и выплаты', hint: 'оплата получена, вознаграждение выплачено, деньги возвращены или перевод не прошёл', for: 'all', sms: true },
  { id: 'org_invites', name: 'Приглашения в организацию', hint: 'Вас пригласили стать сотрудником организации', for: 'all', sms: true },
  { id: 'offers', name: 'Предложения дел', hint: 'Вам предложили новое дело (и предложения госзаказа из БЕРТЕЛ CRM)', for: 'specialist', sms: true },
  { id: 'executor_work', name: 'Мои дела как исполнителя', hint: 'напоминания о сроке, владелец или помощник прислал фото осмотра, назначен или отменён выезд, возврат на доработку, результат принят, дело снято, передано другому или отменено', for: 'specialist', sms: true },
  { id: 'org_cases', name: 'Дела организации', hint: 'организации предложено дело — назначьте эксперта; эксперт отказался; предложение снято (для руководителя)', for: 'all', sms: true },
  { id: 'dispatch', name: 'Очередь диспетчера', hint: 'новые и оплаченные заявки, отказы исполнителей, сдача на проверку, просроченные сроки, отмены, неудачные выплаты и возвраты', for: 'dispatcher', sms: false },
];
export const TYPE = Object.fromEntries(TYPES.map((t) => [t.id, t]));

// title — строка в кабинете и в СМС. order: true — событие по заявке (в СМС добавляется её короткий номер).
// mail: true — заказчику заявки, пришедшей по письму, уходит и письмо в ту же переписку (1.9, src/mail/mail.mjs).
export const EVENTS = {
  submitted: { type: 'dispatch', title: 'Новая заявка ждёт подбора исполнителя', order: true },
  declined: { type: 'dispatch', title: 'Исполнитель отказался от дела — нужен новый подбор', order: true },
  org_declined: { type: 'dispatch', title: 'Организация отказалась от дела — нужен новый подбор', order: true },
  in_review: { type: 'dispatch', title: 'Результат сдан на проверку', order: true },
  cancelled_by_customer: { type: 'dispatch', title: 'Заказчик отменил заявку', order: true },
  payout_failed_staff: { type: 'dispatch', title: 'Выплата исполнителю не прошла — нужен повтор', order: true },
  paid_staff: { type: 'dispatch', title: 'Заявка оплачена — можно предлагать исполнителю', order: true },
  deadline_overdue_staff: { type: 'dispatch', title: 'Срок по заявке прошёл, результат не выдан', order: true },
  refund_failed_staff: { type: 'dispatch', title: 'Возврат заказчику не прошёл — нужен повтор', order: true },

  offer: { type: 'offers', title: 'Вам предложено новое дело', order: true },
  crm_offer: { type: 'offers', title: 'Новое предложение госзаказа — принять можно в БЕРТЕЛ CRM', order: false },

  offer_withdrawn: { type: 'executor_work', title: 'Предложение дела снято', order: true },
  inspection_done: { type: 'executor_work', title: 'Владелец объекта прислал фото осмотра', order: true },
  onsite_done: { type: 'executor_work', title: 'Помощник завершил выезд: фото и данные с объекта в деле', order: true },
  // Помощнику на объекте (2.4) — без номера заявки: заявку он не видит, выезд — в разделе «Специалист».
  onsite_assigned: { type: 'executor_work', title: 'Вам назначен выезд на объект', order: false },
  onsite_cancelled: { type: 'executor_work', title: 'Выезд на объект отменён', order: false },
  // Руководителю организации исполнителя (2.5а): эксперт подписал результат — нужна подпись организации (раздел «Организации»).
  org_sign_needed: { type: 'executor_work', title: 'Эксперт подписал заключение — нужна подпись организации', order: false },
  rework: { type: 'executor_work', title: 'Результат возвращён на доработку', order: true },
  // Напоминания о сроках (2.13): src/notify/reminders.mjs, раз в минуту вместе с повтором СМС.
  deadline_soon: { type: 'executor_work', title: 'До срока по делу осталось 3 дня', order: true },
  deadline_tomorrow: { type: 'executor_work', title: 'Срок по делу — завтра', order: true },
  deadline_overdue: { type: 'executor_work', title: 'Срок по делу прошёл — сдайте результат или напишите диспетчеру', order: true },
  result_accepted: { type: 'executor_work', title: 'Результат принят проверкой', order: true },
  executor_cancelled: { type: 'executor_work', title: 'Дело отменено', order: true },
  executor_closed: { type: 'executor_work', title: 'Заявка закрыта', order: true },
  executor_reassigned: { type: 'executor_work', title: 'Дело передано другому исполнителю', order: true },

  priced: { type: 'order_progress', title: 'Цена назначена — оплатите заявку, чтобы передать её исполнителю', order: true, mail: true },
  accepted: { type: 'order_progress', title: 'Исполнитель принял заявку в работу', order: true, mail: true },
  reassigned: { type: 'order_progress', title: 'Заявка передана другому исполнителю', order: true, mail: true },
  done: { type: 'order_progress', title: 'Результат проверен и доступен в кабинете', order: true, mail: true },
  cancelled_by_dispatcher: { type: 'order_progress', title: 'Диспетчер отменил заявку', order: true, mail: true },

  message: { type: 'messages', title: 'Новое сообщение по заявке', order: true },

  paid: { type: 'money', title: 'Оплата получена — подбираем исполнителя', order: true, mail: true },
  payout_succeeded: { type: 'money', title: 'Вознаграждение выплачено', order: true },
  payout_failed: { type: 'money', title: 'Выплата вознаграждения не прошла — диспетчер повторит', order: true },
  refund_succeeded: { type: 'money', title: 'Деньги по заявке возвращены', order: true, mail: true },
  refund_failed: { type: 'money', title: 'Возврат денег не прошёл — диспетчер повторит', order: true },

  // Руководителю организации (2.17) — без номера заявки: заявку он не видит, дело — в «Делах экспертов» раздела «Организации».
  org_offer: { type: 'org_cases', title: 'Организации предложено дело — назначьте эксперта в разделе «Организации»', order: false },
  org_expert_declined: { type: 'org_cases', title: 'Эксперт отказался от дела — назначьте другого или откажитесь', order: false },
  org_offer_withdrawn: { type: 'org_cases', title: 'Предложение дела организации снято', order: false },

  invite: { type: 'org_invites', title: 'Вас пригласили в организацию', order: false },
};

const ID_RE = /^[a-z_]{1,40}$/;

// Проверка реестра при запуске: ошибка в описании — сервер не стартует (как у модулей-профессий).
export function validateRegistry(types = TYPES, events = EVENTS) {
  const ids = new Set();
  for (const t of types) {
    if (!ID_RE.test(t.id) || ids.has(t.id)) throw new Error(`уведомления: вид «${t.id}» — неверный или повторяется`);
    if (!t.name || typeof t.sms !== 'boolean' || !['all', 'specialist', 'dispatcher'].includes(t.for)) throw new Error(`уведомления: вид «${t.id}» описан не полностью`);
    ids.add(t.id);
  }
  for (const [id, e] of Object.entries(events)) {
    if (!ID_RE.test(id)) throw new Error(`уведомления: событие «${id}» — неверный код`);
    if (!ids.has(e.type)) throw new Error(`уведомления: у события «${id}» неизвестный вид «${e.type}»`);
    if (e.mail !== undefined && (typeof e.mail !== 'boolean' || !e.order)) throw new Error(`уведомления: письмо — только у события по заявке («${id}»)`);
    if (!e.title || e.title.length > 120) throw new Error(`уведомления: у события «${id}» нет текста или он длиннее 120 знаков`);
  }
}

// Короткий номер заявки — тот же, что в закрывающих документах.
export const orderRef = (orderId) => `№ ${String(orderId).slice(0, 8).toUpperCase()}`;

// Текст СМС: только событие и номер заявки, без имён, адресов и названий.
export function smsText(eventId, { orderId } = {}) {
  const e = EVENTS[eventId];
  if (eventId === 'invite') return 'БЕРТЕЛ Дело: Вас пригласили в организацию. Войдите по этому номеру телефона, чтобы ответить.';
  return `БЕРТЕЛ Дело: ${e.title}${e.order && orderId ? `. Заявка ${orderRef(orderId)}` : ''}. Подробности — в кабинете.`;
}
