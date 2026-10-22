import test from 'node:test';
import assert from 'node:assert/strict';
import { canOpenView } from '../app/access';
import { permissionsForRole, roles } from '../../../packages/domain/src';

test('navigation respects server role permissions and never exposes user management to ordinary staff', () => {
  for (const role of roles) {
    const permissions = permissionsForRole(role);
    assert.equal(canOpenView('users', permissions), role === 'SUPER_ADMIN');
    assert.equal(
      canOpenView('qr', permissions),
      ['ADMIN', 'SUPER_ADMIN', 'MARKETING_MANAGER'].includes(role),
    );
  }
  assert.ok(canOpenView('tickets', permissionsForRole('AGENT')));
  assert.ok(!canOpenView('reports', permissionsForRole('AGENT')));
  assert.ok(!canOpenView('customers', permissionsForRole('AREA_MANAGER')));
  assert.ok(canOpenView('schedule', permissionsForRole('SCHEDULER')));
  assert.ok(!canOpenView('tickets', permissionsForRole('SCHEDULER')));
  assert.ok(canOpenView('settings', []));
  assert.ok(!canOpenView('unknown', permissionsForRole('SUPER_ADMIN')));
});

test('requested business roles keep executive viewing and operations escalation separate from support assignment', () => {
  const marketing = permissionsForRole('MARKETING_MANAGER');
  assert.ok(marketing.includes('assign'));
  assert.ok(marketing.includes('pii'));
  assert.ok(marketing.includes('configure'));
  assert.ok(!marketing.includes('users.manage'));
  const operations = permissionsForRole('OPERATIONS_MANAGER');
  assert.ok(operations.includes('investigate'));
  assert.ok(!operations.includes('assign'));
  assert.ok(!operations.includes('pii'));
  for (const role of ['CEO', 'OWNER']) {
    assert.deepEqual(permissionsForRole(role), ['read', 'report']);
    assert.ok(canOpenView('reports', permissionsForRole(role)));
    assert.ok(!canOpenView('customers', permissionsForRole(role)));
    assert.ok(!canOpenView('users', permissionsForRole(role)));
  }
});

test('quality section is unavailable even with legacy QA permission', () => {
  assert.equal(canOpenView('qa', ['qa'], 'SUPER_ADMIN'), false);
});
