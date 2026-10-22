import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { complaintStages, complaintStage, nextComplaintAction } from '../app/workflow';
import { ComplaintActionPanel } from '../app/complaint-actions';
import type { Data, Ticket } from '../app/types';
const ticket = {
  id: 'example',
  state: 'RESOLVED',
  brandId: 'waqf',
  branchId: 'branch-a',
  resolutionOwner: 'agent-1',
  communicationsOwner: 'agent-1',
  actionCompletedAt: '2026-10-20T01:00:00.000Z',
  customerConfirmedAt: null,
  events: [
    { type: 'CONTACT_RECORDED', createdAt: '2026-10-20T01:01:00.000Z' },
    { type: 'FOLLOWUP_UNREACHABLE', createdAt: '2026-10-20T01:01:00.000Z' },
  ],
  refunds: [],
} as unknown as Ticket;
test('an unsuccessful call stays in the resolved queue until customer confirmation', () => {
  assert.equal(complaintStage(ticket), 'followup');
  assert.equal(nextComplaintAction(ticket).action, 'followup');
  assert.equal(
    complaintStage({ ...ticket, customerConfirmedAt: '2026-10-20T01:02:00.000Z' }),
    'followup',
  );
});
test('new complaints go directly to assignment without a triage step', () => {
  assert.equal(nextComplaintAction({ ...ticket, state: 'NEW' }).action, 'assign');
  assert.equal(nextComplaintAction({ ...ticket, state: 'ASSIGNED' }).action, 'start');
});
test('a customer outcome must be explicitly selected and unassigned staff have no work action', () => {
  const data = {
    me: { id: 'agent-2', role: 'AGENT' },
    users: [],
    brands: [],
    permissions: ['comment', 'contact', 'investigate', 'resolve', 'escalate'],
  } as unknown as Data;
  const html = renderToStaticMarkup(
    <ComplaintActionPanel
      ticket={{ ...ticket, state: 'IN_PROGRESS' }}
      data={data}
      busy={false}
      mutate={async () => undefined}
    />,
  );
  assert.doesNotMatch(html, /name="outcome"/);
  assert.doesNotMatch(html, /الإجراء المنفذ لشرحه للعميل/);
  const own = renderToStaticMarkup(
    <ComplaintActionPanel
      ticket={ticket}
      data={{ ...data, me: { ...data.me, id: 'agent-1' } }}
      busy={false}
      mutate={async () => undefined}
    />,
  );
  assert.match(own, /value="" selected=""/);
  assert.match(own, /حدد نتيجة التواصل/);
});

test('the exact five-stage order ends with solved and assignment offers support people only', () => {
  assert.deepEqual(
    complaintStages.map((s) => s.label),
    ['استقبال الشكوى', 'الإسناد', 'جارٍ العمل', 'التواصل مع العميل', 'تم الحل'],
  );
  const data = {
    me: { id: 'lead', role: 'SHIFT_LEAD' },
    permissions: ['assign', 'comment'],
    users: [
      { id: 'agent-1', name: 'Support person', role: 'AGENT', brandIds: ['waqf'], branchIds: [] },
      {
        id: 'ops',
        name: 'Operations recipient',
        role: 'GROUP_OPERATIONS_MANAGER',
        brandIds: ['waqf'],
        branchIds: [],
      },
      {
        id: 'area',
        name: 'Area recipient',
        role: 'AREA_MANAGER',
        brandIds: ['waqf'],
        branchIds: [],
      },
      {
        id: 'branch',
        name: 'Branch person',
        role: 'BRANCH_MANAGER',
        brandIds: ['waqf'],
        branchIds: ['branch-a'],
      },
    ],
  } as unknown as Data;
  const html = renderToStaticMarkup(
    <ComplaintActionPanel
      ticket={{ ...ticket, state: 'NEW', resolutionOwner: null }}
      data={data}
      busy={false}
      mutate={async () => undefined}
    />,
  );
  assert.match(html, /Support person/);
  assert.doesNotMatch(html, /Operations recipient|Area recipient|Branch person/);
  assert.doesNotMatch(html, /name="branchId"|name="owner"|name="branchBrief"/);
  assert.equal((html.match(/<select/g) ?? []).length, 1);
  assert.equal(complaintStage({ ...ticket, state: 'CLOSED' }), 'closed');
});
