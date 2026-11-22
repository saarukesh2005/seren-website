-- Upgrade: staff logins, activity log, daily stock, coupons, loyalty, refunds (credit notes), table tabs,
-- waiter calls, feedback, customer list, product editing with photos, shareable order links.

ALTER TABLE orders ADD COLUMN discount INTEGER NOT NULL DEFAULT 0;          -- coupon + loyalty, paise
ALTER TABLE orders ADD COLUMN coupon_code TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN points_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN points_earned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN opt_in INTEGER NOT NULL DEFAULT 0;            -- customer agreed to WhatsApp offers
ALTER TABLE orders ADD COLUMN channel TEXT NOT NULL DEFAULT 'web';          -- web | whatsapp | table | counter | tab
ALTER TABLE orders ADD COLUMN tab_id INTEGER;
ALTER TABLE orders ADD COLUMN credit_note_no TEXT;
ALTER TABLE orders ADD COLUMN credit_note_date TEXT;
ALTER TABLE orders ADD COLUMN refund_method TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN refund_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN coupon_held INTEGER NOT NULL DEFAULT 0;      -- 1 while this order counts as a coupon use
ALTER TABLE orders ADD COLUMN points_held INTEGER NOT NULL DEFAULT 0;      -- 1 while the points it used are taken from the customer
CREATE UNIQUE INDEX orders_credit_note ON orders (credit_note_no) WHERE credit_note_no IS NOT NULL;
CREATE INDEX orders_phone ON orders (customer_phone);
CREATE INDEX orders_tab ON orders (tab_id);
CREATE INDEX orders_invoice_date ON orders (invoice_date);
CREATE INDEX orders_paid_at ON orders (paid_at);

ALTER TABLE prices ADD COLUMN daily_limit INTEGER;                          -- NULL = no limit

-- Extra links to the same order (e.g. one the owner sends on WhatsApp)
CREATE TABLE order_links (
  token_hash TEXT PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders (id),
  created_at TEXT NOT NULL
);

CREATE TABLE staff (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role            TEXT NOT NULL CHECK (role IN ('manager', 'cashier', 'kitchen')),
  pass_hash       TEXT NOT NULL,
  salt            TEXT NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1,
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
);

CREATE TABLE audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX audit_at ON audit (at);

-- How many of a limited product are promised for each day. The CHECK makes over-selling impossible.
CREATE TABLE stock (
  item_id TEXT NOT NULL,
  day     TEXT NOT NULL,
  cap     INTEGER NOT NULL,
  sold    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, day),
  CHECK (sold >= 0 AND sold <= cap)
);
CREATE TABLE order_stock (
  order_id INTEGER NOT NULL,
  item_id  TEXT NOT NULL,
  day      TEXT NOT NULL,
  qty      INTEGER NOT NULL,
  PRIMARY KEY (order_id, item_id)
);

CREATE TABLE coupons (
  code           TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('percent', 'flat')),
  value          INTEGER NOT NULL CHECK (value > 0),  -- percent, or paise
  min_order      INTEGER NOT NULL DEFAULT 0,
  max_discount   INTEGER NOT NULL DEFAULT 0,           -- 0 = no cap
  starts         TEXT NOT NULL DEFAULT '',             -- YYYY-MM-DD, '' = now
  ends           TEXT NOT NULL DEFAULT '',             -- YYYY-MM-DD, '' = never
  max_uses       INTEGER NOT NULL DEFAULT 0,           -- 0 = unlimited
  uses           INTEGER NOT NULL DEFAULT 0,
  once_per_phone INTEGER NOT NULL DEFAULT 0,
  active         INTEGER NOT NULL DEFAULT 1,
  note           TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  CHECK (uses >= 0 AND (max_uses = 0 OR uses <= max_uses))
);

CREATE TABLE customers (
  phone       TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '',
  first_at    TEXT NOT NULL,
  last_at     TEXT NOT NULL,
  orders      INTEGER NOT NULL DEFAULT 0,
  spent       INTEGER NOT NULL DEFAULT 0,
  points      INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  opt_in      INTEGER NOT NULL DEFAULT 0,
  opt_in_at   TEXT,
  notes       TEXT NOT NULL DEFAULT ''
);
CREATE TABLE points_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  phone    TEXT NOT NULL,
  order_id INTEGER,
  delta    INTEGER NOT NULL,
  reason   TEXT NOT NULL,
  at       TEXT NOT NULL
);
CREATE INDEX points_log_phone ON points_log (phone, id);

-- A table's running tab: several rounds of dine-in orders, one bill at the end.
CREATE TABLE tabs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  table_no      TEXT NOT NULL COLLATE NOCASE,
  status        TEXT NOT NULL CHECK (status IN ('open', 'billed', 'closed')),
  opened_at     TEXT NOT NULL,
  billed_at     TEXT,
  closed_at     TEXT,
  bill_order_id INTEGER,
  bill_token    TEXT                              -- the bill's customer link, shown to guests at that table
);
CREATE UNIQUE INDEX tabs_one_open ON tabs (table_no) WHERE status != 'closed';

CREATE TABLE table_calls (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  table_no TEXT NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('waiter', 'bill')),
  at       TEXT NOT NULL,
  done_at  TEXT,
  done_by  TEXT
);
CREATE INDEX table_calls_open ON table_calls (done_at, at);

CREATE TABLE feedback (
  order_id INTEGER PRIMARY KEY REFERENCES orders (id),
  stars    INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment  TEXT NOT NULL DEFAULT '',
  at       TEXT NOT NULL
);

-- Product edits from the dashboard: changes to menu.js products (custom = 0) and new products (custom = 1).
CREATE TABLE products (
  id          TEXT PRIMARY KEY,
  category    TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  img         TEXT,                              -- images.key, or NULL to keep the website's photo
  veg         INTEGER,                           -- 1 veg, 0 non-veg, NULL not shown
  hidden      INTEGER NOT NULL DEFAULT 0,
  custom      INTEGER NOT NULL DEFAULT 0,
  name_ta     TEXT NOT NULL DEFAULT '',          -- Tamil name for the Tamil website (optional)
  description_ta TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL
);

CREATE TABLE images (
  key        TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,
  data       BLOB NOT NULL,
  created_at TEXT NOT NULL
);
