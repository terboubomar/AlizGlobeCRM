import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../apps/api/src/password';
import { can, inScope } from '../packages/domain/src';
test('passwords use salted scrypt hashes and reject wrong or malformed credentials', async () => {
  const password = 'Synthetic-Password-Only-2026';
  const first = await hashPassword(password),
    second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.ok(!first.includes(password));
  assert.ok(await verifyPassword(password, first));
  assert.equal(await verifyPassword('Wrong-Synthetic-Password', first), false);
  assert.equal(await verifyPassword(password, 'invalid-hash'), false);
  assert.equal(await verifyPassword(password, 'scrypt$999999999$8$1$invalid$invalid'), false);
  await assert.rejects(hashPassword('short'));
});
test('superadmin has global scope and known permissions; ordinary admin remains restricted', () => {
  const superadmin = {
    id: 'test-super',
    name: 'Test',
    role: 'SUPER_ADMIN',
    brandIds: [],
    branchIds: [],
  };
  assert.ok(inScope(superadmin, { brandId: 'new-brand', branchId: 'new-branch' }));
  for (const permission of [
    'pii',
    'assign',
    'contact',
    'brands.manage',
    'branches.manage',
    'configure',
    'audit',
    'refund.decide',
  ])
    assert.ok(can(superadmin, permission));
  assert.equal(can(superadmin, 'unknown-permission'), false);
  assert.equal(can({ ...superadmin, role: 'ADMIN' }, 'pii'), false);
});
