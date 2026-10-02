// Служебные операции, которые включаются только в определённых режимах.
import crypto from 'node:crypto';
import { HttpError, rateLimiter, sessionCookie } from '../http/core.mjs';
import { STAGE_LOGIN_ENVS } from '../config.mjs';
import { openSession, SESSION_TTL_SEC } from '../auth/auth.mjs';
import { phoneFrom, publicUser } from './util.mjs';
import { contentDisposition } from '../providers/storage.mjs';
import { processInbound, receiveMail } from '../mail/inbound.mjs';
import { deliverMail } from '../mail/outbox.mjs';

// Хранилище «в памяти»: выдача по подписанной временной ссылке (как у S3).
export function memoryFileOps() {
  return [{
    id: 'files.memory', method: 'GET', path: '/files/:token', auth: 'public',
    publicReason: 'временная ссылка с подписью и сроком — только при хранилище «в памяти» (тесты)',
    async handler({ params, providers, res }) {
      const file = providers.storage.open(params.token);
      if (!file) throw new HttpError(404, 'not_found', 'Ссылка устарела');
      res.setHeader('Content-Type', file.contentType || 'application/octet-stream');
      res.setHeader('Content-Disposition', contentDisposition(file.filename));
      res.end(file.body);
    },
  }];
}

// Тестовые номера: +7 999 000-xx-xx (устав: тестовые данные помечены).
export const TEST_PHONE = /^\+7999000\d{4}$/;

// Служебный вход тестовыми номерами на проверочной площадке (решение Дамира 02.10.2026, вариант А): сама площадка
// закрыта от посторонних (вызов только с ключом технического пользователя облака), а вход — по отдельному ключу
// из хранилища ключей. Без кода из СМС, только номера +7999000xxxx. На prod операции нет: ключ там запрещён
// настройкой (config.mjs), а здесь — повторная проверка контура.
export function stageLoginOps(cfg) {
  if (!cfg.stageLoginKey || !STAGE_LOGIN_ENVS.includes(cfg.appEnv)) return [];
  const expected = crypto.createHash('sha256').update(cfg.stageLoginKey).digest();
  const limit = rateLimiter({ windowMs: 10 * 60_000, max: 60 });
  return [{
    id: 'stage.login', method: 'POST', path: '/__stage/login', auth: 'public',
    publicReason: 'служебный вход тестовыми номерами — только на закрытой проверочной площадке, по ключу из хранилища ключей',
    rateLimit: (ip) => limit(`stage-login:${ip}`),
    async handler({ req, body, sql, res }) {
      const got = crypto.createHash('sha256').update(req.get('x-stage-login') || '').digest();
      if (!crypto.timingSafeEqual(got, expected)) throw new HttpError(404, 'not_found', 'Не найдено');
      const phone = phoneFrom(body?.phone);
      if (!TEST_PHONE.test(phone)) throw new HttpError(403, 'not_test_phone', 'Служебный вход — только для тестовых номеров +7 999 000-xx-xx');
      const { user, token } = await openSession(sql, phone, 'auth.stage_login');
      res.setHeader('Set-Cookie', sessionCookie(cfg, token, SESSION_TTL_SEC));
      return { user: publicUser(user) };
    },
  }];
}

// Автотесты читают вызовы поддельных поставщиков и задают им сценарий. Только APP_ENV=test и по служебному токену.
export function testControlOps(cfg) {
  const expected = Buffer.from(cfg.testControlToken);
  const guard = (req) => {
    const got = Buffer.from(req.get('x-test-control') || '');
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) throw new HttpError(404, 'not_found', 'Не найдено');
  };
  const fakeOf = (providers, name) => {
    const f = providers[name];
    if (!f || !f.calls) throw new HttpError(404, 'not_found', 'Нет такого поставщика');
    return f;
  };
  const reason = 'только APP_ENV=test, по служебному токену';
  return [
    {
      id: 'test.calls', method: 'GET', path: '/__test/fakes/:name/calls', auth: 'public', publicReason: reason,
      async handler({ req, params, providers }) { guard(req); return { calls: fakeOf(providers, params.name).calls }; },
    },
    {
      id: 'test.script', method: 'POST', path: '/__test/fakes/:name/script', auth: 'public', publicReason: reason,
      async handler({ req, params, providers, body }) { guard(req); fakeOf(providers, params.name).script(body); },
    },
    {
      // Письмо на особый адрес (заявка по письму, 1.9): кладётся в ящик поддельной почты и сразу разбирается.
      id: 'test.mail.inbound', method: 'POST', path: '/__test/mail/inbound', auth: 'public', publicReason: reason,
      async handler(ctx) {
        guard(ctx.req);
        const b = ctx.body ?? {};
        const letter = ctx.providers.mail.deliver({
          from: b.from, subject: b.subject ?? '', text: b.text ?? '', inReplyTo: b.in_reply_to ?? [],
          ...(b.authenticated === false ? { authenticated: false } : {}), ...(b.auto_reply ? { autoReply: true } : {}),
          attachments: (b.attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.content_type, content: Buffer.from(a.base64 ?? '', 'base64') })),
        });
        await receiveMail(ctx);
        await processInbound(ctx);
        await deliverMail(ctx.sql, ctx.providers, ctx.cfg);
        const [row] = await ctx.sql`select id, outcome, status, order_id, attempts from mail_inbound where provider_id = ${letter.id}`;
        return { message_id: letter.messageId, inbound: row ?? null };
      },
    },
    {
      id: 'test.reset', method: 'POST', path: '/__test/fakes/reset', auth: 'public', publicReason: reason,
      async handler({ req, providers }) { guard(req); for (const p of Object.values(providers)) p.reset?.(); },
    },
  ];
}
