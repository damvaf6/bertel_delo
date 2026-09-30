// Хранилище файлов. Один интерфейс для S3-совместимого хранилища (Yandex Object Storage, MinIO в CI)
// и варианта «в памяти» для быстрых проверок. Файлы отдаются только временными ссылками.
//   put(key, body, contentType) · delete(key) · get(key) → Buffer|null · link(key, { filename, ttlSec }) → url
import crypto from 'node:crypto';
import {
  S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const LINK_TTL_SEC = 300;

export function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function s3Storage(s3cfg) {
  const opts = {
    region: s3cfg.region,
    endpoint: s3cfg.endpoint,
    forcePathStyle: s3cfg.forcePathStyle,
    credentials: s3cfg.accessKeyId ? { accessKeyId: s3cfg.accessKeyId, secretAccessKey: s3cfg.secretAccessKey } : undefined,
  };
  const client = new S3Client(opts);
  // Ссылки подписываются на адрес, по которому хранилище видит пользователь.
  const signer = s3cfg.publicEndpoint ? new S3Client({ ...opts, endpoint: s3cfg.publicEndpoint }) : client;
  const Bucket = s3cfg.bucket;

  return {
    kind: 's3',
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        return Buffer.from(await res.Body.transformToByteArray());
      } catch (e) {
        if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
    async link(key, { filename, ttlSec = LINK_TTL_SEC }) {
      const cmd = new GetObjectCommand({ Bucket, Key: key, ResponseContentDisposition: contentDisposition(filename) });
      return getSignedUrl(signer, cmd, { expiresIn: ttlSec });
    },
  };
}

// «В памяти»: ссылка ведёт на сервер ядра (/files/<подписанный токен>), срок и подпись проверяются там.
export function memoryStorage(secret) {
  const objects = new Map();
  const sign = (payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

  return {
    kind: 'memory',
    objects,
    async put(key, body, contentType) { objects.set(key, { body: Buffer.from(body), contentType }); },
    async delete(key) { objects.delete(key); },
    async get(key) { return objects.get(key)?.body ?? null; },
    async link(key, { filename, ttlSec = LINK_TTL_SEC }) {
      const payload = Buffer.from(JSON.stringify({ k: key, f: filename, e: Date.now() + ttlSec * 1000 })).toString('base64url');
      return `/files/${payload}.${sign(payload)}`;
    },
    // Проверка ссылки: null — подделана или истекла.
    open(token) {
      const [payload, sig] = String(token).split('.');
      if (!payload || !sig) return null;
      const expected = sign(payload);
      if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
      const { k, f, e } = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (Date.now() > e) return null;
      const obj = objects.get(k);
      return obj ? { ...obj, filename: f } : null;
    },
  };
}
