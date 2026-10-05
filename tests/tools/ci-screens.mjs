// Снимки проверок — в Yandex Object Storage каталога bertel-delo-test, 7 дней (решение Дамира 05.10.2026, вопрос 22):
// место для снимков у GitHub кончилось, проверки идут на своей машине в облаке (.github/workflows/runner.yml).
//   node tests/tools/ci-screens.mjs setup <bucket> <id сервисного аккаунта снимков>   — бакет, срок 7 дней, право записи
//   node tests/tools/ci-screens.mjs upload <prefix> <папка>...                        — выложить папки (что есть)
//   node tests/tools/ci-screens.mjs download <prefix> <файл> <куда>                  — забрать один файл (нет — не ошибка)
// Ключи: setup — S3_ACCESS_KEY / S3_SECRET_KEY временного ключа технического пользователя; upload/download — CI_S3_*
// из /etc/delo-ci/s3.env на машине проверок (ключ только к бакету снимков).
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, relative, dirname, extname } from 'node:path';
import {
  S3Client, CreateBucketCommand, HeadBucketCommand, PutBucketLifecycleConfigurationCommand, GetBucketAclCommand,
  PutBucketAclCommand, PutObjectCommand, GetObjectCommand,
} from '@aws-sdk/client-s3';

const ENDPOINT = process.env.CI_S3_ENDPOINT || 'https://storage.yandexcloud.net';
const KEEP_DAYS = 7;
const TYPES = { '.png': 'image/png', '.json': 'application/json', '.html': 'text/html', '.pdf': 'application/pdf', '.zip': 'application/zip', '.txt': 'text/plain' };

function client(accessKeyId, secretAccessKey) {
  if (!accessKeyId || !secretAccessKey) throw new Error('нет ключа к хранилищу снимков');
  return new S3Client({ region: 'ru-central1', endpoint: ENDPOINT, credentials: { accessKeyId, secretAccessKey } });
}

async function* files(dir) {
  let list;
  try { list = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of list) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (e.isFile()) yield p;
  }
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'setup') {
  const [Bucket, writerId] = args;
  const s3 = client(process.env.S3_ACCESS_KEY, process.env.S3_SECRET_KEY);
  try { await s3.send(new HeadBucketCommand({ Bucket })); } catch { await s3.send(new CreateBucketCommand({ Bucket, ACL: 'private' })); }
  await s3.send(new PutBucketLifecycleConfigurationCommand({
    Bucket,
    LifecycleConfiguration: { Rules: [{ ID: `keep-${KEEP_DAYS}-days`, Status: 'Enabled', Filter: { Prefix: '' }, Expiration: { Days: KEEP_DAYS } }] },
  }));
  // Право писать и читать — только сервисному аккаунту снимков и только в этом бакете.
  const acl = await s3.send(new GetBucketAclCommand({ Bucket }));
  const grants = (acl.Grants ?? []).filter((g) => g.Grantee?.ID !== writerId);
  for (const Permission of ['READ', 'WRITE']) grants.push({ Grantee: { Type: 'CanonicalUser', ID: writerId }, Permission });
  await s3.send(new PutBucketAclCommand({ Bucket, AccessControlPolicy: { Owner: acl.Owner, Grants: grants } }));
  console.log(`бакет ${Bucket}: снимки хранятся ${KEEP_DAYS} дней, запись — ${writerId}`);
} else if (cmd === 'upload') {
  const [prefix, ...dirs] = args;
  const s3 = client(process.env.CI_S3_ACCESS_KEY, process.env.CI_S3_SECRET_KEY);
  let n = 0, bytes = 0;
  for (const dir of dirs) {
    for await (const f of files(dir)) {
      const Body = await readFile(f);
      await s3.send(new PutObjectCommand({ Bucket: process.env.CI_S3_BUCKET, Key: `${prefix}/${relative('.', f)}`, Body, ContentType: TYPES[extname(f).toLowerCase()] ?? 'application/octet-stream' }));
      n++; bytes += Body.length;
    }
  }
  console.log(`снимков выложено: ${n} (${(bytes / 1048576).toFixed(1)} МБ) → s3://${process.env.CI_S3_BUCKET}/${prefix}/ (хранятся ${KEEP_DAYS} дней)`);
} else if (cmd === 'download') {
  const [prefix, file, dest] = args;
  const s3 = client(process.env.CI_S3_ACCESS_KEY, process.env.CI_S3_SECRET_KEY);
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: process.env.CI_S3_BUCKET, Key: `${prefix}/${file}` }));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(await res.Body.transformToByteArray()));
    console.log(`забран ${file} (${(await stat(dest)).size} байт)`);
  } catch (e) {
    console.log(`файла ${prefix}/${file} нет: ${e.name}`);
  }
} else {
  console.error('команда: setup | upload | download');
  process.exit(2);
}
