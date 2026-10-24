import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoleWorkspace } from '../app/role-workspace';
import { RefundWorkspace } from '../app/refund-workspace';
import { roleWorkspaces, canOpenView } from '../app/access';
import { permissionsForRole } from '../../../packages/domain/src';
import type { Data } from '../app/types';
function dataFor(role: string): Data {
  return {
    me: { id: 'me', name: 'Test', role, brandIds: ['brand'], branchIds: [] },
    brands: [{ id: 'brand', name: 'علامتي', logo: 'neutral.svg', branches: [] }],
    users: [],
    tickets: [],
    ticketCount: 0,
    refunds: [],
    tasks: [],
    permissions: permissionsForRole(role),
  } as unknown as Data;
}
test('every requested role has an intentional navigation profile', () => {
  const expected: Record<string, string[]> = {
    SUPER_ADMIN: [
      'overview',
      'tickets',
      'refunds',
      'branches',
      'qr',
      'customers',
      'tasks',
      'schedule',
      'reports',
      'users',
      'settings',
    ],
    MARKETING_MANAGER: [
      'overview',
      'tickets',
      'refunds',
      'branches',
      'qr',
      'customers',
      'tasks',
      'schedule',
      'reports',
    ],
    SHIFT_LEAD: ['overview', 'tickets', 'refunds', 'branches', 'customers', 'tasks'],
    AGENT: ['overview', 'tickets', 'refunds', 'tasks', 'schedule'],
    OPERATIONS_MANAGER: ['overview', 'tickets', 'refunds', 'reports'],
    CEO: ['overview', 'reports', 'tickets', 'refunds', 'branches'],
    OWNER: ['overview', 'reports', 'tickets', 'refunds', 'branches'],
  };
  for (const [role, views] of Object.entries(expected)) {
    const profile = roleWorkspaces[role];
    assert.deepEqual(profile.views, views);
    for (const id of Object.keys(
      roleWorkspaces.SUPER_ADMIN.views.reduce((a, v) => ({ ...a, [v]: true }), {}),
    ))
      assert.equal(canOpenView(id, permissionsForRole(role), role), views.includes(id));
  }
});
test('homepages provide distinct role content and executives receive no management shortcuts', () => {
  for (const role of [
    'SUPER_ADMIN',
    'MARKETING_MANAGER',
    'SHIFT_LEAD',
    'OPERATIONS_MANAGER',
    'CEO',
    'OWNER',
  ]) {
    const html = renderToStaticMarkup(
      <RoleWorkspace data={dataFor(role)} brand="all" onOpen={() => {}} onNavigate={() => {}} />,
    );
    if (role === 'SUPER_ADMIN') assert.match(html, /المستخدمون والصلاحيات/);
    if (role === 'SHIFT_LEAD') assert.match(html, /توزيع العمل على الفريق/);
    if (role === 'MARKETING_MANAGER') assert.match(html, /عبر QR/);
    if (role === 'OPERATIONS_MANAGER') assert.match(html, /قائمة التصعيدات المسندة/);
    if (role === 'OWNER') assert.match(html, /العلامات ضمن ملكيتي/);
    if (role === 'CEO') assert.match(html, /تجربة العملاء حسب العلامة/);
    if (['CEO', 'OWNER'].includes(role)) {
      assert.doesNotMatch(html, /إدارة الحسابات|إنشاء الروابط|إسناد الشكوى/);
    }
  }
});
test('agents can create and track refunds without financial approval controls', () => {
  const html = renderToStaticMarkup(
    <RefundWorkspace
      data={dataFor('AGENT')}
      brand="all"
      mutate={async () => ({})}
      busy={false}
      reload={async () => {}}
      onComplaint={() => {}}
    />,
  );
  assert.match(html, /طلباتي للاسترجاع والإلغاء/);
  assert.match(html, /طلب استرجاع أو إلغاء/);
  assert.ok(
    !permissionsForRole('AGENT').some((p) =>
      ['refund.decide', 'refund.execute', 'refund.verify'].includes(p),
    ),
  );
});
test('dashboard tiles use exact server counts, not the capped case list', async () => {
  const { summaryFor } = await import('../app/types');
  const counts = (active: number) => ({
    active,
    closed: 3,
    followup: 2,
    waiting: 4,
    escalated: 1,
    late: 5,
    urgent: 6,
  });
  const summary = { brand: counts(742), other: counts(8) };
  assert.equal(summaryFor(summary, 'all')?.active, 750);
  assert.equal(summaryFor(summary, 'brand')?.active, 742);
  assert.equal(summaryFor(summary, 'missing')?.active, 0);
  assert.equal(summaryFor(undefined, 'all'), null);
  // No cases loaded at all, yet the tiles must show the scope-wide totals.
  const data = { ...dataFor('SHIFT_LEAD'), ticketSummary: summary, ticketCount: 750 };
  const html = renderToStaticMarkup(
    <RoleWorkspace data={data} brand="brand" onOpen={() => {}} onNavigate={() => {}} />,
  );
  assert.match(html, />742</);
  assert.doesNotMatch(html, />750</);
});
