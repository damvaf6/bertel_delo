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
// Статусы заявки: сторона «заказчик» — у кого write или manage; сторона «диспетчер» — диспетчер платформы
//               (администратор только читает). Какие шаги доступны стороне — src/orders/workflow.mjs.
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
    level: (actor, found) => orderLevel(actor, found.order),
  },
  org: {
    async load(sql, id) {
      if (!UUID_RE.test(id)) return null;
      const org = await sql.one`select * from organizations where id = ${id}`;
      return org && { subject: org, org };
    },
    level: (actor, found) => orgLevel(actor, found.org),
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
