import 'dotenv/config';
import { db } from './client';
import { encrypt } from '../../apps/api/src/crypto';
import { milestones } from '../domain/src';
async function main() {
  if (process.env.DEMO_MODE !== 'true' || process.env.NODE_ENV === 'production')
    throw new Error('Demo seed requires nonproduction DEMO_MODE=true');
  if (process.env.SEED_DEMO_CASES === 'true' && process.env.SEED_DEMO_USERS !== 'true')
    throw new Error('Sample cases require SEED_DEMO_USERS=true as well as SEED_DEMO_CASES=true');
  const brands = [
    ['waqf', 'واقف', 'Burger Waqf', 'waqf.jpeg', '#B62E30'],
    ['kabab', 'كباب علوم', 'Kabab Uloom', 'kabab.png', '#15A84C'],
    ['batatisyon', 'بطاطسيون', 'Batatisyon', 'batatisyon.jpeg', '#E95627'],
    ['mazmuzil', 'مزمزيل', 'Mazmuzil', 'mazmuzil.webp', '#827B41'],
    ['shawarman', 'شاورمان', 'Shawarman', 'shawarman.webp', '#C52C31'],
  ];
  for (const [id, name, nameEn, logo, color] of brands)
    await db.brand.upsert({
      where: { id },
      create: { id, name, nameEn, logo, color, status: id === 'waqf' ? 'ACTIVE' : 'DRAFT' },
      update: { logo },
    });
  const brandIds = brands.map((b) => b[0]);
  for (const b of brands)
    for (let i = 1; i <= 2; i++)
      await db.branch.upsert({
        where: { code: `DEMO-${b[0]}-${i}` },
        create: {
          id: `demo-${b[0]}-${i}`,
          brandId: b[0],
          name: `فرع تجريبي ${i === 1 ? 'أ' : 'ب'}`,
          code: `DEMO-${b[0]}-${i}`,
          city: 'مدينة تجريبية',
          active: true,
          demo: true,
        },
        update: {},
      });
  const users = [
    ['lead', 'مشرف التجربة', 'SHIFT_LEAD'],
    ['support-manager', 'مدير خدمة العملاء التجريبي', 'CUSTOMER_SERVICE_MANAGER'],
    ['area', 'مدير المنطقة التجريبي', 'AREA_MANAGER'],
    ...Array.from({ length: 7 }, (_, i) => [`agent-${i + 1}`, `موظف تجريبي ${i + 1}`, 'AGENT']),
    ['branch', 'مدير الفرع التجريبي', 'BRANCH_MANAGER'],
    ['group', 'مدير العمليات التجريبي', 'GROUP_OPERATIONS_MANAGER'],
    ['finance', 'الموافق المالي التجريبي', 'FINANCE_APPROVER'],
    ['processor', 'مسؤول التنفيذ التجريبي', 'REFUND_PROCESSOR'],
    ['verifier', 'المتحقق المالي التجريبي', 'FINANCE_APPROVER'],
    ['qa', 'مراجع الجودة التجريبي', 'QA_REVIEWER'],
    ['scheduler', 'مسؤول الجدولة التجريبي', 'SCHEDULER'],
    ['admin', 'مسؤول النظام التجريبي', 'ADMIN'],
  ];
  if (process.env.SEED_DEMO_USERS === 'true') {
    for (const [id, name, role] of users)
      await db.user.upsert({
        where: { id },
        create: {
          id,
          name,
          role,
          brandIds: ['BRANCH_MANAGER', 'AREA_MANAGER'].includes(role) ? ['waqf'] : brandIds,
          branchIds:
            role === 'BRANCH_MANAGER'
              ? ['demo-waqf-1']
              : role === 'AREA_MANAGER'
                ? ['demo-waqf-1', 'demo-waqf-2']
                : [],
        },
        update: {},
      });
  }
  if (process.env.SEED_DEMO_CASES === 'true' && !(await db.ticket.count())) {
    const descriptions = [
      'تجربة توضيحية: أفاد العميل بتأخر تسليم الطلب، ويحتاج إلى متابعة مع الفرع.',
      'تجربة توضيحية: أحد الأصناف غير موجود في الطلب المستلم.',
      'تجربة توضيحية: تم تسجيل الطلب لدى فرع آخر ويحتاج إلى مراجعة.',
      'تجربة توضيحية: ملاحظة على جودة الوجبة المستلمة.',
      'تجربة توضيحية: ملاحظة على تجربة الخدمة في الفرع.',
    ];
    for (let i = 0; i < 18; i++) {
      const brandId = brandIds[i % 5],
        createdAt = new Date(Date.now() - (i + 1) * 9 * 60000),
        category = ['DELAY', 'MISSING', 'WRONG_BRANCH', 'QUALITY', 'SERVICE'][i % 5],
        state = ['NEW', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'][i % 6];
      await db.$transaction(async (tx) => {
        const t = await tx.ticket.create({
          data: {
            brandId,
            branchId: `demo-${brandId}-${(i % 2) + 1}`,
            source: i % 3 === 0 ? 'PUBLIC_QR' : 'PHONE_AGENT',
            category,
            priority: i % 4 === 0 ? 'P2' : 'P3',
            state,
            description: encrypt(descriptions[i % 5]),
            communicationsOwner: i % 6 === 0 ? 'UNASSIGNED' : `agent-${(i % 7) + 1}`,
            resolutionOwner: state === 'NEW' ? null : `demo-${brandId}-${(i % 2) + 1}`,
            creator: 'agent-1',
            externalOrder: `DEMO-ORDER-${100 + i}`,
            platform: 'منصة تجريبية',
            receivedAt: createdAt,
            createdAt,
            demo: true,
            actionCompletedAt: ['RESOLVED', 'CLOSED'].includes(state) ? new Date() : null,
            closedAt: state === 'CLOSED' ? new Date() : null,
          },
        });
        await tx.event.create({
          data: { ticketId: t.id, actor: 'SYSTEM', type: 'DEMO_CREATED', createdAt },
        });
        await tx.timer.createMany({
          data: milestones(t.priority, createdAt, state !== 'NEW' ? createdAt : undefined).map(
            (m) => ({
              ...m,
              ticketId: t.id,
              completedAt: ['RESOLVED', 'CLOSED'].includes(state)
                ? new Date()
                : m.milestone === 'FIRST_ACTION' && state !== 'NEW'
                  ? new Date()
                  : m.milestone === 'ACKNOWLEDGMENT' &&
                      ['ACKNOWLEDGED', 'IN_PROGRESS'].includes(state)
                    ? new Date()
                    : null,
            }),
          ),
        });
        if (i === 2)
          await tx.refund.create({
            data: {
              ticketId: t.id,
              brandId,
              branchId: t.branchId,
              externalOrder: t.externalOrder!,
              platform: t.platform!,
              kind: 'REFUND',
              reason: encrypt('طلب تجريبي للمراجعة فقط'),
              amountMinor: 4500,
              requester: 'agent-1',
              events: { create: { type: 'REFUND_REQUESTED', actor: 'agent-1' } },
            },
          });
      });
    }
  }
  console.log(
    'Demo directory ready. Sample staff require SEED_DEMO_USERS=true; sample cases also require SEED_DEMO_CASES=true.',
  );
}
main().finally(() => db.$disconnect());
