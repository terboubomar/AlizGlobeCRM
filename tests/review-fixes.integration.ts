import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { db } from '../packages/db/client';
import { hashPassword } from '../apps/api/src/password';
import { createTicketTx } from '../apps/api/src/service';
import { demoSla } from '../apps/api/src/sla';

const base = (process.env.TEST_API_ORIGIN ?? 'http://127.0.0.1:4000') + '/api/';
test(
  'privacy, finance segregation, rejected resubmission and directory activation through actual API routes',
  { skip: process.env.LOCAL_PASSWORD_AUTH !== 'true' },
  async () => {
    assert.ok(process.env.TEST_API_ORIGIN, 'Run via the isolated test harness');
    const id = 'fix-' + randomUUID(),
      password = 'Synthetic-Fix-Verification-2026',
      passwordHash = await hashPassword(password);
    await db.brand.create({
      data: {
        id,
        name: 'Isolated verification',
        nameEn: '',
        logo: 'neutral.svg',
        color: '#b62e30',
        status: 'DRAFT',
      },
    });
    await db.branch.create({
      data: { id, brandId: id, name: 'Isolated branch', code: id, city: 'Test' },
    });
    const cookies: Record<string, string> = {};
    for (const [name, role, financeDuty] of [
      ['root', 'SUPER_ADMIN', 'NONE'],
      ['creator', 'AGENT', 'APPROVER'],
      ['approver', 'SHIFT_LEAD', 'APPROVER'],
      ['processor', 'AGENT', 'PROCESSOR'],
      ['verifier', 'AGENT', 'VERIFIER'],
      ['ceo', 'CEO', 'NONE'],
    ]) {
      const email = `${name}-${id}@example.invalid`;
      await db.user.create({
        data: {
          id: id + name,
          name,
          email,
          passwordHash,
          role,
          financeDuty,
          brandIds: [id],
          branchIds: [],
        },
      });
      const response = await fetch(base + 'login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      assert.equal(response.status, 201);
      cookies[name] = response.headers.get('set-cookie')!.split(';')[0];
    }
    async function post(who: string, path: string, body: unknown) {
      return fetch(base + path, {
        method: 'POST',
        headers: {
          Cookie: cookies[who],
          'Content-Type': 'application/json',
          'Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify(body),
      });
    }
    assert.equal(
      (await post('approver', `brands/${id}/status`, { active: true, expectedActive: false }))
        .status,
      403,
    );
    assert.equal(
      (await post('root', `branches/${id}/status`, { active: true, expectedActive: false })).status,
      409,
    );
    assert.equal(
      (await post('root', `brands/${id}/status`, { active: true, expectedActive: false })).status,
      201,
    );
    assert.equal(
      (await post('root', `branches/${id}/status`, { active: true, expectedActive: false })).status,
      201,
    );
    const response = await post('creator', 'tickets/phone', {
      brandId: id,
      branchId: id,
      category: 'SERVICE',
      priority: 'P2',
      description: 'Synthetic complaint with private customer evidence',
      externalOrder: id,
      platform: 'TEST',
    });
    assert.equal(response.status, 201);
    const complaint = await response.json();
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#cc3344' } })
      .png()
      .toBuffer();
    async function upload(who: string, path: string) {
      const form = new FormData();
      form.append('files', new Blob([png], { type: 'image/png' }), 'proof.png');
      return fetch(base + path, { method: 'POST', headers: { Cookie: cookies[who] }, body: form });
    }
    assert.equal((await upload('creator', `tickets/${complaint.id}/attachments`)).status, 201);
    const evidence = await db.attachment.findFirstOrThrow({ where: { ticketId: complaint.id } });
    assert.equal(
      (await fetch(base + 'attachments/' + evidence.id, { headers: { Cookie: cookies.ceo } }))
        .status,
      403,
    );
    assert.equal(
      (await fetch(base + 'attachments/' + evidence.id, { headers: { Cookie: cookies.creator } }))
        .status,
      200,
    );
    const request = await post('creator', 'refunds', {
      ticketId: complaint.id,
      kind: 'REFUND',
      reason: 'Original refund reason needing correction',
      amountMinor: 2500,
    });
    assert.equal(request.status, 201);
    const refund = await request.json();
    const action = async (who: string, step: string, body: Record<string, unknown> = {}) =>
      post(who, `refunds/${refund.id}/${step}`, {
        version: (await db.refund.findUniqueOrThrow({ where: { id: refund.id } })).version,
        note: 'Synthetic verification of ' + step,
        ...body,
      });
    assert.equal((await action('creator', 'review')).status, 403);
    assert.equal((await action('approver', 'review')).status, 201);
    assert.equal((await action('approver', 'reject')).status, 201);
    assert.equal(
      (
        await action('creator', 'resubmit', {
          reason: 'Corrected refund reason',
          amountMinor: 2000,
        })
      ).status,
      201,
    );
    assert.equal(await db.refund.count({ where: { ticketId: complaint.id, kind: 'REFUND' } }), 1);
    assert.equal(
      await db.refundEvent.count({ where: { refundId: refund.id, type: 'REFUND_RESUBMIT' } }),
      1,
    );
    assert.equal((await action('approver', 'review')).status, 201);
    assert.equal((await action('approver', 'approve')).status, 201);
    assert.equal((await upload('processor', `refunds/${refund.id}/evidence/images`)).status, 201);
    const proof = await db.attachment.findFirstOrThrow({ where: { refundId: refund.id } });
    assert.equal(
      (await action('approver', 'execute', { reference: 'TEST-REF', proofId: proof.id })).status,
      403,
    );
    assert.equal(
      (await action('processor', 'execute', { reference: 'TEST-REF', proofId: proof.id })).status,
      201,
    );
    assert.equal((await action('processor', 'verify')).status, 403);
    assert.equal((await action('verifier', 'verify')).status, 201);
    assert.equal((await action('processor', 'notify')).status, 201);
    assert.equal((await action('processor', 'complete')).status, 201);
    assert.equal((await action('creator', 'resubmit')).status, 409);
    assert.equal(
      (await post('root', `brands/${id}/status`, { active: false, expectedActive: true })).status,
      201,
    );
    assert.equal(
      (await post('root', `brands/${id}/status`, { active: false, expectedActive: true })).status,
      409,
    );
    await db.$disconnect();
  },
);
test('production intake persists approved SLA snapshots and timers atomically', async () => {
  const id = 'sla-' + randomUUID(),
    rollback = new Error('rollback SLA verification');
  const previous = {
    DEMO_MODE: process.env.DEMO_MODE,
    SLA_POLICY_APPROVED: process.env.SLA_POLICY_APPROVED,
  };
  process.env.DEMO_MODE = 'false';
  process.env.SLA_POLICY_APPROVED = 'true';
  const fields = {
    SLA_POLICY_VERSION: 'APPROVED-TEST',
    SLA_P1_FIRST_MINUTES: '3',
    SLA_P1_ACK_MINUTES: '4',
    SLA_P2_FIRST_MINUTES: '5',
    SLA_P2_ACK_MINUTES: '6',
    SLA_P2_REMEDY_MINUTES: '30',
    SLA_P3_FIRST_MINUTES: '15',
    SLA_P3_ACK_MINUTES: '30',
    SLA_P3_REMEDY_MINUTES: '240',
  };
  const old = Object.fromEntries(Object.keys(fields).map((k) => [k, process.env[k]]));
  Object.assign(process.env, fields);
  try {
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.brand.create({
          data: {
            id,
            name: 'Rollback SLA',
            nameEn: '',
            logo: 'neutral.svg',
            color: '#b62e30',
            status: 'ACTIVE',
          },
        });
        await tx.branch.create({
          data: { id, brandId: id, name: 'Rollback branch', code: id, city: 'Test', active: true },
        });
        const result = (await createTicketTx(
          tx,
          { id: 'agent', name: 'agent', role: 'AGENT', brandIds: [id], branchIds: [] },
          {
            brandId: id,
            branchId: id,
            category: 'SERVICE',
            priority: 'P2',
            description: 'Production SLA transaction verification',
          },
          randomUUID(),
        )) as { id: string };
        const saved = await tx.ticket.findUniqueOrThrow({
          where: { id: result.id },
          include: { timers: true },
        });
        assert.equal(saved.policyVersion, 'APPROVED-TEST');
        assert.equal(saved.demo, false);
        assert.equal(saved.timers.length, 2);
        assert.deepEqual(saved.slaPolicy, {
          ...demoSla,
          version: 'APPROVED-TEST',
          p1First: 3,
          p1Ack: 4,
          p2Ack: 6,
        });
        throw rollback;
      }),
      (e) => e === rollback,
    );
  } finally {
    for (const [k, v] of Object.entries({ ...old, ...previous })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await db.$disconnect();
  }
});
