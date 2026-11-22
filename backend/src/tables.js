// Dine-in tables: signed QR links, running tabs (order rounds, pay once) and "call waiter / ask for bill".
import { HttpError } from "./http.js";
import { summarise } from "./pricing.js";
import { base64url, safeEqual } from "./util.js";

const now = () => new Date().toISOString();

// A short signature printed in each table's QR link, so tabs and calls only work from the real table card.
export async function tableKey(env, settings, table) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SESSION_SECRET || "dev"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`table|v${settings.tableKeyVersion}|${table.toLowerCase()}`));
  return base64url(new Uint8Array(sig)).slice(0, 12);
}

export async function validTableKey(env, settings, table, k) {
  return typeof k === "string" && k.length === 12 && safeEqual(k, await tableKey(env, settings, table));
}

export async function openTab(db, table) {
  return db.prepare("SELECT * FROM tabs WHERE table_no = ?1 AND status != 'closed'").bind(table).first();
}

// The table's open tab. Only staff open tabs (when they seat guests), so a photo of a table card
// can't be used to order on credit from somewhere else.
export async function tabForOrder(db, table) {
  const tab = await openTab(db, table);
  if (!tab) throw new HttpError(409, "To pay at the end, ask our staff to open your table. Or choose \"Now, by UPI\".");
  if (tab.status !== "open") throw new HttpError(409, "Your table's bill has already been made. Please pay it, or ask us to add more.");
  return tab;
}

// Staff seat guests: opens the table's tab (or says it's already open / waiting for payment).
export async function seatTable(db, table) {
  await db.prepare("INSERT INTO tabs (table_no, status, opened_at) VALUES (?1, 'open', ?2) ON CONFLICT DO NOTHING").bind(table, now()).run();
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
  const { results } = await db.prepare(`SELECT t.id, t.table_no, t.status, t.opened_at, t.bill_order_id,
      (SELECT COUNT(*) FROM orders o WHERE o.tab_id = t.id AND o.channel != 'tab' AND o.status != 'cancelled') AS rounds,
      (SELECT COALESCE(SUM(total), 0) FROM orders o WHERE o.tab_id = t.id AND o.channel != 'tab' AND o.status != 'cancelled') AS total,
      (SELECT code FROM orders o WHERE o.id = t.bill_order_id) AS bill_code
    FROM tabs t WHERE t.status != 'closed' ORDER BY t.opened_at`).all();
  return results;
}
