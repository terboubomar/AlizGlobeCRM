import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentWorkspace, agentQueue } from '../app/agent-workspace';
import { canOpenView } from '../app/access';
import { permissionsForRole } from '../../../packages/domain/src';
import type { Data, Ticket } from '../app/types';
const base = {
  state: 'ASSIGNED',
  brandId: 'waqf',
  branchId: 'branch',
  brand: { name: 'واقف', logo: 'waqf.jpeg' },
  branch: { name: 'الفرع الأول' },
  source: 'PHONE_AGENT',
  category: 'SERVICE',
  priority: 'P3',
  receivedAt: '2026-10-21T08:00:00Z',
  timers: [],
  externalOrder: null,
} as unknown as Ticket;
test('agents retain personal work and refund requests even with unrelated granted permissions', () => {
  const all = [
    'overview',
    'tickets',
    'tasks',
    'refunds',
    'branches',
    'qr',
    'customers',
    'schedule',
    'reports',
    'qa',
    'users',
    'settings',
  ];
  assert.deepEqual(
    all.filter((id) => canOpenView(id, permissionsForRole('SUPER_ADMIN'), 'AGENT')),
    ['overview', 'tickets', 'tasks', 'refunds', 'schedule'],
  );
  assert.ok(permissionsForRole('AGENT').includes('refund.request'));
  assert.ok(!permissionsForRole('AGENT').includes('refund.decide'));
  assert.ok(permissionsForRole('AGENT').includes('schedule.self'));
  assert.ok(!permissionsForRole('AGENT').includes('schedule'));
});
test('agent queue separates working, contact, waiting and escalated cases', () => {
  assert.equal(agentQueue({ ...base, resolutionOwner: 'me' }, 'me'), 'working');
  assert.equal(
    agentQueue({ ...base, state: 'RESOLVED', communicationsOwner: 'me' }, 'me'),
    'contact',
  );
  assert.equal(agentQueue({ ...base, resolutionOwner: null, creator: 'me' }, 'me'), 'waiting');
  assert.equal(
    agentQueue({ ...base, resolutionOwner: 'operations', escalated: true }, 'me'),
    'escalated',
  );
  assert.equal(agentQueue({ ...base, state: 'CLOSED' }, 'me'), 'closed');
  assert.equal(agentQueue({ ...base, resolutionOwner: 'other', creator: 'me' }, 'me'), 'tracking');
});
test('agent workspace displays owned and recorded cases without management controls or coworkers cases', () => {
  const data = {
    me: { id: 'me', role: 'AGENT' },
    tickets: [
      { ...base, id: 'own', number: 'MY-ASSIGNED', resolutionOwner: 'me' },
      { ...base, id: 'intake', number: 'MY-INTAKE', creator: 'me' },
      {
        ...base,
        id: 'other',
        number: 'OTHER-PRIVATE',
        creator: 'other',
        resolutionOwner: 'other',
        communicationsOwner: 'other',
      },
    ],
  } as unknown as Data;
  const html = renderToStaticMarkup(
    <AgentWorkspace data={data} brand="all" onOpen={() => {}} onPhone={() => {}} />,
  );
  assert.match(html, /MY-ASSIGNED/);
  assert.match(html, /MY-INTAKE/);
  assert.doesNotMatch(html, /OTHER-PRIVATE/);
  for (const label of [
    'إدارة المستخدمين',
    'رموز الفروع',
    'الموافقة المالية',
    'بانتظار الإسناد لفريق الدعم',
  ])
    assert.ok(!html.includes(label));
  assert.match(html, /بدء العمل/);
  assert.match(html, /عرض الشكوى/);
});

test('all-complaints mode offers phone and complaint lookup including resolved history without replacing the personal queue', () => {
  const data = { me: { id: 'me', role: 'AGENT' }, tickets: [] } as unknown as Data;
  const html = renderToStaticMarkup(
    <AgentWorkspace data={data} brand="all" browseAll onOpen={() => {}} onPhone={() => {}} />,
  );
  assert.match(html, /جميع شكاوى العملاء/);
  assert.match(html, /الجوال/);
  assert.match(html, /بما فيها المحلولة/);
  assert.doesNotMatch(html, /ملخص عملي/);
});
