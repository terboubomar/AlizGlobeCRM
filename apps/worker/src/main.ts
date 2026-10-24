import 'dotenv/config';
process.env.LOG_SERVICE ??= 'worker';
import { deliverConfirmations } from '../../api/src/whatsapp';
import { deliverTelegram, routeOutbox } from '../../api/src/telegram';
import { Queue, Worker } from 'bullmq';
import { db } from '../../../packages/db/client';
import { retentionDays, retentionSweep } from '../../api/src/privacy';
import { errorKind, log } from '../../api/src/log';
export async function reconcile(now = new Date()) {
  const timers = await db.timer.findMany({
    where: { completedAt: null, warningAt: { lte: now }, ticket: { state: { not: 'CLOSED' } } },
    include: { ticket: true },
  });
  for (const timer of timers)
    await db.$transaction(async (tx) => {
      const breached = timer.dueAt <= now;
      const type = breached ? 'SLA_BREACHED' : 'SLA_WARNING';
      const claimed = await tx.timer.updateMany({
        where: {
          id: timer.id,
          completedAt: null,
          ...(breached ? { breachedAt: null } : { warnedAt: null }),
        },
        data: breached ? { breachedAt: now } : { warnedAt: now },
      });
      if (!claimed.count) return;
      await tx.event.create({ data: { ticketId: timer.ticketId, actor: 'SYSTEM', type } });
      if (breached)
        await tx.ticket.update({
          where: { id: timer.ticketId },
          data: { escalated: true, version: { increment: 1 } },
        });
      await tx.outbox.upsert({
        where: { key: `${type}:${timer.id}` },
        create: {
          key: `${type}:${timer.id}`,
          type,
          ticketId: timer.ticketId,
          brandId: timer.ticket.brandId,
          branchId: timer.ticket.branchId,
        },
        update: {},
      });
    });
}
async function main() {
  if (
    process.env.WORKER_MODE === 'local' &&
    process.env.DEMO_MODE === 'true' &&
    process.env.NODE_ENV !== 'production'
  ) {
    await reconcile();
    let sending = false;
    const deliveryInterval = setInterval(async () => {
      if (sending) return;
      sending = true;
      try {
        const deliveries = await Promise.allSettled([
          deliverConfirmations(),
          routeOutbox().then(() => deliverTelegram()),
        ]);
        for (const result of deliveries)
          if (result.status === 'rejected')
            log({
              level: 'error',
              event: 'job_failed',
              job: 'delivery',
              ...errorKind(result.reason),
            });
      } catch (e) {
        log({ level: 'error', event: 'job_failed', job: 'delivery', ...errorKind(e) });
      } finally {
        sending = false;
      }
    }, 10000);
    const interval = setInterval(
      () =>
        reconcile().catch((e: unknown) =>
          log({ level: 'error', event: 'job_failed', job: 'reconcile', ...errorKind(e) }),
        ),
      60000,
    );
    process.on('SIGTERM', () => {
      clearInterval(interval);
      clearInterval(deliveryInterval);
      db.$disconnect().finally(() => process.exit(0));
    });
    return;
  }
  const url = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6389');
  const connection = {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.password ? { password: url.password } : {}),
  };
  const queue = new Queue('sla', { connection });
  await queue.upsertJobScheduler(
    'reconcile-every-minute',
    { every: 60000 },
    { name: 'reconcile', data: {}, opts: { removeOnComplete: 10, removeOnFail: 50 } },
  );
  await queue.upsertJobScheduler(
    'customer-confirmations',
    { every: 10000 },
    { name: 'confirmations', data: {}, opts: { removeOnComplete: 10, removeOnFail: 50 } },
  );
  await queue.upsertJobScheduler(
    'telegram-notifications',
    { every: 10000 },
    { name: 'telegram', data: {}, opts: { removeOnComplete: 10, removeOnFail: 50 } },
  );
  // Retention runs only when a period is configured (and, in production, approved).
  const keepDays = retentionDays();
  if (keepDays === null) await queue.removeJobScheduler('retention-daily');
  else
    await queue.upsertJobScheduler(
      'retention-daily',
      { every: 86400000 },
      { name: 'retention', data: {}, opts: { removeOnComplete: 10, removeOnFail: 50 } },
    );
  const worker = new Worker(
    'sla',
    async (job) => {
      if (job.name === 'retention') {
        if (keepDays !== null) {
          const r = await retentionSweep(keepDays);
          log({ level: 'info', event: 'retention_run', days: keepDays, ...r });
        }
      } else if (job.name === 'confirmations') await deliverConfirmations();
      else if (job.name === 'telegram') {
        await routeOutbox();
        await deliverTelegram();
      } else await reconcile();
    },
    { connection },
  );
  worker.on('failed', (job, e) =>
    log({ level: 'error', event: 'job_failed', job: job?.name ?? 'unknown', ...errorKind(e) }),
  );
  await reconcile();
  async function stop() {
    await worker.close();
    await queue.close();
    await db.$disconnect();
    process.exit(0);
  }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
if (process.env.NODE_ENV !== 'test')
  main().catch((e: unknown) => {
    log({ level: 'error', event: 'startup_failed', ...errorKind(e) });
    process.stderr.write('Worker startup failed. Check Redis and PostgreSQL.\n');
    process.exit(1);
  });
