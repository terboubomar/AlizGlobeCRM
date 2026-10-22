import { z } from 'zod';
export const roles = [
  'SUPER_ADMIN',
  'MARKETING_MANAGER',
  'OPERATIONS_MANAGER',
  'CEO',
  'OWNER',
  'AGENT',
  'SHIFT_LEAD',
  'CUSTOMER_SERVICE_MANAGER',
  'AREA_MANAGER',
  'BRANCH_MANAGER',
  'BRAND_OPERATIONS_MANAGER',
  'GROUP_OPERATIONS_MANAGER',
  'FINANCE_APPROVER',
  'REFUND_PROCESSOR',
  'QA_REVIEWER',
  'SCHEDULER',
  'ADMIN',
  'PRIVACY_OFFICER',
] as const;
export const assignableRoles = [
  'SUPER_ADMIN',
  'MARKETING_MANAGER',
  'SHIFT_LEAD',
  'AGENT',
  'OPERATIONS_MANAGER',
  'CEO',
  'OWNER',
] as const;
export type Role = (typeof roles)[number];
export type Actor = {
  id: string;
  name: string;
  role: string;
  brandIds: string[];
  branchIds: string[];
  financeDuty?: string;
};
export const financeDuties = ['NONE', 'APPROVER', 'PROCESSOR', 'VERIFIER'] as const;
const financePermissions: Record<string, string[]> = {
  APPROVER: ['refund.decide', 'evidence.view'],
  PROCESSOR: ['refund.execute', 'refund.notify', 'evidence.view', 'evidence.attach'],
  VERIFIER: ['refund.verify', 'evidence.view'],
};
export type Scope = { brandId: string; branchId?: string | null };
const rights: Record<string, string[]> = {
  AGENT: [
    'schedule.self',
    'read',
    'pii',
    'create',
    'comment',
    'contact',
    'task',
    'refund.request',
    'acknowledge',
    'investigate',
    'resolve',
    'escalate',
  ],
  SHIFT_LEAD: [
    'brands.manage',
    'branches.manage',
    'read',
    'pii',
    'create',
    'comment',
    'contact',
    'task',
    'refund.request',
    'assign',
    'triage',
    'close',
    'escalate',
    'investigate',
    'resolve',
    'qa',
  ],
  CUSTOMER_SERVICE_MANAGER: [
    'brands.manage',
    'branches.manage',
    'read',
    'pii',
    'create',
    'comment',
    'contact',
    'task',
    'refund.request',
    'assign',
    'triage',
    'close',
    'escalate',
    'investigate',
    'resolve',
    'report',
  ],
  AREA_MANAGER: ['read', 'comment', 'report', 'investigate', 'resolve', 'escalate'],
  BRANCH_MANAGER: ['read', 'comment'],
  BRAND_OPERATIONS_MANAGER: ['read', 'comment', 'escalate', 'report', 'investigate', 'resolve'],
  GROUP_OPERATIONS_MANAGER: ['read', 'comment', 'escalate', 'report', 'investigate', 'resolve'],
  FINANCE_APPROVER: ['read', 'comment', 'refund.decide', 'refund.verify'],
  REFUND_PROCESSOR: ['read', 'comment', 'refund.execute', 'refund.notify'],
  QA_REVIEWER: ['read', 'qa', 'report'],
  SCHEDULER: ['schedule'],
  ADMIN: ['configure', 'audit', 'brands.manage', 'branches.manage'],
  PRIVACY_OFFICER: ['read', 'pii', 'privacy', 'audit'],
};
rights.MARKETING_MANAGER = [...rights.CUSTOMER_SERVICE_MANAGER, 'qa', 'schedule', 'configure'];
rights.OPERATIONS_MANAGER = ['read', 'comment', 'report', 'investigate', 'resolve', 'escalate'];
rights.CEO = ['read', 'report'];
rights.OWNER = ['read', 'report'];
rights.SUPER_ADMIN = [
  ...new Set(Object.values(rights).flat()),
  'users.manage',
  'directory.activate',
  'evidence.view',
];
rights.FINANCE_APPROVER.push('evidence.view');
rights.REFUND_PROCESSOR.push('evidence.view');
export function permissionsForRole(role: string, financeDuty?: string) {
  const base = rights[role];
  if (!base) return [];
  return [
    ...new Set([
      ...base,
      ...(base.includes('pii') ? ['evidence.view'] : []),
      ...(base.includes('comment') ? ['evidence.attach'] : []),
      ...(financePermissions[financeDuty ?? 'NONE'] ?? []),
    ]),
  ];
}
export function can(actor: Actor, action: string) {
  return permissionsForRole(actor.role, actor.financeDuty).includes(action);
}
export function inScope(actor: Actor, s: Scope) {
  if (actor.role === 'SUPER_ADMIN') return true;
  return (
    actor.brandIds.includes(s.brandId) &&
    (!actor.branchIds.length || (!!s.branchId && actor.branchIds.includes(s.branchId)))
  );
}
export function authorize(actor: Actor, action: string, s?: Scope) {
  if (!can(actor, action) || (s && !inScope(actor, s)))
    throw new DomainError('FORBIDDEN', 403, 'لا تملك صلاحية لهذا الإجراء أو النطاق');
}
export function canWorkComplaint(
  actor: Actor,
  ticket: Scope & { resolutionOwner: string | null; escalated?: boolean },
) {
  return (
    inScope(actor, ticket) &&
    (can(actor, 'assign') ||
      (ticket.resolutionOwner === actor.id &&
        (supportRoles.includes(actor.role) || !!ticket.escalated)))
  );
}
export function isComplaintParticipant(
  a: Actor,
  ticket: { creator?: string; resolutionOwner?: string | null; communicationsOwner?: string },
) {
  return (
    ticket.creator === a.id ||
    ticket.resolutionOwner === a.id ||
    ticket.communicationsOwner === a.id
  );
}
export const supportRoles = [
  'AGENT',
  'SHIFT_LEAD',
  'MARKETING_MANAGER',
  'CUSTOMER_SERVICE_MANAGER',
  'SUPER_ADMIN',
];
export const escalationRoles = [
  'MARKETING_MANAGER',
  'OPERATIONS_MANAGER',
  'SHIFT_LEAD',
  'CUSTOMER_SERVICE_MANAGER',
  'AREA_MANAGER',
  'BRAND_OPERATIONS_MANAGER',
  'GROUP_OPERATIONS_MANAGER',
];
export class DomainError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const ticketInput = z.object({
  brandId: z.string().min(1),
  branchId: z.string().nullable().optional(),
  unknownReason: z.string().max(300).optional(),
  category: z.enum(['DELAY', 'MISSING', 'WRONG_BRANCH', 'QUALITY', 'SAFETY', 'SERVICE', 'OTHER']),
  priority: z.enum(['P1', 'P2', 'P3']),
  description: z.string().trim().min(10).max(4000),
  name: z.string().trim().max(100).optional(),
  phone: z
    .string()
    .regex(/^(\+?966|0)?5\d{8}$/, 'أدخل رقم جوال سعودي صحيح')
    .optional()
    .or(z.literal('')),
  externalOrder: z.string().max(100).optional(),
  platform: z.string().max(80).optional(),
  receivedAt: z.iso.datetime().optional(),
  whatsappConsent: z.boolean().default(false),
});
export const categoryLabels: Record<string, string> = {
  DELAY: 'تأخر الطلب',
  MISSING: 'طلب ناقص',
  WRONG_BRANCH: 'طلب في فرع آخر',
  QUALITY: 'جودة الطعام',
  SAFETY: 'سلامة الغذاء',
  SERVICE: 'تجربة الخدمة',
  OTHER: 'أخرى',
};
export const stateLabels: Record<string, string> = {
  NEW: 'جديد',
  TRIAGED: 'قيد الفرز',
  ASSIGNED: 'بانتظار الفرع',
  ACKNOWLEDGED: 'تم استلام البلاغ',
  IN_PROGRESS: 'جاري المعالجة',
  RESOLVED: 'تمت المعالجة',
  CLOSED: 'مغلق',
};
export const steps: Record<string, string> = {
  triage: 'TRIAGED',
  assign: 'ASSIGNED',
  acknowledge: 'ACKNOWLEDGED',
  investigate: 'IN_PROGRESS',
  start: 'IN_PROGRESS',
  resolve: 'RESOLVED',
  close: 'CLOSED',
  reopen: 'IN_PROGRESS',
};
const from: Record<string, string[]> = {
  triage: ['NEW'],
  assign: ['NEW', 'TRIAGED', 'ASSIGNED', 'ACKNOWLEDGED', 'IN_PROGRESS'],
  acknowledge: ['ASSIGNED'],
  investigate: ['ACKNOWLEDGED'],
  start: ['ASSIGNED', 'ACKNOWLEDGED'],
  resolve: ['IN_PROGRESS'],
  close: ['RESOLVED'],
  reopen: ['RESOLVED', 'CLOSED'],
};
export function transition(state: string, action: string) {
  if (!from[action]?.includes(state))
    throw new DomainError('INVALID_TRANSITION', 409, 'الإجراء غير متاح في الحالة الحالية');
  return steps[action];
}
export function milestones(priority: string, received: Date, assigned?: Date) {
  const first = priority === 'P3' ? 15 : 5;
  const ack = priority === 'P3' ? 30 : 5;
  return [
    {
      milestone: 'FIRST_ACTION',
      dueAt: new Date(+received + first * 60000),
      warningAt: new Date(+received + first * 48000),
    },
    ...(assigned
      ? [
          {
            milestone: 'ACKNOWLEDGMENT',
            dueAt: new Date(+assigned + ack * 60000),
            warningAt: new Date(+assigned + ack * 48000),
          },
        ]
      : []),
    ...(priority === 'P1'
      ? []
      : [
          {
            milestone: 'REMEDY',
            dueAt: new Date(+received + (priority === 'P2' ? 30 : 240) * 60000),
            warningAt: new Date(+received + (priority === 'P2' ? 30 : 240) * 48000),
          },
        ]),
  ];
}
export function refundNext(status: string, action: string) {
  const transitions: Record<string, [string[], string]> = {
    resubmit: [['REJECTED'], 'REQUESTED'],
    review: [['REQUESTED'], 'UNDER_REVIEW'],
    approve: [['UNDER_REVIEW'], 'AWAITING_EXTERNAL_EXECUTION'],
    reject: [['REQUESTED', 'UNDER_REVIEW'], 'REJECTED'],
    execute: [['AWAITING_EXTERNAL_EXECUTION'], 'EXECUTED_UNVERIFIED'],
    verify: [['EXECUTED_UNVERIFIED'], 'VERIFIED'],
    notify: [['VERIFIED'], 'CUSTOMER_NOTIFIED'],
    complete: [['CUSTOMER_NOTIFIED'], 'COMPLETED'],
  };
  const t = transitions[action];
  if (!t || !t[0].includes(status))
    throw new DomainError(
      'INVALID_REFUND_TRANSITION',
      409,
      'لا يمكن تجاوز خطوات الموافقة والتنفيذ والتحقق وإبلاغ العميل',
    );
  return t[1];
}
export function safeCell(value: unknown) {
  const v = String(value ?? '');
  return '"' + (/^[\s]*[=+@\-\t\r]/.test(v) ? "'" : '') + v.replaceAll('"', '""') + '"';
}
export function normalizePhone(value: string) {
  const digits = value.replace(/\D/g, '');
  return digits.startsWith('966')
    ? digits
    : digits.startsWith('0')
      ? '966' + digits.slice(1)
      : '966' + digits;
}
export function overlaps(a: Date, b: Date, c: Date, d: Date) {
  return a < d && c < b;
}
