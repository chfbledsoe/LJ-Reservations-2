import assert from 'node:assert/strict';
import {
  computeAvailability, checkAndAssignTable, slotsForDate, findAvailableTable,
} from './availability.js';

const servicePeriods = [
  { id: 1, name: 'Dinner', days_of_week: '0,1,2,3,4,5,6', start_time: '17:00', end_time: '19:00',
    slot_interval_minutes: 30, turn_time_minutes: 90, covers_cap: 10, active: 1 },
];
const tables = [
  { id: 1, name: 'T1', capacity: 2, active: 1 },
  { id: 2, name: 'T2', capacity: 4, active: 1 },
];
const date = '2026-09-20'; // a Sunday

// 1. Empty book: every slot open, correct slot count (17:00..19:00 every 30m = 5 slots)
{
  const { slots } = computeAvailability({ date, partySize: 2, tables, servicePeriods, reservations: [], blackoutDates: [] });
  assert.equal(slots.length, 5);
  assert.ok(slots.every((s) => s.available));
}

// 2. Table cap: party of 4 at 17:00 occupies the only 4-top for its 90-min turn.
//    A second party of 4 at 17:00 or 17:30 (overlapping window) should find no table.
{
  const reservations = [
    { id: 1, date, time: '17:00', party_size: 4, table_id: 2, status: 'confirmed', turn_time_minutes: 90 },
  ];
  const t1 = findAvailableTable({ date, time: '17:00', partySize: 4, turnTimeMinutes: 90, tables, reservations });
  assert.equal(t1, null, 'second 4-top request at same time should fail — only one 4-top exists');

  const t2 = findAvailableTable({ date, time: '18:30', partySize: 4, turnTimeMinutes: 90, tables, reservations });
  assert.ok(t2, '18:30 is after the 17:00 party turns (17:00+90=18:30), table should free up');
}

// 3. Covers cap: cap is 10. Three parties of 4 at the same slot (12 covers) should reject the third.
{
  let reservations = [];
  const r1 = checkAndAssignTable({ date, time: '17:00', partySize: 4, tables: [...tables, { id: 3, name: 'T3', capacity: 4, active: 1 }, { id: 4, name: 'T4', capacity: 4, active: 1 }], servicePeriods, reservations, blackoutDates: [] });
  assert.ok(r1.ok);
  reservations.push({ id: 1, date, time: '17:00', party_size: 4, table_id: r1.table.id, status: 'confirmed', turn_time_minutes: 90 });

  const tablesWide = [...tables, { id: 3, name: 'T3', capacity: 4, active: 1 }, { id: 4, name: 'T4', capacity: 4, active: 1 }];
  const r2 = checkAndAssignTable({ date, time: '17:00', partySize: 4, tables: tablesWide, servicePeriods, reservations, blackoutDates: [] });
  assert.ok(r2.ok);
  reservations.push({ id: 2, date, time: '17:00', party_size: 4, table_id: r2.table.id, status: 'confirmed', turn_time_minutes: 90 });

  // covers now at 8, cap is 10 — a third party of 4 would push to 12 > 10 → reject on covers_cap
  const r3 = checkAndAssignTable({ date, time: '17:00', partySize: 4, tables: tablesWide, servicePeriods, reservations, blackoutDates: [] });
  assert.equal(r3.ok, false);
  assert.equal(r3.reason, 'covers_cap');
}

// 4. Blackout date blocks everything regardless of capacity.
{
  const { blackedOut, slots } = computeAvailability({
    date, partySize: 2, tables, servicePeriods, reservations: [], blackoutDates: [{ date, reason: 'Private buyout' }],
  });
  assert.equal(blackedOut, true);
  assert.equal(slots.length, 0);
}

// 5. Cancelled/completed reservations don't hold a table or count toward covers.
{
  const reservations = [
    { id: 1, date, time: '17:00', party_size: 4, table_id: 2, status: 'cancelled', turn_time_minutes: 90 },
  ];
  const t = findAvailableTable({ date, time: '17:00', partySize: 4, turnTimeMinutes: 90, tables, reservations });
  assert.ok(t, 'a cancelled reservation must not block the table');
}

console.log('All availability tests passed.');
