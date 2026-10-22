import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorize,
  inScope,
  transition,
  refundNext,
  milestones,
  safeCell,
  normalizePhone,
  overlaps,
  Actor,
} from '../packages/domain/src';
const branch: Actor = {
  id: 'a',
  name: 'a',
  role: 'BRANCH_MANAGER',
  brandIds: ['waqf'],
  branchIds: ['a'],
};
test('branch and brand isolation is deny by default', () => {
  assert.equal(inScope(branch, { brandId: 'waqf', branchId: 'b' }), false);
  assert.equal(inScope(branch, { brandId: 'other', branchId: 'a' }), false);
  assert.equal(inScope(branch, { brandId: 'waqf', branchId: null }), false);
  assert.throws(() => authorize(branch, 'read', { brandId: 'waqf', branchId: 'b' }));
  assert.throws(() => authorize(branch, 'acknowledge', { brandId: 'waqf', branchId: 'a' }));
});
test('admin cannot see customer PII or approve refunds by default', () => {
  const admin = { ...branch, role: 'ADMIN' };
  assert.throws(() => authorize(admin, 'pii'));
  assert.throws(() => authorize(admin, 'refund.decide'));
});
test('unknown roles and actions fail closed', () => {
  assert.throws(() => authorize({ ...branch, role: 'ROOT' }, 'read'));
  assert.throws(() => authorize(branch, 'refund.execute'));
});
test('ticket lifecycle prevents skipped acknowledgment or customer closure', () => {
  assert.throws(() => transition('ASSIGNED', 'resolve'));
  assert.throws(() => transition('IN_PROGRESS', 'close'));
  assert.equal(transition('ASSIGNED', 'acknowledge'), 'ACKNOWLEDGED');
  assert.equal(transition('CLOSED', 'reopen'), 'IN_PROGRESS');
});
test('refund approval cannot directly complete or verify a request', () => {
  assert.throws(() => refundNext('AWAITING_EXTERNAL_EXECUTION', 'complete'));
  assert.throws(() => refundNext('REQUESTED', 'verify'));
  let state = 'REQUESTED';
  for (const action of ['review', 'approve', 'execute', 'verify', 'notify', 'complete'])
    state = refundNext(state, action);
  assert.equal(state, 'COMPLETED');
});
test('SLA uses declared intake and separates branch acknowledgment', () => {
  const intake = new Date('2026-10-20T08:00:00Z'),
    assigned = new Date('2026-10-20T08:12:00Z');
  const t = milestones('P2', intake, assigned);
  assert.equal(
    t.find((t) => t.milestone === 'FIRST_ACTION')!.dueAt.toISOString(),
    '2026-10-20T08:05:00.000Z',
  );
  assert.equal(
    t.find((t) => t.milestone === 'ACKNOWLEDGMENT')!.dueAt.toISOString(),
    '2026-10-20T08:17:00.000Z',
  );
  assert.equal(
    t.find((t) => t.milestone === 'REMEDY')!.dueAt.toISOString(),
    '2026-10-20T08:30:00.000Z',
  );
});
test('P1 never gets an artificial remedy or closure deadline', () => {
  assert.equal(milestones('P1', new Date()).length, 1);
});
test('CSV formula injection and quoting are neutralized', () => {
  assert.equal(safeCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.ok(safeCell(' \t+1').startsWith('"\''));
  assert.equal(safeCell('اسم'), '"اسم"');
});
test('phone lookup normalizes Saudi formats consistently', () => {
  assert.equal(normalizePhone('0500000000'), normalizePhone('+966500000000'));
});
test('shift boundary adjacency allowed and overlap rejected', () => {
  const d = (h: number) => new Date(2026, 9, 20, h);
  assert.equal(overlaps(d(8), d(12), d(12), d(16)), false);
  assert.equal(overlaps(d(8), d(12), d(11), d(16)), true);
});
