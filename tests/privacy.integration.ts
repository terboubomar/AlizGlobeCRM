import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomInt } from 'node:crypto';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../packages/db/client';
import { createTicketTx, status } from '../apps/api/src/service';
import { decrypt, encrypt } from '../apps/api/src/crypto';
import {
  dueForRetention,
  eraseCase,
  exportCases,
  findCases,
  retentionSweep,
  setLegalHold,
} from '../apps/api/src/privacy';
import type { Actor } from '../packages/domain/src';

// Synthetic data only. The isolated harness runs this against a disposable database.
test('a customer data request exports, then erases personal data but keeps the anonymous case', async () => {
  const id = 'privacy-' + randomUUID(),
    phone = '05' + String(randomInt(10000000, 99999999)),
    uploads = await mkdtemp(join(tmpdir(), 'aliz-privacy-'));
  process.env.UPLOAD_DIR = uploads;
  await db.brand.create({
    data: { id, name: 'Privacy check brand', nameEn: '', logo: 'neutral.svg', color: '#b62e30' },
  });
  await db.branch.create({
    data: { id, brandId: id, name: 'Privacy check branch', code: id, city: 'Test', active: true },
  });
  const qr: Actor = { id: 'QR:' + id, name: 'QR', role: 'PUBLIC', brandIds: [], branchIds: [] };
  const input = {
    brandId: id,
    branchId: id,
    category: 'MISSING',
    priority: 'P3',
    description: 'Synthetic description: the fries were missing from order 77',
    name: 'Synthetic Customer Name',
    phone,
    externalOrder: 'SYN-ORDER-77',
    platform: 'SyntheticApp',
  };
  const key = randomUUID();
  const created = (await db.$transaction((tx) =>
    createTicketTx(tx, qr, input, key, { id, brandId: id, branchId: id }),
  )) as { id: string; number: string; trackingToken: string };
  const ticketId = created.id;

  // Records that also hold personal data or point at it.
  await db.task.create({
    data: {
      ticketId,
      owner: 'lead',
      dueAt: new Date(),
      note: encrypt('Call Synthetic Customer Name back'),
    },
  });
  await db.review.create({
    data: { ticketId, reviewer: 'lead', score: 4, note: 'Spoke to the customer' },
  });
  await db.complaintConfirmation.create({
    data: {
      ticketId,
      payloadEncrypted: encrypt(JSON.stringify({ phone })),
      recipientHash: 'synthetic-recipient',
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  const fileKey = randomUUID() + '.webp';
  await writeFile(join(uploads, fileKey), 'synthetic image bytes');
  await db.attachment.create({
    data: { ticketId, key: fileKey, mime: 'image/webp', size: 21, checksum: 'x', status: 'CLEAN' },
  });
  const refund = await db.refund.create({
    data: {
      ticketId,
      brandId: id,
      branchId: id,
      externalOrder: 'SYN-ORDER-77',
      platform: 'SyntheticApp',
      kind: 'REFUND',
      reason: encrypt('Missing item'),
      requester: 'agent-1',
    },
  });

  // Find by phone and by case number.
  const byPhone = await findCases({ phone });
  assert.deepEqual(
    byPhone.map((c) => c.id),
    [ticketId],
  );
  assert.equal((await findCases({ caseNumber: created.number })).length, 1);
  await assert.rejects(findCases({ caseNumber: 'nonsense' }), /AG-2026-000123/);

  // Export: readable copy of what the customer gave us, audited.
  const exported = await exportCases([ticketId], 'OPERATOR:test');
  const one = exported.cases[0];
  assert.equal(one.description, input.description);
  assert.deepEqual(one.customer, { name: input.name, phone: '966' + phone.slice(1) });
  assert.equal(one.externalOrder, input.externalOrder);
  assert.equal(one.photos.length, 1);
  assert.equal(
    await db.audit.count({ where: { entityId: ticketId, action: 'PERSONAL_DATA_EXPORTED' } }),
    1,
  );

  // A legal hold blocks erasure.
  await setLegalHold(ticketId, true, 'OPERATOR:test');
  assert.deepEqual(await eraseCase(ticketId, 'OPERATOR:test'), {
    id: ticketId,
    number: created.number,
    result: 'skipped',
    reason: 'legal_hold',
  });
  await setLegalHold(ticketId, false, 'OPERATOR:test');

  // A refund still in progress blocks erasure; a finished one does not.
  assert.equal((await eraseCase(ticketId, 'OPERATOR:test')).result, 'skipped');
  await db.refund.update({ where: { id: refund.id }, data: { status: 'COMPLETED' } });

  const erased = await eraseCase(ticketId, 'OPERATOR:test');
  assert.equal(erased.result, 'erased');

  const t = await db.ticket.findUniqueOrThrow({ where: { id: ticketId } });
  assert.ok(t.erasedAt);
  assert.equal(decrypt(t.description), '');
  for (const field of [
    'customer',
    'phoneHash',
    'externalOrder',
    'platform',
    'receiptEncrypted',
  ] as const)
    assert.equal(t[field], null, field);
  // The anonymous record stays for statistics.
  assert.equal(t.brandId, id);
  assert.equal(t.category, 'MISSING');
  assert.equal(t.source, 'PUBLIC_QR');

  // The tracking link and the retry cache are gone; staff and QA notes are blanked.
  await assert.rejects(status(created.trackingToken), { status: 404 });
  assert.equal(await db.idempotency.count({ where: { key: qr.id + ':' + key } }), 0);
  const task = await db.task.findFirstOrThrow({ where: { ticketId } });
  assert.equal(decrypt(task.note), '');
  assert.equal((await db.review.findFirstOrThrow({ where: { ticketId } })).note, '');
  const confirmation = await db.complaintConfirmation.findUniqueOrThrow({ where: { ticketId } });
  assert.equal(confirmation.recipientHash, 'ERASED');
  assert.equal(decrypt(confirmation.payloadEncrypted), '{}');

  // The photo file is deleted and its record marked.
  assert.equal(
    (await db.attachment.findUniqueOrThrow({ where: { key: fileKey } })).status,
    'ERASED',
  );
  await assert.rejects(access(join(uploads, fileKey)), { code: 'ENOENT' });

  // Erasure is audited, the phone no longer finds the case, and it cannot be undone.
  assert.equal(
    await db.audit.count({ where: { entityId: ticketId, action: 'PERSONAL_DATA_ERASED' } }),
    1,
  );
  assert.equal((await findCases({ phone })).length, 0);
  await assert.rejects(
    db.ticket.update({ where: { id: ticketId }, data: { customer: encrypt('{"name":"x"}') } }),
    /cannot be restored/,
  );
  assert.equal((await eraseCase(ticketId, 'OPERATOR:test')).result, 'skipped');
});

test('retention erases only closed cases past the period, never ones on legal hold', async () => {
  const id = 'retention-' + randomUUID(),
    longAgo = new Date('2004-01-01T00:00:00Z'),
    days = 7000; // ~19 years: nothing else in the test database is this old
  await db.brand.create({
    data: { id, name: 'Retention check brand', nameEn: '', logo: 'neutral.svg', color: '#b62e30' },
  });
  const base = {
    brandId: id,
    source: 'PHONE_AGENT',
    category: 'SERVICE',
    priority: 'P3',
    description: encrypt('Synthetic retention description'),
    customer: encrypt(JSON.stringify({ name: 'Synthetic', phone: '' })),
    creator: 'lead',
    communicationsOwner: 'lead',
  };
  const old = await db.ticket.create({ data: { ...base, state: 'CLOSED', closedAt: longAgo } });
  const held = await db.ticket.create({
    data: { ...base, state: 'CLOSED', closedAt: longAgo, legalHold: true },
  });
  const recent = await db.ticket.create({
    data: { ...base, state: 'CLOSED', closedAt: new Date() },
  });
  const open = await db.ticket.create({ data: { ...base, state: 'IN_PROGRESS' } });

  const due = (await dueForRetention(days)).map((t) => t.id);
  assert.ok(due.includes(old.id));
  for (const t of [held, recent, open]) assert.ok(!due.includes(t.id));

  const dry = await retentionSweep(days, { dryRun: true });
  assert.ok(dry.due >= 1);
  assert.equal(dry.erased, 0);
  assert.equal((await db.ticket.findUniqueOrThrow({ where: { id: old.id } })).erasedAt, null);

  await retentionSweep(days);
  assert.ok((await db.ticket.findUniqueOrThrow({ where: { id: old.id } })).erasedAt);
  for (const t of [held, recent, open])
    assert.equal((await db.ticket.findUniqueOrThrow({ where: { id: t.id } })).erasedAt, null);
  assert.equal(
    await db.audit.count({
      where: { entityId: old.id, action: 'RETENTION_ERASED', actor: 'RETENTION' },
    }),
    1,
  );
});
