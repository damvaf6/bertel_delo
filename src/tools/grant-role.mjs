// Назначение служебной роли по номеру телефона — для первого администратора, когда в интерфейсе ещё некому это сделать.
// Запуск только в контуре (как миграции), не из интернета:
//   node src/tools/grant-role.mjs +79990000001 admin        # dispatcher | admin | none (снять роль)
// Пользователь создаётся, если с этого номера ещё не входили. Действие пишется в журнал (автор — «команда»).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normPhone } from '../auth/auth.mjs';
import { setPlatformRole } from '../ops/admin-ops.mjs';

export async function grantRole(sql, rawPhone, rawRole) {
  const phone = normPhone(rawPhone);
  if (!phone) throw new Error('Номер: мобильный телефон России');
  const role = rawRole === 'none' ? null : rawRole;
  return sql.tx(async (tx) => {
    await tx`insert into users (phone) values (${phone}) on conflict (phone) do nothing`;
    const u = await tx.one`select id from users where phone = ${phone}`;
    return setPlatformRole(tx, null, u.id, role);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { loadConfig } = await import('../config.mjs');
  const { createDb } = await import('../db.mjs');
  const sql = createDb(loadConfig());
  try {
    const u = await grantRole(sql, process.argv[2], process.argv[3]);
    console.log(`готово: ${u.phone} — ${u.platform_role ?? 'без служебной роли'}`);
  } catch (e) {
    console.error('не удалось:', e.message);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
