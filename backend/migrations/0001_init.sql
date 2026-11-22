-- SEREN orders database (Cloudflare D1 / SQLite). Money is stored in paise (₹1 = 100).

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL            -- JSON
);

CREATE TABLE prices (
  item_id    TEXT PRIMARY KEY,   -- matches an id in src/catalog.js
  price      INTEGER NOT NULL CHECK (price >= 0),
  unit       TEXT NOT NULL DEFAULT '',  -- e.g. "per piece", "box of 6", "6-inch cake"
  available  INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT NOT NULL UNIQUE,        -- public order number, e.g. SRN-K7Q2MX
  token_hash      TEXT NOT NULL,               -- SHA-256 of the customer's private link token
  source          TEXT NOT NULL CHECK (source IN ('online', 'counter')),
  status          TEXT NOT NULL,
  customer_name   TEXT NOT NULL DEFAULT '',
  customer_phone  TEXT NOT NULL DEFAULT '',
  customer_gstin  TEXT NOT NULL DEFAULT '',
  mode            TEXT NOT NULL CHECK (mode IN ('pickup', 'delivery', 'dinein', 'counter')),
  table_no        TEXT NOT NULL DEFAULT '',    -- dine-in table, e.g. "5" or "Patio 2"
  address         TEXT NOT NULL DEFAULT '',
  pincode         TEXT NOT NULL DEFAULT '',
  slot_date       TEXT NOT NULL DEFAULT '',    -- YYYY-MM-DD (India time)
  slot_time       TEXT NOT NULL DEFAULT '',    -- HH:MM
  notes           TEXT NOT NULL DEFAULT '',
  lines           TEXT NOT NULL,               -- JSON snapshot: name, qty, unit price, tax at the time of ordering
  subtotal        INTEGER NOT NULL,
  delivery_fee    INTEGER NOT NULL DEFAULT 0,
  total           INTEGER NOT NULL,
  tax_snapshot    TEXT NOT NULL,               -- JSON: GST breakdown and seller details used on the bill
  payment_method  TEXT NOT NULL DEFAULT 'upi' CHECK (payment_method IN ('upi', 'cash', 'card')),
  utr             TEXT UNIQUE,                 -- 12-digit UPI reference from the customer's payment
  invoice_no      TEXT UNIQUE,                 -- given only once payment is confirmed (no gaps in the series)
  invoice_date    TEXT,
  admin_note      TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  expires_at      TEXT,
  paid_at         TEXT
);
CREATE INDEX orders_status  ON orders (status, created_at);
CREATE INDEX orders_created ON orders (created_at);
CREATE INDEX orders_slot    ON orders (slot_date, slot_time);

CREATE TABLE order_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders (id),
  status     TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  actor      TEXT NOT NULL,                    -- 'customer', 'owner' or 'system'
  at         TEXT NOT NULL
);
CREATE INDEX order_events_order ON order_events (order_id, id);

CREATE TABLE counters (
  key TEXT PRIMARY KEY,                        -- e.g. 'invoice:2627'
  n   INTEGER NOT NULL
);

CREATE TABLE rate_hits (
  key    TEXT NOT NULL,                        -- action + hashed IP
  win    INTEGER NOT NULL,
  n      INTEGER NOT NULL,
  PRIMARY KEY (key, win)
);
