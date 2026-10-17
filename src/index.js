import {
  computeAvailability, checkAndAssignTable, isTableFree, findAvailableTable,
  periodsForDate, isBlackedOut, timeToMinutes, turnTimeForParty,
} from './availability.js';
import {
  getTables, getServicePeriods, getBlackoutDates, getReservationsForDate,
  insertReservation, getReservation, updateReservationStatus, cancelReservation,
  insertTable, updateTable, updateReservationTable,
  getAllServicePeriods, insertServicePeriod, updateServicePeriod,
  insertBlackoutDate, deleteBlackoutDate, updateReservationDetails,
  getWaitlist, getWaitlistEntry, insertWaitlist, updateWaitlist,
} from './db.js';
import { upsertSquareCustomer, createSquareOrder } from './square.js';

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

function requireBasicAuth(request, env) {
  // Fail closed if the secrets haven't been set — never fall back to a guessable default.
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
    return new Response(
      'Admin access is not configured — set ADMIN_USERNAME and ADMIN_PASSWORD with `wrangler secret put`.',
      { status: 500 },
    );
  }
  const auth = request.headers.get('Authorization') || '';
  const expected = 'Basic ' + btoa(`${env.ADMIN_USERNAME}:${env.ADMIN_PASSWORD}`);
  if (auth !== expected) {
    return new Response('Authentication required', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Reservations admin"' },
    });
  }
  return null; // authorized
}

async function loadContext(env) {
  const [tables, servicePeriods, blackoutDates] = await Promise.all([
    getTables(env), getServicePeriods(env), getBlackoutDates(env),
  ]);
  return { tables, servicePeriods, blackoutDates };
}

async function handleAvailability(request, env) {
  const url = new URL(request.url);
  const date = url.searchParams.get('date');
  const partySize = Number(url.searchParams.get('party_size'));
  if (!date || !partySize || partySize < 1) {
    return json({ error: 'date and party_size are required' }, { status: 400 });
  }

  const { tables, servicePeriods, blackoutDates } = await loadContext(env);
  const reservations = await getReservationsForDate(env, date);
  const result = computeAvailability({ date, partySize, tables, servicePeriods, reservations, blackoutDates });
  return json(result);
}

async function handleCreateReservation(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'invalid JSON body' }, { status: 400 });

  const { date, time, party_size: partySize, guest_name: guestName, phone, email, notes } = body;
  if (!date || !time || !partySize || !guestName || (!phone && !email)) {
    return json({ error: 'date, time, party_size, guest_name, and phone or email are required' }, { status: 400 });
  }

  const { tables, servicePeriods, blackoutDates } = await loadContext(env);
  const reservations = await getReservationsForDate(env, date);

  const check = checkAndAssignTable({ date, time, partySize, tables, servicePeriods, reservations, blackoutDates });
  if (!check.ok) {
    return json({ error: 'That time is no longer available', reason: check.reason }, { status: 409 });
  }

  // Square customer upsert — best-effort. A Square outage should never block a booking.
  let squareCustomerId = null;
  try {
    squareCustomerId = await upsertSquareCustomer(env, {
      name: guestName, phone, email, note: notes,
    });
  } catch (err) {
    console.error('Square customer upsert failed:', err.message);
  }

  const id = await insertReservation(env, {
    date, time, partySize, guestName, phone, email, notes,
    tableId: check.table.id, turnTimeMinutes: check.turnTimeMinutes, squareCustomerId,
  });

  return json({
    id, date, time, party_size: partySize, table: check.table.name, status: 'confirmed',
  }, { status: 201 });
}

async function handleListReservations(request, env) {
  const url = new URL(request.url);
  const date = url.searchParams.get('date');
  if (!date) return json({ error: 'date is required' }, { status: 400 });
  const reservations = await getReservationsForDate(env, date);
  const tables = await getTables(env);
  const byId = Object.fromEntries(tables.map((t) => [t.id, t.name]));
  const enriched = reservations
    .map((r) => ({ ...r, table_name: byId[r.table_id] || null }))
    .sort((a, b) => a.time.localeCompare(b.time));
  return json({ reservations: enriched });
}

async function handleUpdateReservation(request, env, id) {
  const body = await request.json().catch(() => null);
  const EDIT_KEYS = ['date', 'time', 'party_size', 'guest_name', 'phone', 'email', 'notes'];
  const hasEdit = body && EDIT_KEYS.some((k) => body[k] !== undefined);
  if (!body || (!body.status && body.table_id === undefined && !hasEdit)) {
    return json({ error: 'status, table_id, or reservation details are required' }, { status: 400 });
  }

  const existing = await getReservation(env, id);
  if (!existing) return json({ error: 'not found' }, { status: 404 });

  // Editing details (move the time/date, change party size, fix contact info).
  if (hasEdit) {
    const editResult = await applyReservationEdit(env, existing, body);
    if (editResult.error) return json(editResult.error, { status: editResult.status });
    if (!body.status && body.table_id === undefined) {
      const updated = await getReservation(env, id);
      return json({ ...updated });
    }
    Object.assign(existing, editResult.applied); // later checks use the edited values
  }

  // Reassigning to a different table (floor plan drag or the Table dropdown). The same
  // hold rule as online booking applies: a table can't take another reservation until the
  // previous one's window has passed (90 min for parties of 4 or fewer, 120 for 5+).
  if (body.table_id !== undefined) {
    const tables = await getTables(env);
    const table = tables.find((t) => t.id === body.table_id);
    if (!table) return json({ error: 'table_id does not match an active table' }, { status: 400 });
    const sameDay = await getReservationsForDate(env, existing.date);
    const free = isTableFree({
      tableId: body.table_id, date: existing.date, time: existing.time,
      partySize: existing.party_size, reservations: sameDay, excludeReservationId: id,
    });
    if (!free) {
      return json({
        error: `${table.name} is already held by another reservation during that time`,
        reason: 'table_conflict',
      }, { status: 409 });
    }
    await updateReservationTable(env, id, body.table_id);
  }

  if (!body.status) {
    const updated = await getReservation(env, id);
    return json({ id, table_id: updated.table_id });
  }

  const allowed = ['confirmed', 'seated', 'completed', 'cancelled', 'no_show'];
  if (!allowed.includes(body.status)) {
    return json({ error: `status must be one of ${allowed.join(', ')}` }, { status: 400 });
  }

  if (body.status === 'cancelled') {
    await cancelReservation(env, id);
    return json({ id, status: 'cancelled' });
  }

  let squareOrderId;
  if (body.status === 'seated') {
    const reservation = await getReservation(env, id);
    try {
      squareOrderId = await createSquareOrder(env, {
        referenceId: id,
        note: `${reservation.guest_name} — party of ${reservation.party_size}`,
      });
    } catch (err) {
      console.error('Square order creation failed:', err.message);
      // Still mark the party seated — front of house shouldn't stall on a POS hiccup.
    }
  }

  await updateReservationStatus(env, id, body.status, { squareOrderId });
  return json({ id, status: body.status, square_order_id: squareOrderId || null });
}


// Staff edit of an existing reservation. Re-validates the slot, the covers cap and the
// table hold (ignoring the reservation itself). Keeps the current table when it still
// works; otherwise moves the party to another free table; otherwise refuses with 409.
async function applyReservationEdit(env, existing, body) {
  const date = body.date !== undefined ? String(body.date) : existing.date;
  const time = body.time !== undefined ? String(body.time) : existing.time;
  const partySize = body.party_size !== undefined ? Number(body.party_size) : existing.party_size;
  const guestName = body.guest_name !== undefined ? String(body.guest_name).trim() : existing.guest_name;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { status: 400, error: { error: 'date must be YYYY-MM-DD' } };
  if (!/^\d{2}:\d{2}$/.test(time)) return { status: 400, error: { error: 'time must be HH:MM' } };
  if (!Number.isInteger(partySize) || partySize < 1) {
    return { status: 400, error: { error: 'party_size must be a positive whole number' } };
  }
  if (!guestName) return { status: 400, error: { error: 'guest_name cannot be empty' } };

  const timingChanged = date !== existing.date || time !== existing.time || partySize !== existing.party_size;
  const fields = { guest_name: guestName };
  for (const k of ['phone', 'email', 'notes']) {
    if (body[k] !== undefined) fields[k] = body[k] || null;
  }

  if (timingChanged) {
    const { tables, servicePeriods, blackoutDates } = await loadContext(env);
    if (isBlackedOut(date, blackoutDates)) {
      return { status: 409, error: { error: 'That date is closed', reason: 'blackout' } };
    }
    const period = periodsForDate(date, servicePeriods).find((p) => {
      const t = timeToMinutes(time);
      return t >= timeToMinutes(p.start_time) && t <= timeToMinutes(p.end_time)
        && (t - timeToMinutes(p.start_time)) % p.slot_interval_minutes === 0;
    });
    const slotMoved = date !== existing.date || time !== existing.time;
    if (!period && slotMoved) {
      return { status: 409, error: { error: 'That time is not a bookable slot for that day', reason: 'invalid_slot' } };
    }
    const sameDay = (await getReservationsForDate(env, date)).filter((r) => Number(r.id) !== Number(existing.id));
    const coversThere = sameDay
      .filter((r) => r.time === time && ['confirmed', 'seated'].includes(r.status))
      .reduce((n, r) => n + r.party_size, 0);
    if (period && coversThere + partySize > period.covers_cap) {
      return { status: 409, error: { error: 'That time is full (covers limit reached)', reason: 'covers_cap' } };
    }

    // Keep current table if it still fits and is free; else find another.
    const current = tables.find((t) => t.id === existing.table_id);
    let table = null;
    if (current && current.capacity >= partySize
      && isTableFree({ tableId: current.id, date, time, partySize, reservations: sameDay })) {
      table = current;
    } else {
      table = findAvailableTable({ date, time, partySize, tables, reservations: sameDay });
    }
    if (!table) {
      return { status: 409, error: { error: 'No table is free for that time and party size', reason: 'no_table' } };
    }
    Object.assign(fields, {
      date, time, party_size: partySize, table_id: table.id, turn_time_minutes: turnTimeForParty(partySize),
    });
  }

  await updateReservationDetails(env, existing.id, fields);
  return { applied: fields };
}

// Seat a party right now without a prior reservation (walk-in). Staff override: ignores the
// per-slot covers cap and slot grid, but still needs a genuinely free table.
async function seatWalkIn(env, { date, time, partySize, guestName, phone, email, notes, tableId }) {
  const tables = await getTables(env);
  const sameDay = await getReservationsForDate(env, date);
  let table = null;
  if (tableId) {
    const t = tables.find((x) => x.id === Number(tableId));
    if (!t) return { status: 400, error: { error: 'table_id does not match an active table' } };
    if (t.capacity < partySize) {
      return { status: 409, error: { error: `${t.name} only seats ${t.capacity}`, reason: 'too_small' } };
    }
    if (!isTableFree({ tableId: t.id, date, time, partySize, reservations: sameDay })) {
      return { status: 409, error: { error: `${t.name} is held by another reservation`, reason: 'table_conflict' } };
    }
    table = t;
  } else {
    table = findAvailableTable({ date, time, partySize, tables, reservations: sameDay });
  }
  if (!table) {
    return { status: 409, error: { error: 'No table is free right now for that party size', reason: 'no_table' } };
  }

  const id = await insertReservation(env, {
    date, time, partySize, guestName, phone, email, notes,
    tableId: table.id, turnTimeMinutes: turnTimeForParty(partySize), status: 'seated',
  });
  let squareOrderId;
  try {
    squareOrderId = await createSquareOrder(env, {
      referenceId: id, note: `${guestName} — party of ${partySize} (walk-in)`,
    });
    if (squareOrderId) await updateReservationStatus(env, id, 'seated', { squareOrderId });
  } catch (err) {
    console.error('Square order creation failed:', err.message);
  }
  return { id, table };
}

function validDate(d) { return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d); }
function validTime(t) { return typeof t === 'string' && /^\d{2}:\d{2}$/.test(t); }

async function handleWalkIn(request, env) {
  const body = await request.json().catch(() => null);
  const guestName = String(body?.guest_name || '').trim();
  const partySize = Number(body?.party_size);
  if (!guestName || !Number.isInteger(partySize) || partySize < 1) {
    return json({ error: 'guest_name and a positive party_size are required' }, { status: 400 });
  }
  if (!validDate(body.date) || !validTime(body.time)) {
    return json({ error: 'date (YYYY-MM-DD) and time (HH:MM) are required' }, { status: 400 });
  }
  const r = await seatWalkIn(env, {
    date: body.date, time: body.time, partySize, guestName,
    phone: body.phone, email: body.email, notes: body.notes, tableId: body.table_id,
  });
  if (r.error) return json(r.error, { status: r.status });
  return json({ id: r.id, table: r.table.name, table_id: r.table.id, status: 'seated' }, { status: 201 });
}

async function handleListWaitlist(request, env) {
  const date = new URL(request.url).searchParams.get('date');
  if (!validDate(date)) return json({ error: 'date is required' }, { status: 400 });
  return json({ waitlist: await getWaitlist(env, date) });
}

async function handleCreateWaitlist(request, env) {
  const body = await request.json().catch(() => null);
  const guestName = String(body?.guest_name || '').trim();
  const partySize = Number(body?.party_size || 2);
  if (!guestName || !validDate(body?.date) || !Number.isInteger(partySize) || partySize < 1) {
    return json({ error: 'date, guest_name and a positive party_size are required' }, { status: 400 });
  }
  if (!body.phone && !body.email) {
    return json({ error: 'a phone number or email is required' }, { status: 400 });
  }
  if (body.preferred_time && !validTime(body.preferred_time)) {
    return json({ error: 'preferred_time must be HH:MM' }, { status: 400 });
  }
  const id = await insertWaitlist(env, {
    date: body.date, guestName, phone: body.phone, email: body.email,
    partySize, preferredTime: body.preferred_time, notes: body.notes,
  });
  return json({ id }, { status: 201 });
}

async function handleUpdateWaitlist(request, env, id) {
  const body = await request.json().catch(() => null);
  const entry = await getWaitlistEntry(env, id);
  if (!entry) return json({ error: 'not found' }, { status: 404 });
  const fields = {};
  for (const k of ['guest_name', 'phone', 'email', 'party_size', 'preferred_time', 'notes']) {
    if (body?.[k] !== undefined) fields[k] = body[k];
  }
  if (body?.status !== undefined) {
    if (!['waiting', 'removed'].includes(body.status)) {
      return json({ error: 'status must be waiting or removed' }, { status: 400 });
    }
    fields.status = body.status;
  }
  if (!Object.keys(fields).length) return json({ error: 'nothing to update' }, { status: 400 });
  await updateWaitlist(env, id, fields);
  return json({ id, ...fields });
}

// Move a waitlisted party onto the book: { mode: 'book', date, time } makes a confirmed
// reservation (normal slot/cap/table rules); { mode: 'seat', date, time } seats them now.
async function handlePlaceWaitlist(request, env, id) {
  const body = await request.json().catch(() => null);
  const entry = await getWaitlistEntry(env, id);
  if (!entry || entry.status !== 'waiting') return json({ error: 'not found' }, { status: 404 });
  const mode = body?.mode === 'seat' ? 'seat' : 'book';
  const date = body?.date || entry.date;
  const time = body?.time || entry.preferred_time;
  if (!validDate(date) || !validTime(time)) {
    return json({ error: 'a time (HH:MM) is required' }, { status: 400 });
  }

  let reservationId;
  if (mode === 'seat') {
    const r = await seatWalkIn(env, {
      date, time, partySize: entry.party_size, guestName: entry.guest_name,
      phone: entry.phone, email: entry.email, notes: entry.notes, tableId: body?.table_id,
    });
    if (r.error) return json(r.error, { status: r.status });
    reservationId = r.id;
  } else {
    const { tables, servicePeriods, blackoutDates } = await loadContext(env);
    const reservations = await getReservationsForDate(env, date);
    const check = checkAndAssignTable({
      date, time, partySize: entry.party_size, tables, servicePeriods, reservations, blackoutDates,
    });
    if (!check.ok) {
      return json({ error: 'That time is not available', reason: check.reason }, { status: 409 });
    }
    let squareCustomerId = null;
    try {
      squareCustomerId = await upsertSquareCustomer(env, {
        name: entry.guest_name, phone: entry.phone, email: entry.email, note: entry.notes,
      });
    } catch (err) {
      console.error('Square customer upsert failed:', err.message);
    }
    reservationId = await insertReservation(env, {
      date, time, partySize: entry.party_size, guestName: entry.guest_name,
      phone: entry.phone, email: entry.email, notes: entry.notes,
      tableId: check.table.id, turnTimeMinutes: check.turnTimeMinutes, squareCustomerId,
    });
  }
  await updateWaitlist(env, id, { status: mode === 'seat' ? 'seated' : 'booked' });
  return json({ id: reservationId, mode }, { status: 201 });
}

async function handleListTables(request, env) {
  const tables = await getTables(env);
  return json({ tables });
}

async function handleCreateTable(request, env) {
  const body = await request.json().catch(() => null);
  const { name, capacity, section } = body || {};
  if (!name || !capacity || capacity < 1) {
    return json({ error: 'name and a positive capacity are required' }, { status: 400 });
  }
  const id = await insertTable(env, { name, capacity, section });
  return json({ id, name, capacity, section: section || null, pos_x: 40, pos_y: 40 }, { status: 201 });
}

// Only these fields may ever be written via this endpoint — never pass a request body
// straight through to updateTable, which builds raw SQL from its keys.
const EDITABLE_TABLE_FIELDS = ['name', 'capacity', 'section', 'active', 'pos_x', 'pos_y'];

async function handleUpdateTable(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'invalid JSON body' }, { status: 400 });

  const fields = {};
  for (const key of EDITABLE_TABLE_FIELDS) {
    if (body[key] !== undefined) fields[key] = body[key];
  }
  if (!Object.keys(fields).length) {
    return json({ error: `no editable fields provided (allowed: ${EDITABLE_TABLE_FIELDS.join(', ')})` }, { status: 400 });
  }
  await updateTable(env, id, fields);
  return json({ id, ...fields });
}

async function handleListServicePeriods(request, env) {
  const servicePeriods = await getAllServicePeriods(env);
  return json({ service_periods: servicePeriods });
}

async function handleCreateServicePeriod(request, env) {
  const body = await request.json().catch(() => null);
  const {
    name, days_of_week: daysOfWeek, start_time: startTime, end_time: endTime,
    slot_interval_minutes: slotIntervalMinutes, turn_time_minutes: turnTimeMinutes,
    covers_cap: coversCap,
  } = body || {};
  if (!name || !daysOfWeek || !startTime || !endTime || !coversCap) {
    return json(
      { error: 'name, days_of_week, start_time, end_time, and covers_cap are required' },
      { status: 400 },
    );
  }
  const id = await insertServicePeriod(env, {
    name,
    daysOfWeek,
    startTime,
    endTime,
    slotIntervalMinutes: slotIntervalMinutes || 30,
    turnTimeMinutes: turnTimeMinutes || 90,
    coversCap,
  });
  return json({ id }, { status: 201 });
}

// Only these fields may ever be written via this endpoint — same guard as EDITABLE_TABLE_FIELDS.
const EDITABLE_PERIOD_FIELDS = [
  'name', 'days_of_week', 'start_time', 'end_time',
  'slot_interval_minutes', 'turn_time_minutes', 'covers_cap', 'active',
];

async function handleUpdateServicePeriod(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'invalid JSON body' }, { status: 400 });

  const fields = {};
  for (const key of EDITABLE_PERIOD_FIELDS) {
    if (body[key] !== undefined) fields[key] = body[key];
  }
  if (!Object.keys(fields).length) {
    return json({ error: `no editable fields provided (allowed: ${EDITABLE_PERIOD_FIELDS.join(', ')})` }, { status: 400 });
  }
  await updateServicePeriod(env, id, fields);
  return json({ id, ...fields });
}

async function handleListBlackoutDates(request, env) {
  const blackoutDates = await getBlackoutDates(env);
  return json({ blackout_dates: blackoutDates });
}

async function handleCreateBlackoutDate(request, env) {
  const body = await request.json().catch(() => null);
  const { date, reason } = body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ error: 'date is required in YYYY-MM-DD format' }, { status: 400 });
  }
  const id = await insertBlackoutDate(env, { date, reason });
  return json({ id, date, reason: reason || null }, { status: 201 });
}

async function handleDeleteBlackoutDate(request, env, id) {
  await deleteBlackoutDate(env, id);
  return json({ id, deleted: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === '/api/availability' && request.method === 'GET') {
        return await handleAvailability(request, env);
      }
      if (pathname === '/api/reservations' && request.method === 'POST') {
        return await handleCreateReservation(request, env);
      }
      if (pathname === '/api/reservations' && request.method === 'GET') {
        const authFail = requireBasicAuth(request, env);
        if (authFail) return authFail;
        return await handleListReservations(request, env);
      }
      const patchMatch = pathname.match(/^\/api\/reservations\/(\d+)$/);
      if (patchMatch && request.method === 'PATCH') {
        const authFail = requireBasicAuth(request, env);
        if (authFail) return authFail;
        return await handleUpdateReservation(request, env, Number(patchMatch[1]));
      }

      if (pathname === '/api/walk-ins' && request.method === 'POST') {
        const authFail = requireBasicAuth(request, env);
        if (authFail) return authFail;
        return await handleWalkIn(request, env);
      }
      if (pathname === '/api/waitlist' && request.method === 'GET') {
        const authFail = requireBasicAuth(request, env);
        if (authFail) return authFail;
        return await handleListWaitlist(request, env);
      }
      if (pathname === '/api/waitlist' && request.method === 'POST') {
        const authFail = requireBasicAuth(request, env);
        if (authFail) return authFail;
        return await handleCreateWaitlist(request, env);
      }
      const waitMatch = pathname.match(/^\/api\/waitlist\/(\d+)(\/place)?$/);
      if (waitMatch && (request.method === 'PATCH' || (request.method === 'POST' && waitMatch[2]))) {
        const authFail = requireBasicAuth(request, env);
        if (authFail) return authFail;
        const wid = Number(waitMatch[1]);
        return waitMatch[2]
          ? await handlePlaceWaitlist(request, env, wid)
          : await handleUpdateWaitlist(request, env, wid);
      }

      if (pathname === '/api/tables' && request.method === 'GET') {
        const authFail = requireBasicAuth(request, env);
        if (authFail) return authFail;
        return await handleListTables(request, env);
      }
      if (pathname === '/api/tables' && request.method === 'POST') {
        const authFail = requireBasicAuth(request, env);
        if (authFail) return authFail;
        return await handleCreateTable(request, env);
      }
      const tablePatchMatch = pathname.match(/^\/api\/tables\/(\d+)$/);
      if (tablePatchMatch && request.method === 'PATCH') {
        const authFail = requireBasicAuth(request, env);
        if (authFail) return authFail;
        return await handleUpdateTable(request, env, Number(tablePatchMatch[1]));
      }

      if (pathname === '/api/service-periods' && request.method === 'GET') {
        const authFail = requireBasicAuth(request, env);
        if (authFail) return authFail;
        return await handleListServicePeriods(request, env);
      }
      if (pathname === '/api/service-periods' && request.method === 'POST') {
        const authFail = requireBasicAuth(request, env);
        if (authFail) return authFail;
        return await handleCreateServicePeriod(request, env);
      }
      const periodPatchMatch = pathname.match(/^\/api\/service-periods\/(\d+)$/);
      if (periodPatchMatch && request.method === 'PATCH') {
        const authFail = requireBasicAuth(request, env);
        if (authFail) return authFail;
        return await handleUpdateServicePeriod(request, env, Number(periodPatchMatch[1]));
      }

      if (pathname === '/api/blackout-dates' && request.method === 'GET') {
        const authFail = requireBasicAuth(request, env);
        if (authFail) return authFail;
        return await handleListBlackoutDates(request, env);
      }
      if (pathname === '/api/blackout-dates' && request.method === 'POST') {
        const authFail = requireBasicAuth(request, env);
        if (authFail) return authFail;
        return await handleCreateBlackoutDate(request, env);
      }
      const blackoutDeleteMatch = pathname.match(/^\/api\/blackout-dates\/(\d+)$/);
      if (blackoutDeleteMatch && request.method === 'DELETE') {
        const authFail = requireBasicAuth(request, env);
        if (authFail) return authFail;
        return await handleDeleteBlackoutDate(request, env, Number(blackoutDeleteMatch[1]));
      }

      if (pathname === '/admin' || pathname === '/admin.html') {
        const authFail = requireBasicAuth(request, env);
        if (authFail) return authFail;
        // Pass the original request through as-is. Cloudflare's asset handler canonicalizes
        // /admin.html -> a redirect to /admin on its own; rewriting the URL here caused a
        // redirect loop against that canonicalization (caught in local testing).
        return env.ASSETS.fetch(request);
      }

      // Everything else (book.html, /, static assets) is served from ./public.
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error('Unhandled error:', err);
      return json({ error: 'internal error' }, { status: 500 });
    }
  },
};
