import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

// Private photo storage. Files are encrypted by the app (AES-256-GCM, key
// derived from PII_KEY) before they leave the process, so the storage
// provider never holds readable customer photos, whichever provider it is.
// Drivers: `fs` (a private directory; local and demo) and `s3` (any
// S3-compatible object store; required in production).

const MAGIC = Buffer.from('AGF1');

function fileKey() {
  const value = process.env.PII_KEY;
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) throw new Error('PII_KEY must be 32-byte hex');
  return Buffer.from(hkdfSync('sha256', Buffer.from(value, 'hex'), '', 'aliz-files-v1', 32));
}

export function sealFile(plain: Buffer) {
  const iv = randomBytes(12),
    c = createCipheriv('aes-256-gcm', fileKey(), iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}

export function openFile(stored: Buffer, allowPlain = false) {
  // Files written before encryption was added are plain images; only the
  // local driver can hold them.
  if (!stored.subarray(0, 4).equals(MAGIC)) {
    if (allowPlain) return stored;
    throw new Error('Stored file is not encrypted');
  }
  const iv = stored.subarray(4, 16),
    tag = stored.subarray(16, 32),
    d = createDecipheriv('aes-256-gcm', fileKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(stored.subarray(32)), d.final()]);
}

const safeKey = (key: string) => {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(key) || key.startsWith('.'))
    throw new Error('Invalid storage key');
  return key;
};

type Driver = {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
};

const dir = () => resolve(process.env.UPLOAD_DIR ?? '.data/uploads');

const fsDriver: Driver = {
  async put(key, body) {
    await mkdir(dir(), { recursive: true });
    await writeFile(resolve(dir(), key), body, { flag: 'wx', mode: 0o600 });
  },
  get: (key) => readFile(resolve(dir(), key)),
  async remove(key) {
    await unlink(resolve(dir(), key)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
  },
};

let client: S3Client | undefined;
function s3() {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
  client ??= new S3Client({
    region: process.env.S3_REGION || 'us-east-1',
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    // Falls back to the SDK's standard chain (instance role, env) when unset.
    credentials: process.env.S3_ACCESS_KEY_ID
      ? {
          accessKeyId: process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
        }
      : undefined,
  });
  return { client, bucket, prefix: process.env.S3_PREFIX ?? 'attachments/' };
}

const s3Driver: Driver = {
  async put(key, body) {
    const { client, bucket, prefix } = s3();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: prefix + key,
        Body: body,
        ContentType: 'application/octet-stream',
        // Never overwrite an existing object.
        IfNoneMatch: '*',
      }),
    );
  },
  async get(key) {
    const { client, bucket, prefix } = s3();
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: prefix + key }));
    return Buffer.from(await out.Body!.transformToByteArray());
  },
  async remove(key) {
    const { client, bucket, prefix } = s3();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: prefix + key }));
  },
};

export function storageDriver(env = process.env) {
  const name = env.STORAGE_DRIVER || 'fs';
  if (name !== 'fs' && name !== 's3') throw new Error('STORAGE_DRIVER must be fs or s3');
  if (env.NODE_ENV === 'production' && name !== 's3')
    throw new Error('Production stores photos in managed object storage: set STORAGE_DRIVER=s3');
  return name;
}

const driver = () => (storageDriver() === 's3' ? s3Driver : fsDriver);

export const putFile = (key: string, plain: Buffer) => driver().put(safeKey(key), sealFile(plain));
export const getFile = async (key: string) =>
  openFile(await driver().get(safeKey(key)), storageDriver() === 'fs');
export const removeFile = (key: string) => driver().remove(safeKey(key));
