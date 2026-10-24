import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { db } from '../../../packages/db/client';
import { DomainError } from '../../../packages/domain/src';
import { ComplaintReceipt, receiptTime } from '../../../packages/domain/src/complaint-receipt';
import { decrypt, encrypt, phoneHash } from './crypto';
export function whatsappConfig() {
  const fields = [
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_TEMPLATE_NAME',
  ];
  const missing = fields.filter((key) => !process.env[key]);
  let publicOrigin = false;
  try {
    const u = new URL(process.env.APP_ORIGIN ?? '');
    publicOrigin =
      u.protocol === 'https:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) &&
      !u.username &&
      !u.password;
  } catch {
    /* missing origin */
  }
  if (!publicOrigin) missing.push('PUBLIC_HTTPS_APP_ORIGIN');
  if (process.env.WHATSAPP_TEMPLATE_APPROVED !== 'true') missing.push('WHATSAPP_TEMPLATE_APPROVED');
  if (!/^\d+$/.test(process.env.WHATSAPP_PHONE_NUMBER_ID ?? ''))
    missing.push('VALID_PHONE_NUMBER_ID');
  if (!/^[a-z0-9_]{1,512}$/.test(process.env.WHATSAPP_TEMPLATE_NAME ?? ''))
    missing.push('VALID_TEMPLATE_NAME');
  if (!/^v\d+\.\d+$/.test(process.env.WHATSAPP_API_VERSION ?? 'v26.0'))
    missing.push('VALID_API_VERSION');
  return {
    enabled: process.env.WHATSAPP_ENABLED === 'true',
    ready: process.env.WHATSAPP_ENABLED === 'true' && !missing.length,
    missing: [...new Set(missing)],
  };
}
export function templatePayload(id: string, phone: string, r: ComplaintReceipt) {
  const text = (s: string, max = 100) => s.replace(/\s+/g, ' ').trim().slice(0, max) || 'غير محدد';
  const parameters = {
    number: r.number,
    brand: text(r.brand),
    branch: text(r.branch),
    received_at: receiptTime(r.receivedAt),
    category: r.category,
    order: text(r.externalOrder),
    summary: text(r.description, 180),
    tracking_url: new URL(r.trackingPath, process.env.APP_ORIGIN).toString(),
  };
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone.replace(/^\+/, ''),
    type: 'template',
    biz_opaque_callback_data: id,
    template: {
      name: process.env.WHATSAPP_TEMPLATE_NAME,
      language: { code: process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? 'ar' },
      components: [
        {
          type: 'body',
          parameters: Object.entries(parameters).map(([parameter_name, text]) => ({
            type: 'text',
            parameter_name,
            text,
          })),
        },
      ],
    },
  };
}
export function validWhatsAppSignature(
  raw: Buffer,
  signature: string,
  secret = process.env.WHATSAPP_APP_SECRET ?? '',
) {
  if (!secret || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}
export async function deliverConfirmations(
  fetcher: typeof fetch = fetch,
  now = new Date(),
  store: Pick<Prisma.TransactionClient, 'complaintConfirmation'> = db,
) {
  if (!whatsappConfig().ready) return;
  await store.complaintConfirmation.updateMany({
    where: { status: 'SENDING', claimedAt: { lt: new Date(+now - 120000) } },
    data: { status: 'UNKNOWN', lastError: 'SEND_OUTCOME_UNKNOWN' },
  });
  await store.complaintConfirmation.updateMany({
    where: { status: 'QUEUED', expiresAt: { lte: now } },
    data: { status: 'EXPIRED' },
  });
  const jobs = await store.complaintConfirmation.findMany({
    where: { status: 'QUEUED', nextAttemptAt: { lte: now }, expiresAt: { gt: now } },
    orderBy: { createdAt: 'asc' },
    take: 10,
  });
  for (const job of jobs) {
    const claim = await store.complaintConfirmation.updateMany({
      where: { id: job.id, status: 'QUEUED', attempts: job.attempts },
      data: { status: 'SENDING', claimedAt: now, attempts: { increment: 1 } },
    });
    if (!claim.count) continue;
    try {
      const payload = JSON.parse(decrypt(job.payloadEncrypted)) as {
        phone: string;
        receipt: ComplaintReceipt;
      };
      const response = await fetcher(
        `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION ?? 'v26.0'}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(templatePayload(job.id, payload.phone, payload.receipt)),
          signal: AbortSignal.timeout(10000),
        },
      );
      const body = (await response.json()) as {
        messages?: { id?: string }[];
        error?: { code?: number };
      };
      const messageId = body.messages?.[0]?.id;
      if (response.ok && messageId) {
        await store.complaintConfirmation.updateMany({
          where: { id: job.id, status: { in: ['SENDING', 'UNKNOWN'] } },
          data: { status: 'ACCEPTED', providerMessageId: messageId, lastError: null },
        });
        continue;
      }
      const retry = response.status === 429 && job.attempts < 2;
      await store.complaintConfirmation.updateMany({
        where: { id: job.id, status: 'SENDING' },
        data: {
          status: response.ok ? 'UNKNOWN' : retry ? 'QUEUED' : 'FAILED',
          nextAttemptAt: new Date(+now + 60000 * 2 ** job.attempts),
          lastError: `HTTP_${response.status}_${typeof body.error?.code === 'number' ? body.error.code : 'UNKNOWN'}`,
        },
      });
    } catch {
      await store.complaintConfirmation.updateMany({
        where: { id: job.id, status: 'SENDING' },
        data: { status: 'UNKNOWN', lastError: 'SEND_OUTCOME_UNKNOWN' },
      });
    }
  }
}
const callback = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          field: z.string(),
          value: z.object({
            metadata: z.object({ phone_number_id: z.string() }),
            statuses: z
              .array(
                z.object({
                  id: z.string(),
                  status: z.enum(['sent', 'delivered', 'read', 'failed']),
                  recipient_id: z.string(),
                  biz_opaque_callback_data: z.string().optional(),
                  errors: z.array(z.object({ code: z.number() })).optional(),
                }),
              )
              .optional(),
          }),
        }),
      ),
    }),
  ),
});
export async function applyWhatsAppStatus(
  body: unknown,
  store: Pick<Prisma.TransactionClient, 'complaintConfirmation'> = db,
) {
  const parsed = callback.safeParse(body);
  if (!parsed.success) return;
  for (const entry of parsed.data.entry)
    for (const change of entry.changes) {
      if (
        change.field !== 'messages' ||
        change.value.metadata.phone_number_id !== process.env.WHATSAPP_PHONE_NUMBER_ID
      )
        continue;
      for (const status of change.value.statuses ?? []) {
        const job = await store.complaintConfirmation.findFirst({
          where: status.biz_opaque_callback_data
            ? { id: status.biz_opaque_callback_data }
            : { providerMessageId: status.id },
        });
        if (
          !job ||
          job.recipientHash !== phoneHash(status.recipient_id.replace(/\D/g, '')) ||
          (job.providerMessageId && job.providerMessageId !== status.id)
        )
          continue;
        const next = { sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' }[
          status.status
        ];
        const allowed =
          next === 'READ'
            ? ['SENDING', 'UNKNOWN', 'ACCEPTED', 'SENT', 'DELIVERED', 'FAILED']
            : next === 'DELIVERED'
              ? ['SENDING', 'UNKNOWN', 'ACCEPTED', 'SENT', 'FAILED']
              : next === 'SENT'
                ? ['SENDING', 'UNKNOWN', 'ACCEPTED']
                : ['SENDING', 'UNKNOWN', 'ACCEPTED', 'SENT'];
        await store.complaintConfirmation.updateMany({
          where: { id: job.id, status: { in: allowed } },
          data: {
            status: next,
            providerMessageId: status.id,
            ...(next === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
            ...(next === 'READ'
              ? { readAt: new Date(), deliveredAt: job.deliveredAt ?? new Date() }
              : {}),
            ...(next === 'FAILED'
              ? { lastError: `META_${status.errors?.[0]?.code ?? 'UNKNOWN'}` }
              : { lastError: null }),
          },
        });
      }
    }
}
export function verifyWhatsAppChallenge(query: Record<string, unknown>) {
  const expected = process.env.WHATSAPP_VERIFY_TOKEN ?? '',
    given = query['hub.verify_token'];
  if (
    query['hub.mode'] !== 'subscribe' ||
    !expected ||
    typeof given !== 'string' ||
    Buffer.byteLength(given) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(given), Buffer.from(expected)) ||
    typeof query['hub.challenge'] !== 'string'
  )
    throw new DomainError('FORBIDDEN', 403, 'غير مصرح');
  return query['hub.challenge'];
}

export async function queueConfirmationTx(
  tx: Prisma.TransactionClient,
  input: {
    ticketId: string;
    phone: string;
    receipt: ComplaintReceipt;
    consent: boolean;
    now: Date;
  },
) {
  if (!input.consent) return 'NOT_REQUESTED';
  if (!whatsappConfig().ready) return 'NOT_CONFIGURED';
  const recipientHash = phoneHash(input.phone);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${recipientHash}))`;
  const recent = await tx.complaintConfirmation.count({
    where: { recipientHash, createdAt: { gt: new Date(+input.now - 3600000) } },
  });
  if (recent >= 5) return 'RATE_LIMITED';
  await tx.complaintConfirmation.create({
    data: {
      ticketId: input.ticketId,
      recipientHash,
      payloadEncrypted: encrypt(JSON.stringify({ phone: input.phone, receipt: input.receipt })),
      expiresAt: new Date(+input.now + 3600000),
    },
  });
  return 'QUEUED';
}
