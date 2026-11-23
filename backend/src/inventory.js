// Raw-material stock: ingredients, recipes, purchases, wastage, stock counts and food cost.
// Money is integer paise. An ingredient's cost is paise per 1000 units (per kg / litre / 1000 pieces).
// Quantities are in the ingredient's own unit: g, ml or pcs. Stock may go negative (a sale is never blocked).
import { HttpError } from "./http.js";
import { loadCatalog } from "./products.js";
import { getPrices } from "./store.js";
import { istParts } from "./util.js";

export const UNITS = ["g", "ml", "pcs"];
const MAX_QTY = 1e9;
const MAX_MONEY = 1_000_000_000; // ₹1 crore, in paise
const MAX_RECIPE_LINES = 30;
const MAX_PURCHASE_LINES = 30;
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const now = () => new Date().toISOString();
const round3 = (n) => Math.round(n * 1000) / 1000;
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const marks = (n) => Array.from({ length: n }, (_, i) => `?${i + 1}`).join(",");

/* ---------- input checks ---------- */
function qtyOf(v, label, { zeroOk = false } = {}) {
  if ((typeof v !== "number" && typeof v !== "string") || String(v).trim() === "") throw new HttpError(400, `${label}: type a number`);
  const n = round3(Number(v));
  if (!Number.isFinite(n) || n < 0 || n > MAX_QTY || (!zeroOk && n <= 0)) {
    throw new HttpError(400, `${label}: ${zeroOk ? "0 or more" : "more than 0"} (up to 3 decimals)`);
  }
  return n;
}

function intOf(v, label, min, max) {
  const n = typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label} isn't valid`);
  return n;
}

const idOf = (v, label = "Ingredient") => intOf(v, label, 1, 999999999);

function nameOf(v) {
  const name = clean(v, 40);
  if (name.length < 2) throw new HttpError(400, "Name: 2 to 40 characters");
  return name;
}

function unitOf(v) {
  if (!UNITS.includes(v)) throw new HttpError(400, "Unit must be g, ml or pcs");
  return v;
}

function dayOf(v) {
  const today = istParts().date;
  if (v === undefined || v === null || v === "") return today;
  const s = String(v);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : null;
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new HttpError(400, "Date: use the date picker");
  if (s > today) throw new HttpError(400, "A purchase can't be dated in the future");
  if (s < new Date(Date.parse(`${today}T00:00:00Z`) - 400 * 864e5).toISOString().slice(0, 10)) throw new HttpError(400, "That date is too long ago");
  return s;
}

const uniqueError = (e, message) => {
  if (String(e.message).includes("UNIQUE")) throw new HttpError(409, message);
  throw e;
};

/* ---------- ingredients ---------- */
const shape = (r) => ({
  id: r.id, name: r.name, unit: r.unit, onHand: round3(r.on_hand), lowAt: r.low_at, cost: r.cost, active: Boolean(r.active),
  low: Boolean(r.active) && r.on_hand <= r.low_at,
});

export async function listIngredients(db) {
  const { results } = await db.prepare("SELECT id, name, unit, on_hand, low_at, cost, active FROM ingredients ORDER BY active DESC, name COLLATE NOCASE").all();
  return results.map(shape);
}

// Active ingredients at or below their warning level.
export const lowStock = async (db) => (await listIngredients(db)).filter((i) => i.low);

async function ingredientsById(db, ids) {
  const uniq = [...new Set(ids)];
  const { results } = await db.prepare(`SELECT id, name, unit, on_hand, low_at, cost, active FROM ingredients WHERE id IN (${marks(uniq.length)})`).bind(...uniq).all();
  if (results.length !== uniq.length) throw new HttpError(404, "One of those ingredients doesn't exist");
  return new Map(results.map((r) => [r.id, r]));
}

export async function addIngredient(db, body) {
  const name = nameOf(body.name);
  const unit = unitOf(body.unit);
  const lowAt = body.lowAt === undefined ? 0 : qtyOf(body.lowAt, "Low-stock level", { zeroOk: true });
  const cost = body.cost === undefined ? 0 : intOf(body.cost, "Cost", 0, MAX_MONEY);
  const onHand = body.onHand === undefined ? 0 : qtyOf(body.onHand, "Stock now", { zeroOk: true });
  let res;
  try {
    res = await db.batch([
      db.prepare("INSERT INTO ingredients (name, unit, on_hand, low_at, cost) VALUES (?1, ?2, ?3, ?4, ?5)").bind(name, unit, onHand, lowAt, cost),
      db.prepare("INSERT INTO stock_moves (ingredient_id, delta, reason, ref, actor, at) SELECT last_insert_rowid(), ?1, 'count', 'opening stock', '', ?2 WHERE ?1 > 0").bind(onHand, now()),
    ]);
  } catch (e) { uniqueError(e, "You already have an ingredient with that name"); }
  return { id: res[0].meta.last_row_id, name };
}

export async function editIngredient(db, id, body) {
  const row = await db.prepare("SELECT id, name, unit FROM ingredients WHERE id = ?1").bind(id).first();
  if (!row) throw new HttpError(404, "Ingredient not found");
  const sets = [];
  const args = [];
  const add = (col, v) => { args.push(v); sets.push(`${col} = ?${args.length}`); };
  if (body.name !== undefined) add("name", nameOf(body.name));
  if (body.lowAt !== undefined) add("low_at", qtyOf(body.lowAt, "Low-stock level", { zeroOk: true }));
  if (body.cost !== undefined) add("cost", intOf(body.cost, "Cost", 0, MAX_MONEY));
  if (body.active !== undefined) add("active", body.active ? 1 : 0);
  if (body.unit !== undefined && body.unit !== row.unit) {
    unitOf(body.unit);
    const used = await db.prepare("SELECT (SELECT COUNT(*) FROM recipes WHERE ingredient_id = ?1) + (SELECT COUNT(*) FROM stock_moves WHERE ingredient_id = ?1) AS n").bind(id).first();
    if (used.n) throw new HttpError(409, "The unit can't change once the ingredient has been used. Add a new ingredient instead.");
    add("unit", body.unit);
  }
  if (!sets.length) throw new HttpError(400, "Nothing to change");
  args.push(id);
  try {
    await db.prepare(`UPDATE ingredients SET ${sets.join(", ")} WHERE id = ?${args.length}`).bind(...args).run();
  } catch (e) { uniqueError(e, "You already have an ingredient with that name"); }
  return body.name !== undefined ? nameOf(body.name) : row.name;
}

/* ---------- recipes ---------- */
export async function getRecipe(db, productId) {
  const { results } = await db.prepare(`SELECT r.ingredient_id, r.qty, i.name, i.unit, i.cost FROM recipes r
    JOIN ingredients i ON i.id = r.ingredient_id WHERE r.product_id = ?1 ORDER BY i.name COLLATE NOCASE`).bind(productId).all();
  return results.map((r) => ({ ingredientId: r.ingredient_id, name: r.name, unit: r.unit, qty: r.qty, cost: r.cost }));
}

// Which products have a recipe, and how many ingredients each uses.
export async function recipeCounts(db) {
  const { results } = await db.prepare("SELECT product_id, COUNT(*) AS n FROM recipes GROUP BY product_id").all();
  return Object.fromEntries(results.map((r) => [r.product_id, r.n]));
}

// Replaces the whole recipe of one product. An empty list removes it.
export async function setRecipe(db, productId, raw) {
  if (!Array.isArray(raw) || raw.length > MAX_RECIPE_LINES) throw new HttpError(400, `A recipe has up to ${MAX_RECIPE_LINES} ingredients`);
  const lines = raw.map((l) => ({ ingredientId: idOf(l?.ingredientId), qty: qtyOf(l?.qty, "Amount") }));
  if (new Set(lines.map((l) => l.ingredientId)).size !== lines.length) throw new HttpError(400, "Each ingredient can be listed only once");
  if (lines.length) await ingredientsById(db, lines.map((l) => l.ingredientId));
  await db.batch([
    db.prepare("DELETE FROM recipes WHERE product_id = ?1").bind(productId),
    ...lines.map((l) => db.prepare("INSERT INTO recipes (product_id, ingredient_id, qty) VALUES (?1, ?2, ?3)").bind(productId, l.ingredientId, l.qty)),
  ]);
  return lines.length;
}

/* ---------- taking stock when a bill is paid ---------- */
// The ingredients a paid order will use, as they stand now: Map(id -> { id, name, unit, on_hand, low_at }).
export async function ingredientsOfOrder(db, order) {
  const products = [...new Set(order.lines.map((l) => String(l.id)))];
  if (!products.length) return new Map();
  const { results } = await db.prepare(`SELECT id, name, unit, on_hand, low_at FROM ingredients WHERE active = 1
    AND id IN (SELECT ingredient_id FROM recipes WHERE product_id IN (${marks(products.length)}))`).bind(...products).all();
  return new Map(results.map((r) => [r.id, r]));
}

// Ingredients that were above their warning level before and are at or below it now.
export const crossedLow = (before, after) => [...after.values()].filter((a) => {
  const b = before.get(a.id);
  return b && b.on_hand > b.low_at && a.on_hand <= a.low_at;
});

export const lowStockText = (crossed) => `SEREN low stock: ${crossed.map((i) => `${i.name} ${round3(i.on_hand)} ${i.unit} left`).join(", ")}`;

/**
 * Statements that take a paid order's raw materials out of stock, exactly once.
 * A D1 batch is one transaction and runs in order. Every statement is guarded by "this order has stock_used = 0",
 * and the statement that sets stock_used = 1 comes LAST, so the guard stays true for all the others and a
 * second run (a retry, a double tap) finds the flag already set and changes nothing.
 */
export function useStockStmts(db, order) {
  const perProduct = new Map();
  for (const l of order.lines) perProduct.set(String(l.id), (perProduct.get(String(l.id)) || 0) + (Number(l.qty) || 0));
  const fresh = "EXISTS (SELECT 1 FROM orders WHERE id = ?1 AND stock_used = 0)";
  const at = now();
  const stmts = [];
  for (const [product, qty] of perProduct) {
    if (qty <= 0) continue;
    stmts.push(
      db.prepare(`INSERT INTO stock_moves (ingredient_id, delta, reason, ref, actor, at)
        SELECT r.ingredient_id, -(r.qty * ?3), 'sale', ?4, '', ?5 FROM recipes r WHERE r.product_id = ?2 AND ${fresh}`).bind(order.id, product, qty, order.code, at),
      db.prepare(`UPDATE ingredients SET on_hand = ROUND(on_hand - (SELECT r.qty FROM recipes r WHERE r.product_id = ?2 AND r.ingredient_id = ingredients.id) * ?3, 3)
        WHERE id IN (SELECT ingredient_id FROM recipes WHERE product_id = ?2) AND ${fresh}`).bind(order.id, product, qty),
    );
  }
  stmts.push(db.prepare("UPDATE orders SET stock_used = 1 WHERE id = ?1 AND stock_used = 0").bind(order.id));
  return stmts;
}

/* ---------- vendors ---------- */
export async function listVendors(db) {
  const { results } = await db.prepare("SELECT id, name, phone, gstin FROM vendors ORDER BY name COLLATE NOCASE").all();
  return results;
}

function vendorFields(body) {
  const name = nameOf(body.name);
  const phone = clean(body.phone, 15).replace(/[^\d+]/g, "");
  if (phone && !/^\+?\d{8,13}$/.test(phone)) throw new HttpError(400, "Phone number doesn't look right");
  const gstin = clean(body.gstin, 15).toUpperCase();
  if (gstin && !GSTIN.test(gstin)) throw new HttpError(400, "GSTIN doesn't look right");
  return { name, phone, gstin };
}

// Adds a vendor, or changes one when body.id is given.
export async function saveVendor(db, body) {
  const v = vendorFields(body);
  try {
    if (body.id !== undefined) {
      const id = idOf(body.id, "Vendor");
      const res = await db.prepare("UPDATE vendors SET name = ?1, phone = ?2, gstin = ?3 WHERE id = ?4").bind(v.name, v.phone, v.gstin, id).run();
      if (!res.meta.changes) throw new HttpError(404, "Vendor not found");
      return { id, ...v, created: false };
    }
    const res = await db.prepare("INSERT INTO vendors (name, phone, gstin) VALUES (?1, ?2, ?3)").bind(v.name, v.phone, v.gstin).run();
    return { id: res.meta.last_row_id, ...v, created: true };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return uniqueError(e, "You already have a vendor with that name");
  }
}

// A purchase names its vendor by id, or by name (an unknown name is added as a new vendor).
async function resolveVendor(db, body) {
  if (body.vendorId !== undefined && body.vendorId !== null && body.vendorId !== "") {
    const id = idOf(body.vendorId, "Vendor");
    const row = await db.prepare("SELECT id, name FROM vendors WHERE id = ?1").bind(id).first();
    if (!row) throw new HttpError(404, "Vendor not found");
    return row;
  }
  const name = clean(body.vendorName, 40);
  if (!name) return null;
  const found = await db.prepare("SELECT id, name FROM vendors WHERE name = ?1").bind(name).first();
  if (found) return found;
  const v = await saveVendor(db, { name, phone: body.vendorPhone, gstin: body.vendorGstin });
  return { id: v.id, name: v.name };
}

/* ---------- purchases ---------- */
export async function addPurchase(db, user, body) {
  if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > MAX_PURCHASE_LINES) throw new HttpError(400, `Add 1 to ${MAX_PURCHASE_LINES} items bought`);
  const lines = body.lines.map((l) => ({
    ingredientId: idOf(l?.ingredientId),
    qty: qtyOf(l?.qty, "Quantity bought"),
    amount: intOf(l?.amount, "Amount paid", 0, MAX_MONEY),
  }));
  const day = dayOf(body.day);
  const billNo = clean(body.billNo, 30);
  const have = await ingredientsById(db, lines.map((l) => l.ingredientId));
  const total = lines.reduce((n, l) => n + l.amount, 0);
  if (total > MAX_MONEY) throw new HttpError(400, "That total is too large");
  const paid = body.paid === undefined ? total : intOf(body.paid, "Paid so far", 0, total);
  const vendor = await resolveVendor(db, body);
  const at = now();
  const saved = lines.map((l) => ({ ingredient: l.ingredientId, name: have.get(l.ingredientId).name, qty: l.qty, amount: l.amount }));
  const res = await db.batch([
    db.prepare("INSERT INTO purchases (vendor_id, day, bill_no, total, paid, lines, actor, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
      .bind(vendor ? vendor.id : null, day, billNo, total, paid, JSON.stringify(saved), user.name, at),
    ...lines.flatMap((l) => [
      // the new cost is the weighted average of the stock we still have (never counting a negative balance) and what was just bought
      db.prepare(`UPDATE ingredients SET
          cost = CAST(ROUND((MAX(on_hand, 0) * cost + ?2 * 1000.0) / (MAX(on_hand, 0) + ?3)) AS INTEGER),
          on_hand = ROUND(on_hand + ?3, 3) WHERE id = ?1`).bind(l.ingredientId, l.amount, l.qty),
      db.prepare("INSERT INTO stock_moves (ingredient_id, delta, reason, ref, actor, at) VALUES (?1, ?2, 'purchase', (SELECT 'P' || MAX(id) FROM purchases), ?3, ?4)")
        .bind(l.ingredientId, l.qty, user.name, at),
    ]),
  ]);
  return { id: res[0].meta.last_row_id, total, vendor: vendor ? vendor.name : "", billNo, count: lines.length };
}

export async function listPurchases(db, limit = 50) {
  const { results } = await db.prepare(`SELECT p.id, p.day, p.bill_no, p.total, p.paid, p.lines, p.actor, p.at, v.name AS vendor
    FROM purchases p LEFT JOIN vendors v ON v.id = p.vendor_id ORDER BY p.id DESC LIMIT ?1`).bind(limit).all();
  return results.map((p) => ({ id: p.id, day: p.day, billNo: p.bill_no, total: p.total, paid: p.paid, vendor: p.vendor || "", actor: p.actor, at: p.at, lines: JSON.parse(p.lines) }));
}

/* ---------- wastage and counts ---------- */
export async function recordWastage(db, user, body) {
  const id = idOf(body.ingredientId);
  const qty = qtyOf(body.qty, "Amount wasted");
  const reason = clean(body.reason, 80);
  const row = (await ingredientsById(db, [id])).get(id);
  const at = now();
  await db.batch([
    db.prepare("UPDATE ingredients SET on_hand = ROUND(on_hand - ?2, 3) WHERE id = ?1").bind(id, qty),
    db.prepare("INSERT INTO stock_moves (ingredient_id, delta, reason, ref, actor, at) VALUES (?1, ?2, 'wastage', ?3, ?4, ?5)").bind(id, -qty, reason, user.name, at),
  ]);
  return { name: row.name, unit: row.unit, qty, reason };
}

// Sets stock to what was counted on the shelf; the difference is recorded as a correction.
export async function recordCount(db, user, body) {
  const id = idOf(body.ingredientId);
  const counted = qtyOf(body.counted, "Counted", { zeroOk: true });
  const row = (await ingredientsById(db, [id])).get(id);
  const at = now();
  await db.batch([
    db.prepare(`INSERT INTO stock_moves (ingredient_id, delta, reason, ref, actor, at)
      SELECT id, ROUND(?2 - on_hand, 3), 'count', 'stock count', ?3, ?4 FROM ingredients WHERE id = ?1 AND ROUND(?2 - on_hand, 3) != 0`).bind(id, counted, user.name, at),
    db.prepare("UPDATE ingredients SET on_hand = ?2 WHERE id = ?1").bind(id, counted),
  ]);
  return { name: row.name, unit: row.unit, before: round3(row.on_hand), counted, delta: round3(counted - row.on_hand) };
}

export async function listMoves(db, { ingredient, before, limit = 100 }) {
  const where = [];
  const args = [];
  if (ingredient) { args.push(ingredient); where.push(`m.ingredient_id = ?${args.length}`); }
  if (before) { args.push(before); where.push(`m.id < ?${args.length}`); }
  args.push(limit);
  const { results } = await db.prepare(`SELECT m.id, m.ingredient_id, i.name, i.unit, m.delta, m.reason, m.ref, m.actor, m.at
    FROM stock_moves m JOIN ingredients i ON i.id = m.ingredient_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY m.id DESC LIMIT ?${args.length}`).bind(...args).all();
  return results.map((m) => ({ id: m.id, ingredientId: m.ingredient_id, name: m.name, unit: m.unit, delta: round3(m.delta), reason: m.reason, ref: m.ref, actor: m.actor, at: m.at }));
}

/* ---------- food cost ---------- */
// For every product with a recipe: what its raw materials cost against today's selling price.
export async function foodCost(db) {
  const [{ results }, prices, catalog] = await Promise.all([
    db.prepare("SELECT r.product_id, r.qty, i.cost FROM recipes r JOIN ingredients i ON i.id = r.ingredient_id").all(),
    getPrices(db),
    loadCatalog(db),
  ]);
  const names = new Map(catalog.map((c) => [c.id, c.name]));
  const by = new Map();
  for (const r of results) {
    const e = by.get(r.product_id) || { cost: 0, unknown: 0 };
    e.cost += (r.qty * r.cost) / 1000;
    if (!r.cost) e.unknown += 1;
    by.set(r.product_id, e);
  }
  const items = [...by].map(([id, e]) => {
    const price = prices.get(id)?.price ?? null;
    const cost = Math.round(e.cost);
    return { id, name: names.get(id) || id, price, cost, costPercent: price ? Math.round((cost / price) * 1000) / 10 : null, unknownCosts: e.unknown };
  });
  return items.sort((a, b) => (b.costPercent ?? -1) - (a.costPercent ?? -1) || a.name.localeCompare(b.name));
}
