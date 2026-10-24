import test from 'node:test';
import assert from 'node:assert/strict';
import { contentSecurityPolicy, servedOverHttps } from '../app/security-headers';

const directive = (csp: string, name: string) =>
  csp
    .split('; ')
    .find((d) => d.startsWith(name + ' ') || d === name)
    ?.slice(name.length)
    .trim();

test('production CSP only runs scripts that carry the request nonce', () => {
  const csp = contentSecurityPolicy({ nonce: 'abc123', dev: false, https: true });
  assert.equal(directive(csp, 'script-src'), "'self' 'nonce-abc123' 'strict-dynamic'");
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.doesNotMatch(directive(csp, 'script-src') ?? '', /unsafe-inline/);
  assert.equal(directive(csp, 'object-src'), "'none'");
  assert.equal(directive(csp, 'frame-ancestors'), "'none'");
  assert.equal(directive(csp, 'base-uri'), "'self'");
  assert.equal(directive(csp, 'upgrade-insecure-requests'), '');
});

test('development CSP allows eval for React tooling and skips HTTPS upgrades', () => {
  const csp = contentSecurityPolicy({ nonce: 'n', dev: true, https: false });
  assert.match(directive(csp, 'script-src') ?? '', /'unsafe-eval'/);
  assert.equal(directive(csp, 'upgrade-insecure-requests'), undefined);
});

test('HSTS and HTTPS upgrades apply only to production HTTPS origins', () => {
  assert.equal(servedOverHttps('https://crm.example.com', 'production'), true);
  assert.equal(servedOverHttps('http://localhost:3000', 'production'), false);
  assert.equal(servedOverHttps('https://crm.example.com', 'development'), false);
  assert.equal(servedOverHttps(undefined, 'production'), false);
});
