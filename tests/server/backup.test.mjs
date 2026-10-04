// Еженедельная выгрузка базы и учебное восстановление (src/tools/backup.mjs).
// Восстановление — во временную базу на тестовом сервере (RESTORE_ADMIN_URL); вариант «временный PostgreSQL внутри
// контейнера» проверяет CI, запуская образ выгрузки. Хранилище: MinIO, если задан S3_TEST_ENDPOINT, иначе подмена в памяти.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PutObjectCommand, GetObjectCommand, ListObjectsV2Command, S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { startApp, login, DB_URL } from '../helpers.mjs';
import { backupConfig, runBackup, restoreLatest } from '../../src/tools/backup.mjs';

// Подмена хранилища: Content-MD5 обязателен, как в бакете копий с блокировкой от удаления.
function memoryS3() {
  const objects = new Map();
  const times = new Map();
  let tick = Date.parse('2026-10-01T00:00:00Z');
  return {
    objects,
    async send(cmd) {
      const { Key, Body, ContentMD5 } = cmd.input;
      if (cmd instanceof PutObjectCommand) {
        assert.ok(ContentMD5, 'без Content-MD5 бакет копий не примет загрузку');
        assert.equal(crypto.createHash('md5').update(Body).digest('base64'), ContentMD5);
        objects.set(Key, Buffer.from(Body));
        times.set(Key, new Date((tick += 3_600_000)));
        return {};
      }
      if (cmd instanceof GetObjectCommand) {
        const b = objects.get(Key);
        if (!b) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
        return { Body: { transformToByteArray: async () => new Uint8Array(b) } };
      }
      if (cmd instanceof ListObjectsV2Command) {
        return { Contents: [...objects.keys()].filter((k) => k.startsWith(cmd.input.Prefix)).map((k) => ({ Key: k, LastModified: times.get(k), Size: objects.get(k).length })), IsTruncated: false };
      }
      throw new Error(`неожиданная команда ${cmd.constructor.name}`);
    },
  };
}

const s3e = process.env.S3_TEST_ENDPOINT;
const env = (extra = {}) => ({
  DATABASE_URL: DB_URL, DB_SSL: 'disable', RESTORE_ADMIN_URL: DB_URL,
  S3_ENDPOINT: s3e || 'http://s3.invalid', S3_BUCKET: 'delo-test-backups', S3_REGION: 'us-east-1', S3_PATH_STYLE: '1',
  S3_ACCESS_KEY: process.env.S3_TEST_ACCESS_KEY || 'minioadmin', S3_SECRET_KEY: process.env.S3_TEST_SECRET_KEY || 'minioadmin',
  ...extra,
});

let S;
before(async () => {
  S = await startApp();
  await login(S, '+79990001001');
  await login(S, '+79990001002');
});
after(async () => { await S?.close(); });

test('выгрузка: копия в хранилище, учебное восстановление совпадает с базой по таблицам и строкам', async () => {
  const s3 = memoryS3();
  const r = await runBackup(backupConfig(env()), { s3, now: new Date('2026-10-04T23:00:00Z') });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.key, 'weekly/20261004T230000Z.dump');
  assert.deepEqual(r.restore, { tables: true, rows: true });
  assert.ok(s3.objects.get(r.key).length === r.bytes && r.bytes > 0);
  assert.equal(r.counts.users, 2);
  assert.ok(r.counts.schema_migrations >= 11);
  assert.equal(r.tables, Object.keys(r.counts).length);
  // В итоге — только имена таблиц и числа, без содержимого.
  assert.doesNotMatch(JSON.stringify(r), /7999000/);
  // Временная база восстановления удалена.
  const left = await S.sql`select datname from pg_database where datname like 'delo_restore_%'`;
  assert.deepEqual(left, []);
});

test('выгрузка: испорченная копия в хранилище — ошибка, а не «готово»', async () => {
  const s3 = memoryS3();
  const real = s3.send.bind(s3);
  s3.send = async (cmd) => {
    const out = await real(cmd);
    if (cmd instanceof PutObjectCommand) s3.objects.get(cmd.input.Key)[100] ^= 0xff;
    return out;
  };
  await assert.rejects(runBackup(backupConfig(env()), { s3 }), /не совпадает/);
});

test('выгрузка: без сертификата базы не подключается; без бакета и ключей — не запускается', async () => {
  await assert.rejects(runBackup(backupConfig(env({ DB_SSL: '', DB_CA_PATH: '/nonexistent/ca.pem' })), { s3: memoryS3() }),
    /сертификата базы/);
  assert.throws(() => backupConfig(env({ S3_BUCKET: '' })), /S3_BUCKET/);
  assert.throws(() => backupConfig(env({ S3_SECRET_KEY: '' })), /S3_SECRET_KEY/);
});

test('выгрузка в S3-совместимое хранилище (MinIO)', { skip: s3e ? false : 'S3_TEST_ENDPOINT не задан (в CI — MinIO)' }, async () => {
  const cfg = backupConfig(env());
  const c = new S3Client({ region: 'us-east-1', endpoint: s3e, forcePathStyle: true,
    credentials: { accessKeyId: cfg.s3.accessKeyId, secretAccessKey: cfg.s3.secretAccessKey } });
  try { await c.send(new HeadBucketCommand({ Bucket: cfg.s3.bucket })); } catch { await c.send(new CreateBucketCommand({ Bucket: cfg.s3.bucket })); }
  const r = await runBackup(cfg);
  assert.equal(r.ok, true, JSON.stringify(r));
  const got = await c.send(new GetObjectCommand({ Bucket: cfg.s3.bucket, Key: r.key }));
  assert.equal(Number(got.ContentLength), r.bytes);
});

// 2.40: учебное восстановление последней копии, которая уже лежит в хранилище (её сделал таймер), — без новой выгрузки.
test('восстановление последней копии из хранилища: та самая копия, целиком; пусто или испорчено — ошибка', async () => {
  const s3 = memoryS3();
  const cfg = backupConfig(env());
  await assert.rejects(restoreLatest(cfg, { s3 }), /в хранилище нет копий/);
  const first = await runBackup(cfg, { s3, now: new Date('2026-09-27T23:00:00Z') });
  const second = await runBackup(cfg, { s3, now: new Date('2026-10-04T23:00:00Z') });
  assert.ok(first.ok && second.ok);
  // После копии база поменялась — восстановленная копия остаётся снимком на свою дату.
  await login(S, '+79990001003');
  const r = await restoreLatest(cfg, { s3, now: new Date('2026-10-02T00:00:00Z') });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.key, second.key);
  assert.equal(r.copies, 2);
  assert.equal(r.counts.users, 2, 'снимок на дату копии, без нового пользователя');
  assert.ok(r.migrations > 0 && r.tables === second.tables);
  // Испорченная последняя копия — ошибка восстановления, а не «готово».
  s3.objects.set(second.key, Buffer.from('не копия'));
  await assert.rejects(restoreLatest(cfg, { s3 }), /pg_restore/);
});
