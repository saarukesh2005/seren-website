// Counter billing: walk-in bills, cake / advance orders, and orders from delivery apps (Swiggy, Zomato, ONDC, Magicpin…)
// all in one place, all on the same bill series, kitchen screen and reports.
import { approval } from "./auth.js";
import { HttpError, json, readJson } from "./http.js";
import { couponAmount, getCustomer, spendPointsStmts, usableCoupon, useCouponStmt } from "./offers.js";
import { checkCart, priceOrder } from "./pricing.js";
import { loadCatalog, orderable } from "./products.js";
import { METHODS, afterPaid, checkSplit } from "./routes-admin.js";
import { snapshot } from "./routes-public.js";
import { TABLE } from "./settings.js";
import { audit } from "./staff.js";
import { reserveStmts, shortage } from "./stock.js";
import * as store from "./store.js";
import { checkUtr } from "./upi.js";
import { addDays, istParts, randomCode, randomToken, rupees, safeEqual, sha256hex } from "./util.js";

const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const phoneOf = (v) => {
  const p = String(v || "").replace(/\D/g, "").slice(-10);
  return /^[6-9]\d{9}$/.test(p) ? p : "";
};
const lineKey = (l) => `${l.id}|${(l.opts || []).join(",")}|${l.qty}`;
const sameItems = (o, cart) => JSON.stringify(o.lines.map(lineKey).sort()) === JSON.stringify(cart.map(lineKey).sort());

// The counter app gives every bill its own id. If the same bill is sent twice (e.g. syncing after the internet
// came back) we return the bill already saved, but only if it really is the same bill.
async function alreadySaved(env, clientRef, cart) {
  const row = await env.DB.prepare("SELECT code FROM orders WHERE client_ref = ?1").bind(clientRef).first();
  if (!row) return null;
  const o = await store.getOrder(env.DB, row.code);
  if (!sameItems(o, cart)) throw new HttpError(409, "This bill id was already used for a different bill");
  return json({ order: o, duplicate: true });
}

/**
 * Prices a counter bill with coupon, loyalty points and a staff discount, asking for a manager's OK when
 * the discount or the points go past the owner's limits. Returns everything needed to save it.
 */
async function priceCounterBill(c, body, settings, { mode, phone, packing, service, platform }) {
  const { env, user } = c;
  const cart = checkCart(body.items);
  if (cart.error) throw new HttpError(400, cart.error);
  let coupon = null;
  if (body.coupon) {
    const found = await usableCoupon(env.DB, body.coupon, phone);
    if (found.error) throw new HttpError(400, found.error);
    coupon = found.coupon;
  }
  const points = Number(body.points) || 0;
  if (points) {
    if (!settings.loyalty.enabled) throw new HttpError(400, "Loyalty points are switched off");
    if (!phone) throw new HttpError(400, "Add the customer's mobile number to use points");
    if (!Number.isInteger(points) || points < 0) throw new HttpError(400, "Points must be a whole number");
    const cust = await getCustomer(env.DB, phone);
    if (!cust || cust.points < points) throw new HttpError(400, `This customer has ${cust ? cust.points : 0} points`);
  }
  const [prices, catalog] = await Promise.all([store.getPrices(env.DB), loadCatalog(env.DB)]);
  const items = orderable(catalog);
  // delivery apps pay the GST on these (section 9(5)) and settle the exact amount, so no GST and no rounding
  const pricing = platform ? { ...settings, gstin: "", charges: { ...settings.charges, roundOff: false } } : settings;
  const offers = { packing, service, platform, ...(coupon ? { coupon: (t) => couponAmount(coupon, t) } : {}), points: points * settings.loyalty.pointValue };
  let priced = priceOrder(cart.value, items, prices, pricing, mode, offers);
  if (priced.error) throw new HttpError(409, priced.error === "minOrder" ? "Below the minimum order" : priced.error);
  if (coupon && !priced.value.couponDiscount) throw new HttpError(400, `This code works on bills of ${rupees(coupon.min_order)} or more`);

  // a discount typed by staff: percent of the items, or an amount
  const d = body.discount && typeof body.discount === "object" ? body.discount : null;
  let manual = 0;
  if (d) {
    const pct = Number(d.percent || 0);
    const amt = Number(d.amount || 0);
    if (!(pct >= 0 && pct <= 100) || !Number.isInteger(amt) || amt < 0) throw new HttpError(400, "Discount: a percent (0–100) or an amount");
    manual = Math.min(pct ? Math.round((priced.value.subtotal * pct) / 100) : amt, priced.value.subtotal);
    if (manual) priced = priceOrder(cart.value, items, prices, pricing, mode, { ...offers, manual });
  }
  const reasons = [];
  if (manual > Math.round((priced.value.subtotal * settings.approvals.discountPercent) / 100)) reasons.push(`a ${rupees(manual)} discount`);
  // the points limit counts everything this customer spent today, so it can't be dodged bill by bill
  if (points) {
    const since = new Date(Date.now() - 86400000).toISOString();
    const row = await env.DB.prepare("SELECT COALESCE(SUM(-delta), 0) AS n FROM points_log WHERE phone = ?1 AND reason = 'spent' AND at >= ?2").bind(phone, since).first();
    if (points + row.n > settings.approvals.points) reasons.push(`spending ${points} points${row.n ? ` (${row.n} already today)` : ""}`);
  }
  const approvedBy = reasons.length ? await approval(env, env.DB, user, body, `Giving ${reasons.join(" and ")}`, store) : "";
  const usedPoints = settings.loyalty.pointValue ? Math.ceil(priced.value.pointsDiscount / settings.loyalty.pointValue) : 0;
  return { cart: cart.value, priced: priced.value, prices, coupon, usedPoints, approvedBy, manual };
}

// How the bill was paid: one method, or split (e.g. ₹200 cash + ₹150 UPI).
function payParts(body, total, settings) {
  const parts = body.split ? checkSplit(body.split, total) : null;
  const method = parts ? [...parts].sort((a, b) => b.amount - a.amount)[0].method : body.method;
  if (!METHODS.includes(method)) throw new HttpError(400, "Choose UPI, cash or card");
  const upiRef = parts ? (parts.find((p) => p.method === "upi") || {}).ref : body.method === "upi" ? body.utr : "";
  const hasUpi = parts ? parts.some((p) => p.method === "upi") : method === "upi";
  if (hasUpi && settings.approvals.counterUpiNeedsRef && !upiRef) throw new HttpError(400, "Type the UPI reference from the customer's payment screen");
  let utr = null;
  if (upiRef) {
    const u = checkUtr(upiRef);
    if (u.error) throw new HttpError(400, u.error);
    utr = u.value;
  }
  return { method, parts, utr };
}

const quoteOf = (p, settings) => ({
  total: p.priced.total, subtotal: p.priced.subtotal, discount: p.priced.discount, pointsUsed: p.usedPoints, couponCode: p.coupon ? p.coupon.code : "",
  charges: p.priced.charges.map((x) => ({ name: x.name, amount: x.gross })), roundOff: p.priced.roundOff,
  lines: p.priced.lines.map((l) => ({ id: l.id, name: l.name, qty: l.qty, amount: l.gross })),
  // the UPI ID always comes from the server, never from what the counter PC remembers
  upi: { id: settings.upiId, name: settings.upiName },
});

async function saveAndPay(c, o, { extra, pay, settings, audits }) {
  const { env, user } = c;
  const saved = await store.createOrder(env.DB, o, extra);
  if (saved.error === "duplicate") return null;
  if (saved.error === "external") throw new HttpError(409, "That app order number is already entered");
  if (saved.error === "points") throw new HttpError(409, "Not enough points");
  if (saved.error === "coupon") throw new HttpError(409, "That code has just been fully used");
  if (saved.error) throw new HttpError(409, (await shortage(env.DB, o.lines, o.date, await store.getPrices(env.DB))) || "Something is sold out");
  const created = await store.getOrder(env.DB, o.code);
  const result = await store.confirmPayment(env.DB, created, { method: pay.method, utr: pay.utr, prefix: settings.invoicePrefix, actor: user.name, payments: pay.parts });
  if (result === "taken") {
    await store.moveStatus(env.DB, created, "cancelled", "UPI reference already used", "system");
    throw new HttpError(409, "That UPI reference is already on another order");
  }
  const paid = await afterPaid(c, o.code, settings);
  await audit(env.DB, user, audits[0], `${o.code} ${paid.invoice_no} ${audits[1]}`, env);
  return paid;
}

/* ---------- walk-in bills ---------- */
export async function counterSale(c) {
  const { env, user } = c;
  const body = await readJson(c.request);
  const clientRef = body.clientRef === undefined ? null : String(body.clientRef);
  if (clientRef !== null && !/^[A-Za-z0-9-]{8,40}$/.test(clientRef)) throw new HttpError(400, "Bad bill id");
  if (clientRef && !c.quote) {
    const cart = checkCart(body.items);
    if (cart.error) throw new HttpError(400, cart.error);
    const done = await alreadySaved(env, clientRef, cart.value);
    if (done) return done;
  }
  const offlineAt = typeof body.offlineAt === "string" && !Number.isNaN(Date.parse(body.offlineAt)) ? new Date(body.offlineAt) : null;
  const settings = await store.getSettings(env.DB);
  const gstin = clean(body.gstin, 15).toUpperCase();
  if (gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) throw new HttpError(400, "Customer GSTIN doesn't look right");
  const phone = phoneOf(body.phone);
  const table = clean(body.table, 10);
  if (table && !TABLE.test(table)) throw new HttpError(400, "Table: up to 10 letters or numbers");
  const mode = table ? "dinein" : "counter";
  const p = await priceCounterBill(c, body, settings, { mode, phone, packing: body.packing === true, service: body.service !== false });
  if (c.quote) return json({ quote: quoteOf(p, settings) });

  const pay = payParts(body, p.priced.total, settings);
  if (pay.utr && (await env.DB.prepare("SELECT 1 FROM orders WHERE utr = ?1").bind(pay.utr).first())) throw new HttpError(409, "That UPI reference is already on another order");
  const code = `SRN-${randomCode()}`;
  const today = istParts();
  const rungBy = offlineAt ? clean(body.rungBy, 30) : "";
  const notes = [
    offlineAt ? `Billed offline at ${offlineAt.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}${rungBy && rungBy !== user.name ? ` by ${rungBy}` : ""}` : "",
    p.manual ? `Staff discount ${rupees(p.manual)}${p.approvedBy && p.approvedBy !== user.name ? ` (OK by ${p.approvedBy})` : ""}` : "",
  ].filter(Boolean).join(" · ");
  const order = {
    code, tokenHash: await sha256hex(randomToken()), source: "counter", status: "awaiting_payment",
    name: clean(body.name, 60), phone, gstin, mode, table, date: today.date, time: today.time,
    lines: p.priced.lines, subtotal: p.priced.subtotal, discount: p.priced.discount, couponCode: p.coupon ? p.coupon.code : "",
    pointsUsed: p.usedPoints, total: p.priced.total, taxSnapshot: snapshot(settings, p.priced), paymentMethod: pay.method,
    optIn: body.optIn === true && Boolean(phone), channel: "counter", actor: user.name, clientRef, notes, rungBy,
    expiresAt: new Date(Date.now() + 30 * 60000).toISOString(), // only matters if confirming below fails
  };
  const extra = [
    ...reserveStmts(env.DB, code, p.priced.lines, today.date, p.prices),
    ...(p.coupon ? [useCouponStmt(env.DB, p.coupon.code)] : []),
    ...(p.usedPoints ? spendPointsStmts(env.DB, phone, p.usedPoints, code) : []),
  ];
  const how = pay.parts ? pay.parts.map((x) => `${x.method} ${rupees(x.amount)}`).join(" + ") : pay.method;
  const paid = await saveAndPay(c, order, { extra, pay, settings, audits: ["counter bill", `${how}${p.usedPoints ? ` · ${p.usedPoints} points of ${phone}` : ""}${p.approvedBy && p.approvedBy !== user.name ? ` · OK by ${p.approvedBy}` : ""}`] });
  if (!paid) return alreadySaved(env, clientRef, p.cart);
  return json({ order: paid }, 201);
}

/* ---------- cake / advance orders ---------- */
// Booked at the counter for a later day: the customer pays an advance now and gets an advance receipt;
// the tax invoice is made when they collect and pay the rest (Orders → the booking → Confirm payment).
export async function advanceOrder(c) {
  const { env, user } = c;
  const body = await readJson(c.request);
  const settings = await store.getSettings(env.DB);
  const phone = phoneOf(body.phone);
  if (!phone) throw new HttpError(400, "Advance orders need the customer's 10-digit mobile number");
  const name = clean(body.name, 60);
  if (name.length < 2) throw new HttpError(400, "Customer name, please");
  const today = istParts().date;
  const date = String(body.date || "");
  const time = String(body.time || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today || date > addDays(today, 90)) throw new HttpError(400, "Pickup date: today up to 90 days ahead");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, "Pickup time like 17:30");
  const p = await priceCounterBill(c, body, settings, { mode: "pickup", phone, packing: body.packing !== false, service: false });
  const a = body.advance && typeof body.advance === "object" ? body.advance : {};
  const amount = Number(a.amount);
  if (!METHODS.includes(a.method)) throw new HttpError(400, "How was the advance paid? UPI, cash or card");
  if (!Number.isInteger(amount) || amount < 100 || amount > p.priced.total) throw new HttpError(400, `Advance: ₹1 up to the bill total ${rupees(p.priced.total)}`);
  const ref = a.method === "upi" && a.ref ? checkUtr(a.ref) : null;
  if (ref && ref.error) throw new HttpError(400, ref.error);

  const code = `SRN-${randomCode()}`;
  const order = {
    code, tokenHash: await sha256hex(randomToken()), source: "counter", status: "booked",
    name, phone, mode: "pickup", date, time, notes: clean(body.notes, 300), cakeMessage: clean(body.cakeMessage, 80),
    lines: p.priced.lines, subtotal: p.priced.subtotal, discount: p.priced.discount, couponCode: p.coupon ? p.coupon.code : "",
    pointsUsed: p.usedPoints, total: p.priced.total, taxSnapshot: snapshot(settings, p.priced), paymentMethod: a.method,
    optIn: body.optIn === true, channel: "counter", actor: user.name,
  };
  const extra = [
    ...reserveStmts(env.DB, code, p.priced.lines, date, p.prices),
    ...(p.coupon ? [useCouponStmt(env.DB, p.coupon.code)] : []),
    ...(p.usedPoints ? spendPointsStmts(env.DB, phone, p.usedPoints, code) : []),
  ];
  const saved = await store.createOrder(env.DB, order, extra);
  if (saved.error) throw new HttpError(409, saved.error === "stock" ? (await shortage(env.DB, p.priced.lines, date, p.prices)) || "Sold out that day" : "Couldn't save the booking");
  const booked = await store.getOrder(env.DB, code);
  if ((await store.takeAdvance(env.DB, booked, { method: a.method, amount, ref: ref ? ref.value : "", prefix: settings.invoicePrefix, actor: user.name })) !== "ok") {
    throw new HttpError(409, "Couldn't record the advance. Refresh and try again.");
  }
  const after = await store.getOrder(env.DB, code);
  await audit(env.DB, user, "advance order booked", `${code} ${after.receipt_no} ${rupees(amount)} of ${rupees(after.total)} for ${date} ${time}`);
  return json({ order: after }, 201);
}

/* ---------- Swiggy, Zomato, ONDC… in one place ---------- */
// Staff type the app's order (or a connector sends it, see hookOrder). It is billed on SEREN's series without GST
// (the app collects and pays GST on restaurant orders, section 9(5)), goes to the kitchen screen, and the
// reports show what the app owes after its commission.
async function platformOrder(c, body, settings) {
  const { env, user } = c;
  const platform = settings.platforms.find((x) => x.id === String(body.platform || "").toLowerCase());
  if (!platform) throw new HttpError(400, "Which app is this order from?");
  const externalId = clean(body.externalId, 40).replace(/\s+/g, "");
  if (!/^[A-Za-z0-9-]{3,40}$/.test(externalId)) throw new HttpError(400, `${platform.name} order number: 3 to 40 letters or numbers`);
  const existing = await env.DB.prepare("SELECT code FROM orders WHERE platform = ?1 AND external_id = ?2").bind(platform.id, externalId).first();
  if (existing) return { order: await store.getOrder(env.DB, existing.code), duplicate: true };
  const mode = body.mode === "pickup" ? "pickup" : "delivery";
  const p = await priceCounterBill(c, { items: body.items }, settings, { mode, phone: "", packing: false, service: false, platform: platform.id });
  const code = `SRN-${randomCode()}`;
  const today = istParts();
  const snap = { ...snapshot({ ...settings }, p.priced), platform: { id: platform.id, name: platform.name, commission: platform.commission,
    note: `Ordered on ${platform.name} (order ${externalId}). GST on this sale is collected and paid by ${platform.name} under section 9(5).` } };
  const order = {
    code, tokenHash: await sha256hex(randomToken()), source: "counter", status: "awaiting_payment",
    name: clean(body.name, 60) || `${platform.name} customer`, mode, date: today.date, time: today.time, notes: clean(body.notes, 300),
    lines: p.priced.lines, subtotal: p.priced.subtotal, discount: 0, total: p.priced.total, taxSnapshot: snap, paymentMethod: "upi",
    channel: "app", actor: user.name, platform: platform.id, externalId,
  };
  const pay = { method: "upi", utr: null, parts: [{ method: "platform", amount: p.priced.total, ref: externalId }] };
  const paid = await saveAndPay(c, order, { extra: reserveStmts(env.DB, code, p.priced.lines, today.date, p.prices), pay, settings, audits: ["app order", `${platform.name} ${externalId}`] });
  return { order: paid };
}

export async function appOrder(c) {
  const body = await readJson(c.request);
  const out = await platformOrder(c, body, await store.getSettings(c.env.DB));
  return json(out, out.duplicate ? 200 : 201);
}

// For a connector (UrbanPiper, n8n, Zapier…) that forwards app orders automatically.
// Off unless the owner sets the secret APP_ORDERS_TOKEN (32+ characters); the connector sends "Authorization: Bearer <token>".
export async function hookOrder(c) {
  const token = String(c.env.APP_ORDERS_TOKEN || "");
  const sent = (c.request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (token.length < 32 || !(await safeEqual(sent, token))) throw new HttpError(401, "Not allowed");
  const body = await readJson(c.request);
  const settings = await store.getSettings(c.env.DB);
  const out = await platformOrder({ ...c, user: { id: -1, name: "App connector", role: "system" } }, body, settings);
  return json({ code: out.order.code, invoice: out.order.invoice_no, duplicate: Boolean(out.duplicate) }, out.duplicate ? 200 : 201);
}

// A bill taken offline that the order system refused, removed from the counter PC by staff: recorded for the owner.
export async function droppedBill(c) {
  const body = await readJson(c.request);
  const ref = clean(body.clientRef, 40);
  if (!/^[A-Za-z0-9-]{8,40}$/.test(ref)) throw new HttpError(400, "Bad bill id");
  const amount = Number.isInteger(body.estimate) && body.estimate >= 0 ? body.estimate : 0;
  await audit(c.env.DB, c.user, "offline bill removed", `${ref} ${rupees(amount)}${body.rungBy ? ` rung by ${clean(body.rungBy, 30)}` : ""} · ${clean(body.problem, 120)}`, c.env);
  return json({ ok: true });
}
