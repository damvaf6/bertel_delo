// Слой «организация» (задача 1.2): организация, состав и роли, приглашения по номеру телефона.
// Решения Дамира 30.09.2026: организацию заводит любой пользователь сам и становится руководителем;
// роли — руководитель / старший / сотрудник; ушедший сотрудник теряет доступ к делам организации, дела остаются у неё.
import { HttpError } from '../http/core.mjs';
import { LEVEL, ORG_ROLES, orgLevel } from '../access/policy.mjs';
import { audit, oneOf, phoneFrom, text, uuidFrom } from './util.mjs';
import { notifyPhone } from '../notify/notify.mjs';

export const INVITE_TTL_DAYS = 14;
export const LIMITS = {
  orgsCreatedPerUser: 10,     // защита от засорения; настоящим организациям хватит с запасом
  pendingInvitesPerOrg: 50,
};

const ROLE_RU = { head: 'руководитель', senior: 'старший', member: 'сотрудник' };

function innFrom(value) {
  if (value == null || value === '') return null;
  const v = String(value).replace(/\s/g, '');
  if (!/^(\d{10}|\d{12})$/.test(v)) throw new HttpError(400, 'bad_inn', 'ИНН: 10 цифр для организации или 12 для ИП');
  return v;
}

const publicOrg = (o) => ({ id: o.id, name: o.name, inn: o.inn, created_at: o.created_at });
const publicInvite = (i) => ({ id: i.id, org_id: i.org_id, phone: i.phone, role: i.role, created_at: i.created_at, expires_at: i.expires_at });

// В организации всегда остаётся хотя бы один руководитель. Вызывать внутри транзакции:
// строка организации блокируется, чтобы два руководителя не сняли друг друга одновременно.
async function assertHeadRemains(tx, orgId, leavingUserId) {
  await tx`select 1 from organizations where id = ${orgId} for update`;
  const rest = await tx.one`
    select count(*)::int as n from org_members where org_id = ${orgId} and role = 'head' and user_id <> ${leavingUserId}`;
  if (rest.n === 0) throw new HttpError(409, 'last_head', 'В организации должен остаться хотя бы один руководитель');
}

export function orgOps() {
  return [
    {
      id: 'orgs.create', method: 'POST', path: '/api/orgs', auth: 'user', access: 'self',
      async handler({ sql, actor, body, res }) {
        const name = text(body?.name, 'Название', 300);
        const inn = innFrom(body?.inn);
        const org = await sql.tx(async (tx) => {
          await tx`select 1 from users where id = ${actor.id} for update`;
          const made = await tx.one`select count(*)::int as n from organizations where created_by = ${actor.id}`;
          if (made.n >= LIMITS.orgsCreatedPerUser) throw new HttpError(429, 'too_many_orgs', 'Слишком много организаций');
          const o = await tx.one`insert into organizations (name, inn, created_by) values (${name}, ${inn}, ${actor.id}) returning *`;
          await tx`insert into org_members (org_id, user_id, role) values (${o.id}, ${actor.id}, 'head')`;
          await audit(tx, actor, 'org.create', 'org', o.id);
          return o;
        });
        res.status(201);
        return { org: publicOrg(org), my_role: 'head' };
      },
    },
    {
      id: 'orgs.list', method: 'GET', path: '/api/orgs', auth: 'user', access: 'self',
      async handler({ sql, actor }) {
        const orgs = await sql`
          select o.*, m.role as my_role from org_members m join organizations o on o.id = m.org_id
          where m.user_id = ${actor.id} order by o.name`;
        return { orgs: orgs.map((o) => ({ ...publicOrg(o), my_role: o.my_role })) };
      },
    },
    {
      id: 'orgs.get', method: 'GET', path: '/api/orgs/:id', auth: 'user',
      access: { resource: 'org', param: 'id', need: 'read' },
      async handler({ actor, org }) {
        const my = actor.orgs.find((m) => m.org_id === org.id);
        return { org: publicOrg(org), my_role: my?.role ?? null, manage: orgLevel(actor, org) === LEVEL.manage };
      },
    },
    {
      id: 'orgs.update', method: 'PATCH', path: '/api/orgs/:id', auth: 'user',
      access: { resource: 'org', param: 'id', need: 'manage' },
      async handler({ sql, actor, org, body }) {
        const name = body?.name === undefined ? org.name : text(body.name, 'Название', 300);
        const inn = body?.inn === undefined ? org.inn : innFrom(body.inn);
        const updated = await sql.tx(async (tx) => {
          const o = await tx.one`update organizations set name = ${name}, inn = ${inn} where id = ${org.id} returning *`;
          await audit(tx, actor, 'org.update', 'org', org.id);
          return o;
        });
        return { org: publicOrg(updated) };
      },
    },
    {
      // Состав: имена и роли видят все участники; телефоны — руководитель; число дел (нагрузку) — руководитель и старший.
      id: 'orgs.members', method: 'GET', path: '/api/orgs/:id/members', auth: 'user',
      access: { resource: 'org', param: 'id', need: 'read' },
      async handler({ sql, actor, org }) {
        const level = orgLevel(actor, org);
        const myRole = actor.orgs.find((m) => m.org_id === org.id)?.role;
        const seesLoad = myRole === 'head' || myRole === 'senior';
        const rows = await sql`
          select m.user_id, m.role, m.created_at, u.full_name, u.phone,
                 (select count(*)::int from orders r where r.org_id = m.org_id and r.owner_user_id = m.user_id) as orders
          from org_members m join users u on u.id = m.user_id
          where m.org_id = ${org.id}
          order by case m.role when 'head' then 0 when 'senior' then 1 else 2 end, u.full_name, m.created_at`;
        return {
          members: rows.map((m) => ({
            user_id: m.user_id,
            full_name: m.full_name,
            role: m.role,
            since: m.created_at,
            ...(level === LEVEL.manage ? { phone: m.phone } : {}),
            ...(seesLoad ? { orders: m.orders } : {}),
          })),
        };
      },
    },
    {
      id: 'orgs.members.update', method: 'PATCH', path: '/api/orgs/:id/members/:userId', auth: 'user',
      access: { resource: 'org', param: 'id', need: 'manage' },
      async handler({ sql, actor, org, params, body }) {
        const userId = uuidFrom(params.userId, 'Сотрудник не найден');
        const role = oneOf(body?.role, ORG_ROLES, 'Роль');
        await sql.tx(async (tx) => {
          const m = await tx.one`select role from org_members where org_id = ${org.id} and user_id = ${userId}`;
          if (!m) throw new HttpError(404, 'not_found', 'Сотрудник не найден');
          if (m.role === 'head' && role !== 'head') await assertHeadRemains(tx, org.id, userId);
          await tx`update org_members set role = ${role} where org_id = ${org.id} and user_id = ${userId}`;
          await audit(tx, actor, 'org.member.role', 'org', org.id, { user_id: userId, from: m.role, to: role });
        });
        return { user_id: userId, role };
      },
    },
    {
      id: 'orgs.members.remove', method: 'DELETE', path: '/api/orgs/:id/members/:userId', auth: 'user',
      access: { resource: 'org', param: 'id', need: 'manage' },
      async handler({ sql, actor, org, params }) {
        const userId = uuidFrom(params.userId, 'Сотрудник не найден');
        await sql.tx(async (tx) => {
          const m = await tx.one`select role from org_members where org_id = ${org.id} and user_id = ${userId}`;
          if (!m) throw new HttpError(404, 'not_found', 'Сотрудник не найден');
          if (m.role === 'head') await assertHeadRemains(tx, org.id, userId);
          await tx`delete from org_members where org_id = ${org.id} and user_id = ${userId}`;
          await audit(tx, actor, 'org.member.remove', 'org', org.id, { user_id: userId });
        });
      },
    },
    {
      id: 'orgs.leave', method: 'POST', path: '/api/orgs/:id/leave', auth: 'user',
      access: { resource: 'org', param: 'id', need: 'write' },
      async handler({ sql, actor, org }) {
        await sql.tx(async (tx) => {
          const m = await tx.one`select role from org_members where org_id = ${org.id} and user_id = ${actor.id}`;
          if (!m) throw new HttpError(404, 'not_found', 'Не найдено');
          if (m.role === 'head') await assertHeadRemains(tx, org.id, actor.id);
          await tx`delete from org_members where org_id = ${org.id} and user_id = ${actor.id}`;
          await audit(tx, actor, 'org.member.leave', 'org', org.id);
        });
      },
    },
    {
      id: 'orgs.invites.list', method: 'GET', path: '/api/orgs/:id/invites', auth: 'user',
      access: { resource: 'org', param: 'id', need: 'manage' },
      async handler({ sql, org }) {
        const rows = await sql`
          select * from org_invites
          where org_id = ${org.id} and accepted_at is null and declined_at is null and revoked_at is null and expires_at > now()
          order by created_at desc`;
        return { invites: rows.map(publicInvite) };
      },
    },
    {
      // Ответ одинаковый, есть ли у номера учётная запись или нет, — чтобы по приглашениям нельзя было проверять номера.
      id: 'orgs.invites.create', method: 'POST', path: '/api/orgs/:id/invites', auth: 'user',
      access: { resource: 'org', param: 'id', need: 'manage' },
      async handler({ sql, actor, org, body, res }) {
        const phone = phoneFrom(body?.phone);
        const role = oneOf(body?.role ?? 'member', ORG_ROLES, 'Роль');
        const invite = await sql.tx(async (tx) => {
          await tx`select 1 from organizations where id = ${org.id} for update`;
          const already = await tx.one`
            select 1 from org_members m join users u on u.id = m.user_id where m.org_id = ${org.id} and u.phone = ${phone}`;
          if (already) throw new HttpError(409, 'already_member', 'Этот человек уже в организации');
          // Просроченное приглашение на тот же номер закрываем, чтобы можно было пригласить заново.
          await tx`update org_invites set revoked_at = now()
                   where org_id = ${org.id} and phone = ${phone} and expires_at <= now()
                     and accepted_at is null and declined_at is null and revoked_at is null`;
          const open = await tx`
            select phone from org_invites
            where org_id = ${org.id} and accepted_at is null and declined_at is null and revoked_at is null and expires_at > now()`;
          if (open.some((i) => i.phone === phone)) throw new HttpError(409, 'invite_exists', 'Приглашение на этот номер уже отправлено');
          if (open.length >= LIMITS.pendingInvitesPerOrg) throw new HttpError(429, 'too_many_invites', 'Слишком много неотвеченных приглашений');
          const i = await tx.one`
            insert into org_invites (org_id, phone, role, invited_by, expires_at)
            values (${org.id}, ${phone}, ${role}, ${actor.id}, now() + make_interval(days => ${INVITE_TTL_DAYS}))
            returning *`;
          await audit(tx, actor, 'org.invite.create', 'org', org.id, { invite_id: i.id, role });
          await notifyPhone(tx, 'invite', phone, { orgId: org.id, actor });
          return i;
        });
        res.status(201);
        return { invite: publicInvite(invite) };
      },
    },
    {
      id: 'invites.revoke', method: 'DELETE', path: '/api/invites/:id', auth: 'user',
      access: { resource: 'orgInvite', param: 'id', need: 'manage' },
      async handler({ sql, actor, invite }) {
        await sql.tx(async (tx) => {
          const r = await tx.one`update org_invites set revoked_at = now()
                                 where id = ${invite.id} and accepted_at is null and declined_at is null and revoked_at is null
                                 returning id`;
          if (!r) throw new HttpError(409, 'invite_closed', 'Приглашение уже принято, отклонено или отозвано');
          await audit(tx, actor, 'org.invite.revoke', 'org', invite.org_id, { invite_id: invite.id });
        });
      },
    },
    {
      // Мои приглашения — по номеру телефона вошедшего.
      id: 'invites.mine', method: 'GET', path: '/api/invites', auth: 'user', access: 'self',
      async handler({ sql, actor }) {
        const rows = await sql`
          select i.*, o.name as org_name from org_invites i join organizations o on o.id = i.org_id
          where i.phone = ${actor.phone} and i.accepted_at is null and i.declined_at is null and i.revoked_at is null
            and i.expires_at > now()
          order by i.created_at desc`;
        return { invites: rows.map((i) => ({ ...publicInvite(i), org_name: i.org_name, role_ru: ROLE_RU[i.role] })) };
      },
    },
    {
      id: 'invites.accept', method: 'POST', path: '/api/invites/:id/accept', auth: 'user',
      access: { resource: 'invite', param: 'id', need: 'write' },
      async handler({ sql, actor, invite }) {
        return sql.tx(async (tx) => {
          const i = await tx.one`update org_invites set accepted_at = now()
                                 where id = ${invite.id} and accepted_at is null and declined_at is null and revoked_at is null
                                   and expires_at > now()
                                 returning *`;
          if (!i) throw new HttpError(409, 'invite_closed', 'Приглашение уже недействительно');
          // Уже в организации (например, пригласили дважды разные руководители) — роль не меняем.
          const joined = await tx.one`
            insert into org_members (org_id, user_id, role) values (${i.org_id}, ${actor.id}, ${i.role})
            on conflict (org_id, user_id) do nothing returning role`;
          await audit(tx, actor, 'org.invite.accept', 'org', i.org_id, { invite_id: i.id });
          const m = joined ?? await tx.one`select role from org_members where org_id = ${i.org_id} and user_id = ${actor.id}`;
          return { org_id: i.org_id, role: m.role };
        });
      },
    },
    {
      id: 'invites.decline', method: 'POST', path: '/api/invites/:id/decline', auth: 'user',
      access: { resource: 'invite', param: 'id', need: 'write' },
      async handler({ sql, actor, invite }) {
        await sql.tx(async (tx) => {
          const r = await tx.one`update org_invites set declined_at = now()
                                 where id = ${invite.id} and accepted_at is null and declined_at is null and revoked_at is null
                                 returning id`;
          if (!r) throw new HttpError(409, 'invite_closed', 'Приглашение уже недействительно');
          await audit(tx, actor, 'org.invite.decline', 'org', invite.org_id, { invite_id: invite.id });
        });
      },
    },
  ];
}
