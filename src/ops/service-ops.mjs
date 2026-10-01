// Служебные операции, которые включаются только в определённых режимах.
import crypto from 'node:crypto';
import { HttpError } from '../http/core.mjs';
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
