// Администрирование платформы (задача 1.2): роли диспетчера и администратора, отключение учётной записи.
// Только администратор; остальным эти операции отвечают «не найдено».
// Первого администратора назначает команда src/tools/grant-role.mjs (запуск в контуре, не из интернета).
import { HttpError } from '../http/core.mjs';
import { PLATFORM_ROLES } from '../access/policy.mjs';
import { audit, phoneFrom, uuidFrom } from './util.mjs';

async function adminView(sql, user) {
  const orgs = await sql`
    select o.name, m.role from org_members m join organizations o on o.id = m.org_id
    where m.user_id = ${user.id} order by o.name`;
  return {
    id: user.id, phone: user.phone, full_name: user.full_name, platform_role: user.platform_role,
    is_active: user.is_active, created_at: user.created_at, orgs,
  };
}

// Назначить или снять служебную роль. Общая для операции и команды первого назначения.
export async function setPlatformRole(tx, actor, userId, role) {
  if (role !== null && !PLATFORM_ROLES.includes(role)) throw new HttpError(400, 'bad_input', 'Поле «Роль»: недопустимое значение');
  const u = await tx.one`update users set platform_role = ${role} where id = ${userId} returning *`;
  if (!u) throw new HttpError(404, 'not_found', 'Пользователь не найден');
  await audit(tx, actor, 'admin.role', 'user', userId, { role });
  return u;
}

export function adminOps() {
  return [
    {
      id: 'admin.users.find', method: 'GET', path: '/api/admin/users', auth: 'user', access: { platform: 'admin' },
      async handler({ sql, query }) {
        const phone = phoneFrom(query.phone);
        const user = await sql.one`select * from users where phone = ${phone}`;
        if (!user) throw new HttpError(404, 'user_not_found', 'С этим номером ещё никто не входил');
        return { user: await adminView(sql, user) };
      },
    },
    {
      id: 'admin.staff', method: 'GET', path: '/api/admin/staff', auth: 'user', access: { platform: 'admin' },
      async handler({ sql }) {
        const rows = await sql`select * from users where platform_role is not null order by platform_role, full_name, phone`;
        return { users: await Promise.all(rows.map((u) => adminView(sql, u))) };
      },
    },
    {
      id: 'admin.users.update', method: 'PATCH', path: '/api/admin/users/:id', auth: 'user', access: { platform: 'admin' },
      async handler({ sql, actor, params, body }) {
        const userId = uuidFrom(params.id, 'Пользователь не найден');
        // Себя не меняем: так администратор не лишит платформу последнего администратора по ошибке.
        if (userId === actor.id) throw new HttpError(409, 'self_change', 'Свою роль и доступ изменить нельзя');
        const user = await sql.tx(async (tx) => {
          let u = await tx.one`select * from users where id = ${userId} for update`;
          if (!u) throw new HttpError(404, 'not_found', 'Пользователь не найден');
          if (body?.platform_role !== undefined) u = await setPlatformRole(tx, actor, userId, body.platform_role);
          if (body?.is_active !== undefined) {
            if (typeof body.is_active !== 'boolean') throw new HttpError(400, 'bad_input', 'Поле «Доступ»: да или нет');
            u = await tx.one`update users set is_active = ${body.is_active} where id = ${userId} returning *`;
            // Отключённый выходит отовсюду сразу.
            if (!body.is_active) await tx`delete from sessions where user_id = ${userId}`;
            await audit(tx, actor, body.is_active ? 'admin.enable' : 'admin.disable', 'user', userId);
          }
          return u;
        });
        return { user: await adminView(sql, user) };
      },
    },
  ];
}
