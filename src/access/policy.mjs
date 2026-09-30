// Проверка доступа: кто что видит и меняет. Единственное место, где решается «свой / чужой».
//   владелец заявки            — читает и меняет;
//   руководитель организации   — читает и меняет заявки своей организации;
//   сотрудник организации      — только свои (как владелец);
//   диспетчер, администратор   — читают все;
//   остальные                  — не видят вовсе (ответ «не найдено», чтобы не раскрывать существование).
import { HttpError, notFound, UUID_RE } from '../http/core.mjs';

export const LEVEL = { none: 0, read: 1, write: 2 };

export function isStaff(actor) {
  return actor?.platform_role === 'dispatcher' || actor?.platform_role === 'admin';
}

export function headOf(actor, orgId) {
  return !!orgId && actor.orgs.some((m) => m.org_id === orgId && m.role === 'head');
}

export function memberOf(actor, orgId) {
  return !!orgId && actor.orgs.some((m) => m.org_id === orgId);
}

export function orderLevel(actor, order) {
  if (!actor || !order) return LEVEL.none;
  if (order.owner_user_id === actor.id) return LEVEL.write;
  if (headOf(actor, order.org_id)) return LEVEL.write;
  if (isStaff(actor)) return LEVEL.read;
  return LEVEL.none;
}

// Условие выборки «видимые заявки» — та же логика, что orderLevel, но для списка.
export function visibleOrdersFilter(actor) {
  if (isStaff(actor)) return { all: true };
  return { userId: actor.id, headOrgIds: actor.orgs.filter((m) => m.role === 'head').map((m) => m.org_id) };
}

// Загрузчики предметов доступа: по параметру пути находят запись и заявку, к которой она относится.
export const RESOURCES = {
  async order(sql, id) {
    if (!UUID_RE.test(id)) return null;
    const order = await sql.one`select * from orders where id = ${id}`;
    return order && { subject: order, order };
  },
  async document(sql, id) {
    if (!UUID_RE.test(id)) return null;
    const doc = await sql.one`select * from documents where id = ${id} and deleted_at is null`;
    if (!doc) return null;
    const order = await sql.one`select * from orders where id = ${doc.order_id}`;
    return order && { subject: doc, order };
  },
};

export async function authorize(sql, actor, spec, params) {
  const load = RESOURCES[spec.resource];
  if (!load) throw new Error(`Неизвестный предмет доступа: ${spec.resource}`);
  const found = await load(sql, params[spec.param]);
  const level = found ? orderLevel(actor, found.order) : LEVEL.none;
  if (level === LEVEL.none) throw notFound();
  if (level < LEVEL[spec.need]) throw new HttpError(403, 'forbidden', 'Недостаточно прав');
  return found;
}
