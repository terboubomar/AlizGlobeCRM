import test from 'node:test';
import assert from 'node:assert/strict';
import { requestIdFor } from '../apps/api/src/request-id';

test('request IDs reuse a well-formed edge ID and replace anything else', () => {
  const edge = '3f2a9c1e8b7d4a6f9e0c1b2a3d4e5f60';
  assert.equal(requestIdFor(edge), edge);
  for (const bad of [
    undefined,
    '',
    'short',
    'x'.repeat(129),
    'abc12345\nFAKE LOG LINE',
    'abc12345 <script>',
    ['abc12345', 'def67890'],
  ]) {
    const id = requestIdFor(bad);
    assert.notEqual(id, bad);
    assert.match(id, /^[0-9a-f-]{36}$/);
  }
});
