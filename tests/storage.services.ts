import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { CreateBucketCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getFile, putFile, removeFile } from '../apps/api/src/storage';
import { scan } from '../apps/api/src/scanner';

// Runs against a real S3-compatible store and a real clamd (CI starts both;
// see the `storage` job). Settings come from S3_* and MALWARE_SCANNER.

process.env.PII_KEY ??= randomBytes(32).toString('hex');
process.env.STORAGE_DRIVER = 's3';
const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

const raw = new S3Client({
  region: process.env.S3_REGION || 'us-east-1',
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
  },
});

test('photos round-trip through object storage encrypted, and erase removes them', async () => {
  await raw.send(new CreateBucketCommand({ Bucket: process.env.S3_BUCKET! })).catch(() => {});
  const key = randomUUID() + '.webp',
    photo = randomBytes(300 * 1024);
  await putFile(key, photo);
  const stored = await raw.send(
    new GetObjectCommand({
      Bucket: process.env.S3_BUCKET!,
      Key: (process.env.S3_PREFIX ?? 'attachments/') + key,
    }),
  );
  const bytes = Buffer.from(await stored.Body!.transformToByteArray());
  assert.equal(bytes.subarray(0, 4).toString(), 'AGF1', 'the provider only sees ciphertext');
  assert.ok(!bytes.includes(photo.subarray(0, 64)));
  assert.deepEqual(await getFile(key), photo);
  await removeFile(key);
  await assert.rejects(getFile(key));
});

test('the real scanner passes clean files and catches the EICAR test file', async () => {
  assert.deepEqual(await scan(randomBytes(4096)), { clean: true });
  const result = await scan(Buffer.from(eicar));
  assert.equal(result.clean, false);
  assert.match((result as { signature: string }).signature, /Eicar/i);
});
