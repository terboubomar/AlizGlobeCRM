import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../../packages/db/client';
import { Actor, authorize, can, DomainError, refundNext } from '../../../packages/domain/src';
import { encrypt, decrypt } from './crypto';
import { isDemo } from './auth';
import { ticketScope } from './ticket-scope';
const refundInclude = {
  brand: true,
  branch: true,
  ticket: { select: { id: true, sequence: true, createdAt: true } },
  events: { orderBy: { createdAt: 'asc' as const } },
  attachments: true,
};
export function refundScope(a: Actor): Prisma.RefundWhereInput {
  return {
    brandId: { in: a.brandIds },
    ...(a.role === 'AGENT' &&
    !['refund.decide', 'refund.execute', 'refund.verify'].some((p) => can(a, p))
      ? { requester: a.id }
      : {}),
    ...(a.role === 'OPERATIONS_MANAGER'
      ? { ticket: { is: { escalated: true, resolutionOwner: a.id } } }
      : {}),
    ...(a.branchIds.length ? { branchId: { in: a.branchIds } } : {}),
  };
}
export async function getRefund(a: Actor, id: string) {
  authorize(a, 'read');
  const r = await db.refund.findFirst({ where: { id, ...refundScope(a) }, include: refundInclude });
  if (!r) throw new DomainError('NOT_FOUND', 404, 'الطلب المالي غير موجود ضمن نطاقك');
  return r;
}
function presentRefund(r: Prisma.RefundGetPayload<{ include: typeof refundInclude }>, a: Actor) {
  return {
    ...r,
    number: `RF-${r.createdAt.getUTCFullYear()}-${String(r.sequence).padStart(6, '0')}`,
    reason:
      can(a, 'pii') || r.requester === a.id ? decrypt(r.reason) : 'تفاصيل الطلب مقيدة حسب الصلاحية',
    ticket: r.ticket
      ? {
          id: r.ticket.id,
          number: `AG-${r.ticket.createdAt.getUTCFullYear()}-${String(r.ticket.sequence).padStart(6, '0')}`,
        }
      : null,
    attachments: can(a, 'evidence.view') ? r.attachments.map(({ key: _, ...f }) => f) : [],
    events: r.events.map((e) => ({
      ...e,
      note: e.note && (can(a, 'pii') || e.actor === a.id) ? decrypt(e.note) : null,
    })),
  };
}
export async function listRefunds(a: Actor) {
  if (!can(a, 'read')) return [];
  return (
    await db.refund.findMany({
      where: refundScope(a),
      include: refundInclude,
      orderBy: { createdAt: 'desc' },
      take: 500,
    })
  ).map((r) => presentRefund(r, a));
}
async function journal(
  tx: Prisma.TransactionClient,
  id: string,
  a: Actor,
  type: string,
  note?: string,
) {
  await tx.refundEvent.create({
    data: { refundId: id, actor: a.id, type, note: note ? encrypt(note) : undefined },
  });
  await tx.audit.create({ data: { actor: a.id, action: type, entityId: id } });
}
export async function requestRefund(a: Actor, input: unknown) {
  authorize(a, 'refund.request');
  const b = z
    .object({
      ticketId: z.string().optional(),
      brandId: z.string().optional(),
      branchId: z.string().nullable().optional(),
      externalOrder: z.string().trim().min(1).max(100).optional(),
      platform: z.string().trim().min(1).max(80).optional(),
      kind: z.enum(['REFUND', 'CANCELLATION']),
      reason: z.string().trim().min(5).max(1000),
      amountMinor: z.number().int().positive().max(10000000).optional(),
    })
    .parse(input);
  let linked = null;
  if (b.ticketId) {
    linked = await db.ticket.findFirst({ where: { id: b.ticketId, ...ticketScope(a) } });
    if (!linked) throw new DomainError('NOT_FOUND', 404, 'الشكوى المرتبطة خارج نطاقك');
  }
  const brandId = b.brandId ?? linked?.brandId,
    branchId = b.branchId ?? linked?.branchId ?? null,
    externalOrder = b.externalOrder ?? linked?.externalOrder,
    platform = b.platform ?? linked?.platform;
  if (!brandId || !externalOrder || !platform)
    throw new DomainError('ORDER_REQUIRED', 400, 'حدد العلامة ورقم الطلب ومنصة الطلب');
  if (linked && (linked.brandId !== brandId || linked.branchId !== branchId))
    throw new DomainError('SCOPE_MISMATCH', 400, 'نطاق الطلب المالي يجب أن يطابق الشكوى المرتبطة');
  authorize(a, 'refund.request', { brandId, branchId });
  const brand = await db.brand.findUnique({ where: { id: brandId } });
  if (!brand || (!isDemo() && brand.status !== 'ACTIVE'))
    throw new DomainError('BRAND_INACTIVE', 400, 'العلامة غير مفعلة');
  if (branchId && !(await db.branch.findFirst({ where: { id: branchId, brandId, active: true } })))
    throw new DomainError('INVALID_BRANCH', 400, 'الفرع لا يتبع العلامة المحددة');
  return db.$transaction(async (tx) => {
    if (branchId) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${branchId}))`;
      if (!(await tx.branch.findFirst({ where: { id: branchId, brandId, active: true } })))
        throw new DomainError('INVALID_BRANCH', 409, 'تغير ربط الفرع؛ أعد اختيار الفرع');
    }
    const orderKey = `${brandId}:${platform}:${externalOrder}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${orderKey}))`;
    if (
      await tx.refund.findFirst({
        where: { brandId, externalOrder, platform, status: { notIn: ['REJECTED', 'COMPLETED'] } },
      })
    )
      throw new DomainError('DUPLICATE_REFUND', 409, 'يوجد طلب مالي مفتوح لهذا الطلب الخارجي');
    const r = await tx.refund.create({
      data: {
        ticketId: linked?.id,
        brandId,
        branchId,
        externalOrder,
        platform,
        kind: b.kind,
        reason: encrypt(b.reason),
        amountMinor: b.amountMinor,
        requester: a.id,
      },
    });
    await journal(tx, r.id, a, 'REFUND_REQUESTED');
    return { id: r.id };
  });
}
export async function refundAction(a: Actor, id: string, action: string, input: unknown) {
  const b = z
      .object({
        version: z.number().int(),
        note: z.string().trim().min(3).max(1000),
        reference: z.string().trim().max(200).optional(),
        proofId: z.string().optional(),
        reason: z.string().trim().min(5).max(1000).optional(),
        amountMinor: z.number().int().positive().max(10000000).optional(),
      })
      .parse(input),
    r = await getRefund(a, id);
  authorize(
    a,
    action === 'resubmit'
      ? 'refund.request'
      : ['review', 'approve', 'reject'].includes(action)
        ? 'refund.decide'
        : action === 'verify'
          ? 'refund.verify'
          : action === 'execute'
            ? 'refund.execute'
            : 'refund.notify',
    r,
  );
  if (action === 'resubmit' && r.requester !== a.id)
    throw new DomainError('FORBIDDEN', 403, 'إعادة التقديم متاحة لمقدم الطلب الأصلي فقط');
  if (b.version !== r.version)
    throw new DomainError('CONFLICT', 409, 'تم تعديل الطلب؛ حدّث الصفحة');
  if (!isDemo() && process.env.FINANCE_POLICY_APPROVED !== 'true')
    throw new DomainError('POLICY_PENDING', 409, 'السياسة المالية بانتظار الاعتماد');
  if (!isDemo() && action === 'approve') {
    const limit = Number(process.env.FINANCE_APPROVAL_LIMIT_MINOR);
    if (!Number.isSafeInteger(limit) || limit <= 0 || (r.kind === 'REFUND' && !r.amountMinor))
      throw new DomainError('POLICY_PENDING', 409, 'حد الموافقة والمبلغ المتحقق منه مطلوبان');
    if (r.amountMinor && r.amountMinor > limit)
      throw new DomainError('LIMIT_EXCEEDED', 403, 'المبلغ يتجاوز حد الموافقة');
  }
  if (['review', 'approve', 'reject'].includes(action) && r.requester === a.id)
    throw new DomainError('SELF_APPROVAL', 403, 'لا يمكن اعتماد طلبك');
  if (
    (action === 'execute' && a.id === r.approver) ||
    (action === 'verify' && [r.requester, r.processor, r.approver].includes(a.id))
  )
    throw new DomainError('DUAL_CONTROL', 403, 'التنفيذ والتحقق يتطلبان مسؤولين مستقلين');
  if (action === 'execute') {
    const owners: Prisma.AttachmentWhereInput[] = [{ refundId: id }];
    if (r.ticketId) owners.push({ ticketId: r.ticketId });
    const f = await db.attachment.findFirst({
      where: {
        id: b.proofId ?? '',
        OR: owners,
        status: { in: isDemo() ? ['CLEAN', 'CLEAN_DEMO'] : ['CLEAN'] },
      },
    });
    if (!b.reference || !f)
      throw new DomainError('PROOF_REQUIRED', 400, 'مرجع التنفيذ وإثبات نظيف يخص الطلب مطلوبان');
  }
  const status = refundNext(r.status, action);
  return db.$transaction(async (tx) => {
    if (action === 'resubmit') {
      const orderKey = `${r.brandId}:${r.platform}:${r.externalOrder}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${orderKey}))`;
      if (
        await tx.refund.findFirst({
          where: {
            id: { not: r.id },
            brandId: r.brandId,
            platform: r.platform,
            externalOrder: r.externalOrder,
            status: { notIn: ['REJECTED', 'COMPLETED'] },
          },
        })
      )
        throw new DomainError('DUPLICATE_REFUND', 409, 'يوجد طلب مالي مفتوح لنفس الطلب');
    }
    const changed = await tx.refund.updateMany({
      where: { id, version: b.version },
      data: {
        status,
        version: { increment: 1 },
        ...(['approve', 'reject'].includes(action) ? { approver: a.id } : {}),
        ...(action === 'execute'
          ? { processor: a.id, externalReference: b.reference, proofId: b.proofId }
          : {}),
        ...(action === 'verify' ? { verifier: a.id } : {}),
        ...(action === 'resubmit'
          ? {
              reason: b.reason ? encrypt(b.reason) : r.reason,
              ...(b.amountMinor !== undefined ? { amountMinor: b.amountMinor } : {}),
              approver: null,
              processor: null,
              verifier: null,
              externalReference: null,
              proofId: null,
            }
          : {}),
      },
    });
    if (!changed.count) throw new DomainError('CONFLICT', 409, 'تم تعديل الطلب، حدّث الصفحة');
    await journal(
      tx,
      id,
      a,
      `REFUND_${action.toUpperCase()}`,
      action === 'resubmit'
        ? `${b.note}\nالسبب السابق: ${decrypt(r.reason)}\nالمبلغ السابق (هللة): ${r.amountMinor ?? 'غير محدد'}`
        : b.note,
    );
    return { ok: true };
  });
}
