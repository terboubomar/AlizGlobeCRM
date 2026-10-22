import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../packages/db/client';
import { ticketScope } from '../apps/api/src/ticket-scope';
import { getRefund, listRefunds, requestRefund, refundScope } from '../apps/api/src/refunds';
import { complaintSearchWhere, complaintSearchInput } from '../apps/api/src/complaint-search';
import { phoneHash } from '../apps/api/src/crypto';
import {
  Actor,
  normalizePhone,
  canWorkComplaint,
  isComplaintParticipant,
} from '../packages/domain/src';
test('agents can find all scoped complaints while work ownership and refund privacy remain enforced', async () => {
  const id = 'agent-scope-' + randomUUID();
  const a: Actor = { id: 'me', name: 'Agent', role: 'AGENT', brandIds: [id], branchIds: [] };
  const before = {
    tickets: await db.ticket.count(),
    refunds: await db.refund.count(),
    brands: await db.brand.count(),
  };
  const rollback = new Error('rollback synthetic scope verification');
  await assert.rejects(
    db.$transaction(async (tx) => {
      await tx.brand.create({
        data: {
          id,
          name: 'Temporary scope check',
          nameEn: 'Temporary',
          logo: 'neutral.svg',
          color: '#aa2222',
        },
      });
      const base = {
        brandId: id,
        source: 'PHONE_AGENT',
        category: 'SERVICE',
        priority: 'P3',
        description: 'Synthetic rollback-only data',
        creator: 'other',
        communicationsOwner: 'other',
        phoneHash: phoneHash(normalizePhone('0500000001')),
        externalOrder: 'SEARCH-ORDER-123',
      };
      const assigned = await tx.ticket.create({ data: { ...base, resolutionOwner: a.id } });
      const comms = await tx.ticket.create({ data: { ...base, communicationsOwner: a.id } });
      const recorded = await tx.ticket.create({ data: { ...base, creator: a.id } });
      const other = await tx.ticket.create({ data: { ...base } });
      const visible = await tx.ticket.findMany({ where: ticketScope(a), select: { id: true } });
      assert.deepEqual(
        visible.map((t) => t.id).sort(),
        [assigned.id, comms.id, recorded.id, other.id].sort(),
      );
      assert.equal(await tx.ticket.count({ where: { ...ticketScope(a), id: other.id } }), 1);
      assert.equal(
        await tx.ticket.count({ where: ticketScope({ ...a, branchIds: ['different-branch'] }) }),
        0,
      );
      assert.equal(await tx.ticket.count({ where: ticketScope({ ...a, role: 'SHIFT_LEAD' }) }), 4);
      assert.ok(!canWorkComplaint(a, other));
      assert.ok(!isComplaintParticipant(a, other));
      assert.ok(isComplaintParticipant(a, recorded));
      await tx.ticket.update({ where: { id: other.id }, data: { state: 'CLOSED' } });
      for (const q of [
        '0500000001',
        '+966500000001',
        'SEARCH-ORDER-123',
        `AG-${other.createdAt.getUTCFullYear()}-${String(other.sequence).padStart(6, '0')}`,
      ]) {
        const where = complaintSearchWhere(a, complaintSearchInput.parse({ q, filter: 'all' }));
        assert.ok(
          (await tx.ticket.findMany({ where, select: { id: true } })).some(
            (t) => t.id === other.id,
          ),
        );
      }
      assert.equal(
        await tx.ticket.count({
          where: complaintSearchWhere(
            a,
            complaintSearchInput.parse({ q: '0500000001', filter: 'closed' }),
          ),
        }),
        1,
      );
      assert.equal(
        await tx.ticket.count({
          where: complaintSearchWhere(
            a,
            complaintSearchInput.parse({ q: '0500000001', brandId: 'not-allowed' }),
          ),
        }),
        0,
      );
      const ownRefund = await tx.refund.create({
        data: {
          brandId: id,
          externalOrder: 'Own',
          platform: 'Local',
          kind: 'REFUND',
          reason: 'Rollback only',
          requester: a.id,
        },
      });
      await tx.refund.create({
        data: {
          brandId: id,
          externalOrder: 'Other',
          platform: 'Local',
          kind: 'REFUND',
          reason: 'Rollback only',
          requester: 'other',
        },
      });
      assert.deepEqual(
        (await tx.refund.findMany({ where: refundScope(a), select: { id: true } })).map(
          (r) => r.id,
        ),
        [ownRefund.id],
      );
      await tx.ticket.update({
        where: { id: other.id },
        data: { escalated: true, resolutionOwner: 'operations', state: 'IN_PROGRESS' },
      });
      await tx.refund.create({
        data: {
          brandId: id,
          ticketId: other.id,
          externalOrder: 'Escalated',
          platform: 'Local',
          kind: 'REFUND',
          reason: 'Rollback only',
          requester: 'other',
        },
      });
      const operations = { ...a, id: 'operations', role: 'OPERATIONS_MANAGER' };
      assert.equal(await tx.ticket.count({ where: ticketScope(operations) }), 1);
      assert.equal(await tx.refund.count({ where: refundScope(operations) }), 1);
      assert.equal(
        await tx.ticket.count({ where: ticketScope({ ...operations, id: 'other-operations' }) }),
        0,
      );
      throw rollback;
    }),
    (error) => error === rollback,
  );
  assert.deepEqual(await listRefunds(a), []);
  await assert.rejects(getRefund(a, 'not-owned'), { status: 404 });
  await assert.rejects(requestRefund(a, {}));
  assert.deepEqual(
    {
      tickets: await db.ticket.count(),
      refunds: await db.refund.count(),
      brands: await db.brand.count(),
    },
    before,
  );
  await db.$disconnect();
});
