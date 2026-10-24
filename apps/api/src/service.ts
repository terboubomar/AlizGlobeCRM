import { whatsappConfig, queueConfirmationTx } from './whatsapp';
import { queueTelegramTx } from './telegram';
import { slaPolicy, slaMilestones, demoSla } from './sla';
import type { ComplaintReceipt } from '../../../packages/domain/src/complaint-receipt';
import { branchLocationFields, pairedCoordinates } from './branch-input';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../../packages/db/client';
import {
  Actor,
  authorize,
  can,
  permissionsForRole,
  canWorkComplaint,
  isComplaintParticipant,
  supportRoles,
  escalationRoles,
  inScope,
  DomainError,
  ticketInput,
  categoryLabels,
  transition,
  normalizePhone,
  safeCell,
} from '../../../packages/domain/src';
import { encrypt, decrypt, hash, token, phoneHash } from './crypto';
import { isDemo, passwordAuthEnabled } from './auth';
import { listRefunds } from './refunds';
import { ticketScope } from './ticket-scope';
import { ticketSummary } from './ticket-summary';
type Tx = Prisma.TransactionClient;
export const num = (t: { sequence: number; createdAt: Date }) =>
  `AG-${t.createdAt.getUTCFullYear()}-${String(t.sequence).padStart(6, '0')}`;
export const scope = ticketScope;
export async function audit(tx: Tx, a: Actor, action: string, id: string) {
  await tx.audit.create({ data: { actor: a.id, action, entityId: id } });
}
async function event(tx: Tx, id: string, a: Actor, type: string, note?: string) {
  await tx.event.create({
    data: { ticketId: id, actor: a.id, type, note: note ? encrypt(note) : undefined },
  });
  await audit(tx, a, type, id);
}
export function present(
  t: Prisma.TicketGetPayload<{
    include: {
      brand: true;
      branch: true;
      events: true;
      timers: true;
      refunds: true;
      tasks: true;
      attachments: true;
      reviews: true;
    };
  }>,
  a: Actor,
) {
  const {
    customer,
    phoneHash: _,
    receiptEncrypted: _receipt,
    description,
    branchBrief,
    attachments,
    events,
    refunds,
    tasks,
    reviews,
    ...rest
  } = t;
  return {
    ...rest,
    number: num(t),
    reviews: can(a, 'qa') ? reviews : [],
    branchBrief: branchBrief ? decrypt(branchBrief) : null,
    description: can(a, 'pii') ? decrypt(description) : 'تفاصيل العميل محجوبة حسب الصلاحية',
    customer: customer && can(a, 'pii') ? JSON.parse(decrypt(customer)) : null,
    refunds: refunds
      .filter((r) => a.role !== 'AGENT' || r.requester === a.id)
      .map(({ reason: _, ...refund }) => refund),
    tasks: tasks
      .filter((task) => a.role !== 'AGENT' || task.owner === a.id)
      .map(({ note: _, ...task }) => task),
    attachments: can(a, 'pii') ? attachments.map(({ key: _, ...r }) => r) : [],
    events: events.map((e) => ({
      ...e,
      note: e.note && (can(a, 'pii') || e.actor === a.id) ? decrypt(e.note) : null,
    })),
  };
}
export const include = {
  brand: true,
  branch: true,
  events: { orderBy: { createdAt: 'asc' as const } },
  timers: true,
  refunds: true,
  tasks: true,
  attachments: true,
  reviews: true,
};
export async function getTicket(a: Actor, id: string) {
  authorize(a, 'read');
  const t = await db.ticket.findFirst({ where: { id, ...scope(a) }, include });
  if (!t) throw new DomainError('NOT_FOUND', 404, 'البلاغ غير موجود ضمن نطاقك');
  return t;
}
export async function bootstrap(a: Actor) {
  const brands = await db.brand.findMany({
    where: { id: { in: a.brandIds } },
    include: { branches: { where: a.branchIds.length ? { id: { in: a.branchIds } } : {} } },
  });
  const users = await db.user.findMany({
    where: {
      enabled: true,
      brandIds: { hasSome: a.brandIds },
    },
    select: { id: true, name: true, role: true, brandIds: true, branchIds: true },
  });
  const tickets = can(a, 'read')
    ? await db.ticket.findMany({
        where: scope(a),
        include,
        orderBy: { createdAt: 'desc' },
        take: 500,
      })
    : [];
  const ticketCount = can(a, 'read') ? await db.ticket.count({ where: scope(a) }) : 0;
  const summary = can(a, 'read') ? await ticketSummary(db, a) : {};
  if (can(a, 'pii'))
    await db.audit.create({
      data: { actor: a.id, action: 'SCOPED_PII_READ', entityId: 'BOOTSTRAP' },
    });
  const tasks = can(a, 'task')
    ? await db.task.findMany({
        where: { ticket: scope(a), ...(a.role === 'AGENT' ? { owner: a.id } : {}) },
        include: { ticket: { select: { sequence: true, createdAt: true, brandId: true } } },
        orderBy: { dueAt: 'asc' },
      })
    : [];
  const shifts = can(a, 'schedule')
    ? await db.shift.findMany({
        where: { userId: { in: users.map((u) => u.id) }, cancelledAt: null },
        orderBy: { start: 'asc' },
      })
    : await db.shift.findMany({
        where: { userId: a.id, cancelledAt: null },
        orderBy: { start: 'asc' },
      });
  const leave = can(a, 'schedule')
    ? await db.leave.findMany({ where: { userId: { in: users.map((u) => u.id) } } })
    : await db.leave.findMany({ where: { userId: a.id } });
  return {
    me: a,
    demo: isDemo(),
    authMode: passwordAuthEnabled() ? 'password' : isDemo() ? 'demo' : 'oidc',
    brands,
    users,
    tickets: tickets.map((t) => present(t, a)),
    ticketCount,
    ticketSummary: summary,
    refunds: await listRefunds(a),
    tasks,
    shifts: can(a, 'schedule') || can(a, 'schedule.self') ? shifts : [],
    leave: can(a, 'schedule') || can(a, 'schedule.self') ? leave : [],
    permissions: permissionsForRole(a.role, a.financeDuty),
    integrations: { whatsapp: whatsappConfig().ready },
    policy: {
      sla: (() => {
        try {
          return slaPolicy().version;
        } catch {
          return 'PENDING_APPROVAL';
        }
      })(),
      finance: process.env.FINANCE_POLICY_APPROVED === 'true',
      publicIntake: process.env.PUBLIC_INTAKE_ENABLED === 'true',
    },
  };
}
export async function createTicketTx(
  tx: Prisma.TransactionClient,
  a: Actor,
  input: unknown,
  key: string,
  publicQr?: { brandId: string; branchId: string; id: string },
) {
  const body = ticketInput.parse(input);
  if (!publicQr) authorize(a, 'create', { brandId: body.brandId, branchId: body.branchId });
  if (!key || key.length > 100)
    throw new DomainError('IDEMPOTENCY_REQUIRED', 400, 'مفتاح الطلب مطلوب');
  const keyId = `${a.id}:${key}`,
    requestHash = hash(JSON.stringify(body));
  const existing = await tx.idempotency.findUnique({ where: { key: keyId } });
  if (existing) {
    if (existing.requestHash !== requestHash)
      throw new DomainError('KEY_REUSED', 409, 'مفتاح الطلب مستخدم لبيانات أخرى');
    const cached = existing.response;
    if (
      cached &&
      typeof cached === 'object' &&
      !Array.isArray(cached) &&
      typeof cached.receiptEncrypted === 'string'
    ) {
      const { receiptEncrypted, ...rest } = cached;
      return { ...rest, receipt: JSON.parse(decrypt(receiptEncrypted)) };
    }
    return cached;
  }
  const brandId = publicQr?.brandId ?? body.brandId,
    branchId = publicQr?.branchId ?? body.branchId ?? null;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${brandId}))`;
  const brand = await tx.brand.findUnique({ where: { id: brandId } });
  if (!brand || (!isDemo() && brand.status !== 'ACTIVE'))
    throw new DomainError('BRAND_INACTIVE', 400, 'العلامة غير مفعلة');
  if (branchId) {
    const branch = await tx.branch.findFirst({ where: { id: branchId, brandId } });
    if (!branch || !branch.active)
      throw new DomainError('INVALID_BRANCH', 400, 'الفرع غير موجود أو غير مفعل');
  } else if (!body.unknownReason?.trim())
    throw new DomainError('BRANCH_REQUIRED', 400, 'حدد الفرع أو سبب عدم معرفته');
  const now = new Date(),
    received = body.receivedAt ? new Date(body.receivedAt) : now;
  if (+received > +now + 60000 || +received < +now - 30 * 86400000)
    throw new DomainError(
      'INVALID_RECEIVED_TIME',
      400,
      'وقت الاستقبال يجب أن يكون خلال آخر 30 يوماً',
    );
  const access = publicQr || (body.whatsappConsent && body.phone) ? token() : null;
  const name = body.name || '',
    phone = body.phone ? normalizePhone(body.phone) : '';
  if (body.whatsappConsent && !phone)
    throw new DomainError('PHONE_REQUIRED', 400, 'أدخل رقم الجوال لاستلام تأكيد واتساب.');
  if (branchId) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${branchId}))`;
    const currentBranch = await tx.branch.findFirst({
      where: { id: branchId, brandId, active: true },
    });
    if (!currentBranch)
      throw new DomainError('INVALID_BRANCH', 409, 'تغير ربط الفرع؛ أعد اختيار الفرع');
  }
  const policy = slaPolicy();
  const t = await tx.ticket.create({
    data: {
      brandId,
      branchId,
      unknownReason: branchId ? null : body.unknownReason,
      source: publicQr ? 'PUBLIC_QR' : 'PHONE_AGENT',
      category: body.category,
      priority: body.category === 'SAFETY' ? 'P1' : body.priority,
      description: encrypt(body.description),
      customer: name || phone ? encrypt(JSON.stringify({ name, phone })) : null,
      phoneHash: phone ? phoneHash(phone) : null,
      externalOrder: body.externalOrder,
      platform: body.platform,
      communicationsOwner: publicQr ? 'UNASSIGNED' : a.id,
      creator: publicQr ? 'PUBLIC_QR' : a.id,
      receivedAt: received,
      demo: isDemo(),
      policyVersion: policy.version,
      slaPolicy: policy,
    },
  });
  await event(tx, t.id, a, publicQr ? 'QR_CREATED' : 'PHONE_CREATED');
  await tx.timer.createMany({
    data: slaMilestones(t.priority, received, policy).map((m) => ({ ...m, ticketId: t.id })),
  });
  await tx.outbox.create({
    data: {
      key: `created:${t.id}`,
      type: t.priority === 'P1' ? 'SAFETY_INTAKE' : 'NEW_TICKET',
      ticketId: t.id,
      brandId,
      branchId,
    },
  });
  if (access)
    await tx.access.create({
      data: { hash: hash(access), ticketId: t.id, expiresAt: new Date(+now + 30 * 86400000) },
    });
  const receiptBranch = branchId
    ? await tx.branch.findUnique({ where: { id: branchId }, select: { name: true } })
    : null;
  const receipt: ComplaintReceipt = {
    number: num(t),
    brand: brand.name,
    branch: receiptBranch?.name ?? 'غير محدد',
    receivedAt: received.toISOString(),
    category: categoryLabels[body.category] ?? body.category,
    description: body.description,
    customerName: name,
    externalOrder: body.externalOrder ?? '',
    platform: body.platform ?? '',
    source: publicQr ? 'QR' : 'الهاتف',
    trackingPath: access ? '/track/' + access : '',
  };
  const receiptEncrypted = encrypt(JSON.stringify(receipt));
  await tx.ticket.update({ where: { id: t.id }, data: { receiptEncrypted } });
  await queueTelegramTx(tx, t.id, 'NEW_COMPLAINT', now);
  const confirmationStatus = await queueConfirmationTx(tx, {
    ticketId: t.id,
    phone,
    receipt,
    consent: body.whatsappConsent,
    now,
  });
  const response = {
    id: t.id,
    number: num(t),
    trackingToken: access,
    receiptEncrypted,
    confirmationStatus,
  };
  await tx.idempotency.create({
    data: { key: keyId, requestHash, response, expiresAt: new Date(+now + 86400000) },
  });
  const { receiptEncrypted: _encrypted, ...result } = response;
  return { ...result, receipt };
}
export async function createTicket(
  a: Actor,
  input: unknown,
  key: string,
  publicQr?: { brandId: string; branchId: string; id: string },
) {
  return db.$transaction((tx) => createTicketTx(tx, a, input, key, publicQr));
}
const actionInput = z.object({
  version: z.number().int(),
  note: z.string().trim().min(3).max(2000),
  owner: z.string().optional(),
  resolutionOwner: z.string().optional(),
  outcome: z.enum(['SATISFIED', 'UNREACHABLE', 'UNRESOLVED']).optional(),
  branchBrief: z.string().trim().min(10).max(1000).optional(),
  branchId: z.string().optional(),
});
export async function ticketAction(a: Actor, id: string, action: string, input: unknown) {
  const b = actionInput.parse(input),
    t = await getTicket(a, id);
  const perm: Record<string, string> = {
    reopen: 'close',
    comment: 'comment',
    contact: 'contact',
    confirm: 'contact',
    assign: 'assign',
    triage: 'triage',
    close: 'close',
    acknowledge: 'acknowledge',
    investigate: 'investigate',
    start: 'investigate',
    followup: 'contact',
    resolve: 'resolve',
    escalate: 'escalate',
  };
  authorize(a, perm[action] ?? '__deny', t);
  if (a.role === 'AGENT' && action === 'comment' && !isComplaintParticipant(a, t))
    throw new DomainError(
      'OWNER_REQUIRED',
      403,
      'يمكنك عرض الشكوى؛ إضافة الملاحظات متاحة للموظف المسند أو مسجل الشكوى',
    );
  if (
    ['contact', 'confirm', 'followup'].includes(action) &&
    a.role === 'AGENT' &&
    t.communicationsOwner !== a.id
  )
    throw new DomainError(
      'OWNER_REQUIRED',
      403,
      'إجراء التواصل وتأكيد العميل متاح لمسؤول التواصل المسند أو المشرف',
    );
  if (
    ['start', 'acknowledge', 'investigate', 'resolve', 'escalate'].includes(action) &&
    !canWorkComplaint(a, t)
  )
    throw new DomainError('OWNER_REQUIRED', 403, 'الإجراء متاح للمسؤول المسند أو المشرف ضمن نطاقه');
  if (b.version !== t.version)
    throw new DomainError('CONFLICT', 409, 'تم تحديث البلاغ؛ حدّث الصفحة وأعد المحاولة');
  const next = ['comment', 'contact', 'confirm', 'escalate', 'followup'].includes(action)
    ? t.state
    : transition(t.state, action);
  if (
    action === 'confirm' &&
    (t.state !== 'RESOLVED' ||
      !t.actionCompletedAt ||
      !t.events.some((e) => e.type === 'CONTACT_RECORDED' && e.createdAt >= t.actionCompletedAt!))
  )
    throw new DomainError(
      'CONFIRMATION_BLOCKED',
      409,
      'تأكيد العميل يتطلب معالجة موثقة وتواصلاً بعد المعالجة',
    );
  if (
    action === 'close' &&
    (!t.actionCompletedAt ||
      !t.customerConfirmedAt ||
      !t.events.some((e) => e.type === 'CONTACT_RECORDED' && e.createdAt >= t.actionCompletedAt!) ||
      t.refunds.some((r) => !['COMPLETED', 'REJECTED'].includes(r.status)))
  )
    throw new DomainError(
      'CLOSURE_BLOCKED',
      409,
      'إغلاق البلاغ يتطلب معالجة موثقة، وتواصلاً وتأكيد العميل، واكتمال الطلبات المالية المرتبطة',
    );
  const update: Prisma.TicketUncheckedUpdateManyInput = { state: next, version: { increment: 1 } };
  if (['assign', 'escalate', 'followup'].includes(action)) {
    if (b.branchBrief) {
      const knownName = t.customer ? JSON.parse(decrypt(t.customer)).name?.trim() : '';
      if (
        /(?:\+?\d[\d\s-]{7,}\d)|(?:[^\s@]+@[^\s@]+\.[^\s@]+)/.test(b.branchBrief) ||
        (knownName?.length >= 3 && b.branchBrief.includes(knownName))
      )
        throw new DomainError(
          'PERSONAL_DATA_IN_BRIEF',
          400,
          'أزل الأسماء وأرقام الاتصال والبريد من موجز التصعيد؛ استخدم الحقول المخصصة',
        );
      update.branchBrief = encrypt(b.branchBrief);
    }
  }
  if (action === 'assign') {
    if (b.branchId && b.branchId !== t.branchId)
      throw new DomainError(
        'BRANCH_ASSIGNMENT_REMOVED',
        400,
        'الإسناد لفريق الدعم فقط؛ فرع الشكوى يبقى كما ورد',
      );
    const ownerId = b.resolutionOwner ?? b.owner;
    if (!ownerId || (b.owner && b.owner !== ownerId))
      throw new DomainError('OWNER_REQUIRED', 400, 'اختر مسؤولاً واحداً من فريق خدمة العملاء');
    const owner = await db.user.findUnique({ where: { id: ownerId } });
    if (!owner?.enabled || !supportRoles.includes(owner.role) || !inScope(owner, t))
      throw new DomainError('INVALID_OWNER', 400, 'اختر موظف دعم ضمن نطاق العلامة والفرع');
    update.resolutionOwner = owner.id;
    update.communicationsOwner = owner.id;
    update.escalated = false;
    update.acknowledgedAt = null;
  }
  if (action === 'confirm') update.customerConfirmedAt = new Date();
  if (action === 'acknowledge' || action === 'start')
    update.acknowledgedAt = t.acknowledgedAt ?? new Date();
  if (action === 'resolve') update.actionCompletedAt = new Date();
  if (action === 'close') update.closedAt = new Date();
  if (action === 'reopen') {
    update.closedAt = null;
    update.actionCompletedAt = null;
    update.customerConfirmedAt = null;
  }
  if (action === 'followup') {
    if (t.state !== 'RESOLVED' || !t.actionCompletedAt || !b.outcome)
      throw new DomainError('FOLLOWUP_BLOCKED', 409, 'وثّق الحل ثم حدد نتيجة التواصل مع العميل');
    if (b.outcome === 'SATISFIED') {
      update.customerConfirmedAt = new Date();
      if (!t.refunds.some((r) => !['COMPLETED', 'REJECTED'].includes(r.status))) {
        update.state = 'CLOSED';
        update.closedAt = new Date();
      }
    }
  }
  const escalating = action === 'escalate' || (action === 'followup' && b.outcome === 'UNRESOLVED');
  if (escalating) {
    if (t.state === 'CLOSED')
      throw new DomainError('ESCALATION_BLOCKED', 409, 'أعد فتح الشكوى قبل التصعيد');
    const target = b.resolutionOwner
      ? await db.user.findUnique({ where: { id: b.resolutionOwner } })
      : null;
    if (
      !target?.enabled ||
      target.id === a.id ||
      !inScope(target, t) ||
      !escalationRoles.includes(target.role)
    )
      throw new DomainError(
        'INVALID_ESCALATION_OWNER',
        400,
        'اختر مشرف دعم أو مدير منطقة أو عمليات ضمن نطاق العلامة والفرع',
      );
    if (!b.branchBrief && !t.branchBrief)
      throw new DomainError(
        'ESCALATION_BRIEF_REQUIRED',
        400,
        'أضف موجز التصعيد دون بيانات العميل الشخصية',
      );
    update.resolutionOwner = target.id;
    update.escalated = true;
    update.state = 'ASSIGNED';
    update.acknowledgedAt = null;
    update.actionCompletedAt = null;
    update.customerConfirmedAt = null;
    update.closedAt = null;
  }
  return db.$transaction(async (tx) => {
    const changed = await tx.ticket.updateMany({ where: { id, version: b.version }, data: update });
    if (!changed.count) throw new DomainError('CONFLICT', 409, 'تم تعديل البلاغ بالتزامن');
    await event(
      tx,
      id,
      a,
      action === 'contact' || action === 'followup'
        ? 'CONTACT_RECORDED'
        : action === 'confirm'
          ? 'CUSTOMER_CONFIRMED'
          : action.toUpperCase(),
      b.note,
    );
    if (action === 'followup') {
      await event(tx, id, a, `FOLLOWUP_${b.outcome}`, b.note);
      if (b.outcome === 'SATISFIED') await event(tx, id, a, 'CUSTOMER_CONFIRMED');
      if (update.state === 'CLOSED') await event(tx, id, a, 'CLOSE');
    }
    if (escalating) await event(tx, id, a, 'ESCALATION_ROUTED', `إلى ${update.resolutionOwner}`);
    if (action === 'assign' && t.resolutionOwner !== update.resolutionOwner)
      await queueTelegramTx(tx, id, 'ASSIGNED');
    if (!['comment', 'escalate'].includes(action))
      await tx.timer.updateMany({
        where: { ticketId: id, milestone: 'FIRST_ACTION', completedAt: null },
        data: { completedAt: new Date() },
      });
    if (action === 'assign' || escalating) {
      const policy = slaPolicy(t.slaPolicy ?? (t.demo ? demoSla : undefined));
      const timer = slaMilestones(t.priority, t.receivedAt, policy, new Date()).find(
        (m) => m.milestone === 'ACKNOWLEDGMENT',
      )!;
      await tx.timer.upsert({
        where: { ticketId_milestone: { ticketId: id, milestone: timer.milestone } },
        create: { ...timer, ticketId: id },
        update: {
          dueAt: timer.dueAt,
          warningAt: timer.warningAt,
          completedAt: null,
          breachedAt: null,
        },
      });
    }
    if (action === 'acknowledge' || action === 'start')
      await tx.timer.updateMany({
        where: { ticketId: id, milestone: 'ACKNOWLEDGMENT', completedAt: null },
        data: { completedAt: new Date() },
      });
    if (escalating)
      await tx.timer.updateMany({
        where: { ticketId: id, milestone: 'REMEDY' },
        data: { completedAt: null },
      });
    if (action === 'resolve')
      await tx.timer.updateMany({
        where: { ticketId: id, milestone: 'REMEDY', completedAt: null },
        data: { completedAt: new Date() },
      });
    return { ok: true };
  });
}
export { requestRefund, refundAction } from './refunds';
export async function qrCreate(a: Actor, input: unknown) {
  authorize(a, 'configure');
  const b = z.object({ branchId: z.string().min(1) }).parse(input);
  const branch = await db.branch.findUnique({ where: { id: b.branchId } });
  if (!branch || !inScope(a, branch) || !branch.active)
    throw new DomainError('NOT_FOUND', 404, 'الفرع غير متاح');
  const code = token();
  const qr = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${branch.id}))`;
    const current = await tx.branch.findUnique({ where: { id: branch.id } });
    if (!current?.active || !inScope(a, current) || current.brandId !== branch.brandId)
      throw new DomainError('BRANCH_CHANGED', 409, 'تغير ربط الفرع؛ حدّث دليل الفروع');
    const existing = await tx.qr.findFirst({ where: { branchId: branch.id, active: true } });
    if (existing) {
      if (!existing.codeEncrypted)
        throw new DomainError(
          'QR_LEGACY',
          409,
          'يوجد رمز قديم لهذا الفرع؛ استبدله للحصول على رمز قابل للتنزيل.',
        );
      return existing;
    }
    const qr = await tx.qr.create({
      data: {
        branchId: branch.id,
        placement: 'استلام الطلبات',
        hash: hash(code),
        codeEncrypted: encrypt(code),
      },
    });
    await audit(tx, a, 'QR_CREATED', qr.id);
    return qr;
  });
  return { id: qr.id, url: `${process.env.APP_ORIGIN}/q/${decrypt(qr.codeEncrypted!)}` };
}
export async function qrLink(a: Actor, id: string) {
  authorize(a, 'configure');
  const qr = await db.qr.findUnique({ where: { id }, include: { branch: true } });
  if (!qr || !inScope(a, qr.branch)) throw new DomainError('NOT_FOUND', 404, 'غير متاح');
  if (!qr.active || !qr.branch.active)
    throw new DomainError('QR_RETIRED', 409, 'الرمز أو الفرع غير نشط');
  if (!qr.codeEncrypted)
    throw new DomainError(
      'QR_LEGACY',
      409,
      'هذا رمز قديم؛ استبدله للحصول على رابط قابل للتنزيل مجدداً',
    );
  return { url: `${process.env.APP_ORIGIN}/q/${decrypt(qr.codeEncrypted)}` };
}
export async function qrAction(a: Actor, id: string, action: string) {
  authorize(a, 'configure');
  if (!['revoke', 'rotate'].includes(action))
    throw new DomainError('INVALID_ACTION', 400, 'غير صالح');
  const existing = await db.qr.findUnique({ where: { id }, include: { branch: true } });
  if (!existing || !inScope(a, existing.branch))
    throw new DomainError('NOT_FOUND', 404, 'غير متاح');
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${existing.branchId}))`;
    const qr = await tx.qr.findUnique({ where: { id }, include: { branch: true } });
    if (!qr || !inScope(a, qr.branch)) throw new DomainError('NOT_FOUND', 404, 'غير متاح');
    if (!qr.active) throw new DomainError('QR_RETIRED', 409, 'تم إيقاف الرمز بالفعل؛ حدّث القائمة');
    if (action === 'rotate' && !qr.branch.active)
      throw new DomainError('BRANCH_INACTIVE', 409, 'فعّل الفرع قبل إنشاء رمز بديل');
    await tx.qr.update({ where: { id }, data: { active: false, revokedAt: new Date() } });
    await audit(tx, a, 'QR_REVOKED', id);
    if (action === 'revoke') return { ok: true };
    const code = token();
    const next = await tx.qr.create({
      data: {
        branchId: qr.branchId,
        placement: 'استلام الطلبات',
        hash: hash(code),
        codeEncrypted: encrypt(code),
      },
    });
    await audit(tx, a, 'QR_CREATED', next.id);
    return { id: next.id, url: `${process.env.APP_ORIGIN}/q/${code}` };
  });
}
export async function publicQr(code: string, count = false) {
  if (!isDemo() && process.env.PUBLIC_INTAKE_ENABLED !== 'true')
    throw new DomainError('INTAKE_DISABLED', 403, 'استقبال البلاغات العامة لم يفعّل بعد');
  const qr = await db.qr.findUnique({
    where: { hash: hash(code) },
    include: { branch: { include: { brand: true } } },
  });
  if (!qr?.active || !qr.branch.active || (!isDemo() && qr.branch.brand.status !== 'ACTIVE'))
    throw new DomainError('QR_RETIRED', 404, 'رابط الفرع غير متاح؛ تواصل مع فريق خدمة العملاء');
  if (count) await db.qr.update({ where: { id: qr.id }, data: { scans: { increment: 1 } } });
  return qr;
}
export async function publicCreate(code: string, input: unknown, key: string) {
  const qr = await publicQr(code);
  const b = z
    .object({
      description: z.string(),
      category: z.string(),
      name: z.string().optional(),
      phone: z.string().optional(),
      externalOrder: z.string().optional(),
      platform: z.string().optional(),
      consent: z.literal(true),
      whatsappConsent: z.boolean().default(false),
    })
    .parse(input);
  return createTicket(
    { id: `QR:${qr.id}`, name: 'عميل', role: 'PUBLIC', brandIds: [], branchIds: [] },
    {
      ...b,
      brandId: qr.branch.brandId,
      branchId: qr.branch.id,
      priority: b.category === 'SAFETY' ? 'P1' : 'P3',
    },
    key,
    { id: qr.id, brandId: qr.branch.brandId, branchId: qr.branch.id },
  );
}
export async function status(
  code: string,
  store: Pick<Prisma.TransactionClient, 'access' | 'complaintConfirmation'> = db,
) {
  const access = await store.access.findUnique({
    where: { hash: hash(code) },
    include: { ticket: true },
  });
  if (!access || access.expiresAt < new Date())
    throw new DomainError('TOKEN_EXPIRED', 404, 'رابط المتابعة غير صالح أو منتهي');
  return {
    number: num(access.ticket),
    state: access.ticket.state,
    createdAt: access.ticket.createdAt,
    receipt: access.ticket.receiptEncrypted
      ? JSON.parse(decrypt(access.ticket.receiptEncrypted))
      : null,
    confirmationStatus:
      (
        await store.complaintConfirmation.findUnique({
          where: { ticketId: access.ticketId },
          select: { status: true },
        })
      )?.status ?? null,
  };
}
export async function createBranch(a: Actor, input: unknown) {
  authorize(a, 'branches.manage');
  const b = z
    .object({
      ...branchLocationFields,
      brandId: z.string(),
      name: z.string().trim().min(2).max(100),
      code: z.string().regex(/^[A-Z0-9_-]{2,30}$/),
      city: z.string().trim().min(2).max(80),
    })
    .refine(pairedCoordinates, { message: 'أدخل خط العرض وخط الطول معاً' })
    .parse(input);
  if (!inScope(a, b)) throw new DomainError('FORBIDDEN', 403, 'خارج النطاق');
  if (!(await db.brand.findUnique({ where: { id: b.brandId } })))
    throw new DomainError('BRAND_NOT_FOUND', 404, 'العلامة التجارية غير موجودة');
  return db.$transaction(async (tx) => {
    const branch = await tx.branch.create({ data: { ...b, active: isDemo(), demo: isDemo() } });
    await audit(tx, a, 'BRANCH_CREATED', branch.id);
    return branch;
  });
}
export async function createTask(a: Actor, input: unknown) {
  const b = z
    .object({
      ticketId: z.string(),
      owner: z.string(),
      dueAt: z.iso.datetime(),
      note: z.string().trim().min(3).max(500),
    })
    .parse(input);
  const t = await getTicket(a, b.ticketId);
  authorize(a, 'task', t);
  if (a.role === 'AGENT' && (b.owner !== a.id || !isComplaintParticipant(a, t)))
    throw new DomainError('FORBIDDEN', 403, 'يمكنك إنشاء متابعة لنفسك فقط');
  const u = await db.user.findUnique({ where: { id: b.owner } });
  if (!u?.enabled || !inScope(u, t) || !can(u, 'contact'))
    throw new DomainError('INVALID_OWNER', 400, 'مسؤول المتابعة غير متاح');
  return db.$transaction(async (tx) => {
    const task = await tx.task.create({ data: { ...b, note: encrypt(b.note) } });
    await event(tx, t.id, a, 'FOLLOW_UP_CREATED');
    return task;
  });
}
export async function completeTask(a: Actor, id: string) {
  const task = await db.task.findUnique({ where: { id } });
  if (!task) throw new DomainError('NOT_FOUND', 404, 'المهمة غير موجودة');
  const t = await getTicket(a, task.ticketId);
  authorize(a, 'task', t);
  if (a.role === 'AGENT' && task.owner !== a.id)
    throw new DomainError('FORBIDDEN', 403, 'المهمة ليست مسندة إليك');
  return db.$transaction(async (tx) => {
    await tx.task.update({ where: { id }, data: { completedAt: new Date() } });
    await event(tx, t.id, a, 'FOLLOW_UP_COMPLETED');
    return { ok: true };
  });
}
export { saveShift as createShift } from './scheduling';
export async function exportCsv(a: Actor, brandId?: string) {
  authorize(a, 'report');
  const tickets = await db.ticket.findMany({
    where: { ...scope(a), ...(brandId ? { AND: [{ brandId }] } : {}) },
    include: { brand: true, branch: true },
    orderBy: { createdAt: 'desc' },
  });
  await db.audit.create({
    data: { actor: a.id, action: 'MASKED_CSV_EXPORTED', entityId: brandId ?? 'SCOPED' },
  });
  return (
    '\uFEFF' +
    [
      ['رقم البلاغ', 'العلامة', 'الفرع', 'الحالة', 'الأولوية', 'المصدر', 'وقت الإنشاء (UTC)'],
      ...tickets.map((t) => [
        num(t),
        t.brand.name,
        t.branch?.name ?? 'غير معروف',
        t.state,
        t.priority,
        t.source,
        t.createdAt.toISOString(),
      ]),
    ]
      .map((row) => row.map(safeCell).join(','))
      .join('\r\n')
  );
}
