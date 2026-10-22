import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../packages/db/client';
import { qrCreate, qrLink, qrAction, publicQr } from '../apps/api/src/service';
import { decrypt, hash } from '../apps/api/src/crypto';
import type { Actor } from '../packages/domain/src';
test('QR links reopen, stay scoped, and replace atomically without creating cases', async () => {
  const id = 'qr-test-' + randomUUID();
  const actor: Actor = {
    id,
    name: 'QR integration',
    role: 'SUPER_ADMIN',
    brandIds: [id],
    branchIds: [],
  };
  const admin: Actor = { ...actor, role: 'ADMIN', brandIds: [] };
  const before = { tickets: await db.ticket.count(), refunds: await db.refund.count() };
  await db.brand.create({
    data: {
      id,
      name: 'QR synthetic verification',
      nameEn: 'QR verification',
      logo: 'neutral.svg',
      color: '#aa2222',
    },
  });
  const branch = await db.branch.create({
    data: {
      brandId: id,
      name: 'Temporary QR verification',
      code: id,
      city: 'Local test',
      active: true,
    },
  });
  try {
    const created = await qrCreate(actor, { branchId: branch.id, placement: '  Front counter  ' });
    const code = new URL(created.url).pathname.split('/').pop()!;
    const stored = await db.qr.findUniqueOrThrow({ where: { id: created.id } });
    assert.notEqual(stored.codeEncrypted, code);
    assert.equal(decrypt(stored.codeEncrypted!), code);
    assert.equal(stored.hash, hash(code));
    assert.equal(stored.placement, 'استلام الطلبات');
    const reused = await Promise.all([
      qrCreate(actor, { branchId: branch.id }),
      qrCreate(actor, { branchId: branch.id, placement: 'Table' }),
    ]);
    assert.ok(reused.every((q) => q.id === created.id && q.url === created.url));
    assert.equal(await db.qr.count({ where: { branchId: branch.id, active: true } }), 1);
    await assert.rejects(
      db.qr.create({
        data: { branchId: branch.id, placement: 'Duplicate', hash: hash(randomUUID()) },
      }),
    );
    assert.equal((await qrLink(actor, created.id)).url, created.url);
    assert.equal((await publicQr(code)).branchId, branch.id);
    await assert.rejects(qrLink(admin, created.id), { status: 404 });
    await assert.rejects(qrAction({ ...actor, role: 'AGENT' }, created.id, 'rotate'), {
      status: 403,
    });
    const results = await Promise.allSettled([
      qrAction(actor, created.id, 'rotate'),
      qrAction(actor, created.id, 'rotate'),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await db.qr.count({ where: { branchId: branch.id, active: true } }), 1);
    await assert.rejects(publicQr(code));
    const rotated = results.find((r) => r.status === 'fulfilled')!;
    assert.equal(rotated.status, 'fulfilled');
    if (rotated.status !== 'fulfilled' || !('url' in rotated.value))
      throw new Error('No replacement URL');
    const next = rotated.value;
    if (!next.id || !next.url) throw new Error('Missing replacement code');
    assert.equal((await qrLink(actor, next.id)).url, next.url);
    await db.branch.update({ where: { id: branch.id }, data: { active: false } });
    await assert.rejects(qrLink(actor, next.id), { status: 409 });
    await assert.rejects(qrAction(actor, next.id, 'rotate'), { status: 409 });
    assert.equal((await db.qr.findUniqueOrThrow({ where: { id: next.id } })).active, true);
    await db.branch.update({ where: { id: branch.id }, data: { active: true } });
    await qrAction(actor, next.id, 'revoke');
    await assert.rejects(qrLink(actor, next.id), { status: 409 });
    await assert.rejects(publicQr(new URL(next.url).pathname.split('/').pop()!));
    const legacy = await db.qr.create({
      data: { branchId: branch.id, placement: 'Legacy', hash: hash(randomUUID()) },
    });
    await assert.rejects(qrLink(actor, legacy.id), { status: 409 });
    await assert.rejects(qrCreate(actor, { branchId: branch.id }), { status: 409 });
    assert.deepEqual(
      { tickets: await db.ticket.count(), refunds: await db.refund.count() },
      before,
    );
  } finally {
    await db.qr.deleteMany({ where: { branchId: branch.id } });
    await db.branch.delete({ where: { id: branch.id } });
    await db.brand.delete({ where: { id } });
    await db.$disconnect();
  }
});
