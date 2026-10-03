// Проверка доступа: кто что видит и меняет. Единственное место, где решается «свой / чужой».
//
// Уровни: none < read < write < manage.
//
// Заявка:
//   личная (без организации)     — владелец: write; диспетчер, администратор: read;
//   от имени организации          — руководитель и старший: manage (видят все, распределяют);
//                                   сотрудник — write только своих и только пока состоит в организации
//                                   (ушёл — дела остаются у организации, решение Дамира 30.09.2026);
//                                   диспетчер, администратор: read.
// Организация:  руководитель — manage; старший и сотрудник — write (участник); диспетчер, администратор — read.
// Приглашение:  адресат (номер совпадает) — write, пока приглашение действует; руководитель организации —
//               manage над приглашениями своей организации. Это два разных предмета: руководитель не может
//               принять чужое приглашение, адресат не может его отозвать.
// Исполнитель:  видит заявку, пока она числится за ним (предложена, в работе, сдана); отказ или отмена — доступ исчезает.
// Результат работы (документ вида «результат», задача 1.5): исполнитель загружает и убирает свой, пока дело в работе;
//               диспетчер и администратор читают всегда; заказчик — только после проверки (статусы «готово», «закрыто»).
// Переписка:    читает каждый, кто видит заявку; пишет тот, у кого есть сторона (заказчик, исполнитель, диспетчер).
// Деньги (1.6): цену назначает диспетчер; платит сторона заказчика; заказчик видит цену, оплату и акт; исполнитель —
//               своё вознаграждение, выплату и отчёт агента; служебные — всё. Результат заказчику — после проверки и оплаты.
// Проверка результата: отметки ставит диспетчер; подробно видят диспетчер, администратор и исполнитель,
//               заказчик — только итог.
// Статусы заявки: сторона «заказчик» — у кого write или manage; сторона «диспетчер» — диспетчер платформы
//               (администратор только читает). Какие шаги доступны стороне — src/orders/workflow.mjs.
// ИИ (1.8):    разбор проблемы видит и превращает в заявку только его автор. Память ассистента — своя у каждого и отдельно
//               по каждой организации (личное и рабочее не смешиваются); заявку в разговор можно взять, только если её видишь,
//               и только в «её» память: дело организации — в память этой организации, личное и дело исполнителя — в личную.
//               ИИ-проверку результата запускает исполнитель перед сдачей и диспетчер на проверке; подсказки видят те же,
//               кто видит отметки проверки; заказчик — нет.
// Почта для заявок (1.9): адрес — только свой; заявки по письмам — от себя или своей организации. Ответ в переписку заявки
//               принимается от того, у кого write или manage; адрес заказчика в заявке видит только сторона заказчика.
// Дистанционный осмотр (2.3): фото и ссылки в деле видит каждый, кто видит заявку; ссылку выдаёт и отзывает исполнитель,
//               пока дело в работе (src/ops/inspect-ops.mjs). Владелец объекта входа не имеет — только секрет ссылки по одной
//               заявке; фото осмотра не удаляет никто.
// Экспресс-выезд (2.4): назначает и отменяет исполнитель, пока дело в работе; ход выезда и данные видит каждый, кто видит
//               заявку, имя помощника — исполнитель и служебные. Помощник заявку не видит: только свой выезд — услугу,
//               поля для поиска объекта из описания модуля и шаги; снимает и пишет данные, пока выезд действует.
// Подпись организации (2.5а): если исполнитель работает от организации (выбрал её в профиле специалиста и состоит в ней),
//               её руководитель видит файлы результата этого дела и подписывает их от организации, пока дело в работе;
//               саму заявку, переписку и заказчика он не видит. Заказчик видит подписи вместе с результатом.
// Дела экспертов (2.16): руководитель организации видит дела экспертов, которые работают от неё (выбрали в профиле и
//               состоят в ней), — услугу, номер, срок, состояние, эксперта, вознаграждение; нагрузку и деньги за месяц.
//               Заказчика, поля заявки, документы и переписку — нет. Старший и сотрудник — «недостаточно прав»
//               (организацию они и так знают), посторонние и чужие руководители — «не найдено» (src/ops/org-ops.mjs).
// Распределение в организации (2.17): диспетчер предлагает дело организации, где есть эксперты с допуском; её руководитель
//               в «Делах экспертов» видит его теми же сведениями (без заказчика) и назначает эксперта из своих или
//               отказывается (дело — снова диспетчеру). Отказ эксперта возвращает дело руководителю. Саму заявку руководитель
//               не видит; старший и сотрудник — «недостаточно прав», чужие — «не найдено» (src/ops/org-ops.mjs).
// Остальные не видят вовсе — ответ «не найдено», чтобы не раскрывать существование.
import { HttpError, notFound, UUID_RE } from '../http/core.mjs';

export const LEVEL = { none: 0, read: 1, write: 2, manage: 3 };
export const ORG_ROLES = ['head', 'senior', 'member'];
export const PLATFORM_ROLES = ['dispatcher', 'admin'];

export function isStaff(actor) {
  return actor?.platform_role === 'dispatcher' || actor?.platform_role === 'admin';
}

export function isAdmin(actor) {
  return actor?.platform_role === 'admin';
}

export function roleIn(actor, orgId) {
  if (!orgId) return null;
  return actor.orgs.find((m) => m.org_id === orgId)?.role ?? null;
}

export function memberOf(actor, orgId) {
  return !!roleIn(actor, orgId);
}

// Видит все дела организации и распределяет их.
export function seesAllOf(actor, orgId) {
  const r = roleIn(actor, orgId);
  return r === 'head' || r === 'senior';
}

export function orderLevel(actor, order) {
  if (!actor || !order) return LEVEL.none;
  if (order.org_id) {
    if (seesAllOf(actor, order.org_id)) return LEVEL.manage;
    if (order.owner_user_id === actor.id && memberOf(actor, order.org_id)) return LEVEL.write;
  } else if (order.owner_user_id === actor.id) {
    return LEVEL.write;
  }
  // Исполнитель видит дело, которое ему предложено или которое он ведёт; сам дело заказчика не правит.
  if (order.executor_user_id === actor.id) return LEVEL.read;
  if (isStaff(actor)) return LEVEL.read;
  return LEVEL.none;
}

// Чьими глазами вошедший действует над заявкой: 'customer' и/или 'dispatcher'.
export function orderSides(actor, order) {
  const sides = [];
  if (orderLevel(actor, order) >= LEVEL.write) sides.push('customer');
  if (actor?.platform_role === 'dispatcher') sides.push('dispatcher');
  if (order?.executor_user_id && order.executor_user_id === actor?.id) sides.push('executor');
  return sides;
}

// Когда заказчик видит результат работы: после проверки и оплаты (задача 1.6).
export const RESULT_OPEN = ['done', 'closed'];

export function seesResults(actor, order) {
  if (order.executor_user_id && order.executor_user_id === actor?.id) return true;
  if (isStaff(actor)) return true;
  return RESULT_OPEN.includes(order.status) && !!order.paid_at && orderLevel(actor, order) >= LEVEL.read;
}

// Какие деньги по заявке видит вошедший: заказчика (цена, оплата, акт), исполнителя (вознаграждение, выплата, отчёт агента).
export function moneyView(actor, order) {
  const staff = isStaff(actor);
  return {
    staff,
    customer: staff || orderLevel(actor, order) >= LEVEL.write,
    executor: staff || (!!order.executor_user_id && order.executor_user_id === actor?.id),
  };
}

export function documentLevel(actor, doc, order) {
  const base = orderLevel(actor, order);
  if (doc.kind !== 'result') return base;
  // Свой результат исполнитель может убрать (пока не сдал — проверка в обработчике); чужой результат никто не меняет.
  if (order.executor_user_id === actor?.id && doc.uploaded_by === actor.id) return LEVEL.write;
  if (base === LEVEL.none || !seesResults(actor, order)) return LEVEL.none;
  return LEVEL.read;
}

// От чьего имени вошедший пишет в переписке по заявке (null — только читает, например администратор).
export function messageSide(actor, order) {
  const sides = orderSides(actor, order);
  return ['customer', 'executor', 'dispatcher'].find((s) => sides.includes(s)) ?? null;
}

// Кто видит отметки проверки результата по каждому правилу (остальные — только итог).
export const seesReviewDetails = (actor, order) => isStaff(actor) || (!!order.executor_user_id && order.executor_user_id === actor?.id);

// Черновик заключения (2.2): видят исполнитель и служебные (заказчик — никогда); готовит с ИИ, правит и прикладывает
// результатом только исполнитель, пока дело у него в работе.
export const seesDraft = seesReviewDetails;
export const editsDraft = (actor, order) => order.status === 'in_work' && orderSides(actor, order).includes('executor');

// В какой памяти ассистента вошедший может разговаривать: личной (null) или организации, где он состоит.
export const assistantScopeAllowed = (actor, orgId) => orgId === null || memberOf(actor, orgId);

// Можно ли взять заявку в разговор с ассистентом в этой памяти.
export function assistantOrderAllowed(actor, order, orgId) {
  if (orderLevel(actor, order) === LEVEL.none || !assistantScopeAllowed(actor, orgId)) return false;
  if (orgId) return order.org_id === orgId;
  return !order.org_id || order.executor_user_id === actor.id || isStaff(actor);
}

// Кто и когда запускает ИИ-проверку результата: исполнитель — пока дело в работе (перед сдачей), диспетчер — на проверке.
export function aiReviewSide(actor, order) {
  const sides = orderSides(actor, order);
  if (order.status === 'in_work' && sides.includes('executor')) return 'executor';
  if (order.status === 'review' && sides.includes('dispatcher')) return 'dispatcher';
  return null;
}

export function orgLevel(actor, org) {
  if (!actor || !org) return LEVEL.none;
  const r = roleIn(actor, org.id);
  if (r === 'head') return LEVEL.manage;
  if (r) return LEVEL.write;
  if (isStaff(actor)) return LEVEL.read;
  return LEVEL.none;
}

export const invitePending = (inv) => !inv.accepted_at && !inv.declined_at && !inv.revoked_at && new Date(inv.expires_at) > new Date();

// Условие выборки «видимые заявки» — та же логика, что orderLevel, но для списка.
export function visibleOrdersFilter(actor) {
  if (isStaff(actor)) return { all: true };
  return {
    userId: actor.id,
    executorId: actor.id,
    memberOrgIds: actor.orgs.map((m) => m.org_id),
    allOrgIds: actor.orgs.filter((m) => m.role === 'head' || m.role === 'senior').map((m) => m.org_id),
  };
}

// Организация, от имени которой исполнитель сдаёт результат (2.5а): выбрана в его профиле специалиста и он в ней состоит.
// Нет организации (частная практика) — null: подпись организации не нужна.
export async function executorSignOrg(sql, executorId) {
  if (!executorId) return null;
  const r = await sql.one`select o.id, o.name from specialists s join org_members m on m.org_id = s.org_id and m.user_id = s.user_id
                          join organizations o on o.id = s.org_id where s.user_id = ${executorId}`;
  return r ?? null;
}

// Чьими глазами вошедший пишет во внутренней переписке организации по делу (2.28): 'expert' — сам исполнитель,
// 'head' — руководитель организации, от которой он ведёт дело; иначе null.
export function orgCaseSide(actor, { order, signOrg }) {
  if (!actor || !signOrg) return null;
  if (order.executor_user_id === actor.id && memberOf(actor, signOrg.id)) return 'expert';
  if (roleIn(actor, signOrg.id) === 'head') return 'head';
  return null;
}

// Предметы доступа: загрузка по параметру пути и уровень доступа вошедшего к ним.
export const RESOURCES = {
  order: {
    async load(sql, id) {
      if (!UUID_RE.test(id)) return null;
      const order = await sql.one`select * from orders where id = ${id}`;
      return order && { subject: order, order };
    },
    level: (actor, found) => orderLevel(actor, found.order),
  },
  document: {
    async load(sql, id) {
      if (!UUID_RE.test(id)) return null;
      const doc = await sql.one`select * from documents where id = ${id} and deleted_at is null`;
      if (!doc) return null;
      const order = await sql.one`select * from orders where id = ${doc.order_id}`;
      return order && { subject: doc, order };
    },
    level: (actor, found) => documentLevel(actor, found.subject, found.order),
  },
  // Файл результата глазами организации исполнителя (2.5а): только руководитель этой организации — подписать от организации.
  orgDocument: {
    async load(sql, id) {
      if (!UUID_RE.test(id)) return null;
      const doc = await sql.one`select * from documents where id = ${id} and deleted_at is null and kind = 'result'`;
      if (!doc) return null;
      const order = await sql.one`select * from orders where id = ${doc.order_id}`;
      if (!order || doc.uploaded_by !== order.executor_user_id) return null;
      const signOrg = await executorSignOrg(sql, order.executor_user_id);
      return signOrg && { subject: doc, order, signOrg };
    },
    level: (actor, { signOrg }) => (roleIn(actor, signOrg.id) === 'head' ? LEVEL.write : LEVEL.none),
  },
  // Дело глазами организации эксперта (2.28): внутренняя переписка руководителя и эксперта. Видят только сам исполнитель
  // и руководитель организации, от которой он ведёт дело (выбрана в профиле специалиста, он в ней состоит). Заказчик,
  // диспетчер, посторонний, бывший сотрудник, руководитель прежней организации — «не найдено».
  orgCase: {
    async load(sql, id) {
      if (!UUID_RE.test(id)) return null;
      const order = await sql.one`select * from orders where id = ${id}`;
      if (!order?.executor_user_id) return null;
      const signOrg = await executorSignOrg(sql, order.executor_user_id);
      return signOrg && { subject: order, order, signOrg };
    },
    level: (actor, found) => (orgCaseSide(actor, found) ? LEVEL.write : LEVEL.none),
  },
  org: {
    async load(sql, id) {
      if (!UUID_RE.test(id)) return null;
      const org = await sql.one`select * from organizations where id = ${id}`;
      return org && { subject: org, org };
    },
    level: (actor, found) => orgLevel(actor, found.org),
  },
  // Шаблон отчёта организации (2.29): загружает и убирает руководитель, видят и скачивают сотрудники. Служебным платформы,
  // посторонним и бывшим сотрудникам — «не найдено».
  orgTemplate: {
    async load(sql, id) {
      if (!UUID_RE.test(id)) return null;
      const org = await sql.one`select * from organizations where id = ${id}`;
      return org && { subject: org, org };
    },
    level: (actor, { org }) => {
      const r = roleIn(actor, org.id);
      return r === 'head' ? LEVEL.manage : r ? LEVEL.read : LEVEL.none;
    },
  },
  // Выезд помощника (2.4): только сам помощник; остальные смотрят выезд через заявку.
  visit: {
    async load(sql, id) {
      if (!/^\d{1,18}$/.test(String(id))) return null;
      const visit = await sql.one`select * from onsite_visits where id = ${id}`;
      if (!visit) return null;
      const order = await sql.one`select * from orders where id = ${visit.order_id}`;
      return order && { subject: visit, visit, order };
    },
    level: (actor, { visit }) => (visit.helper_id === actor.id ? LEVEL.write : LEVEL.none),
  },
  // Разбор проблемы ИИ: только автор.
  consultation: {
    async load(sql, id) {
      if (!UUID_RE.test(id)) return null;
      const c = await sql.one`select * from ai_consultations where id = ${id}`;
      return c && { subject: c, consultation: c };
    },
    level: (actor, { consultation }) => (consultation.user_id === actor.id ? LEVEL.write : LEVEL.none),
  },
  // Приглашение глазами адресата: принять или отклонить.
  invite: {
    async load(sql, id) {
      if (!UUID_RE.test(id)) return null;
      const invite = await sql.one`select * from org_invites where id = ${id}`;
      return invite && { subject: invite, invite };
    },
    level: (actor, { invite }) => (invite.phone === actor.phone && invitePending(invite) ? LEVEL.write : LEVEL.none),
  },
  // Приглашение глазами организации: отозвать может только её руководитель.
  orgInvite: {
    async load(sql, id) {
      if (!UUID_RE.test(id)) return null;
      const invite = await sql.one`select * from org_invites where id = ${id}`;
      return invite && { subject: invite, invite };
    },
    level: (actor, { invite }) => (roleIn(actor, invite.org_id) === 'head' ? LEVEL.manage : LEVEL.none),
  },
};

// Операции уровня платформы (администрирование): не тот, кто нужен, — «не найдено».
export function authorizePlatform(actor, role) {
  if (role === 'admin' && isAdmin(actor)) return;
  if (role === 'staff' && isStaff(actor)) return;
  if (role === 'dispatcher' && actor?.platform_role === 'dispatcher') return;
  throw notFound();
}

export async function authorize(sql, actor, spec, params) {
  const res = RESOURCES[spec.resource];
  if (!res) throw new Error(`Неизвестный предмет доступа: ${spec.resource}`);
  const found = await res.load(sql, params[spec.param]);
  const level = found ? res.level(actor, found) : LEVEL.none;
  if (level === LEVEL.none) throw notFound();
  if (level < LEVEL[spec.need]) throw new HttpError(403, 'forbidden', 'Недостаточно прав');
  return found;
}
