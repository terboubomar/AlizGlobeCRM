import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../packages/db/client';
import { createTicketTx, status, present, include } from '../apps/api/src/service';
import type { Actor } from '../packages/domain/src';
test('receipt creation and replay stay encrypted and token-scoped in one rollback-only transaction', async () => {
  const id = 'receipt-rollback-' + randomUUID(),
    key = randomUUID(),
    rollback = new Error('rollback receipt test'),
    a: Actor = {
      id: 'QR:' + id,
      name: 'Synthetic receipt test',
      role: 'PUBLIC',
      brandIds: [],
      branchIds: [],
    };
  try {
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.brand.create({
          data: {
            id,
            name: 'Rollback receipt verification',
            nameEn: '',
            logo: 'neutral.svg',
            color: '#b62e30',
          },
        });
        await tx.branch.create({
          data: {
            id,
            brandId: id,
            name: 'Rollback receipt branch',
            code: id,
            city: 'Test',
            active: true,
          },
        });
        const input = {
          brandId: id,
          branchId: id,
          category: 'SERVICE',
          priority: 'P3',
          description: 'Synthetic receipt details in rolled back transaction',
          name: 'Synthetic customer',
          externalOrder: 'TEST-RECEIPT-123',
        };
        const qr = { id, brandId: id, branchId: id };
        const result = (await createTicketTx(tx, a, input, key, qr)) as {
          id: string;
          trackingToken: string;
          receipt: { description: string; branch: string };
          confirmationStatus: string;
        };
        assert.equal(result.receipt.description, input.description);
        assert.equal(result.receipt.branch, 'Rollback receipt branch');
        assert.equal(result.confirmationStatus, 'NOT_REQUESTED');
        assert.deepEqual(await createTicketTx(tx, a, input, key, qr), result);
        assert.equal(await tx.ticket.count({ where: { brandId: id } }), 1);
        assert.equal(await tx.complaintConfirmation.count({ where: { ticketId: result.id } }), 0);
        const stored = await tx.ticket.findUniqueOrThrow({ where: { id: result.id }, include });
        assert.ok(!stored.receiptEncrypted?.includes(input.description));
        const cached = await tx.idempotency.findUniqueOrThrow({ where: { key: a.id + ':' + key } });
        assert.ok(!JSON.stringify(cached.response).includes(input.description));
        assert.ok(!JSON.stringify(cached.response).includes(input.name));
        assert.equal(
          (await status(result.trackingToken, tx)).receipt.description,
          input.description,
        );
        await assert.rejects(status('not-a-valid-tracking-token', tx), { status: 404 });
        const view = present(stored, {
          id: 'exec',
          name: 'Exec',
          role: 'CEO',
          brandIds: [id],
          branchIds: [],
        });
        assert.ok(!('receiptEncrypted' in view));
        assert.ok(!JSON.stringify(view).includes(input.description));
        throw rollback;
      }),
      (e) => e === rollback,
    );
    assert.equal(await db.ticket.count({ where: { brandId: id } }), 0);
  } finally {
    await db.$disconnect();
  }
});
