import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../packages/db/client';
import { ticketSummary, summaryBuckets } from '../apps/api/src/ticket-summary';
import { ticketScope } from '../apps/api/src/ticket-scope';
import type { Actor } from '../packages/domain/src';

test('dashboard summary counts every bucket exactly as the dashboard defines it', async () => {
  const brand = 'summary-' + randomUUID(),
    other = brand + '-other',
    rollback = new Error('rollback summary verification'),
    now = new Date('2030-06-01T12:00:00Z'),
    past = new Date('2030-06-01T11:00:00Z'),
    future = new Date('2030-06-01T13:00:00Z');
  const a: Actor = {
    id: 'lead',
    name: 'Lead',
    role: 'SHIFT_LEAD',
    brandIds: [brand, other],
    branchIds: [],
  };
  try {
    await assert.rejects(
      db.$transaction(async (tx) => {
        for (const id of [brand, other])
          await tx.brand.create({
            data: { id, name: id, nameEn: id, logo: 'neutral.svg', color: '#aa2222' },
          });
        const branch = await tx.branch.create({
          data: {
            brandId: brand,
            name: 'Branch',
            code: 'SUM-' + randomUUID().slice(0, 8),
            city: 'X',
          },
        });
        const base = {
          brandId: brand,
          branchId: branch.id,
          source: 'PHONE_AGENT',
          category: 'SERVICE',
          priority: 'P3',
          description: 'Synthetic rollback-only data',
          creator: 'other',
          communicationsOwner: 'other',
        };
        const make = async (
          data: Record<string, unknown>,
          timer?: { dueAt: Date; completedAt?: Date },
        ) => {
          const t = await tx.ticket.create({ data: { ...base, ...data } });
          if (timer)
            await tx.timer.create({
              data: { ticketId: t.id, milestone: 'FIRST_ACTION', warningAt: timer.dueAt, ...timer },
            });
        };
        await make({ state: 'NEW' }); // active, waiting
        await make({
          state: 'ASSIGNED',
          resolutionOwner: 'agent',
          escalated: true,
          priority: 'P1',
        }); // active, escalated, urgent
        await make({ state: 'IN_PROGRESS', resolutionOwner: 'agent' }, { dueAt: past }); // active, late, urgent
        await make(
          { state: 'IN_PROGRESS', resolutionOwner: 'agent' },
          { dueAt: past, completedAt: past },
        ); // active
        await make({ state: 'IN_PROGRESS', resolutionOwner: 'agent' }, { dueAt: future }); // active
        await make({ state: 'RESOLVED', resolutionOwner: 'agent' }); // active, followup
        await make({ state: 'CLOSED', resolutionOwner: 'agent' }, { dueAt: past }); // closed (not late)
        await make({ state: 'ASSIGNED', resolutionOwner: branch.id }); // active, waiting (legacy)
        await tx.ticket.create({
          data: { ...base, brandId: other, branchId: null, unknownReason: 'x', state: 'CLOSED' },
        });

        const summary = await ticketSummary(tx, a, now);
        assert.deepEqual(summary[brand], {
          active: 7,
          closed: 1,
          followup: 1,
          waiting: 2,
          escalated: 1,
          late: 1,
          urgent: 2,
        });
        assert.equal(summary[other].closed, 1);
        assert.equal(summary[other].active, 0);

        // The same buckets computed the way the dashboard does on loaded cases.
        const rows = await tx.ticket.findMany({ where: ticketScope(a), include: { timers: true } });
        const open = rows.filter((t) => t.state !== 'CLOSED');
        const late = (t: (typeof rows)[number]) =>
          t.timers.some((x) => !x.completedAt && x.dueAt < now);
        const client = {
          active: open.length,
          closed: rows.filter((t) => t.state === 'CLOSED').length,
          followup: open.filter((t) => t.state === 'RESOLVED').length,
          waiting: open.filter((t) => !t.resolutionOwner || t.resolutionOwner === t.branchId)
            .length,
          escalated: open.filter((t) => t.escalated).length,
          late: open.filter(late).length,
          urgent: open.filter((t) => t.priority === 'P1' || late(t)).length,
        };
        for (const bucket of summaryBuckets)
          assert.equal(
            (summary[brand]?.[bucket] ?? 0) + (summary[other]?.[bucket] ?? 0),
            client[bucket],
            bucket,
          );

        // Scope still applies: a branch-restricted actor elsewhere sees nothing.
        assert.deepEqual(await ticketSummary(tx, { ...a, branchIds: ['elsewhere'] }, now), {});
        throw rollback;
      }),
      (e) => e === rollback,
    );
  } finally {
    await db.$disconnect();
  }
});
