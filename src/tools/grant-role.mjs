// Назначение служебной роли по номеру телефона — для первого администратора, когда в интерфейсе ещё некому это сделать.
// Запуск только в контуре (как миграции), не из интернета:
//   node src/tools/grant-role.mjs +79990000001 admin        # dispatcher | admin | none (снять роль)
// Пользователь создаётся, если с этого номера ещё не входили. Действие пишется в журнал (автор — «команда»).
//
// Проверочная площадка (решение Дамира 02.10.2026, вопрос 10, вариант А): база закрыта от интернета, поэтому кнопка
// в GitHub (workflow «Stage admin») поднимает в сети контура временный контейнер из образа ядра:
//   node src/tools/grant-role.mjs serve   — POST /grant назначает администратором номер из STAGE_ADMIN_PHONE.
// Только APP_ENV=stage и только тестовый номер +7999000xxxx; на рабочем сайте (prod) не запускается — там первый
// администратор назначается отдельно и только с «да» Дамира.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normPhone } from '../auth/auth.mjs';
import { setPlatformRole } from '../ops/admin-ops.mjs';
import { TEST_PHONE } from '../ops/service-ops.mjs';
import { audit } from '../ops/util.mjs';

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

// Где работает кнопка: проверочная площадка и автотесты. prod здесь не бывает — это проверяет tests/server/stage-admin.test.mjs.
export const STAGE_ADMIN_ENVS = Object.freeze(['stage', 'test']);

export function stageAdminPhone(cfg, rawPhone) {
  if (!STAGE_ADMIN_ENVS.includes(cfg.appEnv)) throw new Error('Кнопка назначения администратора — только на проверочной площадке (APP_ENV=stage)');
  const phone = normPhone(rawPhone || '');
  if (!phone || !TEST_PHONE.test(phone)) throw new Error('STAGE_ADMIN_PHONE: только тестовый номер +7999000xxxx');
  return phone;
}

// Назначить администратором тестовый номер площадки. Повторное нажатие ничего не меняет и в журнал не пишет.
export async function stageGrantAdmin(sql, cfg, rawPhone) {
  const phone = stageAdminPhone(cfg, rawPhone);
  return sql.tx(async (tx) => {
    await tx`insert into users (phone) values (${phone}) on conflict (phone) do nothing`;
    const u = await tx.one`select id, platform_role from users where phone = ${phone} for update`;
    if (u.platform_role === 'admin') return { phone, role: 'admin', changed: false };
    await setPlatformRole(tx, null, u.id, 'admin');
    await audit(tx, null, 'stage.grant_admin', 'user', u.id, { via: 'github-workflow', env: cfg.appEnv });
    return { phone, role: 'admin', changed: true };
  });
}

// Временный контейнер в облаке: вызывает только workflow (IAM-токен), открытого адреса нет.
export function grantServer(sql, cfg, rawPhone) {
  stageAdminPhone(cfg, rawPhone);
  return http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST' || req.url !== '/grant') return send(404, { ok: false });
    try {
      send(200, { ok: true, ...(await stageGrantAdmin(sql, cfg, rawPhone)) });
    } catch (e) {
      send(500, { ok: false, error: e.message });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { loadConfig } = await import('../config.mjs');
  const { createDb } = await import('../db.mjs');
  const cfg = loadConfig();
  const sql = createDb(cfg);
  if (process.argv[2] === 'serve') {
    if (cfg.appEnv !== 'stage') {
      console.error('не удалось: кнопка назначения администратора — только на проверочной площадке (APP_ENV=stage)');
      process.exit(1);
    }
    const port = Number(process.env.PORT || 8080);
    grantServer(sql, cfg, process.env.STAGE_ADMIN_PHONE).listen(port, () => console.log(`назначение администратора площадки: жду вызова на порту ${port}`));
  } else {
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
}
