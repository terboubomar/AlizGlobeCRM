import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Prisma, Ticket, User } from '@prisma/client';
import { db } from '../../../packages/db/client';
import {
  Actor,
  authorize,
  DomainError,
  inScope,
  permissionsForRole,
  supportRoles,
  categoryLabels,
} from '../../../packages/domain/src';
import { receiptTime } from '../../../packages/domain/src/complaint-receipt';
import { decrypt, encrypt, hash, token } from './crypto';

type Tx = Prisma.TransactionClient;
export function telegramConfig() {
  const missing: string[] = [];
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(process.env.TELEGRAM_BOT_TOKEN ?? ''))
    missing.push('TELEGRAM_BOT_TOKEN');
  if (!/^[a-zA-Z0-9_]{5,32}$/.test(process.env.TELEGRAM_BOT_USERNAME ?? ''))
    missing.push('TELEGRAM_BOT_USERNAME');
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(process.env.TELEGRAM_WEBHOOK_SECRET ?? ''))
    missing.push('TELEGRAM_WEBHOOK_SECRET');
  try {
    const url = new URL(process.env.APP_ORIGIN ?? '');
    if (
      url.protocol !== 'https:' ||
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password
    )
      missing.push('PUBLIC_HTTPS_APP_ORIGIN');
  } catch {
    missing.push('PUBLIC_HTTPS_APP_ORIGIN');
  }
  const enabled = process.env.TELEGRAM_ENABLED === 'true';
  return { enabled, ready: enabled && !missing.length, missing };
}
export function validTelegramSecret(value: string) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
  return (
    !!secret &&
    Buffer.byteLength(value) === Buffer.byteLength(secret) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(secret))
  );
}
type Account = { chatId: string; label: string };
function account(value: string): Account {
  return JSON.parse(decrypt(value));
}
export async function telegramAccount(a: Actor, store: Pick<Tx, 'telegramConnection'> = db) {
  authorize(a, 'read');
  const connection = await store.telegramConnection.findUnique({ where: { userId: a.id } });
  const pending =
    connection?.pendingEncrypted &&
    connection.linkExpiresAt &&
    connection.linkExpiresAt > new Date();
  return {
    available: telegramConfig().ready,
    linked: !!connection?.linkedAt,
    label: connection?.accountEncrypted ? account(connection.accountEncrypted).label : null,
    pending: pending
      ? { label: account(connection.pendingEncrypted!).label, fingerprint: connection.pendingHash }
      : null,
    expiresAt: connection?.linkExpiresAt,
  };
}
export async function beginTelegramLinkTx(tx: Tx, a: Actor, now = new Date()) {
  authorize(a, 'read');
  if (!telegramConfig().ready)
    throw new DomainError('NOT_CONFIGURED', 409, 'ربط تيليجرام غير متاح حالياً');
  const current = await tx.user.findUnique({ where: { id: a.id } });
  if (!current?.enabled) throw new DomainError('FORBIDDEN', 403, 'الحساب غير مفعل');
  const code = token(),
    expiresAt = new Date(+now + 600000);
  await tx.telegramConnection.upsert({
    where: { userId: a.id },
    create: { userId: a.id, linkCodeHash: hash(code), linkExpiresAt: expiresAt },
    update: {
      linkCodeHash: hash(code),
      linkExpiresAt: expiresAt,
      pendingEncrypted: null,
      pendingHash: null,
    },
  });
  return { url: `https://t.me/${process.env.TELEGRAM_BOT_USERNAME}?start=${code}`, expiresAt };
}
const updateInput = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      text: z.string().max(200).optional(),
      forward_origin: z.unknown().optional(),
      via_bot: z.unknown().optional(),
      from: z.object({
        id: z.number().int().positive().safe(),
        is_bot: z.boolean(),
        username: z.string().optional(),
        first_name: z.string().optional(),
      }),
      chat: z.object({ id: z.number().int().positive().safe(), type: z.string() }),
    })
    .optional(),
});
export async function receiveTelegramTx(tx: Tx, input: unknown, now = new Date()) {
  const parsed = updateInput.safeParse(input);
  if (!parsed.success) return;
  const m = parsed.data.message;
  if (
    !m ||
    m.forward_origin ||
    m.via_bot ||
    m.from.is_bot ||
    m.chat.type !== 'private' ||
    m.from.id !== m.chat.id
  )
    return;
  const match = /^\/start(?:@[A-Za-z0-9_]+)? ([A-Za-z0-9_-]{43})$/.exec(m.text ?? '');
  if (!match) return;
  const codeHash = hash(match[1]);
  const link = await tx.telegramConnection.findUnique({
    where: { linkCodeHash: codeHash },
    include: { user: true },
  });
  if (!link?.user.enabled || !link.linkExpiresAt || link.linkExpiresAt <= now) return;
  const pending: Account = {
    chatId: String(m.chat.id),
    label: m.from.username
      ? '@' + m.from.username.slice(0, 32)
      : (m.from.first_name ?? 'حساب تيليجرام').slice(0, 100),
  };
  // Atomically consume the one-time code. Retried webhook updates cannot replace the pending identity.
  await tx.telegramConnection.updateMany({
    where: { userId: link.userId, linkCodeHash: codeHash, linkExpiresAt: { gt: now } },
    data: {
      linkCodeHash: null,
      pendingEncrypted: encrypt(JSON.stringify(pending)),
      pendingHash: hash(pending.chatId),
    },
  });
}
export async function confirmTelegramTx(tx: Tx, a: Actor, input: unknown, now = new Date()) {
  authorize(a, 'read');
  const { fingerprint } = z
    .object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict()
    .parse(input);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`telegram:${a.id}`}))`;
  const c = await tx.telegramConnection.findUnique({
    where: { userId: a.id },
    include: { user: true },
  });
  if (
    !c?.user.enabled ||
    !c.pendingEncrypted ||
    c.pendingHash !== fingerprint ||
    !c.linkExpiresAt ||
    c.linkExpiresAt <= now
  )
    throw new DomainError('LINK_EXPIRED', 409, 'انتهت صلاحية الربط؛ أنشئ رابطاً جديداً');
  const duplicate = await tx.telegramConnection.findUnique({ where: { chatHash: fingerprint } });
  if (duplicate && duplicate.userId !== a.id)
    throw new DomainError('ALREADY_LINKED', 409, 'حساب تيليجرام مرتبط بمستخدم آخر');
  await tx.telegramConnection.update({
    where: { userId: a.id },
    data: {
      accountEncrypted: c.pendingEncrypted,
      chatHash: fingerprint,
      linkedAt: now,
      pendingEncrypted: null,
      pendingHash: null,
      linkCodeHash: null,
      linkExpiresAt: null,
    },
  });
  await tx.audit.create({ data: { actor: a.id, action: 'TELEGRAM_LINKED', entityId: a.id } });
  return { ok: true };
}
export async function disconnectTelegramTx(tx: Tx, a: Actor) {
  authorize(a, 'read');
  await tx.telegramConnection.updateMany({
    where: { userId: a.id },
    data: {
      accountEncrypted: null,
      chatHash: null,
      linkedAt: null,
      pendingEncrypted: null,
      pendingHash: null,
      linkCodeHash: null,
      linkExpiresAt: null,
    },
  });
  await tx.telegramNotification.updateMany({
    where: { userId: a.id, status: 'QUEUED' },
    data: { status: 'CANCELLED' },
  });
  await tx.audit.create({ data: { actor: a.id, action: 'TELEGRAM_DISCONNECTED', entityId: a.id } });
  return { ok: true };
}
// Outbox events that reach people through Telegram. NEW_TICKET is not here:
// new complaints are queued for superadmins at intake (NEW_COMPLAINT).
export const outboxAlertKinds = ['SLA_WARNING', 'SLA_BREACHED', 'SAFETY_INTAKE'] as const;
type OutboxAlertKind = (typeof outboxAlertKinds)[number];
const isOutboxAlert = (kind: string): kind is OutboxAlertKind =>
  (outboxAlertKinds as readonly string[]).includes(kind);
// Supervisors: may assign complaints and cover this brand/branch. Superadmins
// are left out; they already receive every new complaint.
function supervises(user: User, ticket: Ticket) {
  return (
    user.role !== 'SUPER_ADMIN' &&
    permissionsForRole(user.role, user.financeDuty).includes('assign') &&
    inScope(user, ticket)
  );
}
function owns(user: User, ticket: Ticket) {
  return (
    !!ticket.resolutionOwner &&
    user.id === ticket.resolutionOwner &&
    supportRoles.includes(user.role) &&
    inScope(user, ticket)
  );
}
export function eligibleTelegramRecipient(user: User, ticket: Ticket, kind: string) {
  if (!user.enabled) return false;
  if (isOutboxAlert(kind)) {
    if (ticket.state === 'CLOSED') return false;
    if (kind === 'SAFETY_INTAKE') return supervises(user, ticket);
    // A deadline about to pass goes to the owner; unassigned, to the supervisors.
    if (kind === 'SLA_WARNING')
      return ticket.resolutionOwner ? owns(user, ticket) : supervises(user, ticket);
    return owns(user, ticket) || supervises(user, ticket);
  }
  if (kind === 'NEW_COMPLAINT') return user.role === 'SUPER_ADMIN';
  return (
    kind === 'ASSIGNED' &&
    user.id === ticket.resolutionOwner &&
    !ticket.escalated &&
    supportRoles.includes(user.role) &&
    inScope(user, ticket)
  );
}
export async function queueTelegramTx(
  tx: Tx,
  ticketId: string,
  kind: 'NEW_COMPLAINT' | 'ASSIGNED',
  now = new Date(),
) {
  if (!telegramConfig().ready) return;
  const ticket = await tx.ticket.findUniqueOrThrow({ where: { id: ticketId } });
  const recipients = await tx.user.findMany({
    where: {
      enabled: true,
      ...(kind === 'NEW_COMPLAINT'
        ? { role: 'SUPER_ADMIN' }
        : { id: ticket.resolutionOwner ?? '__unassigned' }),
      telegram: { is: { linkedAt: { not: null } } },
    },
    include: { telegram: true },
  });
  for (const user of recipients) {
    if (!eligibleTelegramRecipient(user, ticket, kind) || !user.telegram?.chatHash) continue;
    const key = `${kind}:${ticket.id}:${ticket.version}:${user.id}`;
    await tx.telegramNotification.upsert({
      where: { key },
      update: {},
      create: {
        key,
        ticketId,
        userId: user.id,
        connectionHash: user.telegram.chatHash,
        kind,
        expiresAt: new Date(+now + 86400000),
      },
    });
  }
}
/**
 * Turns pending outbox events into Telegram alerts for the people they concern.
 * Each event is claimed once (deliveredAt); events older than a day are closed
 * without sending so enabling Telegram later does not replay stale alerts.
 * Does nothing while Telegram is not configured.
 */
export async function routeOutboxTx(tx: Tx, now = new Date(), limit = 50) {
  if (!telegramConfig().ready) return { routed: 0, queued: 0 };
  const rows = await tx.outbox.findMany({
    where: { deliveredAt: null },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  if (!rows.length) return { routed: 0, queued: 0 };
  const users = await tx.user.findMany({
    where: { enabled: true, telegram: { is: { linkedAt: { not: null } } } },
    include: { telegram: true },
  });
  let queued = 0;
  for (const row of rows) {
    const claimed = await tx.outbox.updateMany({
      where: { id: row.id, deliveredAt: null },
      data: { deliveredAt: now },
    });
    if (!claimed.count || !isOutboxAlert(row.type) || +row.createdAt < +now - 86400000) continue;
    const ticket = await tx.ticket.findUnique({ where: { id: row.ticketId } });
    if (!ticket) continue;
    for (const user of users) {
      if (!user.telegram?.chatHash || !eligibleTelegramRecipient(user, ticket, row.type)) continue;
      const key = `${row.type}:${row.id}:${user.id}`;
      await tx.telegramNotification.upsert({
        where: { key },
        update: {},
        create: {
          key,
          ticketId: ticket.id,
          userId: user.id,
          connectionHash: user.telegram.chatHash,
          kind: row.type,
          expiresAt: new Date(+now + 86400000),
        },
      });
      queued++;
    }
  }
  return { routed: rows.length, queued };
}
export function routeOutbox(now = new Date()) {
  return db.$transaction((tx) => routeOutboxTx(tx, now));
}
const alertTitle: Record<string, string> = {
  NEW_COMPLAINT: 'شكوى جديدة تحتاج إلى إسناد',
  ASSIGNED: 'تم إسناد شكوى إليك',
  SLA_WARNING: 'تنبيه: شكوى تقترب من تجاوز المهلة',
  SLA_BREACHED: 'شكوى تجاوزت المهلة وتحتاج إلى متابعة',
  SAFETY_INTAKE: 'شكوى عاجلة (P1) تحتاج إلى متابعة فورية',
};
export function telegramMessage(
  ticket: Ticket & { brand: { name: string }; branch: { name: string } | null },
  kind: string,
  chatId: string,
) {
  const number = `AG-${ticket.createdAt.getUTCFullYear()}-${String(ticket.sequence).padStart(6, '0')}`;
  const url = new URL('/', process.env.APP_ORIGIN);
  url.searchParams.set('view', 'tickets');
  url.searchParams.set('ticket', ticket.id);
  return {
    chat_id: chatId,
    text: [
      alertTitle[kind] ?? alertTitle.ASSIGNED,
      number,
      `العلامة: ${ticket.brand.name.slice(0, 100)}`,
      `الفرع: ${ticket.branch?.name.slice(0, 100) ?? 'غير محدد'}`,
      `وقت الاستقبال: ${receiptTime(ticket.receivedAt.toISOString())}`,
      `الأولوية: ${ticket.priority}`,
      `التصنيف: ${categoryLabels[ticket.category] ?? ticket.category}`,
      `المصدر: ${ticket.source === 'PUBLIC_QR' ? 'QR' : 'الهاتف'}`,
    ].join('\n'),
    link_preview_options: { is_disabled: true },
    protect_content: true,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: kind === 'NEW_COMPLAINT' ? 'فتح الشكوى والإسناد' : 'فتح الشكوى',
            url: url.toString(),
          },
        ],
      ],
    },
  };
}
type DeliveryStore = Pick<Tx, 'telegramNotification' | 'telegramConnection'>;
export async function deliverTelegram(
  fetcher: typeof fetch = fetch,
  now = new Date(),
  store: DeliveryStore = db,
) {
  if (!telegramConfig().ready) return;
  await store.telegramNotification.updateMany({
    where: { status: 'SENDING', claimedAt: { lt: new Date(+now - 120000) } },
    data: { status: 'UNKNOWN', lastError: 'SEND_OUTCOME_UNKNOWN' },
  });
  await store.telegramNotification.updateMany({
    where: { status: 'QUEUED', expiresAt: { lte: now } },
    data: { status: 'EXPIRED' },
  });
  const jobs = await store.telegramNotification.findMany({
    where: { status: 'QUEUED', nextAttemptAt: { lte: now }, expiresAt: { gt: now } },
    include: {
      user: { include: { telegram: true } },
      ticket: { include: { brand: true, branch: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: 10,
  });
  for (const job of jobs) {
    const c = job.user.telegram;
    if (
      !c?.accountEncrypted ||
      c.chatHash !== job.connectionHash ||
      !eligibleTelegramRecipient(job.user, job.ticket, job.kind)
    ) {
      await store.telegramNotification.updateMany({
        where: { id: job.id, status: 'QUEUED' },
        data: { status: 'CANCELLED' },
      });
      continue;
    }
    const claim = await store.telegramNotification.updateMany({
      where: { id: job.id, status: 'QUEUED', attempts: job.attempts },
      data: { status: 'SENDING', attempts: { increment: 1 }, claimedAt: now },
    });
    if (!claim.count) continue;
    try {
      // Refresh authorization and binding after claiming, so disabled/reassigned users are skipped.
      const fresh = await store.telegramNotification.findUniqueOrThrow({
        where: { id: job.id },
        include: {
          user: { include: { telegram: true } },
          ticket: { include: { brand: true, branch: true } },
        },
      });
      if (
        !fresh.user.telegram?.accountEncrypted ||
        fresh.user.telegram.chatHash !== job.connectionHash ||
        !eligibleTelegramRecipient(fresh.user, fresh.ticket, job.kind)
      ) {
        await store.telegramNotification.updateMany({
          where: { id: job.id, status: 'SENDING' },
          data: { status: 'CANCELLED' },
        });
        continue;
      }
      const response = await fetcher(
        `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            telegramMessage(
              fresh.ticket,
              job.kind,
              account(fresh.user.telegram.accountEncrypted).chatId,
            ),
          ),
          signal: AbortSignal.timeout(10000),
        },
      );
      const body = (await response.json()) as {
        ok?: boolean;
        result?: { message_id?: number };
        error_code?: number;
        parameters?: { retry_after?: number };
      };
      if (response.ok && body.ok && Number.isSafeInteger(body.result?.message_id)) {
        await store.telegramNotification.updateMany({
          where: { id: job.id, status: 'SENDING' },
          data: {
            status: 'SENT',
            sentAt: now,
            messageId: String(body.result!.message_id),
            lastError: null,
          },
        });
      } else {
        const code = body.error_code ?? response.status;
        const retry = code === 429 && job.attempts < 2;
        const delay = Math.min(86400, Math.max(1, Number(body.parameters?.retry_after) || 60));
        await store.telegramNotification.updateMany({
          where: { id: job.id, status: 'SENDING' },
          data: {
            status:
              (response.ok && body.ok !== false) || response.status >= 500
                ? 'UNKNOWN'
                : retry
                  ? 'QUEUED'
                  : 'FAILED',
            nextAttemptAt: new Date(+now + delay * 1000),
            lastError: `TELEGRAM_${Number.isFinite(code) ? code : 'UNKNOWN'}`,
          },
        });
        if (code === 403)
          await store.telegramConnection.updateMany({
            where: { userId: job.userId, chatHash: job.connectionHash },
            data: { accountEncrypted: null, chatHash: null, linkedAt: null },
          });
        if (code === 429) break;
      }
    } catch {
      await store.telegramNotification.updateMany({
        where: { id: job.id, status: 'SENDING' },
        data: { status: 'UNKNOWN', lastError: 'SEND_OUTCOME_UNKNOWN' },
      });
    }
  }
}
