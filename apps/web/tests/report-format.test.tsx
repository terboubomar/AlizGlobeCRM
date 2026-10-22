import test from 'node:test';
import assert from 'node:assert/strict';
import { reportDuration } from '../app/report-format';
test('report durations use clear units and Western digits', () => {
  assert.equal(reportDuration(null), '—');
  assert.equal(reportDuration(0), '0 د');
  assert.equal(reportDuration(3 / 60), '3 د');
  assert.equal(reportDuration(1.5), '1 س 30 د');
  assert.equal(reportDuration(26), '1 يوم 2 س');
  assert.doesNotMatch(reportDuration(123), /[٠-٩]/);
});
