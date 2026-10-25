import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { db } from '../packages/db/client';
import { createTicketTx } from '../apps/api/src/service';
import { upload } from '../apps/api/src/uploads';
import { getFile } from '../apps/api/src/storage';
import type { Actor } from '../packages/domain/src';
import { fakeClamd } from './helpers/fake-clamd';

// Outside demo mode every photo is malware-scanned before it is stored.
// Synthetic data only, in the harness's disposable database.
test('uploads are scanned: infected or unscanned photos are refused and nothing is kept', async () => {
  const id = 'upload-' + randomUUID(),
    uploads = await mkdtemp(join(tmpdir(), 'aliz-uploads-'));
  const previous = {
    DEMO_MODE: process.env.DEMO_MODE,
    MALWARE_SCANNER: process.env.MALWARE_SCANNER,
    UPLOAD_DIR: process.env.UPLOAD_DIR,
  };
  let verdict = 'stream: OK';
  const clamd = await fakeClamd(() => verdict);
  Object.assign(process.env, { MALWARE_SCANNER: clamd.url, UPLOAD_DIR: uploads });
  try {
    await db.brand.create({
      data: {
        id,
        name: 'Upload check brand',
        nameEn: '',
        logo: 'neutral.svg',
        color: '#b62e30',
        status: 'ACTIVE',
      },
    });
    await db.branch.create({
      data: { id, brandId: id, name: 'Upload check branch', code: id, city: 'Test', active: true },
    });
    const qr: Actor = { id: 'QR:' + id, name: 'QR', role: 'PUBLIC', brandIds: [], branchIds: [] };
    const created = (await db.$transaction((tx) =>
      createTicketTx(
        tx,
        qr,
        {
          brandId: id,
          branchId: id,
          category: 'QUALITY',
          priority: 'P3',
          description: 'Synthetic upload check',
        },
        randomUUID(),
        { id, brandId: id, branchId: id },
      ),
    )) as { id: string; trackingToken: string };
    // The case is opened in demo mode; the uploads below run as in production.
    process.env.DEMO_MODE = 'false';
    const jpeg = await sharp({
      create: { width: 40, height: 30, channels: 3, background: '#c0392b' },
    })
      .jpeg()
      .toBuffer();
    const file = { buffer: jpeg, size: jpeg.length, mimetype: 'image/jpeg' };
    const send = () => upload(created.id, [file], undefined, created.trackingToken);
    const stored = () => db.attachment.count({ where: { ticketId: created.id } });

    verdict = 'stream: Win.Test.Synthetic FOUND';
    await assert.rejects(send(), { code: 'MALWARE_FOUND', status: 422 });
    verdict = 'stream: ERROR';
    await assert.rejects(send(), { code: 'SCANNER_UNAVAILABLE', status: 503 });
    delete process.env.MALWARE_SCANNER;
    await assert.rejects(send(), { code: 'SCANNER_UNAVAILABLE', status: 503 });
    assert.equal(await stored(), 0);
    assert.deepEqual(await readdir(uploads), [], 'refused photos leave no file behind');

    process.env.MALWARE_SCANNER = clamd.url;
    verdict = 'stream: OK';
    await send();
    const [attachment] = await db.attachment.findMany({ where: { ticketId: created.id } });
    assert.equal(attachment.status, 'CLEAN');
    const onDisk = await readFile(join(uploads, attachment.key));
    assert.equal(onDisk.subarray(0, 4).toString(), 'AGF1', 'stored encrypted');
    const image = await sharp(await getFile(attachment.key)).metadata();
    assert.equal(image.format, 'webp');
  } finally {
    clamd.server.close();
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});
