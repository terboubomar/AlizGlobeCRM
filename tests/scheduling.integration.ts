import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../packages/db/client';
import { saveShiftTx, saveBulkShiftsTx } from '../apps/api/src/scheduling';
import type { Actor } from '../packages/domain/src';
test('shared shifts enforce scope, ownership, breaks, leave and version conflicts', async () => {
  const id = 'schedule-check-' + randomUUID(),
    rollback = new Error('rollback schedule verification');
  const actor: Actor = {
    id,
    name: 'Scheduler',
    role: 'SUPER_ADMIN',
    brandIds: [id],
    branchIds: [],
  };
  try {
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.user.create({
          data: { id, name: 'Rollback staff', role: 'AGENT', brandIds: [id], branchIds: [] },
        });
        const input = {
          userId: id,
          start: '2030-01-01T19:00:00Z',
          end: '2030-01-02T03:00:00Z',
          breakStart: '2030-01-01T23:00:00Z',
          breakEnd: '2030-01-01T23:30:00Z',
        };
        const shift = await saveShiftTx(tx, actor, input);
        assert.equal(shift.brandId, null);
        await assert.rejects(saveShiftTx(tx, actor, input), { status: 409 });
        await assert.rejects(saveShiftTx(tx, { ...actor, role: 'AGENT' }, input), { status: 403 });
        await assert.rejects(saveShiftTx(tx, { ...actor, brandIds: ['outside'] }, input), {
          status: 400,
        });
        const changed = await saveShiftTx(
          tx,
          actor,
          { ...input, version: 0, lead: true },
          shift.id,
        );
        assert.equal(changed.version, 1);
        await assert.rejects(saveShiftTx(tx, actor, { ...input, version: 0 }, shift.id), {
          status: 409,
        });
        await tx.shift.update({ where: { id: shift.id }, data: { cancelledAt: new Date() } });
        const recreated = await saveShiftTx(tx, actor, input);
        assert.notEqual(recreated.id, shift.id);
        await tx.leave.create({
          data: {
            userId: id,
            start: new Date('2030-01-03T00:00:00Z'),
            end: new Date('2030-01-04T00:00:00Z'),
            status: 'APPROVED',
          },
        });
        await assert.rejects(
          saveShiftTx(tx, actor, {
            userId: id,
            start: '2030-01-03T05:00:00Z',
            end: '2030-01-03T13:00:00Z',
          }),
          { status: 409 },
        );
        const off = await saveShiftTx(tx, actor, {
          userId: id,
          dayOff: true,
          start: '2030-01-04T21:00:00Z',
          end: '2030-01-05T21:00:00Z',
        });
        assert.equal(off.dayOff, true);
        await assert.rejects(
          saveShiftTx(tx, actor, {
            userId: id,
            start: '2030-01-05T05:00:00Z',
            end: '2030-01-05T13:00:00Z',
          }),
          { status: 409 },
        );
        const converted = await saveShiftTx(
          tx,
          actor,
          { userId: id, version: 0, start: '2030-01-05T05:00:00Z', end: '2030-01-05T13:00:00Z' },
          off.id,
        );
        assert.equal(converted.dayOff, false);
        await assert.rejects(
          saveShiftTx(tx, actor, {
            userId: id,
            dayOff: true,
            start: '2030-01-04T21:00:00Z',
            end: '2030-01-05T21:00:00Z',
          }),
          { status: 409 },
        );
        const batch = {
          entries: [
            {
              userId: id,
              dayOff: true,
              start: '2030-01-10T21:00:00Z',
              end: '2030-01-11T21:00:00Z',
            },
            {
              userId: id,
              dayOff: true,
              start: '2030-01-11T21:00:00Z',
              end: '2030-01-12T21:00:00Z',
            },
          ],
        };
        const result = await saveBulkShiftsTx(tx, actor, batch);
        assert.equal(result.count, 2);
        await assert.rejects(saveBulkShiftsTx(tx, { ...actor, role: 'AGENT' }, batch), {
          status: 403,
        });
        const beforeBatch = await tx.shift.count({ where: { userId: id } });
        await tx.$executeRawUnsafe('SAVEPOINT bulk_conflict_check');
        await assert.rejects(
          saveBulkShiftsTx(tx, actor, {
            entries: [
              {
                userId: id,
                dayOff: true,
                start: '2030-01-09T21:00:00Z',
                end: '2030-01-10T21:00:00Z',
              },
              batch.entries[0],
            ],
          }),
          { status: 409 },
        );
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT bulk_conflict_check');
        assert.equal(await tx.shift.count({ where: { userId: id } }), beforeBatch);
        throw rollback;
      }),
      (e) => e === rollback,
    );
    assert.equal(await db.user.count({ where: { id } }), 0);
  } finally {
    await db.$disconnect();
  }
});
