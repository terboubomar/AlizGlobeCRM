import { createCipheriv, createDecipheriv, randomBytes, createHash, createHmac } from 'node:crypto';
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
function key() {
  const value = process.env.PII_KEY;
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) throw new Error('PII_KEY must be 32-byte hex');
  return Buffer.from(value, 'hex');
}
export function encrypt(s: string) {
  const iv = randomBytes(12),
    c = createCipheriv('aes-256-gcm', key(), iv);
  return [iv, c.update(s, 'utf8'), c.final(), c.getAuthTag()]
    .map((b) => b.toString('base64'))
    .join('.');
}
export function decrypt(s: string) {
  const [iv, body, last, tag] = s.split('.').map((b) => Buffer.from(b, 'base64'));
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.update(last), d.final()]).toString('utf8');
}
export function phoneHash(s: string) {
  if (!process.env.PHONE_HASH_KEY) throw new Error('PHONE_HASH_KEY required');
  return createHmac('sha256', process.env.PHONE_HASH_KEY).update(s).digest('hex');
}
