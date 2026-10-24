import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { errorLogEntry } from '../apps/api/src/error-log';

test('unexpected-error log lines keep the route pattern and code but no message text', () => {
  const secret = 'customer 0500000001 Synthetic Name';
  const e = new Prisma.PrismaClientKnownRequestError(`Unique failed on value ${secret}`, {
    code: 'P2025',
    clientVersion: 'test',
  });
  const entry = errorLogEntry(
    e,
    { method: 'POST', route: { path: '/api/tickets/:id' } },
    500,
    'ab12cd34',
  );
  const line = JSON.stringify(entry);
  assert.doesNotMatch(line, /0500000001|Synthetic Name|Unique failed/);
  assert.equal(entry.ref, 'ab12cd34');
  assert.equal(entry.route, '/api/tickets/:id');
  assert.equal(entry.code, 'P2025');
  assert.equal(entry.error, 'PrismaClientKnownRequestError');
  assert.ok(entry.at.length > 0 && entry.at.every((frame) => frame.startsWith('at ')));
});

test('unmatched routes and non-Error values are logged safely', () => {
  const entry = errorLogEntry('raw string with 0500000001', { method: 'GET' }, 500);
  assert.equal(entry.route, '(unmatched)');
  assert.equal(entry.error, 'string');
  assert.deepEqual(entry.at, []);
  assert.match(entry.ref, /^[0-9a-f]{8}$/);
  assert.doesNotMatch(JSON.stringify(entry), /0500000001/);
});
