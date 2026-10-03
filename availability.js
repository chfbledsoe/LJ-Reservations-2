// Pure logic — no network, no D1 — so it can be unit tested with plain node.
// Two independent caps must both pass for a booking to be offered/accepted:
//   1. Covers cap: total party_size of active reservations already starting in that
//      exact slot must leave room for this party (per-service-period covers_cap).
//   2. Table cap: at least one active table with capacity >= party_size must be free
//      for the whole [time, time + turn_time_minutes) window (no overlapping reservation
//      already seated at that table).

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

// Smallest-fit free table for a party at a given date/time, or null.
export function findAvailableTable({ date, time, partySize, turnTimeMinutes, tables, reservations }) {
  const reqStart = timeToMinutes(time);
  const reqEnd = reqStart + turnTimeMinutes;

  const candidates = tables
    .filter((tb) => tb.active !== 0 && tb.capacity >= partySize)
    .sort((a, b) => a.capacity - b.capacity); // smallest table that fits, first

  for (const tb of candidates) {
    const occupied = reservations.some((r) => {
      if (r.table_id !== tb.id || r.date !== date || !ACTIVE_STATUSES.has(r.status)) return false;
      const rStart = timeToMinutes(r.time);
      const rEnd = rStart + (r.turn_time_minutes || turnTimeMinutes);
      return windowsOverlap(reqStart, reqEnd, rStart, rEnd);
    });
    if (!occupied) return tb;
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
    const table = findAvailableTable({
      date, time, partySize, turnTimeMinutes: period.turn_time_minutes, tables, reservations,
    });
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
  const table = findAvailableTable({
    date, time, partySize, turnTimeMinutes: period.turn_time_minutes, tables, reservations,
  });
  if (!table) return { ok: false, reason: 'no_table' };

  return { ok: true, table, turnTimeMinutes: period.turn_time_minutes };
}
