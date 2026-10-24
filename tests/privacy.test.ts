import test from 'node:test';
import assert from 'node:assert/strict';
import { retentionDays } from '../apps/api/src/privacy';

test('retention stays off until a period is set, and production needs approval', () => {
  assert.equal(retentionDays({}), null);
  assert.equal(retentionDays({ RETENTION_CLOSED_CASE_DAYS: '' }), null);
  assert.equal(retentionDays({ RETENTION_CLOSED_CASE_DAYS: '365' }), 365);
  for (const bad of ['10', '29', '90.5', 'forever', '-1'])
    assert.throws(() => retentionDays({ RETENTION_CLOSED_CASE_DAYS: bad }), /at least 30/);
  assert.throws(
    () => retentionDays({ RETENTION_CLOSED_CASE_DAYS: '365', NODE_ENV: 'production' }),
    /RETENTION_POLICY_APPROVED/,
  );
  assert.equal(
    retentionDays({
      RETENTION_CLOSED_CASE_DAYS: '365',
      NODE_ENV: 'production',
      RETENTION_POLICY_APPROVED: 'true',
    }),
    365,
  );
});
