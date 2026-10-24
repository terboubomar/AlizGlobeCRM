import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { errorKind, formatLog, requestLog, routePattern } from '../apps/api/src/log';
import { requestId } from '../apps/api/src/request-id';

function capture() {
  const lines: string[] = [];
  const out = process.stdout.write.bind(process.stdout),
    err = process.stderr.write.bind(process.stderr);
  // Keep only this app's log lines; pass everything else (the test runner
  // reports over the same streams) through untouched.
  const grab =
    (write: typeof process.stdout.write) =>
    (chunk: string | Uint8Array, ...rest: unknown[]) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      if (text.startsWith('{"time":')) {
        lines.push(...text.split('\n').filter(Boolean));
        return true;
      }
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    };
  process.stdout.write = grab(out) as typeof process.stdout.write;
  process.stderr.write = grab(err) as typeof process.stderr.write;
  return {
    lines,
    restore() {
      process.stdout.write = out;
      process.stderr.write = err;
    },
  };
}

test('log lines are one JSON object with time, service and only the given fields', () => {
  const line = JSON.parse(
    formatLog(
      { level: 'info', event: 'retention_run', due: 3, skipped: undefined },
      new Date('2030-01-01T00:00:00Z'),
    ),
  );
  assert.deepEqual(line, {
    time: '2030-01-01T00:00:00.000Z',
    service: 'api',
    level: 'info',
    event: 'retention_run',
    due: 3,
  });
  assert.equal(routePattern({ baseUrl: '' }), '(unmatched)');
});

test('error details keep the type and code, never the message', () => {
  const e = Object.assign(new Error('Unique constraint failed on phone 0551234567'), {
    code: 'P2002',
  });
  const kind = errorKind(e);
  assert.deepEqual(kind, { error: 'Error', code: 'P2002' });
  assert.ok(!JSON.stringify(kind).includes('0551234567'));
});

test('the access log records the route pattern, status and request ID, not the URL', async () => {
  const app = express();
  app.use(requestId, requestLog, express.json());
  app.post('/api/tickets/:id/notes', (_req, res) => res.status(201).json({ ok: true }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/boom', () => {
    throw new Error('Synthetic failure mentioning Synthetic Customer');
  });
  app.use(
    (_e: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
      res.status(500).end(),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const out = capture();
  try {
    await fetch(url + '/api/tickets/4b6e13ee-secret-id/notes?token=private-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'edge-req-0123456789' },
      body: JSON.stringify({ note: 'Synthetic Customer called back' }),
    });
    await fetch(url + '/api/health');
    await fetch(url + '/api/boom');
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    out.restore();
    server.close();
  }
  const entries = out.lines.map((l) => JSON.parse(l));
  assert.equal(entries.length, 2, 'healthy health checks are not logged');
  const [created, failed] = entries;
  assert.equal(created.event, 'request');
  assert.equal(created.level, 'info');
  assert.equal(created.route, '/api/tickets/:id/notes');
  assert.equal(created.method, 'POST');
  assert.equal(created.status, 201);
  assert.equal(created.requestId, 'edge-req-0123456789');
  assert.equal(typeof created.ms, 'number');
  assert.equal(failed.level, 'error');
  assert.equal(failed.status, 500);
  const all = out.lines.join('\n');
  for (const secret of ['secret-id', 'private-token', 'Synthetic Customer'])
    assert.ok(!all.includes(secret), secret);
});
