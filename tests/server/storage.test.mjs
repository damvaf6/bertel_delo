// Хранилище файлов: один набор проверок для «в памяти» и для S3-совместимого хранилища (MinIO в CI).
// S3-часть запускается, когда задан S3_TEST_ENDPOINT (в CI — всегда; локально — если поднят MinIO).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { memoryStorage, s3Storage } from '../../src/providers/storage.mjs';
import { loadConfig } from '../../src/config.mjs';
import { startApp, login, s3TestEnv, testEnv } from '../helpers.mjs';

const s3env = s3TestEnv();
const skipS3 = s3env ? false : 'S3_TEST_ENDPOINT не задан (в CI проверяется против MinIO)';

async function ensureBucket(cfg) {
  const c = new S3Client({ region: cfg.region, endpoint: cfg.endpoint, forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } });
  try { await c.send(new HeadBucketCommand({ Bucket: cfg.bucket })); } catch { await c.send(new CreateBucketCommand({ Bucket: cfg.bucket })); }
}

async function fetchLink(url, base) {
  return fetch(new URL(url, base));
}

async function contract(storage, base) {
  const key = `test/${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const body = Buffer.from('Тестовое содержимое · проверка хранилища');
  await storage.put(key, body, 'text/plain; charset=utf-8');
  assert.deepEqual(await storage.get(key), body);

  const url = await storage.link(key, { filename: 'Отчёт.txt', ttlSec: 60 });
  const r = await fetchLink(url, base);
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), body);
  assert.match(r.headers.get('content-disposition'), /attachment; .*filename\*=UTF-8''%D0%9E%D1%82%D1%87%D1%91%D1%82\.txt/);

  const short = await storage.link(key, { filename: 'a.txt', ttlSec: 1 });
  await new Promise((res) => setTimeout(res, 2100));
  assert.notEqual((await fetchLink(short, base)).status, 200, 'просроченная ссылка не работает');

  await storage.delete(key);
  assert.equal(await storage.get(key), null);
  assert.notEqual((await fetchLink(url, base)).status, 200, 'после удаления файл не выдаётся');
}

let S3stack;
after(async () => { await S3stack?.close(); });

test('хранилище «в памяти»: положить, ссылка, срок, удалить', async () => {
  const S = await startApp();
  try { await contract(S.providers.storage, S.base); } finally { await S.close(); }
});

test('S3 (MinIO): положить, временная ссылка, срок, удалить', { skip: skipS3 }, async () => {
  const cfg = loadConfig(testEnv(s3env));
  await ensureBucket(cfg.s3);
  await contract(s3Storage(cfg.s3));
});

test('S3 (MinIO): путь документа через ядро — загрузка, ссылка, чужой не получает, удаление', { skip: skipS3 }, async () => {
  S3stack = await startApp(s3env);
  await ensureBucket(S3stack.cfg.s3);
  const owner = await login(S3stack, '+79990000301');
  const stranger = await login(S3stack, '+79990000302');
  const order = (await owner.req('POST', '/api/orders', { module: 'expertise', service: 'realty', title: 'Заявка с файлом в S3' })).body.order;
  const up = await owner.req('POST', `/api/orders/${order.id}/documents`, Buffer.from('PDF-заглушка'), {
    raw: true, headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('заключение.pdf') },
  });
  assert.equal(up.status, 201);
  const doc = up.body.document;
  const [{ storage_key: key }] = await S3stack.sql`select storage_key from documents where id = ${doc.id}`;
  assert.match(key, new RegExp(`^orders/${order.id}/[0-9a-f-]{36}$`), 'в ключе нет имени файла пользователя');

  assert.equal((await stranger.req('GET', `/api/documents/${doc.id}/link`)).status, 404);
  const { url } = (await owner.req('GET', `/api/documents/${doc.id}/link`)).body;
  assert.match(url, /X-Amz-Signature=/);
  assert.equal(await (await fetch(url)).text(), 'PDF-заглушка');

  assert.equal((await owner.req('DELETE', `/api/documents/${doc.id}`)).status, 204);
  assert.equal(await S3stack.providers.storage.get(key), null);
});

test('memoryStorage не принимает чужую подпись', async () => {
  const a = memoryStorage('a'.repeat(40));
  const b = memoryStorage('b'.repeat(40));
  await a.put('k', Buffer.from('x'), 'text/plain');
  await b.put('k', Buffer.from('x'), 'text/plain');
  const url = await a.link('k', { filename: 'x' });
  assert.equal(b.open(url.slice('/files/'.length)), null);
  assert.ok(a.open(url.slice('/files/'.length)));
});
