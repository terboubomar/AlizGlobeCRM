import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { branchLocationFields, pairedCoordinates } from '../apps/api/src/branch-input';
const location = z.object(branchLocationFields).refine(pairedCoordinates);
test('branch locations accept optional details and clear empty values', () => {
  assert.deepEqual(location.parse({}), {});
  assert.deepEqual(
    location.parse({
      district: ' الملقا ',
      address: '',
      mapsUrl: '',
      latitude: '',
      longitude: '',
      phone: '',
    }),
    {
      district: 'الملقا',
      address: null,
      mapsUrl: null,
      latitude: null,
      longitude: null,
      phone: null,
    },
  );
  const saved = location.parse({
    mapsUrl: 'https://maps.google.com/place',
    latitude: '24.7136',
    longitude: '46.6753',
    phone: '+966 11 123 4567',
  });
  assert.equal(saved.latitude, 24.7136);
  assert.equal(saved.longitude, 46.6753);
});
test('branch locations reject unsafe links, invalid coordinates and incomplete pairs', () => {
  for (const value of [
    { mapsUrl: 'javascript:alert(1)' },
    { mapsUrl: 'http://maps.google.com' },
    { mapsUrl: 'https://user:password@example.com' },
    { latitude: '91', longitude: '46' },
    { latitude: '24', longitude: '-181' },
    { latitude: '24' },
    { longitude: '46' },
    { latitude: 'abc', longitude: '46' },
    { phone: 'not-a-number' },
  ])
    assert.equal(location.safeParse(value).success, false);
  assert.equal(location.safeParse({ latitude: '0', longitude: '0' }).success, true);
});
