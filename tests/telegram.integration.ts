import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { db } from '../packages/db/client';
import { createTicketTx } from '../apps/api/src/service';
import { hash } from '../apps/api/src/crypto';
import type { Actor } from '../packages/domain/src';
import {
  telegramAccount,
  beginTelegramLinkTx,
  receiveTelegramTx,
  confirmTelegramTx,
  disconnectTelegramTx,
  queueTelegramTx,
  deliverTelegram,
} from '../apps/api/src/telegram';

test('Telegram links require private-chat and CRM confirmation; complaint and assignment alerts are scoped and rollback-only', async () => {
  const env = {
    TELEGRAM_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: '123456:synthetic-never-sent-token',
    TELEGRAM_BOT_USERNAME: 'aliz_test_bot',
    TELEGRAM_WEBHOOK_SECRET: 'synthetic-secret-at-least-32-characters',
    APP_ORIGIN: 'https://crm.example.test',
  };
  const previous = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const id = 'tg-rollback-' + randomUUID(),
    rollback = new Error('Rollback Telegram test');
  try {
    await assert.rejects(
      db.$transaction(
        async (tx) => {
          await tx.brand.create({
            data: {
              id,
              name: 'Rollback Telegram',
              nameEn: '',
              logo: 'neutral.svg',
              color: '#b93645',
              status: 'ACTIVE',
            },
          });
          await tx.branch.create({
            data: {
              id,
              brandId: id,
              name: 'Rollback branch',
              code: id,
              city: 'Test',
              active: true,
            },
          });
          const admin: Actor = {
            id: id + '-admin',
            name: 'Synthetic admin',
            role: 'SUPER_ADMIN',
            brandIds: [id],
            branchIds: [],
          };
          const agent: Actor = {
            id: id + '-agent',
            name: 'Synthetic agent',
            role: 'AGENT',
            brandIds: [id],
            branchIds: [],
          };
          const unlinked: Actor = { ...agent, id: id + '-unlinked' };
          for (const user of [admin, agent, unlinked]) await tx.user.create({ data: user });
          const update = (code: string, chat = 10000001, type = 'private') => ({
            update_id: 1,
            message: {
              text: '/start ' + code,
              from: { id: chat, is_bot: false, username: 'synthetic_tg' },
              chat: { id: chat, type },
            },
          });
          const first = await beginTelegramLinkTx(tx, admin);
          const code = new URL(first.url).searchParams.get('start')!;
          const stored = await tx.telegramConnection.findUniqueOrThrow({
            where: { userId: admin.id },
          });
          assert.ok(stored.linkCodeHash !== code);
          await receiveTelegramTx(tx, update(code, 10000001, 'group'));
          assert.equal((await telegramAccount(admin, tx)).pending, null);
          await receiveTelegramTx(tx, {
            update_id: 2,
            message: { ...update(code).message, forward_origin: { type: 'user' } },
          });
          assert.equal((await telegramAccount(admin, tx)).pending, null);
          await receiveTelegramTx(tx, update(code));
          let state = await telegramAccount(admin, tx);
          assert.equal(state.linked, false);
          assert.equal(state.pending?.label, '@synthetic_tg');
          await receiveTelegramTx(tx, update(code, 10000002));
          assert.equal((await telegramAccount(admin, tx)).pending?.fingerprint, hash('10000001'));
          await assert.rejects(confirmTelegramTx(tx, admin, { fingerprint: hash('wrong') }), {
            status: 409,
          });
          await confirmTelegramTx(tx, admin, { fingerprint: state.pending!.fingerprint });
          assert.equal((await telegramAccount(admin, tx)).linked, true);
          const adminStored = await tx.telegramConnection.findUniqueOrThrow({
            where: { userId: admin.id },
          });
          assert.ok(!adminStored.accountEncrypted?.includes('synthetic_tg'));
          const expired = await beginTelegramLinkTx(tx, unlinked, new Date(Date.now() - 700000));
          await receiveTelegramTx(
            tx,
            update(new URL(expired.url).searchParams.get('start')!, 10000003),
          );
          assert.equal((await telegramAccount(unlinked, tx)).pending, null);
          // One Telegram account cannot silently be rebound to another CRM account.
          const duplicate = await beginTelegramLinkTx(tx, agent);
          await receiveTelegramTx(tx, update(new URL(duplicate.url).searchParams.get('start')!));
          await assert.rejects(confirmTelegramTx(tx, agent, { fingerprint: hash('10000001') }), {
            status: 409,
          });
          const employeeLink = await beginTelegramLinkTx(tx, agent);
          await receiveTelegramTx(
            tx,
            update(new URL(employeeLink.url).searchParams.get('start')!, 10000002),
          );
          state = await telegramAccount(agent, tx);
          await confirmTelegramTx(tx, agent, { fingerprint: state.pending!.fingerprint });
          const qrActor: Actor = {
            id: 'QR:' + id,
            name: 'Public QR',
            role: 'PUBLIC',
            brandIds: [],
            branchIds: [],
          };
          const input = {
            brandId: id,
            branchId: id,
            category: 'SERVICE',
            priority: 'P3',
            description: 'Rollback-only private complaint details',
          };
          const key = randomUUID(),
            qr = { id, brandId: id, branchId: id };
          const created = (await createTicketTx(tx, qrActor, input, key, qr)) as { id: string };
          await createTicketTx(tx, qrActor, input, key, qr);
          const phone = (await createTicketTx(tx, agent, input, randomUUID())) as { id: string };
          const ticketIds = [created.id, phone.id];
          assert.equal(
            await tx.telegramNotification.count({
              where: { ticketId: { in: ticketIds }, userId: admin.id },
            }),
            2,
          );
          assert.equal(
            await tx.telegramNotification.count({
              where: { ticketId: { in: ticketIds }, userId: agent.id },
            }),
            0,
          );
          await tx.ticket.update({
            where: { id: created.id },
            data: {
              resolutionOwner: agent.id,
              communicationsOwner: agent.id,
              state: 'ASSIGNED',
              version: { increment: 1 },
            },
          });
          await queueTelegramTx(tx, created.id, 'ASSIGNED');
          await queueTelegramTx(tx, created.id, 'ASSIGNED');
          assert.equal(
            await tx.telegramNotification.count({
              where: { ticketId: created.id, userId: agent.id },
            }),
            1,
          );
          const store = {
            telegramNotification: {
              findMany: (args: Prisma.TelegramNotificationFindManyArgs) =>
                tx.telegramNotification.findMany({
                  ...args,
                  where: { AND: [args.where ?? {}, { ticketId: { in: ticketIds } }] },
                }),
              updateMany: (args: Prisma.TelegramNotificationUpdateManyArgs) =>
                tx.telegramNotification.updateMany({
                  ...args,
                  where: { AND: [args.where ?? {}, { ticketId: { in: ticketIds } }] },
                }),
              findUniqueOrThrow: tx.telegramNotification.findUniqueOrThrow.bind(
                tx.telegramNotification,
              ),
            },
            telegramConnection: {
              updateMany: (args: Prisma.TelegramConnectionUpdateManyArgs) =>
                tx.telegramConnection.updateMany({
                  ...args,
                  where: { AND: [args.where ?? {}, { userId: { in: [admin.id, agent.id] } }] },
                }),
            },
          } as unknown as Pick<
            Prisma.TransactionClient,
            'telegramNotification' | 'telegramConnection'
          >;
          const sent: { chat_id: string; text: string }[] = [];
          const fetcher = (async (_url, options) => {
            sent.push(JSON.parse(options!.body as string));
            return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), {
              status: 200,
            });
          }) as typeof fetch;
          await deliverTelegram(fetcher, new Date(), store);
          await deliverTelegram(fetcher, new Date(), store);
          assert.equal(sent.length, 3);
          assert.equal(sent.filter((s) => s.chat_id === '10000001').length, 2);
          assert.equal(sent.filter((s) => s.chat_id === '10000002').length, 1);
          assert.ok(!JSON.stringify(sent).includes(input.description));
          // Each new version represents a fresh assignment event for the fixture.
          await tx.ticket.update({
            where: { id: created.id },
            data: { version: { increment: 1 } },
          });
          await queueTelegramTx(tx, created.id, 'ASSIGNED');
          await tx.ticket.update({
            where: { id: created.id },
            data: { resolutionOwner: unlinked.id },
          });
          await deliverTelegram(fetcher, new Date(), store);
          assert.equal(sent.length, 3);
          assert.equal(
            await tx.telegramNotification.count({
              where: { ticketId: created.id, status: 'CANCELLED' },
            }),
            1,
          );
          await tx.ticket.update({
            where: { id: created.id },
            data: { resolutionOwner: agent.id, version: { increment: 1 } },
          });
          await queueTelegramTx(tx, created.id, 'ASSIGNED');
          await tx.user.update({ where: { id: agent.id }, data: { enabled: false } });
          await deliverTelegram(fetcher, new Date(), store);
          assert.equal(sent.length, 3);
          await tx.user.update({ where: { id: agent.id }, data: { enabled: true, brandIds: [] } });
          await tx.ticket.update({
            where: { id: created.id },
            data: { version: { increment: 1 } },
          });
          await queueTelegramTx(tx, created.id, 'ASSIGNED');
          assert.equal(
            await tx.telegramNotification.count({
              where: { ticketId: created.id, userId: agent.id, status: 'QUEUED' },
            }),
            0,
          );
          // Explicit rate limits retry only after Telegram's delay; ambiguous successes never resend.
          await tx.user.update({ where: { id: agent.id }, data: { brandIds: [id] } });
          await queueTelegramTx(tx, created.id, 'ASSIGNED');
          let requests = 0;
          const now = new Date();
          const rateLimited = (async () => {
            requests++;
            return new Response(
              JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 60 } }),
              { status: 429 },
            );
          }) as typeof fetch;
          await deliverTelegram(rateLimited, now, store);
          await deliverTelegram(rateLimited, now, store);
          assert.equal(requests, 1);
          const ambiguous = (async () => {
            requests++;
            return new Response('{}', { status: 200 });
          }) as typeof fetch;
          await deliverTelegram(ambiguous, new Date(+now + 60000), store);
          await deliverTelegram(ambiguous, new Date(+now + 120000), store);
          assert.equal(requests, 2);
          assert.equal(
            await tx.telegramNotification.count({
              where: { ticketId: created.id, status: 'UNKNOWN' },
            }),
            1,
          );
          await tx.ticket.update({
            where: { id: created.id },
            data: { version: { increment: 1 } },
          });
          await queueTelegramTx(tx, created.id, 'ASSIGNED');
          await disconnectTelegramTx(tx, agent);
          await deliverTelegram(fetcher, new Date(), store);
          assert.equal(sent.length, 3);
          assert.equal((await telegramAccount(agent, tx)).linked, false);
          throw rollback;
        },
        { timeout: 15000 },
      ),
      (e) => e === rollback,
    );
    assert.equal(await db.brand.count({ where: { id } }), 0);
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await db.$disconnect();
  }
});
