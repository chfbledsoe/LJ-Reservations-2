// D1 query helpers. Kept thin and explicit rather than wrapped in an ORM, to match
// a small team maintaining this without a heavy build step.

export async function getTables(env) {
  const { results } = await env.DB.prepare('SELECT * FROM tables WHERE active = 1').all();
  return results;
}

export async function insertTable(env, { name, capacity, section }) {
  const res = await env.DB.prepare(
    'INSERT INTO tables (name, capacity, section, pos_x, pos_y) VALUES (?, ?, ?, 40, 40)',
  ).bind(name, capacity, section || null).run();
  return res.meta.last_row_id;
}

export async function updateTable(env, id, fields) {
  const sets = [];
  const binds = [];
  for (const [col, val] of Object.entries(fields)) {
    sets.push(`${col} = ?`);
    binds.push(val);
  }
  if (!sets.length) return;
  binds.push(id);
  await env.DB.prepare(`UPDATE tables SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
}

export async function getServicePeriods(env) {
  const { results } = await env.DB.prepare('SELECT * FROM service_periods WHERE active = 1').all();
  return results;
}

export async function getBlackoutDates(env) {
  const { results } = await env.DB.prepare('SELECT * FROM blackout_dates').all();
  return results;
}

export async function getReservationsForDate(env, date) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM reservations WHERE date = ? AND status != 'cancelled'`,
  ).bind(date).all();
  return results;
}

export async function insertReservation(env, r) {
  const res = await env.DB.prepare(
    `INSERT INTO reservations
      (date, time, party_size, guest_name, phone, email, notes, table_id, turn_time_minutes, status, square_customer_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)`,
  ).bind(r.date, r.time, r.partySize, r.guestName, r.phone || null, r.email || null,
    r.notes || null, r.tableId, r.turnTimeMinutes || null, r.squareCustomerId || null).run();
  return res.meta.last_row_id;
}

export async function getReservation(env, id) {
  return env.DB.prepare('SELECT * FROM reservations WHERE id = ?').bind(id).first();
}

export async function updateReservationStatus(env, id, status, extra = {}) {
  const sets = ['status = ?', "updated_at = datetime('now')"];
  const binds = [status];
  if (extra.squareOrderId) {
    sets.push('square_order_id = ?');
    binds.push(extra.squareOrderId);
  }
  binds.push(id);
  await env.DB.prepare(`UPDATE reservations SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
}

export async function updateReservationTable(env, id, tableId) {
  await env.DB.prepare(
    `UPDATE reservations SET table_id = ?, updated_at = datetime('now') WHERE id = ?`,
  ).bind(tableId, id).run();
}

export async function cancelReservation(env, id) {
  await env.DB.prepare(`UPDATE reservations SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`)
    .bind(id).run();
}
