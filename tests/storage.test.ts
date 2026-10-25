import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  sealFile,
  openFile,
  storageDriver,
  putFile,
  getFile,
  removeFile,
} from '../apps/api/src/storage';
import { scanWithClamd } from '../apps/api/src/scanner';
import { fakeClamd } from './helpers/fake-clamd';

process.env.PII_KEY ??= randomBytes(32).toString('hex');

const photo = Buffer.concat([Buffer.from('RIFF0000WEBPVP8 '), randomBytes(2000)]);

test('stored photos are encrypted and tamper-evident', () => {
  const sealed = sealFile(photo);
  assert.ok(!sealed.includes(photo.subarray(16, 64)), 'ciphertext must not contain the image');
  assert.deepEqual(openFile(sealed), photo);
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => openFile(tampered));
  // A plain object in the bucket is refused; only the local driver reads old plain files.
  assert.throws(() => openFile(photo), /not encrypted/);
  assert.deepEqual(openFile(photo, true), photo);
});

test('the local driver writes only encrypted bytes and rejects unsafe keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aliz-store-'));
  const previous = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = dir;
  try {
    await putFile('a.webp', photo);
    const raw = await readFile(join(dir, 'a.webp'));
    assert.equal(raw.subarray(0, 4).toString(), 'AGF1');
    assert.deepEqual(await getFile('a.webp'), photo);
    await assert.rejects(putFile('a.webp', photo), 'never overwrites');
    for (const key of ['../x', '.env', 'a/b', '']) await assert.rejects(getFile(key), /Invalid/);
    await removeFile('a.webp');
    await removeFile('a.webp');
    assert.deepEqual(await readdir(dir), []);
  } finally {
    process.env.UPLOAD_DIR = previous;
  }
});

test('production requires object storage', () => {
  assert.equal(storageDriver({}), 'fs');
  assert.equal(storageDriver({ NODE_ENV: 'production', STORAGE_DRIVER: 's3' }), 's3');
  assert.throws(() => storageDriver({ NODE_ENV: 'production' }), /STORAGE_DRIVER=s3/);
  assert.throws(() => storageDriver({ STORAGE_DRIVER: 'ftp' }), /fs or s3/);
});

test('the clamd client sends the whole file and reads the verdict', async () => {
  let received: Buffer = Buffer.alloc(0);
  const big = randomBytes(200 * 1024);
  const clamd = await fakeClamd((body) => {
    received = body;
    return body.includes('EICAR') ? 'stream: Eicar-Test-Signature FOUND' : 'stream: OK';
  });
  try {
    assert.deepEqual(await scanWithClamd(clamd.url, big), { clean: true });
    assert.deepEqual(received, big, 'sent in chunks, reassembled exactly');
    assert.deepEqual(await scanWithClamd(clamd.url, Buffer.from('xx EICAR xx')), {
      clean: false,
      signature: 'Eicar-Test-Signature',
    });
  } finally {
    clamd.server.close();
  }
});

test('scanner errors, silence and bad addresses never count as clean', async () => {
  const failing = await fakeClamd(() => 'INSTREAM size limit exceeded. ERROR');
  const silent = await fakeClamd(() => null);
  try {
    await assert.rejects(scanWithClamd(failing.url, photo), /scanner error/);
    await assert.rejects(scanWithClamd(silent.url, photo, 300), /timed out/);
    await assert.rejects(scanWithClamd('tcp://127.0.0.1:1', photo));
    assert.throws(() => scanWithClamd('http://clamav:3310', photo), /tcp:\/\//);
  } finally {
    failing.server.close();
    silent.server.close();
  }
});
