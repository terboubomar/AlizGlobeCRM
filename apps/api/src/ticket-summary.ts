import { Prisma } from '@prisma/client';
import { Actor } from '../../../packages/domain/src';
import { ticketScope } from './ticket-scope';

export const summaryBuckets = [
  'active',
  'closed',
  'followup',
  'waiting',
  'escalated',
  'late',
  'urgent',
] as const;
export type SummaryBucket = (typeof summaryBuckets)[number];
export type TicketSummary = Record<string, Record<SummaryBucket, number>>;

type Store = Pick<Prisma.TransactionClient, 'ticket'>;

// Dashboard counts per brand over the actor's whole scope. The bootstrap only
// ships the latest 500 cases, so counting those on the client undercounts
// once a scope grows past that. Each bucket matches the dashboard's own
// definition (role-workspace.tsx and risk() in types.ts).
export async function ticketSummary(
  store: Store,
  a: Actor,
  now = new Date(),
): Promise<TicketSummary> {
  const open: Prisma.TicketWhereInput = { state: { not: 'CLOSED' } };
  const late: Prisma.TicketWhereInput = {
    timers: { some: { completedAt: null, dueAt: { lt: now } } },
  };
  const where: Record<SummaryBucket, Prisma.TicketWhereInput> = {
    active: open,
    closed: { state: 'CLOSED' },
    followup: { state: 'RESOLVED' },
    // Unassigned, or still on the legacy branch-as-owner assignment.
    waiting: {
      ...open,
      OR: [
        { resolutionOwner: null },
        { resolutionOwner: { equals: store.ticket.fields.branchId } },
      ],
    },
    escalated: { ...open, escalated: true },
    late: { ...open, ...late },
    urgent: { ...open, OR: [{ priority: 'P1' }, late] },
  };
  const summary: TicketSummary = {};
  for (const bucket of summaryBuckets) {
    const rows = await store.ticket.groupBy({
      by: ['brandId'],
      where: { AND: [ticketScope(a), where[bucket]] },
      _count: { _all: true },
    });
    for (const row of rows) {
      summary[row.brandId] ??= Object.fromEntries(summaryBuckets.map((b) => [b, 0])) as Record<
        SummaryBucket,
        number
      >;
      summary[row.brandId][bucket] = row._count._all;
    }
  }
  return summary;
}
