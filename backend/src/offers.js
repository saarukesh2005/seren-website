// Coupons (discount codes) and loyalty points.
import { HttpError } from "./http.js";
import { istParts } from "./util.js";

const now = () => new Date().toISOString();
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export const normCode = (v) => String(v ?? "").trim().toUpperCase();
const CODE = /^[A-Z0-9]{3,20}$/;

/* ---------- coupons ---------- */
export function couponAmount(c, itemsTotal) {
  if (itemsTotal < c.min_order) return 0;
  const raw = c.kind === "percent" ? Math.floor((itemsTotal * c.value) / 100) : c.value;
  const capped = c.max_discount ? Math.min(raw, c.max_discount) : raw;
  return Math.min(capped, itemsTotal);
}

// Returns { coupon } or { error } in plain words for the customer.
export async function usableCoupon(db, rawCode, phone) {
  const code = normCode(rawCode);
  if (!CODE.test(code)) return { error: "That code doesn't exist" };
  const c = await db.prepare("SELECT * FROM coupons WHERE code = ?1").bind(code).first();
  const today = istParts().date;
  if (!c || !c.active) return { error: "That code doesn't exist" };
  if (c.starts && today < c.starts) return { error: "That code isn't active yet" };
  if (c.ends && today > c.ends) return { error: "That code has expired" };
  if (c.max_uses && c.uses >= c.max_uses) return { error: "That code has been fully used" };
  if (c.once_per_phone && !phone) return { error: "This code needs the customer's mobile number (one use per person)" };
  if (c.once_per_phone) {
    const used = await db.prepare("SELECT 1 FROM orders WHERE coupon_code = ?1 AND customer_phone = ?2 AND status NOT IN ('expired', 'cancelled') LIMIT 1").bind(code, phone).first();
    if (used) return { error: "You've already used this code" };
  }
  return { coupon: c };
}

export function checkCouponInput(body, existing) {
  const code = existing ? existing.code : normCode(body.code);
  if (!CODE.test(code)) throw new HttpError(400, "Code: 3–20 letters or numbers, e.g. WELCOME10");
  const kind = body.kind ?? existing?.kind;
  if (!["percent", "flat"].includes(kind)) throw new HttpError(400, "Choose % off or ₹ off");
  const int = (v, min, max, label) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label} isn't valid`);
    return n;
  };
  const value = int(body.value ?? existing?.value, 1, kind === "percent" ? 100 : 10000000, kind === "percent" ? "Percent (1–100)" : "Amount");
  const date = (v, label) => {
    const s = String(v ?? "");
    if (s && !YMD.test(s)) throw new HttpError(400, `${label} must be a date`);
    return s;
  };
  const out = {
    code, kind, value,
    min_order: int(body.min_order ?? existing?.min_order ?? 0, 0, 100000000, "Minimum order"),
    max_discount: int(body.max_discount ?? existing?.max_discount ?? 0, 0, 100000000, "Maximum discount"),
    starts: date(body.starts ?? existing?.starts, "Start"),
    ends: date(body.ends ?? existing?.ends, "End"),
    max_uses: int(body.max_uses ?? existing?.max_uses ?? 0, 0, 1000000, "Number of uses"),
    once_per_phone: (body.once_per_phone ?? existing?.once_per_phone) ? 1 : 0,
    active: (body.active ?? existing?.active ?? 1) ? 1 : 0,
    note: String(body.note ?? existing?.note ?? "").trim().slice(0, 100),
  };
  if (out.starts && out.ends && out.ends < out.starts) throw new HttpError(400, "End date is before the start date");
  if (existing && out.max_uses && out.max_uses < existing.uses) throw new HttpError(400, `Already used ${existing.uses} times`);
  return out;
}

export async function listCoupons(db) {
  const { results } = await db.prepare("SELECT * FROM coupons ORDER BY active DESC, created_at DESC").all();
  return results;
}

export async function saveCoupon(db, c, isNew) {
  try {
    if (isNew) {
      await db.prepare(`INSERT INTO coupons (code, kind, value, min_order, max_discount, starts, ends, max_uses, once_per_phone, active, note, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`)
        .bind(c.code, c.kind, c.value, c.min_order, c.max_discount, c.starts, c.ends, c.max_uses, c.once_per_phone, c.active, c.note, now()).run();
    } else {
      await db.prepare(`UPDATE coupons SET kind = ?2, value = ?3, min_order = ?4, max_discount = ?5, starts = ?6, ends = ?7, max_uses = ?8,
        once_per_phone = ?9, active = ?10, note = ?11 WHERE code = ?1`)
        .bind(c.code, c.kind, c.value, c.min_order, c.max_discount, c.starts, c.ends, c.max_uses, c.once_per_phone, c.active, c.note).run();
    }
  } catch (e) {
    if (String(e.message).includes("UNIQUE") || String(e.message).includes("PRIMARY")) throw new HttpError(409, "That code already exists");
    throw e;
  }
}

// Counts a use inside the order's transaction. The table's CHECK stops it going over max_uses.
export const useCouponStmt = (db, code) => db.prepare("UPDATE coupons SET uses = uses + 1 WHERE code = ?1").bind(code);

// Gives back a coupon use and spent points, but only once, and only if the order is really cancelled/expired now.
const GONE = "status IN ('expired', 'cancelled')";
export function releaseHeldStmts(db, orderId) {
  return [
    db.prepare(`UPDATE coupons SET uses = MAX(uses - 1, 0) WHERE code = (SELECT coupon_code FROM orders WHERE id = ?1 AND coupon_held = 1 AND ${GONE})`).bind(orderId),
    db.prepare(`UPDATE customers SET points = points + (SELECT points_used FROM orders WHERE id = ?1)
      WHERE phone = (SELECT customer_phone FROM orders WHERE id = ?1 AND points_held = 1 AND ${GONE})`).bind(orderId),
    db.prepare(`UPDATE orders SET coupon_held = 0, points_held = 0 WHERE id = ?1 AND ${GONE}`).bind(orderId),
  ];
}

// A late payment on an expired order: count its coupon use again (without going over the limit).
export function reholdCouponStmts(db, orderId) {
  return [
    db.prepare(`UPDATE coupons SET uses = uses + 1 WHERE code = (SELECT coupon_code FROM orders WHERE id = ?1 AND coupon_held = 0 AND coupon_code != '')
      AND (max_uses = 0 OR uses < max_uses)`).bind(orderId),
    db.prepare("UPDATE orders SET coupon_held = 1 WHERE id = ?1 AND coupon_code != ''").bind(orderId),
  ];
}

/* ---------- customers and loyalty ---------- */
export const pointsFor = (settings, total) => (settings.loyalty.enabled ? Math.floor(total / settings.loyalty.earnEvery) : 0);

export async function getCustomer(db, phone) {
  return db.prepare("SELECT * FROM customers WHERE phone = ?1").bind(phone).first();
}

// After a payment is confirmed: update the customer's totals and add their points (all in one go).
export function paidCustomerStmts(db, order, earned) {
  const at = now();
  const stmts = [
    db.prepare(`INSERT INTO customers (phone, name, first_at, last_at, orders, spent, points, opt_in, opt_in_at)
      VALUES (?1, ?2, ?3, ?3, 1, ?4, ?5, ?6, CASE WHEN ?6 = 1 THEN ?3 END)
      ON CONFLICT (phone) DO UPDATE SET name = CASE WHEN excluded.name != '' THEN excluded.name ELSE name END, last_at = excluded.last_at,
        orders = orders + 1, spent = spent + excluded.spent, points = points + excluded.points,
        opt_in = MAX(opt_in, excluded.opt_in), opt_in_at = COALESCE(opt_in_at, excluded.opt_in_at)`)
      .bind(order.customer_phone, order.customer_name, at, order.total, earned, order.opt_in ? 1 : 0),
    db.prepare("UPDATE orders SET points_earned = ?1 WHERE id = ?2").bind(earned, order.id),
  ];
  if (earned) stmts.push(db.prepare("INSERT INTO points_log (phone, order_id, delta, reason, at) VALUES (?1, ?2, ?3, 'earned', ?4)").bind(order.customer_phone, order.id, earned, at));
  return stmts;
}

// Points spent on a counter bill. The CHECK (points >= 0) stops spending more than the customer has.
export function spendPointsStmts(db, phone, points, orderCode) {
  const at = now();
  return [
    db.prepare("UPDATE customers SET points = points - ?1 WHERE phone = ?2").bind(points, phone),
    db.prepare("INSERT INTO points_log (phone, order_id, delta, reason, at) VALUES (?1, (SELECT id FROM orders WHERE code = ?2), ?3, 'spent', ?4)").bind(phone, orderCode, -points, at),
  ];
}

// A refund takes back the points that order earned (points it used come back through releaseHeldStmts).
export function refundCustomerStmts(db, order) {
  if (!order.customer_phone) return [];
  const at = now();
  const delta = -order.points_earned;
  return [
    db.prepare("UPDATE customers SET points = MAX(points + ?1, 0), orders = MAX(orders - 1, 0), spent = MAX(spent - ?2, 0) WHERE phone = ?3")
      .bind(delta, order.total, order.customer_phone),
    db.prepare("INSERT INTO points_log (phone, order_id, delta, reason, at) VALUES (?1, ?2, ?3, 'refund', ?4)").bind(order.customer_phone, order.id, delta, at),
  ];
}

export async function listCustomers(db, { q = "", optIn = false, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (q) { args.push(`%${q.replace(/[%_]/g, "")}%`); where.push(`(phone LIKE ?${args.length} OR name LIKE ?${args.length})`); }
  if (optIn) where.push("opt_in = 1");
  args.push(Math.min(limit, 1000));
  const { results } = await db.prepare(`SELECT * FROM customers ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY last_at DESC LIMIT ?${args.length}`).bind(...args).all();
  return results;
}

// The product a customer orders most (from their paid orders).
export async function favourites(db, phones) {
  if (!phones.length) return new Map();
  const marks = phones.map((_, i) => `?${i + 1}`).join(",");
  const { results } = await db.prepare(`SELECT customer_phone AS phone, json_extract(j.value, '$.name') AS name, SUM(json_extract(j.value, '$.qty')) AS qty
    FROM orders o, json_each(o.lines) j WHERE o.customer_phone IN (${marks}) AND o.invoice_no IS NOT NULL AND o.status != 'cancelled'
    GROUP BY customer_phone, json_extract(j.value, '$.id') ORDER BY qty DESC`).bind(...phones).all();
  const out = new Map();
  for (const r of results) if (!out.has(r.phone)) out.set(r.phone, r.name);
  return out;
}

export async function updateCustomer(db, phone, body) {
  const row = await getCustomer(db, phone);
  if (!row) throw new HttpError(404, "Customer not found");
  const notes = body.notes === undefined ? row.notes : String(body.notes).slice(0, 300);
  const optIn = body.opt_in === undefined ? row.opt_in : body.opt_in ? 1 : 0;
  let birthday = row.birthday || "";
  if (body.birthday !== undefined) {
    birthday = String(body.birthday || "");
    const m = /^(\d{2})-(\d{2})$/.exec(birthday);
    const ok = birthday === "" || (m && Number(m[1]) >= 1 && Number(m[1]) <= 12 && Number(m[2]) >= 1 && Number(m[2]) <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][Number(m[1]) - 1]);
    if (!ok) throw new HttpError(400, "Birthday: pick a day and month");
  }
  await db.prepare("UPDATE customers SET notes = ?1, opt_in = ?2, opt_in_at = CASE WHEN ?2 = 1 THEN COALESCE(opt_in_at, ?3) ELSE NULL END, birthday = ?5 WHERE phone = ?4")
    .bind(notes, optIn, now(), phone, birthday).run();
}

// Customers with a birthday in the next `days` days (India dates), soonest first.
export async function upcomingBirthdays(db, days = 7) {
  const start = Date.now() + 330 * 60000;
  const wanted = Array.from({ length: days }, (_, i) => new Date(start + i * 86400000).toISOString().slice(5, 10));
  const { results } = await db.prepare(`SELECT phone, name, birthday, opt_in, orders, spent FROM customers WHERE birthday IN (${wanted.map((_, i) => `?${i + 1}`).join(",")})`).bind(...wanted).all();
  return results.map((r) => ({ ...r, inDays: wanted.indexOf(r.birthday) })).sort((a, b) => a.inDays - b.inDays);
}
