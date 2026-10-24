import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';

const base = (process.env.TEST_API_ORIGIN ?? 'http://127.0.0.1:4000') + '/api/';

test('every API response carries a request ID, reusing a valid edge ID', async () => {
  const minted = await fetch(base + 'health');
  assert.match(minted.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
  const edge = 'edge-req-0123456789abcdef';
  const echoed = await fetch(base + 'health', { headers: { 'X-Request-Id': edge } });
  assert.equal(echoed.headers.get('x-request-id'), edge);
  const forged = await fetch(base + 'bootstrap', { headers: { 'X-Request-Id': 'bad id <x>' } });
  assert.equal(forged.status, 401);
  assert.notEqual(forged.headers.get('x-request-id'), 'bad id <x>');
  assert.match(forged.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
});
