-- SEREN "final product" upgrade: security (sessions, approval PINs, table PINs) and the features
-- other billing software has: split payments, cake advances, Swiggy/Zomato orders, cash drawer shifts,
-- expenses, item options (sizes / add-ons), raw-material stock with recipes, purchases and wastage.

/* ---------- security ---------- */
-- One row per login. Logging out deletes it, so a copied cookie stops working at once.
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,          -- unix seconds
  created_at TEXT NOT NULL
);
CREATE INDEX sessions_expiry ON sessions (expires_at);

-- Managers approve voids, big discounts and refunds with a short PIN.
ALTER TABLE staff ADD COLUMN pin_hash TEXT;
ALTER TABLE staff ADD COLUMN pin_salt TEXT;

-- Staff read this 4-digit PIN to guests when seating them: "pay at the end" orders need it.
ALTER TABLE tabs ADD COLUMN pin TEXT NOT NULL DEFAULT '';
-- Only a hash of the bill link is kept (it is shown once, then looked up by hash).
ALTER TABLE tabs ADD COLUMN bill_token_hash TEXT;

/* ---------- money: every payment, part-payment, advance and refund ---------- */
CREATE TABLE payments (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('advance', 'payment', 'refund')),
  method   TEXT NOT NULL,                -- cash, upi, card, platform (Swiggy etc. pay later), store_credit
  amount   INTEGER NOT NULL CHECK (amount >= 0),
  ref      TEXT NOT NULL DEFAULT '',
  at       TEXT NOT NULL,
  actor    TEXT NOT NULL DEFAULT '',
  shift_id INTEGER
);
CREATE INDEX payments_at ON payments (at);
CREATE INDEX payments_order ON payments (order_id);
INSERT INTO payments (order_id, kind, method, amount, ref, at, actor)
  SELECT id, 'payment', payment_method, total, COALESCE(utr, ''), paid_at, '' FROM orders WHERE invoice_no IS NOT NULL AND paid_at IS NOT NULL;
INSERT INTO payments (order_id, kind, method, amount, ref, at, actor)
  SELECT id, 'refund', COALESCE(refund_method, ''), total, COALESCE(refund_ref, ''), updated_at, '' FROM orders WHERE credit_note_no IS NOT NULL;

-- Cake / advance orders: money taken before the day; the bill is made when the rest is paid.
ALTER TABLE orders ADD COLUMN advance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN receipt_no TEXT;           -- advance receipt number (its own series)
ALTER TABLE orders ADD COLUMN cake_message TEXT NOT NULL DEFAULT '';
-- Orders from Swiggy, Zomato, ONDC, Magicpin…: which app, and that app's order number.
ALTER TABLE orders ADD COLUMN platform TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX orders_external ON orders (platform, external_id) WHERE external_id IS NOT NULL;
-- Who rang up a bill made while the internet was down (it can be sent later by someone else).
ALTER TABLE orders ADD COLUMN rung_by TEXT NOT NULL DEFAULT '';

/* ---------- cash drawer ---------- */
CREATE TABLE shifts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_by  TEXT NOT NULL,
  opened_at  TEXT NOT NULL,
  float      INTEGER NOT NULL CHECK (float >= 0),     -- cash in the drawer at the start
  closed_by  TEXT,
  closed_at  TEXT,
  counted    INTEGER,                                 -- cash counted at the end
  expected   INTEGER,                                 -- what should have been there
  note       TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX shifts_one_open ON shifts ((1)) WHERE closed_at IS NULL;

CREATE TABLE cash_moves (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('in', 'out')),
  amount   INTEGER NOT NULL CHECK (amount > 0),
  reason   TEXT NOT NULL,
  actor    TEXT NOT NULL,
  at       TEXT NOT NULL
);

CREATE TABLE expenses (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  day      TEXT NOT NULL,                             -- India date
  category TEXT NOT NULL,
  amount   INTEGER NOT NULL CHECK (amount > 0),
  method   TEXT NOT NULL,                             -- cash (from the drawer), upi, card, bank
  note     TEXT NOT NULL DEFAULT '',
  actor    TEXT NOT NULL,
  at       TEXT NOT NULL
);
CREATE INDEX expenses_day ON expenses (day);

/* ---------- item options: sizes, flavours, add-ons ---------- */
ALTER TABLE products ADD COLUMN options TEXT NOT NULL DEFAULT '[]';

/* ---------- raw materials ---------- */
CREATE TABLE ingredients (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  unit      TEXT NOT NULL,                            -- g, ml, pcs
  on_hand   REAL NOT NULL DEFAULT 0,
  low_at    REAL NOT NULL DEFAULT 0,                  -- warn when stock falls to this
  cost      INTEGER NOT NULL DEFAULT 0,               -- paise per 1000 units (per kg / litre / 1000 pcs)
  active    INTEGER NOT NULL DEFAULT 1
);

-- How much of each raw material one item uses (private: never shown to customers).
CREATE TABLE recipes (
  product_id    TEXT NOT NULL,
  ingredient_id INTEGER NOT NULL,
  qty           REAL NOT NULL CHECK (qty > 0),
  PRIMARY KEY (product_id, ingredient_id)
);

CREATE TABLE vendors (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone  TEXT NOT NULL DEFAULT '',
  gstin  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE purchases (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id INTEGER,
  day       TEXT NOT NULL,
  bill_no   TEXT NOT NULL DEFAULT '',
  total     INTEGER NOT NULL CHECK (total >= 0),
  paid      INTEGER NOT NULL DEFAULT 0,
  lines     TEXT NOT NULL,                            -- [{ingredient, qty, amount}]
  actor     TEXT NOT NULL,
  at        TEXT NOT NULL
);

-- Every change to raw-material stock: sale, purchase, wastage, count correction.
CREATE TABLE stock_moves (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_id INTEGER NOT NULL,
  delta         REAL NOT NULL,
  reason        TEXT NOT NULL CHECK (reason IN ('sale', 'purchase', 'wastage', 'count', 'refund')),
  ref           TEXT NOT NULL DEFAULT '',
  actor         TEXT NOT NULL DEFAULT '',
  at            TEXT NOT NULL
);
CREATE INDEX stock_moves_at ON stock_moves (at);
-- each paid bill takes its raw materials once
ALTER TABLE orders ADD COLUMN stock_used INTEGER NOT NULL DEFAULT 0;
