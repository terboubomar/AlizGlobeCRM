import { Prisma } from '@prisma/client';
import { Actor } from '../../../packages/domain/src';
export function ticketScope(a: Actor): Prisma.TicketWhereInput {
  return {
    brandId: { in: a.brandIds },
    ...(a.role === 'OPERATIONS_MANAGER' ? { escalated: true, resolutionOwner: a.id } : {}),
    ...(a.branchIds.length ? { branchId: { in: a.branchIds } } : {}),
  };
}
