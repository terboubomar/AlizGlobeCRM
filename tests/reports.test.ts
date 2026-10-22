import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateReport, reportInput, reportWhere } from '../apps/api/src/reports';
import type { Actor } from '../packages/domain/src';
const a: Actor = {
  id: 'ops',
  role: 'OPERATIONS_MANAGER',
  name: 'Ops',
  brandIds: ['brand'],
  branchIds: ['branch'],
};
const base = {
  brandId: 'brand',
  branchId: 'branch',
  brand: { name: 'Brand', color: '#b62e30', logo: 'waqf.jpeg' },
  branch: { name: 'Branch' },
  state: 'NEW',
  source: 'PHONE_AGENT',
  category: 'SERVICE',
  escalated: false,
  receivedAt: new Date('2026-10-20T21:30:00Z'),
  closedAt: null as Date | null,
};
test('reports include all matching rows, zero-fill Riyadh days and compute closed durations', () => {
  const rows = Array.from({ length: 501 }, () => ({ ...base }));
  rows.push({
    ...base,
    state: 'CLOSED',
    closedAt: new Date('2026-10-21T01:30:00Z'),
  });
  const r = aggregateReport(rows, '2026-10-20', '2026-10-21');
  assert.equal(r.summary.total, 502);
  assert.equal(r.summary.open, 501);
  assert.equal(r.summary.closed, 1);
  assert.equal(r.summary.avgResolutionHours, 4);
  assert.equal(r.trend[0].received, 0);
  assert.equal(r.trend[1].received, 502);
  assert.equal(r.brands[0].total, 502);
  assert.equal(r.branches[0].total, 502);
  const empty = aggregateReport([], '2026-10-20', '2026-10-21');
  assert.equal(empty.summary.avgResolutionHours, null);
  assert.equal(empty.summary.closureRate, 0);
});
test('report filters preserve actor scope, operations assignment and inclusive Riyadh dates', () => {
  const r = reportWhere(a, {
    from: '2026-10-21',
    to: '2026-10-21',
    brandId: 'outside',
    branchId: 'outside-branch',
    source: 'PUBLIC_QR',
  });
  assert.deepEqual(r.where.AND[0], {
    brandId: { in: ['brand'] },
    branchId: { in: ['branch'] },
    escalated: true,
    resolutionOwner: 'ops',
  });
  assert.equal(r.start.toISOString(), '2026-10-20T21:00:00.000Z');
  assert.equal(r.end.toISOString(), '2026-10-21T21:00:00.000Z');
  assert.equal(reportInput.safeParse({ from: '2026-10-22', to: '2026-10-21' }).success, false);
  assert.equal(reportInput.safeParse({ from: '2020-01-01', to: '2026-10-21' }).success, false);
  assert.equal(reportInput.safeParse({ from: '2026-02-30', to: '2026-03-01' }).success, false);
});

test('previous periods preserve filters and handle leap dates and year boundaries', async () => {
  const { previousReportPeriod } = await import('../apps/api/src/reports');
  assert.deepEqual(
    previousReportPeriod({
      from: '2026-01-01',
      to: '2026-01-07',
      priority: 'P1',
      source: 'PUBLIC_QR',
      brandId: 'brand',
    }),
    { from: '2025-12-25', to: '2025-12-31', priority: 'P1', source: 'PUBLIC_QR', brandId: 'brand' },
  );
  assert.deepEqual(previousReportPeriod({ from: '2024-03-01', to: '2024-03-01' }), {
    from: '2024-02-29',
    to: '2024-02-29',
  });
  assert.equal(
    reportInput.safeParse({ from: '2026-10-01', to: '2026-10-22', priority: 'P4' }).success,
    false,
  );
});
test('aging excludes solved cases, respects exact boundaries and groups current assignees', () => {
  const now = new Date('2026-10-22T12:00:00Z');
  const rows = [0, 23, 24, 48, 72].map((hours, index) => ({
    ...base,
    priority: index ? 'P2' : 'P1',
    resolutionOwner: index ? 'agent' : 'UNASSIGNED',
    receivedAt: new Date(+now - hours * 3600000),
  }));
  rows.push({
    ...base,
    priority: 'P1',
    resolutionOwner: 'agent',
    receivedAt: new Date(+now - 100 * 3600000),
    state: 'CLOSED',
    closedAt: now,
  });
  const report = aggregateReport(rows, '2026-10-01', '2026-10-22', now);
  assert.deepEqual(
    report.aging.map((a) => a.count),
    [2, 1, 1, 1],
  );
  assert.equal(
    report.aging.reduce((n, a) => n + a.count, 0),
    report.summary.open,
  );
  assert.equal(report.team.find((t) => t.id === 'agent')?.total, 5);
  assert.equal(report.priorities.find((p) => p.key === 'P1')?.count, 2);
  assert.equal(report.summary.medianResolutionHours, 100);
  assert.equal(report.summary.resolvedWithTime, 1);
});
test('resolution averages retain minute precision and expose the median', () => {
  const rows = [1, 3, 8, 100].map((minutes) => ({
    ...base,
    state: 'CLOSED',
    closedAt: new Date(+base.receivedAt + minutes * 60000),
  }));
  const r = aggregateReport(rows, '2026-10-21', '2026-10-21');
  assert.equal(r.summary.avgResolutionHours, 28 / 60);
  assert.ok(Math.abs(r.summary.medianResolutionHours! - 5.5 / 60) < 1e-10);
});
