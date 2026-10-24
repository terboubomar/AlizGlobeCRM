import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Prisma } from '@prisma/client';
import { db } from '../../../packages/db/client';
import { normalizePhone } from '../../../packages/domain/src';
import { decrypt, encrypt, phoneHash } from './crypto';

// Customer data requests (see / delete my data) and the retention sweep.
// Erasing keeps the anonymous case record (brand, branch, category, state,
// timestamps) for statistics and removes everything that identifies or
// describes the customer. Cases on legal hold, and cases whose refund is
// still in progress, are never erased. Staff timeline notes are kept because
// the Event table is append-only (see the migration's history triggers).

const FINISHED_REFUND = ['COMPLETED', 'REJECTED'];
const caseNumber = /^AG-(\d{4})-(\d{6})$/;

export type CaseRef = { phone?: string; caseNumber?: string };
export type EraseOutcome =
  | { id: string; number: string; result: 'erased' }
  | {
      id: string;
      number: string;
      result: 'skipped';
      reason: 'legal_hold' | 'refund_open' | 'already_erased';
    };

const number = (t: { sequence: number; createdAt: Date }) =>
  `AG-${t.createdAt.getUTCFullYear()}-${String(t.sequence).padStart(6, '0')}`;

/** Tickets matching a customer's phone number or one case number. */
export async function findCases(ref: CaseRef) {
  if (ref.caseNumber) {
    const m = caseNumber.exec(ref.caseNumber.trim().toUpperCase());
    if (!m) throw new Error('Case number must look like AG-2026-000123');
    const t = await db.ticket.findUnique({
      where: { sequence: Number(m[2]) },
      select: { id: true, sequence: true, createdAt: true },
    });
    return t && t.createdAt.getUTCFullYear() === Number(m[1]) ? [t] : [];
  }
  if (ref.phone) {
    const phone = normalizePhone(ref.phone);
    if (!/^9665\d{8}$/.test(phone)) throw new Error('Phone must be a Saudi mobile number');
    return db.ticket.findMany({
      where: { phoneHash: phoneHash(phone) },
      select: { id: true, sequence: true, createdAt: true },
      orderBy: { sequence: 'asc' },
    });
  }
  throw new Error('Give a phone number or a case number');
}

const plain = (value: string | null | undefined) => {
  if (!value) return null;
  try {
    return decrypt(value);
  } catch {
    return null;
  }
};
const json = (value: string | null | undefined) => {
  const text = plain(value);
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

/** Everything the customer gave us for these cases, readable, for a see-my-data request. */
export async function exportCases(ids: string[], actor: string) {
  const tickets = await db.ticket.findMany({
    where: { id: { in: ids } },
    orderBy: { sequence: 'asc' },
    include: {
      brand: { select: { name: true } },
      branch: { select: { name: true } },
      attachments: { select: { mime: true, size: true, createdAt: true, status: true } },
      events: { select: { type: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
    },
  });
  await db.audit.createMany({
    data: tickets.map((t) => ({ actor, action: 'PERSONAL_DATA_EXPORTED', entityId: t.id })),
  });
  return {
    generatedAt: new Date().toISOString(),
    cases: tickets.map((t) => ({
      number: number(t),
      brand: t.brand.name,
      branch: t.branch?.name ?? null,
      source: t.source,
      category: t.category,
      state: t.state,
      receivedAt: t.receivedAt.toISOString(),
      closedAt: t.closedAt?.toISOString() ?? null,
      erasedAt: t.erasedAt?.toISOString() ?? null,
      description: plain(t.description),
      customer: json(t.customer),
      externalOrder: t.externalOrder,
      platform: t.platform,
      photos: t.attachments.map((f) => ({
        type: f.mime,
        bytes: f.size,
        addedAt: f.createdAt.toISOString(),
        status: f.status,
      })),
      timeline: t.events.map((e) => ({ step: e.type, at: e.createdAt.toISOString() })),
    })),
  };
}

/** Removes a case's personal data inside a transaction. Returns the photo files to delete after commit. */
export async function eraseTicketTx(
  tx: Prisma.TransactionClient,
  id: string,
  actor: string,
  action: 'PERSONAL_DATA_ERASED' | 'RETENTION_ERASED',
): Promise<{ outcome: EraseOutcome; files: string[] }> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'erase:' + id}))`;
  const t = await tx.ticket.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      sequence: true,
      createdAt: true,
      legalHold: true,
      erasedAt: true,
      refunds: { select: { status: true } },
    },
  });
  const n = number(t);
  if (t.erasedAt)
    return { outcome: { id, number: n, result: 'skipped', reason: 'already_erased' }, files: [] };
  if (t.legalHold)
    return { outcome: { id, number: n, result: 'skipped', reason: 'legal_hold' }, files: [] };
  if (t.refunds.some((r) => !FINISHED_REFUND.includes(r.status)))
    return { outcome: { id, number: n, result: 'skipped', reason: 'refund_open' }, files: [] };

  const files = await tx.attachment.findMany({
    where: { ticketId: id, status: { not: 'ERASED' } },
    select: { key: true },
  });
  await tx.ticket.update({
    where: { id },
    data: {
      description: encrypt(''),
      customer: null,
      phoneHash: null,
      externalOrder: null,
      platform: null,
      receiptEncrypted: null,
      branchBrief: null,
      unknownReason: null,
      erasedAt: new Date(),
      version: { increment: 1 },
    },
  });
  // Timeline notes (Event) stay: that table is append-only by design. They are
  // staff-written, encrypted, and readable only with PII access.
  await tx.task.updateMany({ where: { ticketId: id }, data: { note: encrypt('') } });
  await tx.review.updateMany({ where: { ticketId: id }, data: { note: '' } });
  await tx.access.deleteMany({ where: { ticketId: id } });
  await tx.complaintConfirmation.updateMany({
    where: { ticketId: id },
    data: { payloadEncrypted: encrypt('{}'), recipientHash: 'ERASED', lastError: null },
  });
  await tx.attachment.updateMany({ where: { ticketId: id }, data: { status: 'ERASED' } });
  await tx.idempotency.deleteMany({ where: { response: { path: ['id'], equals: id } } });
  await tx.audit.create({ data: { actor, action, entityId: id } });
  return { outcome: { id, number: n, result: 'erased' }, files: files.map((f) => f.key) };
}

async function removeFiles(keys: string[]) {
  const dir = resolve(process.env.UPLOAD_DIR ?? '.data/uploads');
  for (const key of keys) {
    const path = resolve(dir, key);
    if (!path.startsWith(dir + '/')) continue;
    await unlink(path).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
}

/** Erase one case. Photo files are deleted only after the database change commits. */
export async function eraseCase(
  id: string,
  actor: string,
  action: 'PERSONAL_DATA_ERASED' | 'RETENTION_ERASED' = 'PERSONAL_DATA_ERASED',
) {
  const { outcome, files } = await db.$transaction((tx) => eraseTicketTx(tx, id, actor, action));
  await removeFiles(files);
  return outcome;
}

export async function setLegalHold(id: string, hold: boolean, actor: string) {
  await db.$transaction(async (tx) => {
    await tx.ticket.update({ where: { id }, data: { legalHold: hold } });
    await tx.audit.create({
      data: { actor, action: hold ? 'LEGAL_HOLD_SET' : 'LEGAL_HOLD_RELEASED', entityId: id },
    });
  });
}

/** Retention period from the environment, or null when retention is not switched on. */
export function retentionDays(env = process.env) {
  const raw = env.RETENTION_CLOSED_CASE_DAYS;
  if (!raw) return null;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 30)
    throw new Error('RETENTION_CLOSED_CASE_DAYS must be a whole number of days, at least 30');
  if (env.NODE_ENV === 'production' && env.RETENTION_POLICY_APPROVED !== 'true')
    throw new Error(
      'Set RETENTION_POLICY_APPROVED=true once Legal has approved the retention period',
    );
  return days;
}

/** Closed cases past the retention period that still hold personal data. */
export async function dueForRetention(days: number, now = new Date(), limit = 200) {
  return db.ticket.findMany({
    where: {
      state: 'CLOSED',
      closedAt: { lt: new Date(+now - days * 86400000) },
      erasedAt: null,
      legalHold: false,
    },
    select: { id: true },
    orderBy: { closedAt: 'asc' },
    take: limit,
  });
}

/** One retention pass. With dryRun it only reports what would be erased. */
export async function retentionSweep(days: number, { now = new Date(), dryRun = false } = {}) {
  const due = await dueForRetention(days, now);
  if (dryRun) return { due: due.length, erased: 0, skipped: 0 };
  let erased = 0,
    skipped = 0;
  for (const { id } of due) {
    const outcome = await eraseCase(id, 'RETENTION', 'RETENTION_ERASED');
    if (outcome.result === 'erased') erased++;
    else skipped++;
  }
  return { due: due.length, erased, skipped };
}
