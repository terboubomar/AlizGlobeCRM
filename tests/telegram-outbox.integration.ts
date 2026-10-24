import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../packages/db/client';
import { encrypt, hash } from '../apps/api/src/crypto';
import { deliverTelegram, routeOutboxTx } from '../apps/api/src/telegram';

// Deadline and urgent-case events in the outbox reach the right people through
// Telegram. Rollback-only, synthetic data.
test('outbox alerts route to the owner and in-scope supervisors, once, and never for closed or stale cases', async () => {
  const env = {
    TELEGRAM_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: '123456:synthetic-never-sent-token',
    TELEGRAM_BOT_USERNAME: 'aliz_test_bot',
    TELEGRAM_WEBHOOK_SECRET: 'synthetic-secret-at-least-32-characters',
    APP_ORIGIN: 'https://crm.example.test',
  };
  const previous = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const id = 'tg-outbox-' + randomUUID(),
    other = id + '-other',
    rollback = new Error('Rollback outbox test'),
    now = new Date();
  try {
    await assert.rejects(
      db.$transaction(
        async (tx) => {
          for (const brand of [id, other])
            await tx.brand.create({
              data: { id: brand, name: brand, nameEn: '', logo: 'neutral.svg', color: '#b93645' },
            });
          await tx.branch.create({
            data: { id, brandId: id, name: 'Outbox branch', code: id, city: 'Test', active: true },
          });
          const users = {
            agent: { role: 'AGENT', brandIds: [id] },
            lead: { role: 'SHIFT_LEAD', brandIds: [id] },
            otherLead: { role: 'SHIFT_LEAD', brandIds: [other] },
            branchManager: { role: 'BRANCH_MANAGER', brandIds: [id] },
            superadmin: { role: 'SUPER_ADMIN', brandIds: [] },
            unlinkedLead: { role: 'SHIFT_LEAD', brandIds: [id] },
          };
          let chat = 20000000;
          for (const [name, u] of Object.entries(users)) {
            await tx.user.create({
              data: { id: `${id}-${name}`, name, ...u, branchIds: [] },
            });
            if (name === 'unlinkedLead') continue;
            const chatId = String(++chat);
            await tx.telegramConnection.create({
              data: {
                userId: `${id}-${name}`,
                accountEncrypted: encrypt(JSON.stringify({ chatId, label: '@' + name })),
                chatHash: hash(chatId),
                linkedAt: now,
              },
            });
          }
          const base = {
            brandId: id,
            branchId: id,
            source: 'PHONE_AGENT',
            category: 'SAFETY',
            priority: 'P1',
            description: 'Synthetic rollback-only details',
            creator: `${id}-agent`,
            communicationsOwner: `${id}-agent`,
          };
          const assigned = await tx.ticket.create({
            data: { ...base, state: 'ASSIGNED', resolutionOwner: `${id}-agent` },
          });
          const unassigned = await tx.ticket.create({ data: { ...base, state: 'NEW' } });
          const closed = await tx.ticket.create({
            data: { ...base, state: 'CLOSED', closedAt: now, resolutionOwner: `${id}-agent` },
          });
          const event = (type: string, ticketId: string, createdAt = now) =>
            tx.outbox.create({
              data: {
                key: `${type}:${ticketId}:${randomUUID()}`,
                type,
                ticketId,
                brandId: id,
                branchId: id,
                createdAt,
              },
            });
          const rows = {
            warnAssigned: await event('SLA_WARNING', assigned.id),
            warnUnassigned: await event('SLA_WARNING', unassigned.id),
            breached: await event('SLA_BREACHED', assigned.id),
            safety: await event('SAFETY_INTAKE', unassigned.id),
            breachedClosed: await event('SLA_BREACHED', closed.id),
            stale: await event('SLA_WARNING', assigned.id, new Date(+now - 2 * 86400000)),
            newTicket: await event('NEW_TICKET', unassigned.id),
          };

          // Not configured: nothing is routed and the events stay pending.
          process.env.TELEGRAM_ENABLED = 'false';
          assert.deepEqual(await routeOutboxTx(tx, now), { routed: 0, queued: 0 });
          assert.equal(await tx.outbox.count({ where: { brandId: id, deliveredAt: null } }), 7);
          process.env.TELEGRAM_ENABLED = 'true';

          await routeOutboxTx(tx, now);
          const recipients = async (rowId: string) =>
            (
              await tx.telegramNotification.findMany({
                where: { key: { contains: rowId } },
                select: { userId: true },
              })
            )
              .map((n) => n.userId.replace(id + '-', ''))
              .sort();
          assert.deepEqual(await recipients(rows.warnAssigned.id), ['agent']);
          assert.deepEqual(await recipients(rows.warnUnassigned.id), ['lead']);
          assert.deepEqual(await recipients(rows.breached.id), ['agent', 'lead']);
          // Superadmins already get every new complaint; supervisors get the urgent alert.
          assert.deepEqual(await recipients(rows.safety.id), ['lead']);
          assert.deepEqual(await recipients(rows.breachedClosed.id), []);
          assert.deepEqual(await recipients(rows.stale.id), []);
          assert.deepEqual(await recipients(rows.newTicket.id), []);
          assert.equal(await tx.outbox.count({ where: { brandId: id, deliveredAt: null } }), 0);

          // Each event is routed once.
          const before = await tx.telegramNotification.count({
            where: { ticket: { brandId: id } },
          });
          await routeOutboxTx(tx, now);
          assert.equal(
            await tx.telegramNotification.count({ where: { ticket: { brandId: id } } }),
            before,
          );

          // Delivery sends the deadline title and re-checks eligibility: closing the
          // case before delivery cancels its queued alerts.
          await tx.ticket.update({
            where: { id: unassigned.id },
            data: { state: 'CLOSED', closedAt: now },
          });
          const sent: { chat_id: string; text: string }[] = [];
          let messageId = 1;
          const fetcher = (async (_url: string, init?: { body?: string }) => {
            sent.push(JSON.parse(init!.body!));
            return new Response(JSON.stringify({ ok: true, result: { message_id: messageId++ } }), {
              status: 200,
            });
          }) as unknown as typeof fetch;
          for (let i = 0; i < 3; i++) await deliverTelegram(fetcher, new Date(+now + 1000), tx);
          const titles = sent.map((m) => m.text.split('\n')[0]).sort();
          assert.deepEqual(titles, [
            'تنبيه: شكوى تقترب من تجاوز المهلة',
            'شكوى تجاوزت المهلة وتحتاج إلى متابعة',
            'شكوى تجاوزت المهلة وتحتاج إلى متابعة',
          ]);
          for (const m of sent) assert.ok(!m.text.includes('Synthetic rollback-only details'));
          assert.equal(
            await tx.telegramNotification.count({
              where: { ticketId: unassigned.id, status: 'CANCELLED' },
            }),
            2,
          );
          throw rollback;
        },
        { timeout: 30000 },
      ),
      rollback,
    );
  } finally {
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});
