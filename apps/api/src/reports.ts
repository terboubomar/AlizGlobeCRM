import { z } from 'zod';
import { db } from '../../../packages/db/client';
import { Actor, authorize, safeCell } from '../../../packages/domain/src';
import { ticketScope } from './ticket-scope';
export const reportInput = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    brandId: z.string().min(1).optional(),
    branchId: z.string().min(1).optional(),
    source: z.enum(['PUBLIC_QR', 'PHONE_AGENT']).optional(),
    priority: z.enum(['P1', 'P2', 'P3']).optional(),
  })
  .refine(
    (v) => v.from <= v.to && (Date.parse(v.to) - Date.parse(v.from)) / 86400000 < 366,
    'اختر فترة لا تتجاوز 366 يوماً.',
  );
export function reportWhere(a: Actor, raw: unknown) {
  const q = reportInput.parse(raw),
    start = new Date(q.from + 'T00:00:00+03:00'),
    end = new Date(Date.parse(q.to + 'T00:00:00+03:00') + 86400000);
  return {
    q,
    start,
    end,
    where: {
      AND: [
        ticketScope(a),
        { receivedAt: { gte: start, lt: end } },
        ...(q.brandId ? [{ brandId: q.brandId }] : []),
        ...(q.branchId ? [{ branchId: q.branchId }] : []),
        ...(q.source ? [{ source: q.source }] : []),
        ...(q.priority ? [{ priority: q.priority }] : []),
      ],
    },
  };
}
type Row = {
  brandId: string;
  branchId: string | null;
  state: string;
  source: string;
  category: string;
  escalated: boolean;
  priority?: string;
  resolutionOwner?: string | null;
  receivedAt: Date;
  closedAt: Date | null;
  brand: { name: string; logo: string; color: string };
  branch: { name: string } | null;
};
export function summarize(rows: Row[]) {
  const closed = rows.filter((r) => r.state === 'CLOSED'),
    durations = closed
      .filter((r) => r.closedAt && +r.closedAt >= +r.receivedAt)
      .map((r) => (+r.closedAt! - +r.receivedAt) / 3600000);
  durations.sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  return {
    total: rows.length,
    open: rows.length - closed.length,
    closed: closed.length,
    escalated: rows.filter((r) => r.escalated && r.state !== 'CLOSED').length,
    unassigned: rows.filter((r) => r.state === 'NEW' || r.state === 'TRIAGED').length,
    closureRate: rows.length ? Math.round((closed.length / rows.length) * 100) : 0,
    resolvedWithTime: durations.length,
    medianResolutionHours: durations.length
      ? durations.length % 2
        ? durations[middle]
        : (durations[middle - 1] + durations[middle]) / 2
      : null,
    avgResolutionHours: durations.length
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : null,
  };
}
export function aggregateReport(rows: Row[], from: string, to: string, now = new Date()) {
  const counts = (key: 'state' | 'source' | 'category' | 'priority') =>
    Object.entries(
      rows.reduce<Record<string, number>>((all, r) => {
        const stateGroups: Record<string, string> = {
          TRIAGED: 'NEW',
          ACKNOWLEDGED: 'IN_PROGRESS',
          INVESTIGATING: 'IN_PROGRESS',
          ACTION_PENDING: 'IN_PROGRESS',
        };
        const label = key === 'state' ? (stateGroups[r.state] ?? r.state) : (r[key] ?? 'UNKNOWN');
        all[label] = (all[label] ?? 0) + 1;
        return all;
      }, {}),
    )
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count);
  const groups = (kind: 'brand' | 'branch') => {
    const grouped = new Map<string, Row[]>();
    for (const r of rows) {
      const id = kind === 'brand' ? r.brandId : (r.branchId ?? 'UNKNOWN:' + r.brandId);
      const list = grouped.get(id);
      if (list) list.push(r);
      else grouped.set(id, [r]);
    }
    return [...grouped]
      .map(([id, items]) => ({
        id,
        name: kind === 'brand' ? items[0].brand.name : (items[0].branch?.name ?? 'الفرع غير محدد'),
        brandName: items[0].brand.name,
        logo: items[0].brand.logo,
        color: items[0].brand.color,
        ...summarize(items),
      }))
      .sort((a, b) => b.total - a.total);
  };
  const days = new Map<string, { day: string; received: number; closed: number }>();
  for (let d = Date.parse(from + 'T12:00:00Z'); d <= Date.parse(to + 'T12:00:00Z'); d += 86400000) {
    const day = new Date(d).toISOString().slice(0, 10);
    days.set(day, { day, received: 0, closed: 0 });
  }
  const day = (d: Date) => new Date(+d + 10800000).toISOString().slice(0, 10);
  for (const r of rows) {
    const received = days.get(day(r.receivedAt));
    if (received) received.received++;
    if (r.state === 'CLOSED' && r.closedAt) {
      const closed = days.get(day(r.closedAt));
      if (closed) closed.closed++;
    }
  }
  const aging = [
    { key: 'under24', label: 'أقل من 24 ساعة', count: 0 },
    { key: '24to48', label: '24–48 ساعة', count: 0 },
    { key: '48to72', label: '48–72 ساعة', count: 0 },
    { key: 'over72', label: '72 ساعة فأكثر', count: 0 },
  ];
  const team = new Map<string, Row[]>();
  for (const row of rows) {
    const owner = row.resolutionOwner ?? 'UNASSIGNED';
    const group = team.get(owner);
    if (group) group.push(row);
    else team.set(owner, [row]);
    if (row.state !== 'CLOSED') {
      const hours = Math.max(0, (+now - +row.receivedAt) / 3600000);
      aging[hours < 24 ? 0 : hours < 48 ? 1 : hours < 72 ? 2 : 3].count++;
    }
  }
  return {
    aging,
    team: [...team]
      .map(([id, items]) => ({ id, ...summarize(items) }))
      .sort((a, b) => b.open - a.open),
    priorities: counts('priority'),
    summary: summarize(rows),
    states: counts('state'),
    sources: counts('source'),
    categories: counts('category'),
    brands: groups('brand'),
    branches: groups('branch'),
    trend: [...days.values()],
  };
}
export function previousReportPeriod(input: z.infer<typeof reportInput>) {
  const days = (Date.parse(input.to) - Date.parse(input.from)) / 86400000 + 1;
  return {
    ...input,
    from: new Date(Date.parse(input.from) - days * 86400000).toISOString().slice(0, 10),
    to: new Date(Date.parse(input.from) - 86400000).toISOString().slice(0, 10),
  };
}
const reportSelect = {
  brandId: true,
  branchId: true,
  state: true,
  source: true,
  category: true,
  priority: true,
  resolutionOwner: true,
  escalated: true,
  receivedAt: true,
  closedAt: true,
  brand: { select: { name: true, logo: true, color: true } },
  branch: { select: { name: true } },
} as const;
export async function complaintReport(a: Actor, input: unknown) {
  authorize(a, 'report');
  const { q, where } = reportWhere(a, input),
    previous = previousReportPeriod(q),
    now = new Date();
  const [rows, previousRows] = await Promise.all([
    db.ticket.findMany({ where, select: reportSelect }),
    db.ticket.findMany({ where: reportWhere(a, previous).where, select: reportSelect }),
  ]);
  const result = aggregateReport(rows, q.from, q.to, now);
  const owners = await db.user.findMany({
    where: { id: { in: result.team.map((t) => t.id) }, brandIds: { hasSome: a.brandIds } },
    select: { id: true, name: true },
  });
  return {
    ...result,
    team: result.team.map((t) => ({
      ...t,
      name:
        t.id === 'UNASSIGNED'
          ? 'غير مسند'
          : (owners.find((u) => u.id === t.id)?.name ?? 'موظف سابق'),
    })),
    previous: {
      from: previous.from,
      to: previous.to,
      summary: summarize(previousRows),
      trend: aggregateReport(previousRows, previous.from, previous.to, now).trend,
    },
    filters: q,
    generatedAt: now.toISOString(),
  };
}
export async function exportReport(a: Actor, input: unknown) {
  authorize(a, 'report');
  const { where } = reportWhere(a, input);
  const rows = await db.ticket.findMany({
    where,
    select: {
      sequence: true,
      createdAt: true,
      receivedAt: true,
      closedAt: true,
      state: true,
      source: true,
      category: true,
      priority: true,
      brand: { select: { name: true } },
      branch: { select: { name: true } },
    },
    orderBy: { receivedAt: 'desc' },
  });
  await db.audit.create({
    data: { actor: a.id, action: 'FILTERED_REPORT_EXPORTED', entityId: 'SCOPED' },
  });
  const state: Record<string, string> = {
    NEW: 'استقبال الشكوى',
    TRIAGED: 'استقبال الشكوى',
    ASSIGNED: 'الإسناد',
    ACKNOWLEDGED: 'جارٍ العمل',
    INVESTIGATING: 'جارٍ العمل',
    IN_PROGRESS: 'جارٍ العمل',
    ACTION_PENDING: 'جارٍ العمل',
    RESOLVED: 'التواصل مع العميل',
    CLOSED: 'تم الحل',
  };
  return (
    '\uFEFF' +
    [
      [
        'رقم الشكوى',
        'العلامة',
        'الفرع',
        'الحالة',
        'المصدر',
        'التصنيف',
        'الأولوية',
        'الاستقبال - الرياض',
        'الحل - الرياض',
      ],
      ...rows.map((r) => [
        `AG-${r.createdAt.getUTCFullYear()}-${String(r.sequence).padStart(6, '0')}`,
        r.brand.name,
        r.branch?.name ?? 'غير محدد',
        state[r.state] ?? r.state,
        r.source === 'PUBLIC_QR' ? 'QR' : 'هاتف',
        (
          {
            DELAY: 'تأخر الطلب',
            MISSING: 'طلب ناقص',
            WRONG_BRANCH: 'طلب في فرع آخر',
            QUALITY: 'جودة الطعام',
            SAFETY: 'سلامة الغذاء',
            SERVICE: 'تجربة الخدمة',
            OTHER: 'أخرى',
          } as Record<string, string>
        )[r.category] ?? r.category,
        r.priority,
        new Date(+r.receivedAt + 10800000).toISOString().slice(0, 16).replace('T', ' '),
        r.closedAt
          ? new Date(+r.closedAt + 10800000).toISOString().slice(0, 16).replace('T', ' ')
          : '',
      ]),
    ]
      .map((row) => row.map(safeCell).join(','))
      .join('\r\n')
  );
}
