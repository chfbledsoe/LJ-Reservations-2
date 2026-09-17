import {
  computeAvailability, checkAndAssignTable,
} from './availability.js';
import {
  getTables, getServicePeriods, getBlackoutDates, getReservationsForDate,
  insertReservation, getReservation, updateReservationStatus, cancelReservation,
  insertTable, updateTable, updateReservationTable,
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
  if (!body || (!body.status && body.table_id === undefined)) {
    return json({ error: 'status or table_id is required' }, { status: 400 });
  }

  const existing = await getReservation(env, id);
  if (!existing) return json({ error: 'not found' }, { status: 404 });

  // Reassigning to a different table — a staff override from the floor plan / reservation
  // list, independent of status. No overlap re-check here: staff can see the floor plan's
  // occupancy for themselves, and this is a deliberate manual override.
  if (body.table_id !== undefined) {
    const tables = await getTables(env);
    const table = tables.find((t) => t.id === body.table_id);
    if (!table) return json({ error: 'table_id does not match an active table' }, { status: 400 });
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
