// Everything that reads or writes orders, prices and settings in the D1 database.
import { releaseHeldStmts } from "./offers.js";
import { DEFAULT_SETTINGS, checkSettings } from "./settings.js";
import { releaseStmts } from "./stock.js";
import { financialYear, istParts, randomToken, sha256hex } from "./util.js";

const now = () => new Date().toISOString();

/* ---------- settings ---------- */
export async function getSettings(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'store'").first();
  if (!row) return { ...DEFAULT_SETTINGS };
  const merged = checkSettings(JSON.parse(row.value), DEFAULT_SETTINGS);
  return merged.value || { ...DEFAULT_SETTINGS };
}

export async function saveSettings(db, value) {
  await db.prepare("INSERT INTO settings (key, value) VALUES ('store', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(value)).run();
}

/* ---------- prices and daily limits ---------- */
export async function getPrices(db) {
  const { results } = await db.prepare("SELECT item_id, price, unit, available, daily_limit FROM prices").all();
  return new Map(results.map((r) => [r.item_id, { price: r.price, unit: r.unit, available: r.available, daily_limit: r.daily_limit }]));
}

export async function setPrice(db, id, { price, unit, available, dailyLimit }) {
  await db.prepare(`INSERT INTO prices (item_id, price, unit, available, daily_limit, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT (item_id) DO UPDATE SET price = excluded.price, unit = excluded.unit, available = excluded.available,
      daily_limit = excluded.daily_limit, updated_at = excluded.updated_at`)
    .bind(id, price, unit, available ? 1 : 0, dailyLimit ?? null, now()).run();
}

export async function clearPrice(db, id) {
  await db.prepare("DELETE FROM prices WHERE item_id = ?1").bind(id).run();
}

/* ---------- orders ---------- */
const ORDER_COLUMNS = `id, code, advance, receipt_no, cake_message, platform, external_id, rung_by, stock_used, source, status, customer_name, customer_phone, customer_gstin, mode, table_no, address, pincode,
  slot_date, slot_time, notes, lines, subtotal, delivery_fee, total, tax_snapshot, payment_method, utr,
  invoice_no, invoice_date, admin_note, created_at, updated_at, expires_at, paid_at,
  discount, coupon_code, points_used, points_earned, opt_in, channel, tab_id, credit_note_no, credit_note_date, refund_method, refund_ref,
  coupon_held, points_held`;

const parse = (row) => (row ? { ...row, lines: JSON.parse(row.lines), tax_snapshot: JSON.parse(row.tax_snapshot) } : null);
const eventStmt = (db, code, status, note, actor) =>
  db.prepare("INSERT INTO order_events (order_id, status, note, actor, at) VALUES ((SELECT id FROM orders WHERE code = ?1), ?2, ?3, ?4, ?5)")
    .bind(code, status, note, actor, now());

/**
 * Saves a new order together with its stock, coupon and points statements in ONE transaction:
 * if any of them fails (sold out, coupon used up, not enough points), nothing is saved.
 * Returns { id } or { error: "stock" | "coupon" | "points" }.
 */
export async function createOrder(db, o, extra = []) {
  const at = now();
  // A round on a table's tab, or the tab's bill, is only saved while that tab is still open: two people making
  // the bill at the same moment get one bill (the second finds the tab already billed and nothing is saved).
  // If it isn't, nothing is inserted and the event row below fails on its NOT NULL order id, cancelling the batch.
  const insert = db.prepare(`INSERT INTO orders (code, token_hash, source, status, customer_name, customer_phone, customer_gstin, mode,
      address, pincode, slot_date, slot_time, notes, lines, subtotal, delivery_fee, total, tax_snapshot, payment_method,
      created_at, updated_at, expires_at, table_no, discount, coupon_code, points_used, opt_in, channel, tab_id, coupon_held, points_held, client_ref,
      cake_message, platform, external_id, rung_by)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35
    WHERE ?28 IS NULL OR EXISTS (SELECT 1 FROM tabs WHERE id = ?28 AND status = 'open')`)
    .bind(o.code, o.tokenHash, o.source, o.status, o.name || "", o.phone || "", o.gstin || "", o.mode, o.address || "", o.pincode || "",
      o.date || "", o.time || "", o.notes || "", JSON.stringify(o.lines), o.subtotal, o.deliveryFee || 0, o.total,
      JSON.stringify(o.taxSnapshot), o.paymentMethod || "upi", at, o.expiresAt || null, o.table || "",
      o.discount || 0, o.couponCode || "", o.pointsUsed || 0, o.optIn ? 1 : 0, o.channel || "web", o.tabId ?? null,
      o.couponCode ? 1 : 0, o.pointsUsed ? 1 : 0, o.clientRef || null, o.cakeMessage || "", o.platform || "", o.externalId || null, o.rungBy || "");
  try {
    const res = await db.batch([insert, ...extra, eventStmt(db, o.code, o.status, "", o.actor || "customer")]);
    return { id: res[0].meta.last_row_id };
  } catch (e) {
    const msg = String(e.message);
    if (msg.includes("NOT NULL") && o.tabId) return { error: "tab" };
    if (msg.includes("UNIQUE") && msg.includes("client_ref")) return { error: "duplicate" };
    if (msg.includes("UNIQUE") && msg.includes("external_id")) return { error: "external" };
    if (msg.includes("CHECK") && msg.includes("sold")) return { error: "stock" };
    if (msg.includes("CHECK") && msg.includes("uses")) return { error: "coupon" };
    if (msg.includes("CHECK") && msg.includes("points")) return { error: "points" };
    if (msg.includes("CHECK")) return { error: "stock" };
    throw e;
  }
}

export async function getOrder(db, code) {
  return parse(await db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE code = ?1`).bind(code).first());
}

export async function getOrderById(db, id) {
  return parse(await db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?1`).bind(id).first());
}

// The order if `token` is its customer link (the original one, or one the owner shared later).
export async function getOrderForToken(db, code, token) {
  const hash = await sha256hex(token);
  const row = await db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders o WHERE code = ?1 AND (token_hash = ?2
    OR EXISTS (SELECT 1 FROM order_links l WHERE l.order_id = o.id AND l.token_hash = ?2))`).bind(code, hash).first();
  return parse(row);
}

// A new customer link for an order (e.g. to send on WhatsApp). Returns the token.
export async function addOrderLink(db, orderId) {
  const token = randomToken();
  await db.prepare("INSERT INTO order_links (token_hash, order_id, created_at) VALUES (?1, ?2, ?3)").bind(await sha256hex(token), orderId, now()).run();
  return token;
}

export async function listOrders(db, { status, q, from, to, limit = 50, before, statuses, since }) {
  const where = [];
  const args = [];
  const arg = (v) => { args.push(v); return `?${args.length}`; };
  if (statuses) where.push(`status IN (${statuses.map(arg).join(",")})`);
  else if (status === "active") where.push("status IN ('payment_submitted','paid','on_tab','preparing','ready','out_for_delivery','booked')");
  else if (status) where.push(`status = ${arg(status)}`);
  if (q) {
    const like = `%${q.replace(/[%_]/g, "")}%`;
    where.push(`(code LIKE ${arg(like)} OR customer_name LIKE ${arg(like)} OR customer_phone LIKE ${arg(like)} OR invoice_no LIKE ${arg(like)} OR utr LIKE ${arg(like)} OR table_no LIKE ${arg(like)})`);
  }
  if (from) where.push(`created_at >= ${arg(from)}`);
  if (since) where.push(`(created_at >= ${arg(since)} OR status IN ('booked','paid','on_tab','preparing','ready','out_for_delivery','payment_submitted'))`);
  if (to) where.push(`created_at < ${arg(to)}`);
  if (before) where.push(`id < ${arg(before)}`);
  const sql = `SELECT ${ORDER_COLUMNS} FROM orders ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ${arg(Math.min(limit, 500))}`;
  const { results } = await db.prepare(sql).bind(...args).all();
  return results.map(parse);
}

export async function getEvents(db, orderId) {
  const { results } = await db.prepare("SELECT status, note, actor, at FROM order_events WHERE order_id = ?1 ORDER BY id").bind(orderId).all();
  return results;
}

export async function addEvent(db, orderId, status, note, by) {
  await db.prepare("INSERT INTO order_events (order_id, status, note, actor, at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(orderId, status, note, by, now()).run();
}

// Moves an order only if it is still in the status we expect (two people tapping at once can't clash).
// Cancelling an unpaid order gives back its stock and coupon use.
export async function moveStatus(db, order, to, note, by) {
  // "payment not received" also frees the UPI ref the customer typed, so they can enter the right one
  const clearUtr = order.status === "payment_submitted" && to === "awaiting_payment";
  const update = db.prepare(`UPDATE orders SET status = ?1, updated_at = ?2${clearUtr ? ", utr = NULL" : ""} WHERE id = ?3 AND status = ?4`)
    .bind(to, now(), order.id, order.status);
  const res = await db.batch([update]);
  if (!res[0].meta.changes) return false;
  const after = [db.prepare("INSERT INTO order_events (order_id, status, note, actor, at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(order.id, to, note, by, now())];
  if (to === "cancelled" && !order.invoice_no) after.push(...releaseStmts(db, order.id), ...releaseHeldStmts(db, order.id));
  await db.batch(after);
  return true;
}

export async function setAdminNote(db, id, note) {
  await db.prepare("UPDATE orders SET admin_note = ?1, updated_at = ?2 WHERE id = ?3").bind(note, now(), id).run();
}

// Customer says they've paid. Returns "ok", "taken" (UTR already used) or "stale".
export async function submitUtr(db, order, utr) {
  try {
    const res = await db.prepare(`UPDATE orders SET utr = ?1, status = 'payment_submitted', updated_at = ?2
      WHERE id = ?3 AND status IN ('awaiting_payment', 'expired')`).bind(utr, now(), order.id).run();
    if (!res.meta.changes) return "stale";
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) return "taken";
    throw e;
  }
  await addEvent(db, order.id, "payment_submitted", `UPI ref ${utr}`, "customer");
  return "ok";
}

// Next number in a gap-free series (bills or credit notes), only if `condition` on the order still holds.
function numberStmts(db, key, orderId, condition) {
  return [
    db.prepare("INSERT OR IGNORE INTO counters (key, n) VALUES (?1, 0)").bind(key),
    db.prepare(`UPDATE counters SET n = n + 1 WHERE key = ?1 AND EXISTS (SELECT 1 FROM orders WHERE id = ?2 AND ${condition})`).bind(key, orderId),
  ];
}

/**
 * Owner confirms the money arrived. Gives the next invoice number in this financial year, with no gaps:
 * the counter only moves if the order is still unpaid, and both happen in one transaction.
 */
export async function confirmPayment(db, order, { method, utr, prefix, actor = "owner", payments = null }) {
  const at = now();
  const today = istParts().date;
  const fy = financialYear(today);
  const key = `invoice:${prefix}:${fy}`;
  const unpaid = "status IN ('awaiting_payment', 'payment_submitted', 'expired', 'booked') AND invoice_no IS NULL";
  // what was paid now (the advance of a cake order was recorded when it was taken)
  const due = Math.max(order.total - (order.advance || 0), 0);
  const parts = payments || [{ method, amount: due, ref: method === "upi" ? utr || order.utr || "" : "" }];
  try {
    const results = await db.batch([
      ...numberStmts(db, key, order.id, unpaid),
      db.prepare(`UPDATE orders SET status = 'paid', payment_method = ?1, utr = COALESCE(?2, utr), paid_at = ?3, updated_at = ?3,
          invoice_date = ?4, invoice_no = ?5 || '/' || ?6 || '/' || printf('%05d', (SELECT n FROM counters WHERE key = ?7))
        WHERE id = ?8 AND ${unpaid}`).bind(method, utr || null, at, today, prefix, fy, key, order.id),
      // only written if the bill above really was made just now
      ...parts.filter((p) => p.amount > 0).map((p) => paymentStmt(db, order.id, "payment", p, actor, at, "paid_at")),
    ]);
    if (!results[2].meta.changes) return "stale";
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) return "taken";
    throw e;
  }
  const how = parts.length > 1 ? parts.map((p) => `${p.method} ${(p.amount / 100).toFixed(2)}`).join(" + ") : method === "upi" ? `UPI ${utr || order.utr || ""}`.trim() : `Paid by ${method}`;
  await addEvent(db, order.id, "paid", how, actor);
  return "ok";
}

// One money movement, saved only when the order row shows the change we just made (same transaction).
// The open cash-drawer shift (if any) is noted, so the drawer count knows about it.
function paymentStmt(db, orderId, kind, p, actor, at, column) {
  return db.prepare(`INSERT INTO payments (order_id, kind, method, amount, ref, at, actor, shift_id)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, (SELECT id FROM shifts WHERE closed_at IS NULL) WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?1 AND ${column} = ?6)`)
    .bind(orderId, kind, p.method, p.amount, String(p.ref || "").slice(0, 40), at, actor);
}

/**
 * A cake / advance order: the customer pays part now and gets an advance receipt (its own numbered series).
 * The tax invoice is made later, when the rest is paid at pickup.
 */
export async function takeAdvance(db, order, { method, amount, ref, prefix, actor }) {
  const at = now();
  const fy = financialYear(istParts().date);
  const key = `receipt:${prefix}:${fy}`;
  const open = "status = 'booked' AND receipt_no IS NULL AND invoice_no IS NULL";
  const results = await db.batch([
    ...numberStmts(db, key, order.id, open),
    db.prepare(`UPDATE orders SET advance = ?1, updated_at = ?2, receipt_no = ?3 || 'RV/' || ?4 || '/' || printf('%05d', (SELECT n FROM counters WHERE key = ?5))
      WHERE id = ?6 AND ${open}`).bind(amount, at, prefix, fy, key, order.id),
    paymentStmt(db, order.id, "advance", { method, amount, ref }, actor, at, "updated_at"),
  ]);
  if (!results[2].meta.changes) return "stale";
  await addEvent(db, order.id, "booked", `Advance ${(amount / 100).toFixed(2)} by ${method}`, actor);
  return "ok";
}

/**
 * Refund of a paid order: it is cancelled and gets a numbered credit note (its own gap-free series),
 * so the accounts show the sale reversed. `extra` = customer/points statements in the same transaction.
 */
export async function refundOrder(db, order, { method, ref, prefix, actor, extra = [] }) {
  const at = now();
  const today = istParts().date;
  const fy = financialYear(today);
  const key = `credit:${prefix}:${fy}`;
  const refundable = "invoice_no IS NOT NULL AND credit_note_no IS NULL";
  const results = await db.batch([
    ...numberStmts(db, key, order.id, refundable),
    db.prepare(`UPDATE orders SET status = 'cancelled', refund_method = ?1, refund_ref = ?2, updated_at = ?3, credit_note_date = ?4,
        credit_note_no = ?5 || 'CN/' || ?6 || '/' || printf('%05d', (SELECT n FROM counters WHERE key = ?7))
      WHERE id = ?8 AND ${refundable}`).bind(method, ref, at, today, prefix, fy, key, order.id),
    paymentStmt(db, order.id, "refund", { method, amount: order.total, ref }, actor, at, "updated_at"),
  ]);
  if (!results[2].meta.changes) return "stale";
  const after = [
    db.prepare("INSERT INTO order_events (order_id, status, note, actor, at) VALUES (?1, 'cancelled', ?2, ?3, ?4)")
      .bind(order.id, `Refunded by ${method}${ref ? ` (${ref})` : ""}`, actor, now()),
    ...releaseStmts(db, order.id),
    ...releaseHeldStmts(db, order.id),
    ...extra,
  ];
  await db.batch(after);
  return "ok";
}

export async function expireUnpaid(db) {
  const at = now();
  const { results } = await db.prepare("SELECT id FROM orders WHERE status = 'awaiting_payment' AND expires_at < ?1 LIMIT 200").bind(at).all();
  const stmts = [db.prepare("DELETE FROM rate_hits WHERE win < ?1").bind(Math.floor(Date.now() / 1000) - 86400),
    db.prepare("DELETE FROM sessions WHERE expires_at < ?1").bind(Math.floor(Date.now() / 1000))];
  for (const o of results) {
    stmts.push(
      db.prepare("UPDATE orders SET status = 'expired', updated_at = ?1 WHERE id = ?2 AND status = 'awaiting_payment'").bind(at, o.id),
      db.prepare("INSERT INTO order_events (order_id, status, note, actor, at) SELECT ?1, 'expired', '', 'system', ?2 WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?1 AND status = 'expired')").bind(o.id, at),
      ...releaseStmts(db, o.id), // these only act if the order really is expired now
      ...releaseHeldStmts(db, o.id),
    );
  }
  await db.batch(stmts);
}

export async function summary(db) {
  const today = istParts().date;
  const start = new Date(`${today}T00:00:00+05:30`).toISOString();
  const row = await db.prepare(`SELECT
      SUM(CASE WHEN paid_at >= ?1 AND status != 'cancelled' THEN total ELSE 0 END) AS revenue,
      SUM(CASE WHEN paid_at >= ?1 AND status != 'cancelled' THEN 1 ELSE 0 END) AS paid,
      SUM(CASE WHEN status = 'payment_submitted' THEN 1 ELSE 0 END) AS to_check,
      SUM(CASE WHEN status IN ('paid', 'on_tab', 'preparing') THEN 1 ELSE 0 END) AS to_make,
      SUM(CASE WHEN status IN ('ready', 'out_for_delivery') THEN 1 ELSE 0 END) AS to_hand_over
    FROM orders`).bind(start).first();
  return { revenue: row.revenue || 0, paid: row.paid || 0, toCheck: row.to_check || 0, toMake: row.to_make || 0, toHandOver: row.to_hand_over || 0 };
}

/* ---------- rate limiting ---------- */
// Returns true while `key` has made fewer than `limit` requests in the current window.
// Once over the limit it stops writing, so a flood of refused requests can't use up the database's daily writes.
export async function underLimit(db, key, limit, windowSeconds) {
  const win = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  const seen = await db.prepare("SELECT n FROM rate_hits WHERE key = ?1 AND win = ?2").bind(key, win).first();
  if (seen && seen.n >= limit) return false;
  await db.prepare(`INSERT INTO rate_hits (key, win, n) VALUES (?1, ?2, 1)
    ON CONFLICT (key, win) DO UPDATE SET n = n + 1`).bind(key, win).run();
  return true;
}

// Read-only check: has `key` reached `limit` in the current window? (pairs with countHit)
export async function limitReached(db, key, limit, windowSeconds) {
  const win = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  const seen = await db.prepare("SELECT n FROM rate_hits WHERE key = ?1 AND win = ?2").bind(key, win).first();
  return Boolean(seen && seen.n >= limit);
}

// Counts one attempt FIRST and says whether this attempt is over the limit. Because the count goes up before
// anything is checked, a burst of attempts sent at the same moment can't all slip through.
export async function attemptOver(db, key, limit, windowSeconds) {
  const win = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  const row = await db.prepare("INSERT INTO rate_hits (key, win, n) VALUES (?1, ?2, 1) ON CONFLICT (key, win) DO UPDATE SET n = n + 1 RETURNING n")
    .bind(key, win).first();
  return row.n > limit;
}

export async function clearAttempts(db, key) {
  await db.prepare("DELETE FROM rate_hits WHERE key = ?1").bind(key).run();
}

export async function countHit(db, key, windowSeconds) {
  const win = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  await db.prepare("INSERT INTO rate_hits (key, win, n) VALUES (?1, ?2, 1) ON CONFLICT (key, win) DO UPDATE SET n = n + 1").bind(key, win).run();
}

// Unpaid online orders placed in the last hour: by this phone, and across everyone (a brake on fake-order floods).
export async function recentUnpaid(db, phone = "") {
  const since = new Date(Date.now() - 3600000).toISOString();
  const row = await db.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN customer_phone = ?2 AND ?2 != '' THEN 1 ELSE 0 END) AS mine
    FROM orders WHERE source = 'online' AND status IN ('awaiting_payment', 'payment_submitted') AND created_at >= ?1`).bind(since, phone).first();
  return { all: row.n || 0, phone: row.mine || 0 };
}

// Bills issued between two India dates (inclusive), oldest first, for the accountant.
export async function listInvoices(db, fromYmd, toYmd) {
  const { results } = await db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE invoice_no IS NOT NULL AND invoice_date >= ?1 AND invoice_date <= ?2 ORDER BY id`)
    .bind(fromYmd, toYmd).all();
  return results.map(parse);
}

export async function listCreditNotes(db, fromYmd, toYmd) {
  const { results } = await db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE credit_note_no IS NOT NULL AND credit_note_date >= ?1 AND credit_note_date <= ?2 ORDER BY credit_note_no`)
    .bind(fromYmd, toYmd).all();
  return results.map(parse);
}
