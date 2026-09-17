// Thin wrapper around the two Square calls this app makes:
//  1. Upsert a Customer when a reservation is confirmed (search by phone, then email; create if not found).
//  2. Open an Order at the dining room's location when a party is marked "seated", so it shows
//     up on the POS ready for the server to ring items against.
//
// Square API docs used: Customers API (search/create) and Orders API (create), v2, 2026-09-16.
// Failures here are caught by the caller and logged — a Square hiccup should never block a booking.

const SQUARE_VERSION = '2026-09-16';

function squareBase(env) {
  return env.SQUARE_ENVIRONMENT === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
}

async function squareFetch(env, path, body) {
  const res = await fetch(`${squareBase(env)}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      'Square-Version': SQUARE_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    const detail = json?.errors?.map((e) => e.detail).join('; ') || res.statusText;
    throw new Error(`Square ${path} failed (${res.status}): ${detail}`);
  }
  return json;
}

export async function upsertSquareCustomer(env, { name, phone, email, note }) {
  if (!env.SQUARE_ACCESS_TOKEN) throw new Error('SQUARE_ACCESS_TOKEN not configured');

  // 1. Look for an existing customer by phone, then by email.
  if (phone) {
    const byPhone = await squareFetch(env, '/v2/customers/search', {
      query: { filter: { phone_number: { exact: phone } } },
      limit: 1,
    });
    if (byPhone.customers?.length) return byPhone.customers[0].id;
  }
  if (email) {
    const byEmail = await squareFetch(env, '/v2/customers/search', {
      query: { filter: { email_address: { exact: email } } },
      limit: 1,
    });
    if (byEmail.customers?.length) return byEmail.customers[0].id;
  }

  // 2. Not found — create one. Split "name" on the first space for given/family name.
  const [given, ...rest] = (name || '').trim().split(/\s+/);
  const created = await squareFetch(env, '/v2/customers', {
    idempotency_key: crypto.randomUUID(),
    given_name: given || undefined,
    family_name: rest.join(' ') || undefined,
    phone_number: phone || undefined,
    email_address: email || undefined,
    note: note || undefined,
  });
  return created.customer.id;
}

export async function createSquareOrder(env, { referenceId, note }) {
  if (!env.SQUARE_ACCESS_TOKEN) throw new Error('SQUARE_ACCESS_TOKEN not configured');
  if (!env.SQUARE_LOCATION_ID) throw new Error('SQUARE_LOCATION_ID not configured');

  const created = await squareFetch(env, '/v2/orders', {
    idempotency_key: crypto.randomUUID(),
    order: {
      location_id: env.SQUARE_LOCATION_ID,
      reference_id: String(referenceId),
      // No line items — this opens a blank ticket tied to the reservation; the server
      // adds items on the POS once the table is seated. Square doesn't offer an "order note"
      // field usable this way in older API versions, so referenceId is what ties it back.
    },
  });
  return created.order.id;
}
