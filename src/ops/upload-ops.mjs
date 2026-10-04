// Прямая загрузка больших файлов (задача 2.49). Контейнер Yandex Serverless Containers принимает запрос не больше
// 3,5 МБ, а отчёт с фото бывает 50 МБ. Поэтому файл идёт прямо в хранилище по подписанной ссылке, мимо ядра:
//   1) «дай ссылку» — ядро проверяет права (как при обычной загрузке) и выдаёт ссылку PUT и подписанный пропуск;
//   2) браузер кладёт файл по ссылке в хранилище;
//   3) «готово» — ядро по пропуску проверяет права ещё раз, смотрит размер файла в хранилище и записывает документ.
// Пропуск подписан секретом приложения и живёт 30 минут: подставить чужой ключ файла или чужую заявку нельзя.
import crypto from 'node:crypto';
import { HttpError } from '../http/core.mjs';
import { FINAL } from '../orders/workflow.mjs';
import { LEVEL, orderLevel, orderSides } from '../access/policy.mjs';
import { UPLOAD_TTL_SEC } from '../providers/storage.mjs';
import { audit, oneOf, text } from './util.mjs';
import { publicDoc, registerDocument } from './core-ops.mjs';

export const DIRECT_UPLOAD_MAX = 100 * 1024 * 1024;
const DOC_KINDS = ['basis', 'other'];

const sign = (secret, payload) => crypto.createHmac('sha256', secret).update(`upload:${payload}`).digest('base64url');

function makePass(cfg, data) {
  const payload = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + UPLOAD_TTL_SEC * 1000 })).toString('base64url');
  return `${payload}.${sign(cfg.appSecret, payload)}`;
}

function readPass(cfg, pass) {
  const [payload, sig] = String(pass ?? '').split('.');
  if (!payload || !sig) return null;
  const expected = sign(cfg.appSecret, payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
  return Date.now() <= p.exp ? p : null;
}

// Можно ли сейчас положить в заявку файл этого вида — те же правила, что у обычной загрузки (core-ops.mjs).
function guard(actor, order, kind) {
  if (kind === 'result') {
    if (!orderSides(actor, order).includes('executor')) throw new HttpError(403, 'forbidden', 'Результат загружает исполнитель');
    if (order.status !== 'in_work') throw new HttpError(409, 'not_in_work', 'Результат добавляется, пока дело в работе');
  } else if (FINAL.includes(order.status)) throw new HttpError(409, 'order_final', 'Заявка завершена — файлы не добавляются');
}

function fileInfo(body) {
  const filename = text(String(body?.filename ?? '').replace(/[\\/\u0000-\u001f]/g, '_'), 'Имя файла', 255);
  const mime = String(body?.mime || 'application/octet-stream').split(';')[0].trim().slice(0, 100) || 'application/octet-stream';
  const size = Number(body?.size);
  if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, 'empty_file', 'Файл пустой');
  if (size > DIRECT_UPLOAD_MAX) throw new HttpError(413, 'too_large', 'Файл больше 100 МБ');
  return { filename, mime, size };
}

async function issue({ actor, order, providers, cfg, res }, kind, body) {
  guard(actor, order, kind);
  const f = fileInfo(body);
  const key = `orders/${order.id}/${crypto.randomUUID()}`;
  const url = await providers.storage.uploadUrl(key, { contentType: f.mime });
  res.status(201);
  return { upload_url: url, content_type: f.mime, pass: makePass(cfg, { o: order.id, u: actor.id, k: key, kind, ...f }) };
}

export function uploadOps() {
  return [
    {
      // Ссылка на прямую загрузку документа заявки (основание, прочее) — тем, кто может добавлять документы.
      id: 'documents.upload_url', method: 'POST', path: '/api/orders/:id/documents/upload-url', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'write' },
      async handler(ctx) { return issue(ctx, oneOf(ctx.body?.kind || 'other', DOC_KINDS, 'Вид документа'), ctx.body); },
    },
    {
      // Ссылка на прямую загрузку файла результата — исполнителю, пока дело в работе.
      id: 'results.upload_url', method: 'POST', path: '/api/orders/:id/results/upload-url', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler(ctx) { return issue(ctx, 'result', ctx.body); },
    },
    {
      // Файл лёг в хранилище — записать документ. Права проверяются заново (дело могли передать, заявку — закрыть);
      // размер — по хранилищу, а не со слов браузера.
      id: 'uploads.complete', method: 'POST', path: '/api/orders/:id/uploads/complete', auth: 'user',
      access: { resource: 'order', param: 'id', need: 'read' },
      async handler(ctx) {
        const { actor, order, providers, sql, res } = ctx;
        const p = readPass(ctx.cfg, ctx.body?.pass);
        if (!p || p.o !== order.id || p.u !== actor.id) throw new HttpError(403, 'forbidden', 'Загрузка не найдена или устарела — загрузите файл ещё раз');
        if (p.kind !== 'result' && orderLevel(actor, order) < LEVEL.write) throw new HttpError(403, 'forbidden', 'Недостаточно прав');
        guard(actor, order, p.kind);
        const head = await providers.storage.head(p.k);
        if (!head || head.size === 0) throw new HttpError(409, 'not_uploaded', 'Файл не дошёл до хранилища — загрузите ещё раз');
        if (head.size > DIRECT_UPLOAD_MAX) {
          await providers.storage.delete(p.k).catch(() => {});
          throw new HttpError(413, 'too_large', 'Файл больше 100 МБ');
        }
        const already = await sql.one`select * from documents where storage_key = ${p.k}`;
        if (already) return { document: publicDoc(already) };
        const doc = await registerDocument(ctx, { filename: p.filename, mime: p.mime, size: head.size, key: p.k, kind: p.kind });
        await audit(sql, actor, 'document.direct_upload', 'document', doc.id, { size: head.size });
        res.status(201);
        return { document: publicDoc(doc) };
      },
    },
  ];
}
