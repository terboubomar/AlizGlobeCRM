import { SignJWT } from 'jose';
export function sessionKey() {
  const value = process.env.AUTH_SESSION_KEY;
  if (!value || !/^[a-f0-9]{64}$/i.test(value))
    throw new Error('AUTH_SESSION_KEY must contain 32 random bytes');
  return Buffer.from(value, 'hex');
}
export function signStaffSession(
  user: { id: string; sessionVersion: number },
  mode: 'password' | 'oidc',
) {
  return new SignJWT({ sv: user.sessionVersion, mode })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer('aliz-crm')
    .setAudience('aliz-crm-web')
    .setIssuedAt()
    .setExpirationTime('4h')
    .sign(sessionKey());
}
