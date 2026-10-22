import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScheduleWorkspace } from '../app/schedule-workspace';
import type { Data } from '../app/types';
const base = {
  me: { id: 'me', name: 'Me', role: 'AGENT' },
  users: [
    { id: 'me', name: 'My schedule', role: 'AGENT' },
    { id: 'other', name: 'Other staff', role: 'AGENT' },
  ],
  permissions: ['schedule.self'],
  shifts: [],
  leave: [],
} as unknown as Data;
test('agents see their own schedule and leave controls without management actions', () => {
  const html = renderToStaticMarkup(
    <ScheduleWorkspace data={base} mutate={async () => {}} busy={false} />,
  );
  assert.match(html, /جدولي/);
  assert.match(html, /My schedule/);
  assert.doesNotMatch(html, /Other staff/);
  assert.doesNotMatch(html, /إضافة وردية/);
  assert.match(html, /طلب إجازة لحسابي/);
});
test('managers schedule shared support staff without a brand input', () => {
  const html = renderToStaticMarkup(
    <ScheduleWorkspace
      data={{ ...base, permissions: ['schedule'] }}
      mutate={async () => {}}
      busy={false}
    />,
  );
  assert.match(html, /جميع العلامات/);
  assert.match(html, /إضافة وردية/);
  assert.match(html, /Other staff/);
  assert.match(html, /توقيت الرياض/);
  assert.doesNotMatch(html, /name="brandId"/);
});
