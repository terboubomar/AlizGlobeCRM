import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db } from '../../../packages/db/client';
import {
  Actor,
  authorize,
  DomainError,
  assignableRoles,
  permissionsForRole,
  financeDuties,
} from '../../../packages/domain/src';
import { hashPassword } from './password';
import { passwordAuthEnabled } from './auth';
const userSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  financeDuty: true,
  brandIds: true,
  branchIds: true,
  enabled: true,
  sessionVersion: true,
} as const;
const scopeInput = z
  .object({
    name: z.string().trim().min(2).max(100),
    email: z.string().trim().toLowerCase().email().max(254),
    role: z.enum(assignableRoles),
    financeDuty: z.enum(financeDuties).default('NONE'),
    brandIds: z.array(z.string().min(1)).max(1000),
    branchIds: z.array(z.string().min(1)).max(1000),
    branchMode: z.enum(['all', 'selected']),
    enabled: z.boolean(),
    password: z.string().min(12).max(128).optional(),
    subject: z.string().trim().min(1).max(200).optional(),
    version: z.number().int().min(0).optional(),
  })
  .strict();
async function managementLock(tx: Prisma.TransactionClient, a: Actor) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('aliz-user-management'))`;
  const current = await tx.user.findUnique({ where: { id: a.id } });
  if (!current?.enabled || current.role !== 'SUPER_ADMIN')
    throw new DomainError('FORBIDDEN', 403, 'إدارة المستخدمين متاحة للمسؤول الأعلى فقط');
}
export async function listUsers(a: Actor) {
  authorize(a, 'users.manage');
  const users = await db.user.findMany({
    select: { ...userSelect, passwordHash: true, subject: true },
    orderBy: { name: 'asc' },
  });
  return {
    users: users.map(({ passwordHash, subject, sessionVersion, ...u }) => ({
      ...u,
      version: sessionVersion,
      subject,
      loginType:
        subject && !passwordAuthEnabled()
          ? 'oidc'
          : passwordHash
            ? 'password'
            : subject
              ? 'oidc'
              : 'none',
    })),
    roles: assignableRoles.map((role) => ({ id: role, permissions: permissionsForRole(role) })),
    financeDuties: financeDuties.map((id) => ({
      id,
      permissions: permissionsForRole('CEO', id).filter(
        (p) => p.startsWith('refund.') || p.startsWith('evidence.'),
      ),
    })),
    passwordLogin: passwordAuthEnabled(),
  };
}
export async function saveUser(a: Actor, input: unknown, id?: string) {
  authorize(a, 'users.manage');
  const b = scopeInput.parse(input);
  if (id === a.id)
    throw new DomainError('SELF_CHANGE', 409, 'لا يمكنك تعديل حسابك من إدارة المستخدمين');
  if (!passwordAuthEnabled() && b.password)
    throw new DomainError(
      'PASSWORD_LOGIN_DISABLED',
      400,
      'استخدم معرّف الهوية المؤسسية لهذا الحساب',
    );
  const passwordHash = b.password ? await hashPassword(b.password) : undefined;
  return db.$transaction(async (tx) => {
    await managementLock(tx, a);
    const existing = id ? await tx.user.findUnique({ where: { id } }) : null;
    if (id && !existing) throw new DomainError('NOT_FOUND', 404, 'المستخدم غير موجود');
    if (existing && b.version !== existing.sessionVersion)
      throw new DomainError('STALE_USER', 409, 'تغيّرت بيانات المستخدم؛ حدّث القائمة وحاول مجدداً');
    const brandIds = b.role === 'SUPER_ADMIN' ? [] : [...new Set(b.brandIds)];
    const branchIds = b.role === 'SUPER_ADMIN' ? [] : [...new Set(b.branchIds)];
    if (b.role !== 'SUPER_ADMIN' && !brandIds.length)
      throw new DomainError('BRANDS_REQUIRED', 400, 'اختر علامة واحدة على الأقل');
    if (b.role !== 'SUPER_ADMIN' && b.branchMode === 'selected' && !branchIds.length)
      throw new DomainError(
        'BRANCHES_REQUIRED',
        400,
        'اختر فرعاً واحداً على الأقل أو اختر جميع فروع العلامات',
      );
    if (b.branchMode === 'all' && branchIds.length)
      throw new DomainError('INVALID_SCOPE', 400, 'نطاق جميع الفروع لا يقبل قائمة فروع محددة');
    if ((await tx.brand.count({ where: { id: { in: brandIds } } })) !== brandIds.length)
      throw new DomainError('INVALID_SCOPE', 400, 'إحدى العلامات غير موجودة؛ حدّث القائمة');
    if (
      (await tx.branch.count({ where: { id: { in: branchIds }, brandId: { in: brandIds } } })) !==
      branchIds.length
    )
      throw new DomainError('INVALID_SCOPE', 400, 'يجب أن تنتمي الفروع إلى العلامات المحددة');
    if (passwordAuthEnabled() && !passwordHash && !existing?.passwordHash)
      throw new DomainError('PASSWORD_REQUIRED', 400, 'حدد كلمة مرور لإتاحة تسجيل الدخول');
    const subject = passwordAuthEnabled() ? existing?.subject : b.subject;
    if (!passwordAuthEnabled() && !subject)
      throw new DomainError('SUBJECT_REQUIRED', 400, 'أدخل معرّف المستخدم في نظام الهوية المؤسسية');
    const data = {
      name: b.name,
      email: b.email,
      role: b.role,
      financeDuty: b.role === 'SUPER_ADMIN' ? 'NONE' : b.financeDuty,
      brandIds,
      branchIds,
      enabled: b.enabled,
      ...(passwordHash ? { passwordHash } : {}),
      ...(subject ? { subject } : {}),
    };
    const saved = existing
      ? await tx.user.update({
          where: { id: existing.id },
          data: { ...data, sessionVersion: { increment: 1 } },
          select: userSelect,
        })
      : await tx.user.create({ data: { id: crypto.randomUUID(), ...data }, select: userSelect });
    await tx.audit.create({
      data: {
        actor: a.id,
        action: existing ? 'USER_ACCESS_UPDATED' : 'USER_CREATED',
        entityId: saved.id,
      },
    });
    return { id: saved.id };
  });
}
export async function userStatus(a: Actor, id: string, input: unknown) {
  authorize(a, 'users.manage');
  const b = z
    .object({ enabled: z.boolean(), version: z.number().int().min(0) })
    .strict()
    .parse(input);
  if (id === a.id) throw new DomainError('SELF_CHANGE', 409, 'لا يمكنك إيقاف حسابك الحالي');
  return db.$transaction(async (tx) => {
    await managementLock(tx, a);
    const u = await tx.user.findUnique({ where: { id } });
    if (!u) throw new DomainError('NOT_FOUND', 404, 'المستخدم غير موجود');
    if (b.version !== u.sessionVersion)
      throw new DomainError('STALE_USER', 409, 'تغيّرت بيانات المستخدم؛ حدّث القائمة');
    if (b.enabled && (passwordAuthEnabled() ? !u.email || !u.passwordHash : !u.subject))
      throw new DomainError('LOGIN_REQUIRED', 400, 'عدّل الحساب وأكمل بيانات تسجيل الدخول أولاً');
    await tx.user.update({
      where: { id },
      data: { enabled: b.enabled, sessionVersion: { increment: 1 } },
    });
    await tx.audit.create({
      data: { actor: a.id, action: b.enabled ? 'USER_ENABLED' : 'USER_DISABLED', entityId: id },
    });
    return { ok: true };
  });
}
