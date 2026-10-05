// Операции открытой демо-площадки (только APP_ENV=demo; решение Дамира 05.10.2026, вопрос 21, вариант Б).
// Вход — кнопкой «Войти как …» за одного из вымышленных демо-людей (никаких телефонов и кодов: вход по номеру на
// демо-площадке выключен, src/app.mjs). Сброс — раз в ночь из workflow «Demo (Yandex Cloud)» по ключу из Lockbox.
import crypto from 'node:crypto';
import { HttpError, rateLimiter, sessionCookie } from '../http/core.mjs';
import { openSession, SESSION_TTL_SEC } from '../auth/auth.mjs';
import { DEMO_ROLES, demoPerson, resetDemo } from '../demo/demo.mjs';
import { publicUser } from './util.mjs';

export function demoOps(cfg) {
  if (cfg.appEnv !== 'demo') return [];
  const expected = crypto.createHash('sha256').update(cfg.demoResetKey).digest();
  const limit = rateLimiter({ windowMs: 10 * 60_000, max: 60 });
  let resetting = false;
  return [
    {
      id: 'demo.roles', method: 'GET', path: '/api/demo/roles', auth: 'public',
      publicReason: 'кнопки входа демо-площадки: вымышленные роли без данных',
      async handler() {
        return { roles: DEMO_ROLES.map(({ as, title, hint }) => ({ as, title, hint })) };
      },
    },
    {
      id: 'demo.login', method: 'POST', path: '/api/demo/login', auth: 'public',
      publicReason: 'вход кнопкой за вымышленного демо-человека — только на демо-площадке',
      rateLimit: (ip) => limit(`demo-login:${ip}`),
      async handler({ sql, body, res }) {
        const p = demoPerson(String(body?.as ?? ''));
        if (!p) throw new HttpError(404, 'not_found', 'Нет такой демо-роли');
        const { user, token } = await openSession(sql, p.phone, 'auth.demo_login');
        res.setHeader('Set-Cookie', sessionCookie(cfg, token, SESSION_TTL_SEC));
        return { user: publicUser(user) };
      },
    },
    {
      id: 'demo.reset', method: 'POST', path: '/__demo/reset', auth: 'public',
      publicReason: 'ночной сброс демо-данных — только по ключу из хранилища ключей',
      rateLimit: (ip) => limit(`demo-reset:${ip}`),
      async handler({ sql, req, cfg: c }) {
        const got = crypto.createHash('sha256').update(req.get('x-demo-reset') || '').digest();
        if (!crypto.timingSafeEqual(got, expected)) throw new HttpError(404, 'not_found', 'Не найдено');
        if (resetting) throw new HttpError(409, 'busy', 'Сброс уже идёт');
        resetting = true;
        try {
          const base = `http://127.0.0.1:${req.socket.localPort || c.port}`;
          return { ok: true, ...(await resetDemo({ sql, base })) };
        } finally {
          resetting = false;
        }
      },
    },
  ];
}
