import test from 'node:test';
import assert from 'node:assert/strict';
import { shiftInput } from '../apps/api/src/scheduling';
import {
  weekDays,
  riyadhDay,
  localISO,
  localInput,
  netHours,
  intersects,
} from '../apps/web/app/schedule-time';
test('Riyadh week and shift inputs are independent of device timezone', () => {
  assert.equal(riyadhDay('2026-10-24T22:30:00Z'), '2026-10-25');
  assert.deepEqual(weekDays(0, new Date('2026-10-24T22:30:00Z')).slice(0, 2), [
    '2026-10-25',
    '2026-10-26',
  ]);
  assert.equal(localISO('2026-10-21T09:00'), '2026-10-21T06:00:00.000Z');
  assert.equal(localInput('2026-10-21T06:00:00Z'), '2026-10-21T09:00');
});
test('overnight shifts appear on both days and clipped hours exclude breaks', () => {
  const s = {
    start: '2030-01-01T19:00:00Z',
    end: '2030-01-02T03:00:00Z',
    breakStart: '2030-01-01T23:00:00Z',
    breakEnd: '2030-01-01T23:30:00Z',
  };
  assert.equal(netHours([s], '2030-01-01T00:00:00Z', '2030-01-03T00:00:00Z'), 7.5);
  assert.equal(netHours([s], '2030-01-02T00:00:00Z', '2030-01-03T00:00:00Z'), 3);
  assert.equal(intersects(s.start, s.end, '2030-01-02T00:00:00Z', '2030-01-03T00:00:00Z'), true);
  assert.equal(shiftInput.safeParse({ ...s, userId: 'u' }).success, true);
  for (const change of [
    { end: s.start },
    { breakEnd: null },
    { breakStart: s.end },
    { end: '2030-01-03T00:00:00Z' },
  ])
    assert.equal(shiftInput.safeParse({ ...s, userId: 'u', ...change }).success, false);
});

test('day off requires a full Riyadh day without work details and contributes no hours', () => {
  const off = {
    userId: 'u',
    dayOff: true,
    start: '2030-01-01T21:00:00Z',
    end: '2030-01-02T21:00:00Z',
    breakStart: null,
    breakEnd: null,
  };
  assert.equal(shiftInput.safeParse(off).success, true);
  assert.equal(netHours([off], off.start, off.end), 0);
  for (const change of [
    { end: '2030-01-02T20:00:00Z' },
    { start: '2030-01-01T22:00:00Z', end: '2030-01-02T22:00:00Z' },
    { lead: true },
    { breakStart: '2030-01-02T10:00:00Z', breakEnd: '2030-01-02T11:00:00Z' },
  ])
    assert.equal(shiftInput.safeParse({ ...off, ...change }).success, false);
});

test('bulk scheduling expands selected employees and days with overnight breaks', async () => {
  const { bulkScheduleEntries } = await import('../apps/web/app/schedule-time');
  const entries = bulkScheduleEntries(['a', 'b', 'a'], ['2030-01-01', '2030-01-02'], {
    dayOff: false,
    start: '22:00',
    end: '06:00',
    breakStart: '01:00',
    breakEnd: '01:30',
    lead: false,
  });
  assert.equal(entries.length, 4);
  assert.equal(entries[0].start, '2030-01-01T19:00:00.000Z');
  assert.equal(entries[0].end, '2030-01-02T03:00:00.000Z');
  assert.equal(entries[0].breakStart, '2030-01-01T22:00:00.000Z');
  assert.ok(entries.every((e) => shiftInput.safeParse(e).success));
  const off = bulkScheduleEntries(['a'], ['2030-01-01'], {
    dayOff: true,
    start: '',
    end: '',
    lead: true,
  });
  assert.equal(off[0].lead, false);
  assert.equal(netHours(off, off[0].start, off[0].end), 0);
  assert.equal(shiftInput.safeParse(off[0]).success, true);
});
