// Pure logic — no network, no D1 — so it can be unit tested with plain node.
// Two independent caps must both pass for a booking to be offered/accepted:
//   1. Covers cap: total party_size of active reservations already starting in that
//      exact slot must leave room for this party (per-service-period covers_cap).
//   2. Table cap: at least one active table with capacity >= party_size must be free
//      for the whole turn window (no overlapping reservation already on that table).
//
// Turn time depends on party size: a table is held for 90 minutes for parties of 4 or
// fewer and 120 minutes for parties of 5 or more. The next reservation on that table
// can't start until the previous one's window has ended.

export const SMALL_PARTY_MAX = 4;
export const TURN_MINUTES_SMALL = 90;   // parties of 1-4
export const TURN_MINUTES_LARGE = 120;  // parties of 5+

export function turnTimeForParty(partySize) {
  return partySize <= SMALL_PARTY_MAX ? TURN_MINUTES_SMALL : TURN_MINUTES_LARGE;
}

export function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export function minutesToTime(mins) {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const ACTIVE_STATUSES = new Set(['confirmed', 'seated']);

export function isBlackedOut(date, blackoutDates) {
  return blackoutDates.some((b) => b.date === date);
}

// Which service periods apply to this date (by weekday), sorted by start time.
export function periodsForDate(date, servicePeriods) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay(); // noon UTC avoids DST/tz edge cases
  return servicePeriods
    .filter((p) => p.active !== 0 && p.days_of_week.split(',').map(Number).includes(weekday))
    .sort((a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time));
}

// All bookable slot start times (HH:MM strings) for a date, across its service periods.
export function slotsForDate(date, servicePeriods) {
  const slots = [];
  for (const p of periodsForDate(date, servicePeriods)) {
    const start = timeToMinutes(p.start_time);
    const end = timeToMinutes(p.end_time);
    for (let t = start; t <= end; t += p.slot_interval_minutes) {
      slots.push({ time: minutesToTime(t), period: p });
    }
  }
  return slots;
}

function coversAlreadyBooked(date, time, reservations) {
  return reservations
    .filter((r) => r.date === date && r.time === time && ACTIVE_STATUSES.has(r.status))
    .reduce((sum, r) => sum + r.party_size, 0);
}

function windowsOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

// Is this specific table free for the whole turn window a party would need at date/time?
// `excludeReservationId` lets a reservation be re-checked against its own table/time.
export function isTableFree({ tableId, date, time, partySize, reservations, excludeReservationId = null }) {
  const reqStart = timeToMinutes(time);
  const reqEnd = reqStart + turnTimeForParty(partySize);
  return !reservations.some((r) => {
    if (r.table_id !== tableId || r.date !== date || !ACTIVE_STATUSES.has(r.status)) return false;
    if (excludeReservationId != null && Number(r.id) === Number(excludeReservationId)) return false;
    const rStart = timeToMinutes(r.time);
    const rEnd = rStart + turnTimeForParty(r.party_size);
    return windowsOverlap(reqStart, reqEnd, rStart, rEnd);
  });
}

// Smallest-fit free table for a party at a given date/time, or null.
export function findAvailableTable({ date, time, partySize, tables, reservations }) {
  const candidates = tables
    .filter((tb) => tb.active !== 0 && tb.capacity >= partySize)
    .sort((a, b) => a.capacity - b.capacity); // smallest table that fits, first

  for (const tb of candidates) {
    if (isTableFree({ tableId: tb.id, date, time, partySize, reservations })) return tb;
  }
  return null;
}

// Returns { time, available, reason? } for every slot in the applicable service period(s).
export function computeAvailability({ date, partySize, tables, servicePeriods, reservations, blackoutDates }) {
  if (isBlackedOut(date, blackoutDates)) {
    return { blackedOut: true, slots: [] };
  }

  const slots = slotsForDate(date, servicePeriods).map(({ time, period }) => {
    const covers = coversAlreadyBooked(date, time, reservations);
    if (covers + partySize > period.covers_cap) {
      return { time, available: false, reason: 'covers_cap' };
    }
    const table = findAvailableTable({ date, time, partySize, tables, reservations });
    if (!table) {
      return { time, available: false, reason: 'no_table' };
    }
    return { time, available: true };
  });

  return { blackedOut: false, slots };
}

// Re-validates + picks a table right before insert, to close the race window between
// a guest viewing availability and submitting the form. Same rules as computeAvailability
// for one specific slot.
export function checkAndAssignTable({ date, time, partySize, tables, servicePeriods, reservations, blackoutDates }) {
  if (isBlackedOut(date, blackoutDates)) {
    return { ok: false, reason: 'blackout' };
  }
  const period = periodsForDate(date, servicePeriods).find((p) => {
    const start = timeToMinutes(p.start_time);
    const end = timeToMinutes(p.end_time);
    const t = timeToMinutes(time);
    return t >= start && t <= end && (t - start) % p.slot_interval_minutes === 0;
  });
  if (!period) return { ok: false, reason: 'invalid_slot' };

  const covers = coversAlreadyBooked(date, time, reservations);
  if (covers + partySize > period.covers_cap) {
    return { ok: false, reason: 'covers_cap' };
  }
  const table = findAvailableTable({ date, time, partySize, tables, reservations });
  if (!table) return { ok: false, reason: 'no_table' };

  return { ok: true, table, turnTimeMinutes: turnTimeForParty(partySize) };
}
