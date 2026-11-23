// Dine-in tables: signed QR links, running tabs (order rounds, pay once) and "call waiter / ask for bill".
import { HttpError } from "./http.js";
import { summarise } from "./pricing.js";
import { base64url, safeEqual } from "./util.js";

const now = () => new Date().toISOString();
// table links are signed with the server secret; without it nothing can be trusted, so refuse
function secret(env) {
  if (!env.SESSION_SECRET || String(env.SESSION_SECRET).length < 32) throw new HttpError(503, "The shop's server isn't set up yet");
  return env.SESSION_SECRET;
}

// A short signature printed in each table's QR link, so tabs and calls only work from the real table card.
export async function tableKey(env, settings, table) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`table|v${settings.tableKeyVersion}|${table.toLowerCase()}`));
  return base64url(new Uint8Array(sig)).slice(0, 12);
}

export async function validTableKey(env, settings, table, k) {
  return typeof k === "string" && k.length === 12 && safeEqual(k, await tableKey(env, settings, table));
}

export async function openTab(db, table) {
  return db.prepare("SELECT * FROM tabs WHERE table_no = ?1 AND status != 'closed'").bind(table).first();
}

const PIN_TRIES = 15; // wrong table PINs before the tab locks (staff seat the table again to unlock: it gets a new PIN)

/**
 * Checks the 4-digit PIN staff gave the guests when seating them. A photo of the table card alone
 * can't add orders to someone's tab or see their bill. Returns the tab, or throws.
 */
export async function checkTabPin(db, tab, pin, { limitReached, attemptOver }) {
  const key = `tabpin:${tab.id}`;
  if (await limitReached(db, key, PIN_TRIES, 86400)) throw new HttpError(429, "Too many wrong PINs. Please ask our staff.");
  if (tab.pin && (await safeEqual(String(pin || ""), tab.pin))) return tab;
  // wrong: counted at once (a burst of guesses can't all be tried before the count goes up)
  if (await attemptOver(db, key, PIN_TRIES, 86400)) throw new HttpError(429, "Too many wrong PINs. Please ask our staff.");
  throw new HttpError(403, "Please type the 4-digit table PIN our staff gave you", { needPin: true });
}

// The table's open tab. Only staff open tabs (when they seat guests), so a photo of a table card
// can't be used to order on credit from somewhere else.
export async function tabForOrder(db, table, pin, limiter) {
  const tab = await openTab(db, table);
  if (!tab) throw new HttpError(409, "To pay at the end, ask our staff to open your table. Or choose \"Now, by UPI\".");
  if (tab.status !== "open") throw new HttpError(409, "Your table's bill has already been made. Please pay it, or ask us to add more.");
  return checkTabPin(db, tab, pin, limiter);
}

// The link token of a table bill, worked out from the secret (so it never has to be stored or backed up).
export async function billToken(env, code) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`bill|${code}`));
  return base64url(new Uint8Array(sig)).slice(0, 32);
}

const newPin = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, "0");

// Staff seat guests: opens the table's tab with a fresh PIN (or says it's already open / waiting for payment).
export async function seatTable(db, table, { reseat = false } = {}) {
  await db.prepare("INSERT INTO tabs (table_no, status, opened_at, pin) VALUES (?1, 'open', ?2, ?3) ON CONFLICT DO NOTHING").bind(table, now(), newPin()).run();
  // seating a table that's already open (or opened before PINs existed) gives it a fresh PIN and clears any lock
  const open = await openTab(db, table);
  if (open && open.status === "open" && (open.pin === "" || reseat)) {
    await db.batch([
      db.prepare("UPDATE tabs SET pin = ?1 WHERE id = ?2").bind(newPin(), open.id),
      db.prepare("DELETE FROM rate_hits WHERE key = ?1").bind(`tabpin:${open.id}`),
    ]);
  }
  const tab = await openTab(db, table);
  if (!tab) throw new HttpError(409, "Couldn't open the tab. Try again.");
  if (tab.status !== "open") throw new HttpError(409, "This table still has an unpaid bill");
  return tab;
}

export async function tabOrders(db, tabId) {
  const { results } = await db.prepare("SELECT id, code, status, lines, customer_name, created_at FROM orders WHERE tab_id = ?1 AND channel != 'tab' AND status != 'cancelled' ORDER BY id").bind(tabId).all();
  return results.map((r) => ({ ...r, lines: JSON.parse(r.lines) }));
}

// Joins all rounds into bill lines: same product at the same price becomes one line.
export function mergeLines(orders) {
  const by = new Map();
  for (const o of orders) {
    for (const l of o.lines) {
      const key = `${l.id}|${l.price}|${l.rate}`;
      const prev = by.get(key);
      by.set(key, prev
        ? { ...prev, qty: prev.qty + l.qty, listAmount: prev.listAmount + (l.listAmount ?? l.gross), discount: prev.discount + (l.discount || 0), taxable: prev.taxable + l.taxable, tax: prev.tax + l.tax, gross: prev.gross + l.gross }
        : { ...l, listAmount: l.listAmount ?? l.gross, discount: l.discount || 0 });
    }
  }
  const lines = [...by.values()];
  return { lines, total: lines.reduce((n, l) => n + l.gross, 0), taxSummary: summarise(lines) };
}

// Guests moved to another table: the tab moves with them, or joins the open tab already there.
export async function moveTab(db, from, to) {
  const src = await openTab(db, from);
  if (!src || src.status !== "open") throw new HttpError(409, `Table ${from} has no open tab`);
  const dst = await openTab(db, to);
  if (dst && dst.status !== "open") throw new HttpError(409, `Table ${to} is waiting for its bill to be paid`);
  if (!dst) {
    try {
      await db.batch([
        db.prepare("UPDATE tabs SET table_no = ?1 WHERE id = ?2 AND status = 'open'").bind(to, src.id),
        db.prepare("UPDATE orders SET table_no = ?1 WHERE tab_id = ?2 AND EXISTS (SELECT 1 FROM tabs WHERE id = ?2 AND table_no = ?1)").bind(to, src.id),
      ]);
    } catch (e) {
      if (String(e.message).includes("UNIQUE")) throw new HttpError(409, `Table ${to} was just opened. Try joining it instead.`);
      throw e;
    }
    return "moved";
  }
  // both tabs must still be open while this runs (a bill made at the same moment wins, and nothing moves)
  const bothOpen = "EXISTS (SELECT 1 FROM tabs WHERE id = ?3 AND status = 'open') AND EXISTS (SELECT 1 FROM tabs WHERE id = ?1 AND status = 'open')";
  const res = await db.batch([
    db.prepare(`UPDATE orders SET tab_id = ?1, table_no = ?2 WHERE tab_id = ?3 AND ${bothOpen}`).bind(dst.id, to, src.id),
    db.prepare(`UPDATE tabs SET status = 'closed', closed_at = ?2 WHERE id = ?3 AND ${bothOpen}`).bind(dst.id, now(), src.id),
  ]);
  if (!res[1].meta.changes) throw new HttpError(409, "One of the tables just changed. Refresh and try again.");
  return "merged";
}

export async function addCall(db, table, kind) {
  // one open call per table and kind is enough
  const open = await db.prepare("SELECT id FROM table_calls WHERE table_no = ?1 AND kind = ?2 AND done_at IS NULL").bind(table, kind).first();
  if (open) return false;
  await db.prepare("INSERT INTO table_calls (table_no, kind, at) VALUES (?1, ?2, ?3)").bind(table, kind, now()).run();
  return true;
}

export async function openCalls(db) {
  const { results } = await db.prepare("SELECT id, table_no, kind, at FROM table_calls WHERE done_at IS NULL ORDER BY at").all();
  return results;
}

export async function finishCall(db, id, user) {
  await db.prepare("UPDATE table_calls SET done_at = ?1, done_by = ?2 WHERE id = ?3 AND done_at IS NULL").bind(now(), user.name, id).run();
}

export async function openTabs(db) {
  const { results } = await db.prepare(`SELECT t.id, t.table_no, t.status, t.opened_at, t.bill_order_id, t.pin,
      (SELECT COUNT(*) FROM orders o WHERE o.tab_id = t.id AND o.channel != 'tab' AND o.status != 'cancelled') AS rounds,
      (SELECT COALESCE(SUM(total), 0) FROM orders o WHERE o.tab_id = t.id AND o.channel != 'tab' AND o.status != 'cancelled') AS total,
      (SELECT code FROM orders o WHERE o.id = t.bill_order_id) AS bill_code
    FROM tabs t WHERE t.status != 'closed' ORDER BY t.opened_at`).all();
  return results;
}
