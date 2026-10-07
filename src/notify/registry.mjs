// Реестр уведомлений (задача 1.7): виды (по ним человек настраивает СМС) и события (что случилось).
// Новое уведомление = строка в EVENTS (и при необходимости вид в TYPES) + вызов notify() там, где событие происходит.
// Тексты — здесь, а не в базе: формулировку можно поменять, старые уведомления покажутся по-новому.
// В СМС нет персональных данных и названия заявки — только короткий номер; подробности — в кабинете.

// for — кому вид показывается в настройках: всем, специалистам или диспетчерам.
export const TYPES = [
  { id: 'order_progress', name: 'Ход моих заявок', hint: 'назначена цена, исполнитель принял дело или просит документы, срок перенесён, результат готов, заявку отменили или передали другому исполнителю', for: 'all', sms: true },
  { id: 'messages', name: 'Сообщения в переписке', hint: 'новое сообщение по Вашей заявке или делу', for: 'all', sms: false },
  { id: 'money', name: 'Оплата и выплаты', hint: 'оплата получена, вознаграждение выплачено, деньги возвращены или перевод не прошёл', for: 'all', sms: true },
  { id: 'org_invites', name: 'Приглашения в организацию', hint: 'Вас пригласили стать сотрудником организации', for: 'all', sms: true },
  { id: 'offers', name: 'Предложения дел', hint: 'Вам предложили новое дело (и предложения госзаказа из БЕРТЕЛ CRM)', for: 'specialist', sms: true },
  { id: 'executor_work', name: 'Мои дела как исполнителя', hint: 'напоминания о сроке дела и документов досье, заказчик загрузил запрошенный документ, владелец или помощник прислал фото осмотра, по ссылке осмотра 2 дня нет фото, назначен или отменён выезд, ответ на просьбу о переносе срока, возврат на доработку, сообщение руководителя организации или эксперта по делу, результат принят, дело снято, передано другому (или руководитель передал дело Вам) или отменено', for: 'specialist', sms: true },
  { id: 'org_cases', name: 'Дела организации', hint: 'организации предложено дело — назначьте эксперта; эксперт отказался; предложение снято; эксперт не принимает новые дела до какого-то дня; у эксперта кончается или истёк документ досье (для руководителя)', for: 'all', sms: true },
  { id: 'dispatch', name: 'Очередь диспетчера', hint: 'новые и оплаченные заявки, отказы исполнителей, просьбы о переносе срока, сдача на проверку, просроченные сроки, истёкшие документы экспертов, отмены, неудачные выплаты и возвраты, сообщения о проблемах', for: 'dispatcher', sms: false },
];
export const TYPE = Object.fromEntries(TYPES.map((t) => [t.id, t]));

// title — строка в кабинете и в СМС. order: true — событие по заявке (в СМС добавляется её короткий номер).
// section — куда ведёт уведомление без заявки (2.45): 'orgs' (с организацией — сразу в неё), 'specialist', 'specialists', 'problems'.
// focus (2.67) — уведомление руководителю по делу организации ведёт прямо к делу в «Организации»: 'pending' (назначить),
// 'sign' (подписать), 'chat' (переписка с экспертом); номер дела передаётся в notify() как orderId.
// mail: true — заказчику заявки, пришедшей по письму, уходит и письмо в ту же переписку (1.9, src/mail/mail.mjs).
export const EVENTS = {
  submitted: { type: 'dispatch', title: 'Новая заявка ждёт подбора исполнителя', order: true },
  declined: { type: 'dispatch', title: 'Исполнитель отказался от дела — нужен новый подбор', order: true },
  org_declined: { type: 'dispatch', title: 'Организация отказалась от дела — нужен новый подбор', order: true },
  in_review: { type: 'dispatch', title: 'Результат сдан на проверку', order: true },
  cancelled_by_customer: { type: 'dispatch', title: 'Заказчик отменил заявку', order: true },
  payout_failed_staff: { type: 'dispatch', title: 'Выплата исполнителю не прошла — нужен повтор', order: true },
  paid_staff: { type: 'dispatch', title: 'Заявка оплачена — можно предлагать исполнителю', order: true },
  // Досье эксперта (2.14): у эксперта истёк аттестат или полис — список специалистов показывает, у кого.
  dossier_expired_staff: { type: 'dispatch', title: 'У эксперта истёк документ в досье — он отмечен в подборе и в списке специалистов', order: false, section: 'specialists' },
  // Перенос срока (2.91): src/ops/deadline-ops.mjs.
  deadline_ext_requested: { type: 'dispatch', title: 'Исполнитель просит перенести срок по делу — согласитесь или откажите', order: true },
  deadline_overdue_staff: { type: 'dispatch', title: 'Срок по заявке прошёл, результат не выдан', order: true },
  refund_failed_staff: { type: 'dispatch', title: 'Возврат заказчику не прошёл — нужен повтор', order: true },
  // Закрытый запуск (2.54): человек нажал «Сообщить о проблеме» — сообщение в журнале «Проблемы».
  problem_report: { type: 'dispatch', title: 'Новое сообщение о проблеме — раздел «Проблемы»', order: false, section: 'problems' },

  offer: { type: 'offers', title: 'Вам предложено новое дело', order: true },
  crm_offer: { type: 'offers', title: 'Новое предложение госзаказа — принять можно в БЕРТЕЛ CRM', order: false, section: 'specialist' },

  offer_withdrawn: { type: 'executor_work', title: 'Предложение дела снято', order: true },
  inspection_done: { type: 'executor_work', title: 'Владелец объекта прислал фото осмотра', order: true },
  // Ссылка осмотра молчит 2 дня (2.85): src/ops/inspect-ops.mjs, раз в минуту вместе с напоминаниями о сроках.
  inspection_silent: { type: 'executor_work', title: 'По ссылке осмотра 2 дня нет фото — отправьте ссылку владельцу снова', order: true },
  onsite_done: { type: 'executor_work', title: 'Помощник завершил выезд: фото и данные с объекта в деле', order: true },
  // Помощнику на объекте (2.4) — без номера заявки: заявку он не видит, выезд — в разделе «Специалист».
  onsite_assigned: { type: 'executor_work', title: 'Вам назначен выезд на объект', order: false, section: 'specialist' },
  onsite_cancelled: { type: 'executor_work', title: 'Выезд на объект отменён', order: false, section: 'specialist' },
  // Руководителю организации исполнителя (2.5а): эксперт подписал результат — нужна подпись организации (раздел «Организации»).
  org_sign_needed: { type: 'executor_work', title: 'Эксперт подписал заключение — нужна подпись организации', order: false, section: 'orgs', focus: 'sign' },
  // Эксперт напомнил о подписи организации (2.99): не чаще раза в сутки по делу, src/ops/sign-ops.mjs.
  org_sign_reminder: { type: 'executor_work', title: 'Эксперт напоминает: заключение ждёт подписи организации', order: false, section: 'orgs', focus: 'sign' },
  // Эксперту (2.27): руководитель организации вернул файл с замечанием до подписи организации — подпись эксперта снята.
  org_returned: { type: 'executor_work', title: 'Руководитель вернул отчёт с замечанием — исправьте и подпишите заново', order: true },
  // Внутренняя переписка организации по делу (2.28): эксперту — от руководителя; руководителю — от эксперта («Дела экспертов»).
  org_chat_expert: { type: 'executor_work', title: 'Руководитель организации написал Вам по делу', order: true },
  org_chat_head: { type: 'executor_work', title: 'Эксперт написал Вам по делу — «Дела экспертов» в разделе «Организации»', order: false, section: 'orgs', focus: 'chat' },
  rework: { type: 'executor_work', title: 'Результат возвращён на доработку', order: true },
  // Напоминания о сроках (2.13): src/notify/reminders.mjs, раз в минуту вместе с повтором СМС.
  deadline_soon: { type: 'executor_work', title: 'До срока по делу осталось 3 дня', order: true },
  deadline_tomorrow: { type: 'executor_work', title: 'Срок по делу — завтра', order: true },
  deadline_ext_approved: { type: 'executor_work', title: 'Диспетчер согласился перенести срок по делу', order: true },
  deadline_ext_declined: { type: 'executor_work', title: 'Диспетчер отказал в переносе срока по делу', order: true },
  deadline_overdue: { type: 'executor_work', title: 'Срок по делу прошёл — сдайте результат или напишите диспетчеру', order: true },
  // Досье эксперта (2.14): src/dossier/dossier.mjs, раз в минуту вместе с напоминаниями о сроках дел.
  dossier_month: { type: 'executor_work', title: 'Через 30 дней кончается срок документа в досье — обновите его в разделе «Специалист»', order: false, section: 'specialist' },
  dossier_week: { type: 'executor_work', title: 'Через 7 дней кончается срок документа в досье — обновите его в разделе «Специалист»', order: false, section: 'specialist' },
  dossier_expired: { type: 'executor_work', title: 'Истёк срок документа в досье — обновите его в разделе «Специалист»', order: false, section: 'specialist' },
  // Руководителю организации эксперта (2.63): сроки документов досье его экспертов; сами копии руководитель не видит.
  // Руководителю организации эксперта (2.77): эксперт отметил «не принимаю новые дела до …» — до какого дня, видно в «Нагрузке».
  expert_away_head: { type: 'org_cases', title: 'Эксперт Вашей организации не принимает новые дела до указанного дня — видно в «Делах экспертов»', order: false, section: 'orgs' },
  dossier_month_head: { type: 'org_cases', title: 'У эксперта Вашей организации через 30 дней кончается срок документа в досье', order: false, section: 'orgs' },
  dossier_week_head: { type: 'org_cases', title: 'У эксперта Вашей организации через 7 дней кончается срок документа в досье', order: false, section: 'orgs' },
  dossier_expired_head: { type: 'org_cases', title: 'У эксперта Вашей организации истёк документ в досье — по оценке он снят с подбора', order: false, section: 'orgs' },
  result_accepted: { type: 'executor_work', title: 'Результат принят проверкой', order: true },
  executor_cancelled: { type: 'executor_work', title: 'Дело отменено', order: true },
  executor_closed: { type: 'executor_work', title: 'Заявка закрыта', order: true },
  executor_reassigned: { type: 'executor_work', title: 'Дело передано другому исполнителю', order: true },
  // Запрос документов (2.64): заказчик загрузил файл к документу, который просил исполнитель.
  docs_received: { type: 'executor_work', title: 'Заказчик загрузил запрошенный документ', order: true },
  org_case_given: { type: 'executor_work', title: 'Руководитель организации передал Вам дело в работе', order: true },
  // Эксперту (2.76): руководитель отдал предложенное ему дело другому (или забрал назад) до его ответа — без номера.
  org_offer_taken: { type: 'executor_work', title: 'Руководитель организации снял предложенное Вам дело — отвечать не нужно', order: false, section: 'specialist' },
  org_case_taken: { type: 'executor_work', title: 'Руководитель организации передал Ваше дело другому эксперту', order: false, section: 'specialist' },

  priced: { type: 'order_progress', title: 'Цена назначена — оплатите заявку, чтобы передать её исполнителю', order: true, mail: true },
  accepted: { type: 'order_progress', title: 'Исполнитель принял заявку в работу', order: true, mail: true },
  reassigned: { type: 'order_progress', title: 'Заявка передана другому исполнителю', order: true, mail: true },
  deadline_moved: { type: 'order_progress', title: 'Срок по заявке перенесён по просьбе исполнителя — новая дата в заявке', order: true, mail: true },
  // Исполнитель запросил документы (2.64): список с отметками — на странице заявки.
  docs_requested: { type: 'order_progress', title: 'Исполнитель просит документы — список на странице заявки, загрузите файлы', order: true, mail: true },
  done: { type: 'order_progress', title: 'Результат проверен и доступен в кабинете', order: true, mail: true },
  cancelled_by_dispatcher: { type: 'order_progress', title: 'Диспетчер отменил заявку', order: true, mail: true },

  message: { type: 'messages', title: 'Новое сообщение по заявке', order: true },

  paid: { type: 'money', title: 'Оплата получена — подбираем исполнителя', order: true, mail: true },
  payout_succeeded: { type: 'money', title: 'Вознаграждение выплачено', order: true },
  payout_failed: { type: 'money', title: 'Выплата вознаграждения не прошла — диспетчер повторит', order: true },
  refund_succeeded: { type: 'money', title: 'Деньги по заявке возвращены', order: true, mail: true },
  refund_failed: { type: 'money', title: 'Возврат денег не прошёл — диспетчер повторит', order: true },

  // Руководителю организации (2.17) — без номера заявки: заявку он не видит, дело — в «Делах экспертов» раздела «Организации».
  org_offer: { type: 'org_cases', title: 'Организации предложено дело — назначьте эксперта в разделе «Организации»', order: false, section: 'orgs', focus: 'pending' },
  org_expert_declined: { type: 'org_cases', title: 'Эксперт отказался от дела — назначьте другого или откажитесь', order: false, section: 'orgs', focus: 'pending' },
  org_offer_withdrawn: { type: 'org_cases', title: 'Предложение дела организации снято', order: false, section: 'orgs' },

  invite: { type: 'org_invites', title: 'Вас пригласили в организацию', order: false, section: 'orgs' },
};

const ID_RE = /^[a-z_]{1,40}$/;
export const SECTIONS = ['orgs', 'specialist', 'specialists', 'problems'];
export const FOCUS = ['pending', 'sign', 'chat'];

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
    // Уведомление без заявки должно куда-то вести (2.45): иначе человек видит строку и не знает, где действовать.
    if (e.section !== undefined && !SECTIONS.includes(e.section)) throw new Error(`уведомления: у события «${id}» неизвестный раздел «${e.section}»`);
    if (e.focus !== undefined && (e.section !== 'orgs' || !FOCUS.includes(e.focus))) throw new Error(`уведомления: у события «${id}» неверный focus`);
    if (!e.order && !e.section) throw new Error(`уведомления: событие «${id}» без заявки — укажите раздел (section)`);
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
