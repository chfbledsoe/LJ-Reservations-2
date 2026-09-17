-- Lake Junaluska dining room reservations — D1 schema
-- Run once with: wrangler d1 execute lj-reservations --file=./schema.sql

CREATE TABLE IF NOT EXISTS tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  section TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS service_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                 -- e.g. "Dinner"
  days_of_week TEXT NOT NULL,         -- comma list, 0=Sun..6=Sat, e.g. "0,1,2,3,4,5,6"
  start_time TEXT NOT NULL,           -- "17:00"
  end_time TEXT NOT NULL,             -- "20:30" (last bookable slot start, not last seating leaving time)
  slot_interval_minutes INTEGER NOT NULL DEFAULT 30,
  turn_time_minutes INTEGER NOT NULL DEFAULT 90,
  covers_cap INTEGER NOT NULL,        -- max total covers that may START in any one slot
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS blackout_dates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,                 -- "2026-12-25"
  reason TEXT
);

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,                 -- "2026-09-20"
  time TEXT NOT NULL,                 -- "18:30"
  party_size INTEGER NOT NULL,
  guest_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  notes TEXT,
  table_id INTEGER REFERENCES tables(id),
  status TEXT NOT NULL DEFAULT 'confirmed',  -- confirmed | seated | completed | cancelled | no_show
  square_customer_id TEXT,
  square_order_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reservations_date ON reservations(date);
CREATE INDEX IF NOT EXISTS idx_reservations_table_date ON reservations(table_id, date);

-- ---- Starter data — edit to match the real dining room, then re-run just these inserts ----

INSERT INTO service_periods (name, days_of_week, start_time, end_time, slot_interval_minutes, turn_time_minutes, covers_cap)
VALUES ('Dinner', '0,1,2,3,4,5,6', '17:00', '20:30', 30, 90, 80);

INSERT INTO tables (name, capacity, section) VALUES
  ('T1', 2, 'Main'), ('T2', 2, 'Main'), ('T3', 4, 'Main'), ('T4', 4, 'Main'),
  ('T5', 4, 'Main'), ('T6', 6, 'Main'), ('T7', 6, 'Main'), ('T8', 8, 'Main'),
  ('P1', 2, 'Patio'), ('P2', 4, 'Patio');
