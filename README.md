# Lake Junaluska Dining Reservations

A real-time table-booking system: a public booking page (link it from the website), a staff
dashboard for managing the day's reservations, and a two-way tie into Square (customer
records + an open ticket at seating). Runs as a Cloudflare Worker with a D1 database —
same stack as the meal ticket system.

## How availability works

Two independent caps have to clear for a time slot to be offered:

1. **Covers cap** — a per-service-period ceiling (e.g. 80 covers) on how many guests may
   start in any one time slot, regardless of table layout.
2. **Table cap** — at least one table with enough seats has to be physically free for the
   whole turn-time window (default 90 minutes) — no double-booking a table.

Both are configured per **service period** in `schema.sql` (name, days of week, hours,
slot interval, turn time, covers cap), and tables are configured in the `tables` table
(name, capacity, section). Edit the starter data at the bottom of `schema.sql` before your
first deploy to match the real room and service hours — table names, capacities, and the
covers cap are almost certainly not going to be "T1–T8 / 80 covers" for your room.

The matching logic lives in `src/availability.js` and has a test suite
(`npm test`) covering the cap interactions — run it after any change to that file.

## What ties into Square, and what doesn't

- **On a confirmed booking**: the guest is looked up in Square by phone, then email, and
  created if not found (`src/square.js` → Customers API). Their name/phone/email end up in
  your Square Customer directory.
- **When staff mark a party "Seated"** in the admin dashboard: an open Order is created at
  your Square location (Orders API), tagged with the reservation ID as its `reference_id`.
  It shows up as a blank ticket in Square POS/KDS ready for the server to add items to.
- **What this is *not***: real-time two-way sync with Square's own floor plan or table
  status (that's the proprietary OpenTable↔Square integration, not something available to
  build against). This system owns the table/availability logic itself and only pushes
  customer + order records into Square — it doesn't read anything back from Square.
- Every Square call is wrapped so a Square outage **never blocks a booking or a seating** —
  it logs the error and moves on. Check the Worker logs (`wrangler tail`) if guests aren't
  showing up in Square as expected.

## One-time setup

You'll need a Cloudflare account (same one hosting the meal ticket system) and a Square
Developer account with API access to your Lake Junaluska Square location.

```bash
npm install

# 1. Create the D1 database, then paste the returned database_id into wrangler.toml
npx wrangler d1 create lj-reservations

# 2. Edit schema.sql's starter data (tables + service period) for the real room, then:
npx wrangler d1 execute lj-reservations --remote --file=./schema.sql

# 3. Set secrets (never go in wrangler.toml or git)
npx wrangler secret put ADMIN_USERNAME        # staff dashboard login
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SQUARE_ACCESS_TOKEN    # from your Square Developer Dashboard
npx wrangler secret put SQUARE_LOCATION_ID     # the dining room's Square location
npx wrangler secret put SQUARE_ENVIRONMENT     # "sandbox" first, then "production" when ready

# 4. Deploy
npx wrangler deploy
```

That gives you a `*.workers.dev` URL. The guest booking page is the root (`/`) — link or
embed that from the website. Staff use `/admin` (prompts for the username/password you set
in step 3).

### Getting Square credentials

In the [Square Developer Dashboard](https://developer.squareup.com/apps): create an
application, use its **Sandbox** access token and a sandbox location ID first to test the
whole flow without touching real guest/customer data, then switch to a **Production**
access token and your real location ID (and flip `SQUARE_ENVIRONMENT` to `production`)
once you're confident in it. The access token needs `CUSTOMERS_WRITE` and `ORDERS_WRITE`
scopes at minimum.

### Local testing before deploying

```bash
cp .dev.vars.example .dev.vars     # fill in test values
npx wrangler d1 execute lj-reservations --local --file=./schema.sql
npm run dev                         # http://localhost:8787
```

## Known v1 limitations, worth knowing before relying on this

- **No table-combining.** A party larger than your biggest single table's capacity will
  show no availability, even if two adjacent tables could be pushed together. Common
  real-world workaround: add a couple of larger "combo" table rows in the `tables` table
  sized for your biggest expected big-party.
- **No admin UI for tables/service periods/blackout dates yet** — those are managed by
  editing `schema.sql` and re-running `wrangler d1 execute`, or with direct SQL via
  `wrangler d1 execute --command="..."`. Adding a settings screen to the admin dashboard is
  a natural next step if this gets used heavily.
- **No deposit/no-show payment collection.** Square's Orders API supports it, but it's not
  wired up here — flagged as a possible v2 addition.
- **No confirmation email/SMS to the guest yet.** The confirmation currently only shows
  on-screen after booking. Square doesn't send booking confirmations for Orders/Customers
  the way it does for its own Appointments product, so this would need a separate email
  step (e.g. via a transactional email API) if you want it.

## Project layout

```
schema.sql              D1 schema + starter tables/service-period data
src/availability.js     Pure capacity/table-matching logic (unit tested, no network)
src/availability.test.mjs
src/db.js               D1 query helpers
src/square.js           Square Customers + Orders API calls
src/index.js            Worker entry point / routing / Basic Auth gate
public/index.html       Guest-facing booking page (linked from the website)
public/admin.html       Staff dashboard (Basic Auth protected)
```
