import { createHash } from 'node:crypto';
import {
  SignJWT,
  jwtVerify,
  createRemoteJWKSet,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { z } from 'zod';
import { db } from '../../../packages/db/client';
import { DomainError } from '../../../packages/domain/src';
import { token, hash, encrypt, decrypt } from './crypto';
import { sessionKey, signStaffSession } from './sessions';
const metadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
});
type Metadata = z.infer<typeof metadataSchema>;
let cached: { issuer: string; expires: number; data: Metadata } | undefined;
const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export function oidcReady() {
  try {
    for (const value of [process.env.APP_ORIGIN, process.env.OIDC_ISSUER]) {
      const url = new URL(value ?? '');
      if (url.protocol !== 'https:' || url.username || url.password) return false;
    }
    sessionKey();
    return !!process.env.OIDC_CLIENT_ID;
  } catch {
    return false;
  }
}
function callbackUrl() {
  return new URL('/api/auth/oidc/callback', process.env.APP_ORIGIN).toString();
}
export function safeReturnTo(value: unknown) {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\r\n]/.test(value)
  )
    return '/';
  const parsed = new URL(value, 'https://crm.invalid');
  return parsed.origin === 'https://crm.invalid' && parsed.pathname === '/'
    ? parsed.pathname + parsed.search
    : '/';
}
async function metadata(fetcher: typeof fetch) {
  const issuer = process.env.OIDC_ISSUER!;
  if (cached?.issuer === issuer && cached.expires > Date.now()) return cached.data;
  const response = await fetcher(issuer.replace(/\/$/, '') + '/.well-known/openid-configuration', {
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('OIDC discovery unavailable');
  const data = metadataSchema.parse(await response.json());
  if (
    data.issuer !== issuer ||
    [data.authorization_endpoint, data.token_endpoint, data.jwks_uri].some(
      (v) => new URL(v).protocol !== 'https:',
    ) ||
    (data.code_challenge_methods_supported &&
      !data.code_challenge_methods_supported.includes('S256'))
  )
    throw new Error('Invalid OIDC discovery');
  cached = { issuer, expires: Date.now() + 300000, data };
  return data;
}
export async function startOidc(returnTo: unknown, fetcher: typeof fetch = fetch) {
  if (!oidcReady()) throw new DomainError('SSO_UNAVAILABLE', 503, 'تسجيل الدخول المؤسسي غير مهيأ');
  const data = await metadata(fetcher),
    state = token(),
    nonce = token(),
    verifier = token();
  await db.idempotency.create({
    data: {
      key: 'oidc:' + hash(state),
      requestHash: hash(nonce),
      response: {},
      expiresAt: new Date(Date.now() + 600000),
    },
  });
  const payload = await new SignJWT({
    flow: encrypt(JSON.stringify({ state, nonce, verifier, returnTo: safeReturnTo(returnTo) })),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('aliz-oidc')
    .setAudience('aliz-oidc-callback')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(sessionKey());
  const url = new URL(data.authorization_endpoint);
  for (const [k, v] of Object.entries({
    client_id: process.env.OIDC_CLIENT_ID!,
    redirect_uri: callbackUrl(),
    response_type: 'code',
    response_mode: 'query',
    scope: 'openid profile',
    state,
    nonce,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    max_age: '0',
  }))
    url.searchParams.set(k, v);
  if (process.env.OIDC_ACR_VALUES) url.searchParams.set('acr_values', process.env.OIDC_ACR_VALUES);
  return { url: url.toString(), cookie: payload };
}
export function validateOidcClaims(claims: JWTPayload, nonce: string, clientId: string) {
  if (
    !claims.sub ||
    claims.nonce !== nonce ||
    !claims.exp ||
    !claims.iat ||
    !claims.auth_time ||
    typeof claims.auth_time !== 'number' ||
    claims.auth_time < Date.now() / 1000 - 600 ||
    claims.auth_time > Date.now() / 1000 + 60 ||
    (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== clientId) ||
    (claims.azp && claims.azp !== clientId)
  )
    throw new Error('Invalid identity claims');
  const approvedAcr = (process.env.OIDC_MFA_ACR_VALUES ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (
    !(Array.isArray(claims.amr) && claims.amr.includes('mfa')) &&
    !(typeof claims.acr === 'string' && approvedAcr.includes(claims.acr))
  )
    throw new Error('MFA required');
}
export async function finishOidc(
  cookie: string,
  query: unknown,
  fetcher: typeof fetch = fetch,
  testResolver?: JWTVerifyGetKey,
) {
  if (!oidcReady()) throw new Error('SSO unavailable');
  const b = z
    .object({
      state: z.string().max(200),
      code: z.string().min(1).max(4000),
      iss: z.string().optional(),
    })
    .parse(query);
  const signed = await jwtVerify(cookie, sessionKey(), {
    algorithms: ['HS256'],
    issuer: 'aliz-oidc',
    audience: 'aliz-oidc-callback',
  });
  const flow = z
    .object({ state: z.string(), nonce: z.string(), verifier: z.string(), returnTo: z.string() })
    .parse(JSON.parse(decrypt(String(signed.payload.flow))));
  if (flow.state !== b.state || (b.iss && b.iss !== process.env.OIDC_ISSUER))
    throw new Error('State or issuer mismatch');
  const consumed = await db.idempotency.deleteMany({
    where: {
      key: 'oidc:' + hash(b.state),
      requestHash: hash(flow.nonce),
      expiresAt: { gt: new Date() },
    },
  });
  if (consumed.count !== 1) throw new Error('Login expired or replayed');
  const data = await metadata(fetcher),
    params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: b.code,
      redirect_uri: callbackUrl(),
      client_id: process.env.OIDC_CLIENT_ID!,
      code_verifier: flow.verifier,
    });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (process.env.OIDC_CLIENT_SECRET) {
    if (process.env.OIDC_TOKEN_AUTH_METHOD === 'client_secret_post')
      params.set('client_secret', process.env.OIDC_CLIENT_SECRET);
    else
      headers.Authorization =
        'Basic ' +
        Buffer.from(
          encodeURIComponent(process.env.OIDC_CLIENT_ID!) +
            ':' +
            encodeURIComponent(process.env.OIDC_CLIENT_SECRET),
        ).toString('base64');
  }
  const response = await fetcher(data.token_endpoint, {
    method: 'POST',
    headers,
    body: params,
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('Token exchange failed');
  const body = z.object({ id_token: z.string() }).parse(await response.json());
  let resolver = keys.get(data.jwks_uri);
  if (!resolver) {
    resolver = createRemoteJWKSet(new URL(data.jwks_uri));
    keys.set(data.jwks_uri, resolver);
  }
  const { payload } = await jwtVerify(body.id_token, testResolver ?? resolver, {
    issuer: data.issuer,
    audience: process.env.OIDC_CLIENT_ID,
    algorithms: ['RS256', 'ES256'],
    clockTolerance: 5,
  });
  validateOidcClaims(payload, flow.nonce, process.env.OIDC_CLIENT_ID!);
  const user = await db.user.findFirst({ where: { subject: payload.sub, enabled: true } });
  if (!user) throw new Error('User not provisioned');
  await db.audit.create({ data: { actor: user.id, action: 'OIDC_SIGN_IN', entityId: user.id } });
  return { session: await signStaffSession(user, 'oidc'), returnTo: safeReturnTo(flow.returnTo) };
}
