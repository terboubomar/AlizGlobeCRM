import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import type { Request, Response, NextFunction } from 'express';
export function rateBucket(path: string) {
  if (path === '/api/integrations/telegram/webhook')
    return { name: 'telegram-webhook', limit: 5000 };
  if (path === '/api/integrations/whatsapp/webhook')
    return { name: 'whatsapp-webhook', limit: 5000 };
  if (path.startsWith('/api/public/')) return { name: 'public', limit: 120 };
  if (['/api/login', '/api/demo-login'].includes(path) || path.startsWith('/api/auth/oidc/'))
    return { name: 'auth', limit: 30 };
  return { name: 'staff', limit: 500 };
}
export class MemoryLimiter {
  private entries = new Map<string, { count: number; until: number }>();
  hit(key: string, now = Date.now()) {
    const old = this.entries.get(key);
    if (old && old.until > now) return ++old.count;
    if (this.entries.size >= 10000) {
      for (const [k, v] of this.entries) if (v.until <= now) this.entries.delete(k);
      if (this.entries.size >= 10000) return Infinity;
    }
    this.entries.set(key, { count: 1, until: now + 60000 });
    return 1;
  }
}
let redis: Redis | undefined;
let connecting: Promise<unknown> | undefined;
const memory = new MemoryLimiter();
async function hit(key: string) {
  if (process.env.NODE_ENV !== 'production') return memory.hit(key);
  if (!process.env.REDIS_URL) throw new Error('Rate limiter Redis is not configured');
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 3000,
    });
    redis.on('error', () => {});
    connecting = redis.connect().catch(() => {});
  }
  await connecting;
  if (redis.status !== 'ready') throw new Error('Rate limiter is reconnecting');
  return Number(
    await redis.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n",
      1,
      key,
    ),
  );
}
export function trustedProxies() {
  const values = (
    process.env.TRUSTED_PROXY_CIDRS ?? (process.env.NODE_ENV === 'production' ? '' : 'loopback')
  )
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (values.some((v) => ['true', '0.0.0.0/0', '::/0'].includes(v)))
    throw new Error('Trust only the actual reverse proxies');
  return values.length ? values : false;
}
export async function rateLimit(req: Request, res: Response, next: NextFunction) {
  const bucket = rateBucket(req.path),
    ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const key = 'aliz:rate:' + bucket.name + ':' + createHash('sha256').update(ip).digest('hex');
  try {
    if ((await hit(key)) > bucket.limit)
      return res
        .status(429)
        .set('Retry-After', '60')
        .json({ code: 'RATE_LIMIT', message: 'طلبات كثيرة؛ حاول بعد دقيقة' });
    next();
  } catch {
    return res
      .status(503)
      .json({ code: 'RATE_LIMIT_UNAVAILABLE', message: 'الخدمة غير متاحة مؤقتاً؛ حاول مجدداً' });
  }
}
export function closeRateLimiter() {
  redis?.disconnect();
}
