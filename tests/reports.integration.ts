import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../packages/db/client';
import { reportWhere, previousReportPeriod } from '../apps/api/src/reports';
import type { Actor } from '../packages/domain/src';
test('report queries enforce date, source, brand and operations assignment boundaries in SQL', async () => {
  const id = 'reports-' + randomUUID(),
    rollback = new Error('rollback reports verification');
  const a: Actor = {
    id: 'ops',
    name: 'Ops',
    role: 'OPERATIONS_MANAGER',
    brandIds: [id],
    branchIds: [],
  };
  try {
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.brand.create({
          data: {
            id,
            name: 'Rollback report brand',
            nameEn: '',
            logo: 'neutral.svg',
            color: '#b62e30',
          },
        });
        const base = {
          brandId: id,
          source: 'PHONE_AGENT',
          category: 'SERVICE',
          priority: 'P3',
          description: 'Rollback-only report verification',
          creator: 'support',
          communicationsOwner: 'support',
          resolutionOwner: 'ops',
          escalated: true,
        };
        await tx.ticket.create({ data: { ...base, receivedAt: new Date('2030-01-01T21:00:00Z') } });
        await tx.ticket.create({ data: { ...base, receivedAt: new Date('2030-01-02T21:00:00Z') } });
        await tx.ticket.create({
          data: { ...base, resolutionOwner: 'other', receivedAt: new Date('2030-01-01T22:00:00Z') },
        });
        await tx.ticket.create({ data: { ...base, receivedAt: new Date('2030-01-01T20:59:59Z') } });
        const filter = { from: '2030-01-02', to: '2030-01-02' };
        assert.equal(await tx.ticket.count({ where: reportWhere(a, filter).where }), 1);
        assert.equal(
          await tx.ticket.count({ where: reportWhere({ ...a, role: 'CEO' }, filter).where }),
          2,
        );
        assert.equal(
          await tx.ticket.count({ where: reportWhere(a, { ...filter, brandId: 'outside' }).where }),
          0,
        );
        assert.equal(
          await tx.ticket.count({
            where: reportWhere(a, { ...filter, source: 'PUBLIC_QR' }).where,
          }),
          0,
        );
        assert.equal(
          await tx.ticket.count({
            where: reportWhere({ ...a, branchIds: ['outside'] }, filter).where,
          }),
          0,
        );
        assert.equal(
          await tx.ticket.count({ where: reportWhere(a, { ...filter, priority: 'P1' }).where }),
          0,
        );
        assert.equal(
          await tx.ticket.count({ where: reportWhere(a, previousReportPeriod(filter)).where }),
          1,
        );
        throw rollback;
      }),
      (e) => e === rollback,
    );
  } finally {
    await db.$disconnect();
  }
});
