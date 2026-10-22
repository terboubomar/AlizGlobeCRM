import { z } from 'zod';
import { branchLocationFields, pairedCoordinates } from './branch-input';
import { Prisma } from '@prisma/client';
import { db } from '../../../packages/db/client';
import { Actor, authorize, inScope, DomainError } from '../../../packages/domain/src';
const logos = [
  'neutral.svg',
  'waqf.jpeg',
  'kabab.png',
  'batatisyon.jpeg',
  'mazmuzil.webp',
  'shawarman.webp',
] as const;
const brandInput = z.object({
  name: z.string().trim().min(2).max(100),
  nameEn: z.string().trim().max(100).default(''),
  logo: z.enum(logos).default('neutral.svg'),
  color: z
    .string()
    .regex(/^#[a-fA-F0-9]{6}$/)
    .default('#B62E30'),
});
export async function saveBrand(a: Actor, input: unknown, id?: string) {
  authorize(a, 'brands.manage');
  if (id && !inScope(a, { brandId: id }))
    throw new DomainError('FORBIDDEN', 403, 'العلامة خارج نطاقك');
  const body = brandInput.parse(input);
  const code =
    id ?? z.object({ code: z.string().regex(/^[a-z][a-z0-9-]{1,29}$/) }).parse(input).code;
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${code}))`;
    const brand = id
      ? await tx.brand.update({ where: { id }, data: body })
      : await tx.brand.create({ data: { id: code, ...body, status: 'DRAFT' } });
    if (!id) await tx.user.update({ where: { id: a.id }, data: { brandIds: { push: code } } });
    await tx.audit.create({
      data: { actor: a.id, action: id ? 'BRAND_UPDATED' : 'BRAND_CREATED', entityId: brand.id },
    });
    return brand;
  });
}
export async function updateBranch(a: Actor, id: string, input: unknown) {
  authorize(a, 'branches.manage');
  const b = z
    .object({
      ...branchLocationFields,
      brandId: z.string(),
      name: z.string().trim().min(2).max(100),
      city: z.string().trim().min(2).max(80),
      code: z
        .string()
        .regex(/^[A-Z0-9_-]{2,30}$/)
        .optional(),
      active: z.boolean().optional(),
    })
    .refine(pairedCoordinates, { message: 'أدخل خط العرض وخط الطول معاً' })
    .parse(input);
  if (!inScope(a, { brandId: b.brandId, branchId: id }))
    throw new DomainError('FORBIDDEN', 403, 'العلامة المستهدفة خارج النطاق');
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
    const branch = await tx.branch.findUnique({ where: { id } });
    if (!branch || !inScope(a, branch)) throw new DomainError('NOT_FOUND', 404, 'الفرع غير متاح');
    if (branch.brandId !== b.brandId) {
      const history =
        (await tx.ticket.count({ where: { branchId: id } })) +
        (await tx.refund.count({ where: { branchId: id } })) +
        (await tx.qr.count({ where: { branchId: id } }));
      if (history)
        throw new DomainError(
          'BRANCH_HAS_HISTORY',
          409,
          'للفرع سجلات سابقة أو رموز QR. للحفاظ على نسبتها للعلامة الأصلية، أضف فرعاً جديداً تحت العلامة المطلوبة.',
        );
    }
    if (b.active !== undefined && b.active !== branch.active) {
      authorize(a, 'directory.activate');
      if (b.active && !(await tx.brand.findFirst({ where: { id: b.brandId, status: 'ACTIVE' } })))
        throw new DomainError('BRAND_INACTIVE', 409, 'فعّل العلامة قبل تفعيل الفرع');
    }
    const updated = await tx.branch.update({
      where: { id },
      data: {
        brandId: b.brandId,
        name: b.name,
        city: b.city,
        district: b.district,
        address: b.address,
        mapsUrl: b.mapsUrl,
        latitude: b.latitude,
        longitude: b.longitude,
        phone: b.phone,
        ...(b.code !== undefined ? { code: b.code } : {}),
        ...(b.active !== undefined ? { active: b.active } : {}),
      },
    });
    await tx.audit.create({
      data: {
        actor: a.id,
        action: branch.brandId === b.brandId ? 'BRANCH_UPDATED' : 'BRANCH_BRAND_LINKED',
        entityId: id,
      },
    });
    return updated;
  });
}

export async function directoryStatusTx(
  tx: Prisma.TransactionClient,
  a: Actor,
  kind: 'brand' | 'branch',
  id: string,
  input: unknown,
) {
  authorize(a, 'directory.activate');
  const b = z.object({ active: z.boolean(), expectedActive: z.boolean() }).strict().parse(input);
  const branch = kind === 'branch' ? await tx.branch.findUnique({ where: { id } }) : null;
  if (kind === 'branch' && !branch) throw new DomainError('NOT_FOUND', 404, 'الفرع غير موجود');
  const brandId = branch?.brandId ?? id;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${brandId}))`;
  if (kind === 'branch') await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
  const brand = await tx.brand.findUnique({ where: { id: brandId } });
  if (!brand) throw new DomainError('NOT_FOUND', 404, 'العلامة غير موجودة');
  if (kind === 'brand') {
    if ((brand.status === 'ACTIVE') !== b.expectedActive)
      throw new DomainError('CONFLICT', 409, 'تغيرت حالة العلامة؛ حدّث الصفحة');
    await tx.brand.update({ where: { id }, data: { status: b.active ? 'ACTIVE' : 'DRAFT' } });
  } else {
    const current = await tx.branch.findUnique({ where: { id } });
    if (!current || current.brandId !== brandId || current.active !== b.expectedActive)
      throw new DomainError('CONFLICT', 409, 'تغيرت حالة الفرع؛ حدّث الصفحة');
    if (b.active && brand.status !== 'ACTIVE')
      throw new DomainError('BRAND_INACTIVE', 409, 'فعّل العلامة أولاً');
    await tx.branch.update({ where: { id }, data: { active: b.active } });
  }
  await tx.audit.create({
    data: {
      actor: a.id,
      entityId: id,
      action: `${kind.toUpperCase()}_${b.active ? 'ACTIVATED' : 'SUSPENDED'}`,
    },
  });
  return { ok: true };
}

export async function deleteDirectoryEntry(
  a: Actor,
  kind: 'brand' | 'branch',
  id: string,
  input: unknown,
) {
  authorize(a, kind === 'brand' ? 'brands.manage' : 'branches.manage');
  const { name } = z.object({ name: z.string() }).parse(input);
  return db
    .$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const entry =
        kind === 'brand'
          ? await tx.brand.findUnique({ where: { id } })
          : await tx.branch.findUnique({ where: { id } });
      const scoped =
        entry &&
        inScope(a, {
          brandId: 'brandId' in entry ? entry.brandId : entry.id,
          branchId: kind === 'branch' ? id : undefined,
        });
      if (!entry || !scoped) throw new DomainError('NOT_FOUND', 404, 'السجل غير موجود ضمن نطاقك');
      if (name !== entry.name)
        throw new DomainError(
          'DIRECTORY_CHANGED',
          409,
          'تغير اسم السجل؛ حدّث الصفحة وأعد المحاولة',
        );
      const used =
        kind === 'brand'
          ? (await tx.branch.count({ where: { brandId: id } })) +
            (await tx.ticket.count({ where: { brandId: id } })) +
            (await tx.refund.count({ where: { brandId: id } })) +
            (await tx.shift.count({ where: { brandId: id } })) +
            (await tx.outbox.count({ where: { brandId: id } }))
          : (await tx.ticket.count({ where: { branchId: id } })) +
            (await tx.refund.count({ where: { branchId: id } })) +
            (await tx.qr.count({ where: { branchId: id } })) +
            (await tx.outbox.count({ where: { branchId: id } }));
      if (used)
        throw new DomainError(
          'DIRECTORY_IN_USE',
          409,
          kind === 'brand'
            ? 'لا يمكن حذف العلامة لوجود فروع أو سجلات مرتبطة. احذف الفروع غير المستخدمة أولاً.'
            : 'لا يمكن حذف فرع مرتبط بشكاوى أو طلبات مالية أو رموز QR؛ يبقى محفوظاً مع سجلاته.',
        );
      if (kind === 'brand') {
        await tx.brand.delete({ where: { id } });
        const users = await tx.user.findMany({ where: { brandIds: { has: id } } });
        for (const user of users)
          await tx.user.update({
            where: { id: user.id },
            data: { brandIds: user.brandIds.filter((x) => x !== id) },
          });
      } else await tx.branch.delete({ where: { id } });
      await tx.audit.create({
        data: {
          actor: a.id,
          action: kind === 'brand' ? 'BRAND_DELETED' : 'BRANCH_DELETED',
          entityId: id,
        },
      });
      return { id, deleted: true };
    })
    .catch((error: unknown) => {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2003', 'P2025'].includes(error.code)
      )
        throw new DomainError(
          'DIRECTORY_CHANGED',
          409,
          'تغير السجل أو ارتبط بسجلات أخرى؛ حدّث الصفحة وأعد المحاولة',
        );
      throw error;
    });
}
