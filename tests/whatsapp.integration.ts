import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { db } from '../packages/db/client';
import { encrypt } from '../apps/api/src/crypto';
import {
  queueConfirmationTx,
  deliverConfirmations,
  applyWhatsAppStatus,
} from '../apps/api/src/whatsapp';
import type { ComplaintReceipt } from '../packages/domain/src/complaint-receipt';
test('opted-in confirmations are encrypted, claimed once and delivery callbacks are monotonic', async () => {
  const env = {
    WHATSAPP_ENABLED: 'true',
    WHATSAPP_TEMPLATE_APPROVED: 'true',
    WHATSAPP_PHONE_NUMBER_ID: '123456789',
    WHATSAPP_ACCESS_TOKEN: 'synthetic-never-sent',
    WHATSAPP_APP_SECRET: 'synthetic-app-secret',
    WHATSAPP_VERIFY_TOKEN: 'synthetic-verify',
    WHATSAPP_TEMPLATE_NAME: 'aliz_complaint_received',
    APP_ORIGIN: 'https://crm.example.test',
  };
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const id = 'wa-check-' + randomUUID(),
    rollback = new Error('rollback confirmation verification');
  try {
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.brand.create({
          data: { id, name: 'Rollback brand', nameEn: '', logo: 'neutral.svg', color: '#b62e30' },
        });
        const ticket = await tx.ticket.create({
          data: {
            brandId: id,
            source: 'PUBLIC_QR',
            category: 'SERVICE',
            priority: 'P3',
            description: encrypt('Synthetic private detail'),
            creator: 'PUBLIC_QR',
            communicationsOwner: 'UNASSIGNED',
          },
        });
        const receipt: ComplaintReceipt = {
          number: 'AG-2030-TEST',
          brand: 'Rollback brand',
          branch: 'فرع اختباري',
          category: 'الخدمة',
          receivedAt: new Date().toISOString(),
          description: 'Synthetic private detail',
          customerName: '',
          externalOrder: '',
          platform: '',
          source: 'QR',
          trackingPath: '/track/synthetic-only',
        };
        const input = {
          ticketId: ticket.id,
          phone: '966500000001',
          receipt,
          consent: false,
          now: new Date(),
        };
        assert.equal(await queueConfirmationTx(tx, input), 'NOT_REQUESTED');
        assert.equal(await tx.complaintConfirmation.count({ where: { ticketId: ticket.id } }), 0);
        assert.equal(await queueConfirmationTx(tx, { ...input, consent: true }), 'QUEUED');
        let job = await tx.complaintConfirmation.findUniqueOrThrow({
          where: { ticketId: ticket.id },
        });
        assert.ok(!job.payloadEncrypted.includes(input.phone));
        assert.ok(!job.payloadEncrypted.includes(receipt.description));
        // Restrict every test worker operation to this rollback-only complaint.
        const store = {
          complaintConfirmation: {
            findMany: (args: Prisma.ComplaintConfirmationFindManyArgs) =>
              tx.complaintConfirmation.findMany({
                ...args,
                where: { AND: [args.where ?? {}, { ticketId: ticket.id }] },
              }),
            updateMany: (args: Prisma.ComplaintConfirmationUpdateManyArgs) =>
              tx.complaintConfirmation.updateMany({
                ...args,
                where: { AND: [args.where ?? {}, { ticketId: ticket.id }] },
              }),
            findFirst: (args: Prisma.ComplaintConfirmationFindFirstArgs) =>
              tx.complaintConfirmation.findFirst({
                ...args,
                where: { AND: [args.where ?? {}, { ticketId: ticket.id }] },
              }),
          },
        } as unknown as Pick<Prisma.TransactionClient, 'complaintConfirmation'>;
        let sends = 0;
        const fetcher = (async () => {
          sends++;
          return new Response(JSON.stringify({ messages: [{ id: 'wamid.synthetic' }] }), {
            status: 200,
          });
        }) as typeof fetch;
        await deliverConfirmations(fetcher, new Date(), store);
        await deliverConfirmations(fetcher, new Date(), store);
        assert.equal(sends, 1);
        job = await tx.complaintConfirmation.findUniqueOrThrow({ where: { id: job.id } });
        assert.equal(job.status, 'ACCEPTED');
        assert.equal(job.attempts, 1);
        const callback = (status: string, phone = '966500000001') => ({
          object: 'whatsapp_business_account',
          entry: [
            {
              changes: [
                {
                  field: 'messages',
                  value: {
                    metadata: { phone_number_id: '123456789' },
                    statuses: [
                      {
                        id: 'wamid.synthetic',
                        status,
                        recipient_id: phone,
                        biz_opaque_callback_data: job.id,
                      },
                    ],
                  },
                },
              ],
            },
          ],
        });
        await applyWhatsAppStatus(callback('delivered', '966500000099'), store);
        assert.equal(
          (await tx.complaintConfirmation.findUniqueOrThrow({ where: { id: job.id } })).status,
          'ACCEPTED',
        );
        await applyWhatsAppStatus(callback('delivered'), store);
        await applyWhatsAppStatus(callback('sent'), store);
        assert.equal(
          (await tx.complaintConfirmation.findUniqueOrThrow({ where: { id: job.id } })).status,
          'DELIVERED',
        );
        await applyWhatsAppStatus(callback('read'), store);
        await applyWhatsAppStatus(callback('failed'), store);
        assert.equal(
          (await tx.complaintConfirmation.findUniqueOrThrow({ where: { id: job.id } })).status,
          'READ',
        );
        // Reset only this rollback fixture to exercise retry and ambiguous outcomes.
        const now = new Date();
        await tx.complaintConfirmation.update({
          where: { id: job.id },
          data: { status: 'QUEUED', attempts: 0, nextAttemptAt: now, providerMessageId: null },
        });
        let retries = 0;
        const throttled = (async () => {
          retries++;
          return new Response(JSON.stringify({ error: { code: 130429 } }), { status: 429 });
        }) as typeof fetch;
        await deliverConfirmations(throttled, now, store);
        await deliverConfirmations(throttled, now, store);
        assert.equal(retries, 1);
        await deliverConfirmations(throttled, new Date(+now + 60000), store);
        await deliverConfirmations(throttled, new Date(+now + 180000), store);
        assert.equal(retries, 3);
        job = await tx.complaintConfirmation.findUniqueOrThrow({ where: { id: job.id } });
        assert.equal(job.status, 'FAILED');
        assert.equal(job.attempts, 3);
        await tx.complaintConfirmation.update({
          where: { id: job.id },
          data: { status: 'QUEUED', attempts: 0, nextAttemptAt: now },
        });
        const ambiguous = (async () => new Response('{}', { status: 200 })) as typeof fetch;
        await deliverConfirmations(ambiguous, now, store);
        assert.equal(
          (await tx.complaintConfirmation.findUniqueOrThrow({ where: { id: job.id } })).status,
          'UNKNOWN',
        );
        let unwantedSends = 0;
        const mustNotSend = (async () => {
          unwantedSends++;
          throw new Error('Must not resend');
        }) as typeof fetch;
        await deliverConfirmations(mustNotSend, now, store);
        await tx.complaintConfirmation.update({
          where: { id: job.id },
          data: { status: 'QUEUED', expiresAt: now },
        });
        await deliverConfirmations(mustNotSend, now, store);
        assert.equal(
          (await tx.complaintConfirmation.findUniqueOrThrow({ where: { id: job.id } })).status,
          'EXPIRED',
        );
        assert.equal(unwantedSends, 0);
        throw rollback;
      }),
      (e) => e === rollback,
    );
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await db.$disconnect();
  }
});
