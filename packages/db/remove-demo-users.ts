import 'dotenv/config';
import { db } from './client';
const demoAccounts: Record<string, string> = {
  lead: 'مشرف التجربة',
  'support-manager': 'مدير خدمة العملاء التجريبي',
  area: 'مدير المنطقة التجريبي',
  ...Object.fromEntries(
    Array.from({ length: 7 }, (_, i) => ['agent-' + (i + 1), 'موظف تجريبي ' + (i + 1)]),
  ),
  branch: 'مدير الفرع التجريبي',
  group: 'مدير العمليات التجريبي',
  finance: 'الموافق المالي التجريبي',
  processor: 'مسؤول التنفيذ التجريبي',
  verifier: 'المتحقق المالي التجريبي',
  qa: 'مراجع الجودة التجريبي',
  scheduler: 'مسؤول الجدولة التجريبي',
  admin: 'مسؤول النظام التجريبي',
  'test-limited': 'حساب اختبار نطاق',
  'test-directory-scoped': 'مشرف اختبار نطاق الفروع',
};
async function main() {
  if (process.env.DEMO_MODE !== 'true' || process.env.NODE_ENV === 'production')
    throw new Error('Local demo cleanup only');
  const result = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('aliz-user-management'))`;
    const candidates = await tx.user.findMany({
      where: {
        id: { in: Object.keys(demoAccounts) },
        email: null,
        passwordHash: null,
        subject: null,
        role: { not: 'SUPER_ADMIN' },
      },
    });
    const ids = candidates.filter((u) => demoAccounts[u.id] === u.name).map((u) => u.id);
    if (!ids.length) return { removedUsers: 0, removedDemoShifts: 0, removedDemoLeave: 0 };
    const relatedTickets = await tx.ticket.count({
      where: {
        OR: [
          { creator: { in: ids } },
          { communicationsOwner: { in: ids } },
          { resolutionOwner: { in: ids } },
        ],
      },
    });
    const relatedRefunds = await tx.refund.count({
      where: {
        OR: [
          { requester: { in: ids } },
          { approver: { in: ids } },
          { processor: { in: ids } },
          { verifier: { in: ids } },
        ],
      },
    });
    const relatedTasks = await tx.task.count({ where: { owner: { in: ids } } });
    if (relatedTickets || relatedRefunds || relatedTasks)
      throw new Error('Demo users still own case records; no records removed');
    const shifts = await tx.shift.deleteMany({ where: { userId: { in: ids } } });
    const leave = await tx.leave.deleteMany({ where: { userId: { in: ids } } });
    await tx.audit.createMany({
      data: ids.map((id) => ({ actor: 'SYSTEM', action: 'DEMO_USER_REMOVED', entityId: id })),
    });
    const users = await tx.user.deleteMany({
      where: {
        id: { in: ids },
        email: null,
        passwordHash: null,
        subject: null,
        role: { not: 'SUPER_ADMIN' },
      },
    });
    return {
      removedUsers: users.count,
      removedDemoShifts: shifts.count,
      removedDemoLeave: leave.count,
    };
  });
  console.log(
    JSON.stringify({
      ...result,
      remainingUsers: await db.user.count(),
      superadmins: await db.user.count({ where: { role: 'SUPER_ADMIN', enabled: true } }),
      tickets: await db.ticket.count(),
      refunds: await db.refund.count(),
    }),
  );
}
main().finally(() => db.$disconnect());
