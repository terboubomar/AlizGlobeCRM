import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../../packages/db/client';
import { Actor, authorize, can, normalizePhone } from '../../../packages/domain/src';
import { ticketScope } from './ticket-scope';
import { phoneHash } from './crypto';
import { include, present } from './service';
export const complaintSearchInput = z.object({
  q: z.string().trim().max(200).default(''),
  brandId: z.string().max(100).optional(),
  filter: z
    .enum(['all', 'open', 'working', 'contact', 'waiting', 'escalated', 'closed'])
    .default('all'),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});
export function complaintSearchWhere(
  a: Actor,
  b: z.infer<typeof complaintSearchInput>,
): Prisma.TicketWhereInput {
  const clauses: Prisma.TicketWhereInput[] = [ticketScope(a)];
  if (b.brandId && b.brandId !== 'all') clauses.push({ brandId: b.brandId });
  const filters: Record<string, Prisma.TicketWhereInput> = {
    open: { state: { not: 'CLOSED' } },
    closed: { state: 'CLOSED' },
    working: { state: { in: ['ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS'] } },
    contact: { state: 'RESOLVED' },
    waiting: {
      state: { not: 'CLOSED' },
      OR: [{ state: { in: ['NEW', 'TRIAGED'] } }, { resolutionOwner: null }],
    },
    escalated: { escalated: true, state: { not: 'CLOSED' } },
  };
  if (filters[b.filter]) clauses.push(filters[b.filter]);
  if (b.q) {
    const contains = { contains: b.q, mode: 'insensitive' as const };
    const or: Prisma.TicketWhereInput[] = [
      { externalOrder: contains },
      { branch: { is: { name: contains } } },
      { brand: { is: { name: contains } } },
    ];
    const number = /^AG-(\d{4})-(\d+)$/i.exec(b.q);
    if (
      number &&
      Number(number[1]) >= 1900 &&
      Number(number[1]) < 9999 &&
      Number.isSafeInteger(Number(number[2])) &&
      Number(number[2]) <= 2147483647
    ) {
      const year = Number(number[1]);
      or.push({
        sequence: Number(number[2]),
        createdAt: {
          gte: new Date(`${year}-01-01T00:00:00Z`),
          lt: new Date(`${year + 1}-01-01T00:00:00Z`),
        },
      });
    } else if (/^\d{1,9}$/.test(b.q)) or.push({ sequence: Number(b.q) });
    // Matching a customer's phone number reveals who complained, so only roles
    // allowed to see customer data may search by it.
    const phone = normalizePhone(b.q);
    if (can(a, 'pii') && /^9665\d{8}$/.test(phone)) or.push({ phoneHash: phoneHash(phone) });
    clauses.push({ OR: or });
  }
  return { AND: clauses };
}
export async function searchComplaints(a: Actor, input: unknown) {
  authorize(a, 'read');
  const b = complaintSearchInput.parse(input),
    where = complaintSearchWhere(a, b);
  const [tickets, total] = await db.$transaction([
    db.ticket.findMany({
      where,
      include,
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      skip: b.offset,
      take: 50,
    }),
    db.ticket.count({ where }),
  ]);
  await db.audit.create({
    data: { actor: a.id, action: 'SCOPED_COMPLAINT_SEARCH', entityId: b.brandId ?? 'SCOPED' },
  });
  return {
    tickets: tickets.map((t) => present(t, a)),
    total,
    nextOffset: b.offset + tickets.length < total ? b.offset + tickets.length : null,
  };
}
