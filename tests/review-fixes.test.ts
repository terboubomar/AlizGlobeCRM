import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { db } from '../packages/db/client';
import { startOidc, finishOidc, validateOidcClaims, safeReturnTo } from '../apps/api/src/oidc';
import { can, permissionsForRole, refundNext } from '../packages/domain/src';
import { slaPolicy, slaMilestones, demoSla } from '../apps/api/src/sla';
import { MemoryLimiter, rateBucket, trustedProxies } from '../apps/api/src/rate-limit';

test('financial duties use existing roles without granting user administration or PII', () => {
  const a = {
    id: 'a',
    name: 'a',
    role: 'CEO',
    brandIds: ['x'],
    branchIds: [],
    financeDuty: 'PROCESSOR',
  };
  assert.equal(can(a, 'refund.execute'), true);
  assert.equal(can(a, 'refund.verify'), false);
  assert.equal(can(a, 'refund.decide'), false);
  assert.equal(can(a, 'pii'), false);
  assert.equal(can(a, 'users.manage'), false);
  assert.equal(can({ ...a, financeDuty: 'VERIFIER' }, 'refund.verify'), true);
  assert.equal(can({ ...a, financeDuty: 'NONE' }, 'evidence.view'), false);
  assert.deepEqual(permissionsForRole('UNKNOWN', 'APPROVER'), []);
  assert.equal(refundNext('REJECTED', 'resubmit'), 'REQUESTED');
  assert.throws(() => refundNext('COMPLETED', 'resubmit'));
});
test('production SLA fails closed without approval and uses a validated policy snapshot', () => {
  const old = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => slaPolicy(), { code: 'SLA_POLICY_PENDING' });
    const policy = slaPolicy({ ...demoSla, version: 'APPROVED-2026', p2First: 7 });
    const received = new Date('2026-10-22T09:00:00Z');
    assert.equal(
      slaMilestones('P2', received, policy)[0].dueAt.toISOString(),
      '2026-10-22T09:07:00.000Z',
    );
    assert.equal(slaMilestones('P1', received, policy).length, 1);
  } finally {
    if (old === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = old;
  }
});
test('rate limits separate callers and webhooks, expire, and reject trusting the whole internet', () => {
  const limiter = new MemoryLimiter();
  assert.equal(limiter.hit('ip-one', 0), 1);
  assert.equal(limiter.hit('ip-one', 0), 2);
  assert.equal(limiter.hit('ip-two', 0), 1);
  assert.equal(limiter.hit('ip-one', 60000), 1);
  assert.notEqual(
    rateBucket('/api/public/status/x').name,
    rateBucket('/api/integrations/telegram/webhook').name,
  );
  const old = process.env.TRUSTED_PROXY_CIDRS;
  process.env.TRUSTED_PROXY_CIDRS = '0.0.0.0/0';
  try {
    assert.throws(() => trustedProxies());
  } finally {
    if (old === undefined) delete process.env.TRUSTED_PROXY_CIDRS;
    else process.env.TRUSTED_PROXY_CIDRS = old;
  }
});
test('OIDC PKCE exchange verifies identity, MFA, replay protection and redirect safety', async () => {
  const env = {
    NODE_ENV: 'production',
    APP_ORIGIN: 'https://crm.example.test',
    OIDC_ISSUER: 'https://identity.example.test',
    OIDC_CLIENT_ID: 'crm-test',
    AUTH_SESSION_KEY: randomBytes(32).toString('hex'),
    PII_KEY: randomBytes(32).toString('hex'),
  };
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const original = {
    create: db.idempotency.create,
    consume: db.idempotency.deleteMany,
    user: db.user.findFirst,
    audit: db.audit.create,
  };
  let used = false;
  Object.assign(db.idempotency, {
    create: async () => ({}),
    deleteMany: async () => ({ count: used ? 0 : ((used = true), 1) }),
  });
  Object.assign(db.user, {
    findFirst: async () => ({ id: 'oidc-user', enabled: true, sessionVersion: 3 }),
  });
  Object.assign(db.audit, { create: async () => ({}) });
  try {
    const key = await generateKeyPair('RS256'),
      publicKey = await exportJWK(key.publicKey);
    const jwks = createLocalJWKSet({ keys: [{ ...publicKey, kid: 'review-key', alg: 'RS256' }] });
    const mockFetch = (async () =>
      new Response(
        JSON.stringify({
          issuer: env.OIDC_ISSUER,
          authorization_endpoint: env.OIDC_ISSUER + '/authorize',
          token_endpoint: env.OIDC_ISSUER + '/token',
          jwks_uri: env.OIDC_ISSUER + '/keys',
          code_challenge_methods_supported: ['S256'],
        }),
      )) as typeof fetch;
    const start = await startOidc('/?view=tickets&ticket=case', mockFetch),
      url = new URL(start.url);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const idToken = await new SignJWT({
      nonce: url.searchParams.get('nonce'),
      amr: ['mfa'],
      auth_time: Math.floor(Date.now() / 1000),
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'review-key' })
      .setIssuer(env.OIDC_ISSUER)
      .setAudience(env.OIDC_CLIENT_ID)
      .setSubject('staff-subject')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key.privateKey);
    const exchange = (async (_url, options) => {
      assert.equal(
        new URLSearchParams(String(options?.body)).get('grant_type'),
        'authorization_code',
      );
      assert.ok(new URLSearchParams(String(options?.body)).get('code_verifier'));
      return new Response(JSON.stringify({ id_token: idToken }));
    }) as typeof fetch;
    const query = { code: 'synthetic-code', state: url.searchParams.get('state')! };
    const result = await finishOidc(start.cookie, query, exchange, jwks);
    assert.equal(result.returnTo, '/?view=tickets&ticket=case');
    assert.ok(result.session.length > 100);
    await assert.rejects(finishOidc(start.cookie, query, exchange, jwks), /replayed/);
    assert.throws(() =>
      validateOidcClaims({ sub: 'staff', nonce: 'wrong' }, 'expected', 'crm-test'),
    );
    assert.throws(
      () =>
        validateOidcClaims(
          {
            sub: 'staff',
            nonce: 'ok',
            iat: Date.now() / 1000,
            exp: Date.now() / 1000 + 60,
            auth_time: Date.now() / 1000,
            amr: ['pwd'],
          },
          'ok',
          'crm-test',
        ),
      /MFA/,
    );
    for (const target of ['https://evil.test', '//evil.test', '/\\evil.test', '/other'])
      assert.equal(safeReturnTo(target), '/');
  } finally {
    Object.assign(db.idempotency, { create: original.create, deleteMany: original.consume });
    Object.assign(db.user, { findFirst: original.user });
    Object.assign(db.audit, { create: original.audit });
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
