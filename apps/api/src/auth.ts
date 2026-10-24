import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';
import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { db } from '../../../packages/db/client';
import { DomainError } from '../../../packages/domain/src';
import { z } from 'zod';
import { dummyPasswordHash, verifyPassword } from './password';
import { sessionKey, signStaffSession } from './sessions';
const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const demoKey = randomBytes(32);
export const isDemo = () =>
  process.env.DEMO_MODE === 'true' && process.env.NODE_ENV !== 'production';
export async function demoSession(id: string) {
  if (!isDemo() || passwordAuthEnabled())
    throw new DomainError('DEMO_DISABLED', 403, 'الحسابات التجريبية غير متاحة');
  const u = await db.user.findUnique({ where: { id } });
  if (!u?.enabled) throw new DomainError('NOT_FOUND', 404, 'الحساب غير موجود');
  if (u.passwordHash || u.role === 'SUPER_ADMIN')
    throw new DomainError('PASSWORD_REQUIRED', 403, 'هذا الحساب يتطلب تسجيل الدخول بكلمة المرور');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(u.id)
    .setIssuedAt()
    .setExpirationTime('4h')
    .sign(demoKey);
}
export async function actor(req: Request) {
  let sub: string | undefined;
  let sessionVersion = 0;
  let staffSession = false;
  if (passwordAuthEnabled() || !isDemo()) {
    const cookie = req.cookies?.aliz_session;
    if (cookie) {
      try {
        const claims = (
          await jwtVerify(cookie, sessionKey(), {
            algorithms: ['HS256'],
            issuer: 'aliz-crm',
            audience: 'aliz-crm-web',
          })
        ).payload;
        if (
          passwordAuthEnabled() ? claims.mode && claims.mode !== 'password' : claims.mode !== 'oidc'
        )
          throw new Error('Wrong session mode');
        sub = claims.sub;
        staffSession = true;
        sessionVersion = typeof claims.sv === 'number' ? claims.sv : 0;
      } catch {
        /* Invalid sessions fail closed. */
      }
    }
  } else if (isDemo()) {
    const cookie = req.cookies?.aliz_session;
    if (cookie) {
      try {
        sub = (await jwtVerify(cookie, demoKey)).payload.sub;
      } catch {
        /* Invalid credentials fail closed. */
      }
    }
  }
  if (!sub && !isDemo() && !passwordAuthEnabled()) {
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    if (
      bearer &&
      process.env.OIDC_JWKS_URL &&
      process.env.OIDC_ISSUER &&
      process.env.OIDC_AUDIENCE
    ) {
      try {
        const { payload } = await jwtVerify(
          bearer,
          jwks.get(process.env.OIDC_JWKS_URL) ??
            (() => {
              const set = createRemoteJWKSet(new URL(process.env.OIDC_JWKS_URL!));
              jwks.set(process.env.OIDC_JWKS_URL!, set);
              return set;
            })(),
          { issuer: process.env.OIDC_ISSUER, audience: process.env.OIDC_AUDIENCE },
        );
        if (!Array.isArray(payload.amr) || !payload.amr.includes('mfa'))
          throw new Error('MFA required');
        sub = payload.sub;
      } catch {
        /* Invalid credentials fail closed. */
      }
    }
  }
  if (!sub) throw new DomainError('UNAUTHENTICATED', 401, 'يرجى تسجيل الدخول');
  const u = await db.user.findFirst({
    where: {
      enabled: true,
      ...(isDemo() || staffSession ? { id: sub } : { subject: sub }),
    },
  });
  if (!u) throw new DomainError('UNAUTHENTICATED', 401, 'الحساب غير مفعل');
  if (staffSession && u.sessionVersion !== sessionVersion)
    throw new DomainError('UNAUTHENTICATED', 401, 'يرجى تسجيل الدخول');
  const brandIds =
    u.role === 'SUPER_ADMIN'
      ? (await db.brand.findMany({ select: { id: true } })).map((b) => b.id)
      : u.brandIds;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    brandIds,
    branchIds: u.role === 'SUPER_ADMIN' ? [] : u.branchIds,
    financeDuty: u.financeDuty,
  };
}

// Logout must revoke the session, not just clear the browser cookie, or a copied
// cookie keeps working until it expires. Bumping sessionVersion invalidates every
// session issued to this user (actor() rejects a mismatched version), so signing
// out also signs the user out on their other devices.
export async function endStaffSession(req: Request) {
  if (!passwordAuthEnabled() && isDemo()) return;
  const cookie = req.cookies?.aliz_session;
  if (!cookie) return;
  let sub: string | undefined, sessionVersion: number;
  try {
    const { payload } = await jwtVerify(cookie, sessionKey(), {
      algorithms: ['HS256'],
      issuer: 'aliz-crm',
      audience: 'aliz-crm-web',
    });
    sub = payload.sub;
    sessionVersion = typeof payload.sv === 'number' ? payload.sv : 0;
  } catch {
    return; // Invalid or expired: nothing left to revoke.
  }
  if (!sub) return;
  const revoked = await db.user.updateMany({
    where: { id: sub, sessionVersion },
    data: { sessionVersion: { increment: 1 } },
  });
  if (revoked.count)
    await db.audit.create({ data: { actor: sub, action: 'SIGNED_OUT', entityId: sub } });
}

export const passwordAuthEnabled = () =>
  process.env.LOCAL_PASSWORD_AUTH === 'true' && process.env.NODE_ENV !== 'production';
const failures = new Map<string, { count: number; until: number }>();
export async function passwordSession(input: unknown, ip: string) {
  if (!passwordAuthEnabled())
    throw new DomainError('PASSWORD_LOGIN_DISABLED', 403, 'تسجيل الدخول بكلمة المرور غير مفعّل');
  const { email, password } = z
    .object({
      email: z.string().trim().toLowerCase().email().max(254),
      password: z.string().min(1).max(128),
    })
    .parse(input);
  const now = Date.now(),
    keys = [`ip:${ip}`, `email:${email}`];
  for (const [key, entry] of failures) if (entry.until <= now) failures.delete(key);
  if (
    failures.size >= 10000 ||
    keys.some((key, i) => (failures.get(key)?.count ?? 0) >= (i === 0 ? 30 : 5))
  )
    throw new DomainError('LOGIN_RATE_LIMIT', 429, 'محاولات كثيرة. حاول مرة أخرى بعد 15 دقيقة');
  const user = await db.user.findUnique({ where: { email } });
  const valid = await verifyPassword(
    password,
    user?.enabled && user.passwordHash ? user.passwordHash : dummyPasswordHash,
  );
  if (!valid || !user?.enabled || !user.passwordHash) {
    for (const key of keys) {
      const old = failures.get(key);
      failures.set(key, { count: (old?.count ?? 0) + 1, until: old?.until ?? now + 15 * 60000 });
    }
    throw new DomainError('INVALID_CREDENTIALS', 401, 'البريد الإلكتروني أو كلمة المرور غير صحيحة');
  }
  failures.delete(keys[1]);
  const token = await signStaffSession(user, 'password');
  await db.audit.create({
    data: { actor: user.id, action: 'PASSWORD_SIGN_IN', entityId: user.id },
  });
  return token;
}
