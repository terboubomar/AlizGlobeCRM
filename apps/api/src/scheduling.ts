import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { db } from '../../../packages/db/client';
import { Actor, authorize, DomainError } from '../../../packages/domain/src';
export const scheduledRoles = [
  'AGENT',
  'SHIFT_LEAD',
  'CUSTOMER_SERVICE_MANAGER',
  'MARKETING_MANAGER',
];
export const shiftInput = z
  .object({
    userId: z.string().min(1),
    start: z.iso.datetime(),
    end: z.iso.datetime(),
    breakStart: z.iso.datetime().nullish(),
    breakEnd: z.iso.datetime().nullish(),
    lead: z.boolean().default(false),
    dayOff: z.boolean().default(false),
    version: z.number().int().min(0).optional(),
  })
  .superRefine((b, ctx) => {
    const s = +new Date(b.start),
      e = +new Date(b.end);
    if (b.dayOff) {
      if (
        e - s !== 86400000 ||
        new Date(s).getUTCHours() !== 21 ||
        new Date(s).getUTCMinutes() !== 0 ||
        new Date(s).getUTCSeconds() !== 0 ||
        new Date(s).getUTCMilliseconds() !== 0
      )
        ctx.addIssue({
          code: 'custom',
          message: 'يوم الراحة يجب أن يغطي يوماً كاملاً بتوقيت الرياض.',
        });
      if (b.breakStart || b.breakEnd || b.lead)
        ctx.addIssue({ code: 'custom', message: 'يوم الراحة لا يتضمن استراحة أو قيادة وردية.' });
      return;
    }
    if (s >= e || e - s > 12 * 3600000)
      ctx.addIssue({
        code: 'custom',
        message: 'مدة الوردية يجب أن تكون أكثر من صفر وحتى 12 ساعة.',
      });
    if (
      !!b.breakStart !== !!b.breakEnd ||
      (b.breakStart &&
        b.breakEnd &&
        (+new Date(b.breakStart) < s ||
          +new Date(b.breakEnd) > e ||
          +new Date(b.breakStart) >= +new Date(b.breakEnd)))
    )
      ctx.addIssue({ code: 'custom', message: 'حدد بداية ونهاية الاستراحة ضمن الوردية.' });
  });
export async function saveShiftTx(
  tx: Prisma.TransactionClient,
  a: Actor,
  input: unknown,
  id?: string,
) {
  authorize(a, 'schedule');
  const b = shiftInput.parse(input);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${b.userId}))`;
  const user = await tx.user.findUnique({ where: { id: b.userId } });
  if (
    !user?.enabled ||
    !scheduledRoles.includes(user.role) ||
    !user.brandIds.some((x) => a.brandIds.includes(x))
  )
    throw new DomainError('INVALID_STAFF', 400, 'الموظف غير متاح ضمن فريقك.');
  const previous = id ? await tx.shift.findUnique({ where: { id } }) : null;
  if (id && (!previous || previous.userId !== b.userId || previous.cancelledAt))
    throw new DomainError('NOT_FOUND', 404, 'الوردية غير متاحة.');
  if (previous && previous.version !== b.version)
    throw new DomainError('CONFLICT', 409, 'تم تعديل الوردية؛ حدّث الجدول.');
  const start = new Date(b.start),
    end = new Date(b.end);
  if (
    (await tx.shift.count({
      where: {
        userId: b.userId,
        cancelledAt: null,
        ...(id ? { id: { not: id } } : {}),
        start: { lt: end },
        end: { gt: start },
      },
    })) ||
    (await tx.leave.count({
      where: { userId: b.userId, status: 'APPROVED', start: { lt: end }, end: { gt: start } },
    }))
  )
    throw new DomainError(
      'SHIFT_CONFLICT',
      409,
      'الموعد يتعارض مع وردية أو يوم راحة أو إجازة معتمدة.',
    );
  const data = {
    userId: b.userId,
    brandId: null,
    start,
    end,
    breakStart: b.breakStart ? new Date(b.breakStart) : null,
    breakEnd: b.breakEnd ? new Date(b.breakEnd) : null,
    lead: b.lead,
    dayOff: b.dayOff,
  };
  const saved = id
    ? await tx.shift.update({ where: { id }, data: { ...data, version: { increment: 1 } } })
    : await tx.shift.create({ data });
  await tx.audit.create({
    data: { actor: a.id, action: id ? 'SHIFT_UPDATED' : 'SHIFT_CREATED', entityId: saved.id },
  });
  return saved;
}
export async function saveShift(a: Actor, input: unknown, id?: string) {
  return db.$transaction((tx) => saveShiftTx(tx, a, input, id));
}
export async function cancelShift(a: Actor, id: string, input: unknown) {
  authorize(a, 'schedule');
  const { version } = z.object({ version: z.number().int().min(0) }).parse(input);
  return db.$transaction(async (tx) => {
    const prior = await tx.shift.findUnique({ where: { id } });
    if (!prior) throw new DomainError('NOT_FOUND', 404, 'الوردية غير متاحة.');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${prior.userId}))`;
    const user = await tx.user.findUnique({ where: { id: prior.userId } });
    if (!user || !user.brandIds.some((x) => a.brandIds.includes(x)))
      throw new DomainError('NOT_FOUND', 404, 'الوردية غير متاحة.');
    const updated = await tx.shift.updateMany({
      where: { id, version, cancelledAt: null },
      data: { cancelledAt: new Date(), version: { increment: 1 } },
    });
    if (!updated.count) throw new DomainError('CONFLICT', 409, 'تغيرت الوردية؛ حدّث الجدول.');
    await tx.audit.create({ data: { actor: a.id, action: 'SHIFT_CANCELLED', entityId: id } });
    return { ok: true };
  });
}

export const bulkShiftInput = z.object({ entries: z.array(shiftInput).min(1).max(200) });
export async function saveBulkShiftsTx(tx: Prisma.TransactionClient, a: Actor, input: unknown) {
  authorize(a, 'schedule');
  const { entries } = bulkShiftInput.parse(input);
  // Every bulk writer takes staff locks in the same order.
  const ordered = [...entries].sort(
    (x, y) => x.userId.localeCompare(y.userId) || x.start.localeCompare(y.start),
  );
  for (const userId of [...new Set(ordered.map((e) => e.userId))])
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
  for (const entry of ordered) {
    try {
      await saveShiftTx(tx, a, entry);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'SHIFT_CONFLICT') {
        const user = await tx.user.findUnique({
          where: { id: entry.userId },
          select: { name: true },
        });
        const day = new Intl.DateTimeFormat('ar-SA-u-nu-latn', {
          calendar: 'gregory',
          day: 'numeric',
          month: 'long',
          timeZone: 'Asia/Riyadh',
        }).format(new Date(entry.start));
        throw new DomainError(
          error.code,
          error.status,
          `${user?.name ?? 'الموظف'}، ${day}: ${error.message} لم تُحفظ أي تغييرات.`,
        );
      }
      throw error;
    }
  }
  return { count: entries.length };
}
export async function saveBulkShifts(a: Actor, input: unknown) {
  authorize(a, 'schedule');
  return db.$transaction((tx) => saveBulkShiftsTx(tx, a, input), { timeout: 20000 });
}
