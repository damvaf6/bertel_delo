// Создать бакет в S3-совместимом хранилище (MinIO в CI), если его нет.
// node tests/tools/make-bucket.mjs <endpoint> <bucket>   (ключи — S3_ACCESS_KEY / S3_SECRET_KEY, по умолчанию minioadmin)
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';

const [endpoint, Bucket] = process.argv.slice(2);
const client = new S3Client({
  region: 'us-east-1', endpoint, forcePathStyle: true,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY || 'minioadmin', secretAccessKey: process.env.S3_SECRET_KEY || 'minioadmin' },
});
try { await client.send(new HeadBucketCommand({ Bucket })); } catch { await client.send(new CreateBucketCommand({ Bucket })); }
console.log(`бакет ${Bucket} готов`);
