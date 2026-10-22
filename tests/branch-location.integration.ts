import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../packages/db/client';
import { z } from 'zod';
import { branchLocationFields, pairedCoordinates } from '../apps/api/src/branch-input';
test('branch location fields persist, edit and clear without changing the brand link', async () => {
  const id = 'location-check-' + randomUUID();
  const rollback = new Error('rollback branch location check');
  try {
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.brand.create({
          data: {
            id,
            name: 'Location verification',
            nameEn: '',
            logo: 'neutral.svg',
            color: '#B62E30',
          },
        });
        const location = z.object(branchLocationFields).refine(pairedCoordinates).parse({
          district: 'الملقا',
          address: 'شارع تجريبي',
          mapsUrl: 'https://maps.google.com/?q=24.7136,46.6753',
          latitude: '24.7136',
          longitude: '46.6753',
          phone: '+966111234567',
        });
        const branch = await tx.branch.create({
          data: { brandId: id, code: id, name: 'Location check', city: 'الرياض', ...location },
        });
        const read = await tx.branch.findUniqueOrThrow({ where: { id: branch.id } });
        assert.equal(read.latitude, 24.7136);
        assert.equal(read.address, 'شارع تجريبي');
        const updated = await tx.branch.update({
          where: { id: branch.id },
          data: { district: 'العليا', mapsUrl: null, latitude: null, longitude: null },
        });
        assert.equal(updated.brandId, id);
        assert.equal(updated.district, 'العليا');
        assert.equal(updated.latitude, null);
        assert.equal(updated.mapsUrl, null);
        throw rollback;
      }),
      (e) => e === rollback,
    );
    assert.equal(await db.brand.count({ where: { id } }), 0);
  } finally {
    await db.$disconnect();
  }
});
