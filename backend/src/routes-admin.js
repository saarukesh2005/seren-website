// Dashboard API: logging in, orders, payments, refunds, WhatsApp messages, counter bills, kitchen.
// Every handler gets c = { request, env, ctx, url, params, user }.
import { ROLE_NAMES, PERMS, can, checkLogin, clearCookie, sessionCookie } from "./auth.js";
import { HttpError, clientIp, json, readJson } from "./http.js";
import { invoiceHtml } from "./invoice.js";
import { kotHtml } from "./kot.js";
import { couponAmount, getCustomer, paidCustomerStmts, pointsFor, refundCustomerStmts, reholdCouponStmts, spendPointsStmts, usableCoupon, useCouponStmt } from "./offers.js";
import { checkCart, priceOrder } from "./pricing.js";
import { loadCatalog, orderable } from "./products.js";
import { TABLE } from "./settings.js";
import { audit } from "./staff.js";
import { KITCHEN_MOVES, STATUS, TO_MAKE, canConfirmPayment, canMove } from "./status.js";
import { reholdStmts, reserveStmts, shortage } from "./stock.js";
import * as store from "./store.js";
import { checkUtr } from "./upi.js";
import { istParts, randomCode, randomToken, sha256hex } from "./util.js";
import { ipKey, snapshot } from "./routes-public.js";
import { ORDER_CODE } from "./validate.js";
import { fillTemplate, orderVars, sendTemplate, waMeLink } from "./whatsapp.js";

const METHODS = ["upi", "cash", "card"];
const STATUSES = Object.keys(STATUS);

/* ---------- login ---------- */
export async function login({ request, env }) {
  const body = await readJson(request);
  const ip = ipKey(clientIp(request));
  const name = String(body.name || "owner").trim().toLowerCase().slice(0, 30) || "owner";
  // only FAILED attempts count, so staff logging in at the start of a shift never lock each other out
  const keys = [[`loginfail:${(await sha256hex(`${name}|${ip}`)).slice(0, 32)}`, 5], [`loginfail:${(await sha256hex(`ip|${ip}`)).slice(0, 32)}`, 20]];
  for (const [key, max] of keys) if (await store.limitReached(env.DB, key, max, 900)) throw new HttpError(429, "Too many wrong tries. Wait 15 minutes.");
  const user = await checkLogin(env, env.DB, body.name, body.password);
  if (!user) {
    for (const [key] of keys) await store.countHit(env.DB, key, 900);
    await audit(env.DB, null, "login failed", name);
    throw new HttpError(401, "Wrong name or password");
  }
  await audit(env.DB, user, "logged in");
  return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env, user) });
}

export const logout = () => json({ ok: true }, 200, { "Set-Cookie": clearCookie() });

export const me = ({ user }) => json({
  user: { name: user.name, role: user.role, roleName: ROLE_NAMES[user.role] },
  perms: user.role === "owner" ? ["*"] : PERMS[user.role],
});

/* ---------- orders ---------- */
export async function orders({ env, url }) {
  const p = url.searchParams;
  const status = p.get("status") || "";
  if (status && status !== "active" && !STATUSES.includes(status)) throw new HttpError(400, "Unknown status");
  const list = await store.listOrders(env.DB, {
    status,
    q: (p.get("q") || "").slice(0, 40),
    before: Number(p.get("before")) || undefined,
    limit: Math.min(Number(p.get("limit")) || 50, 200),
  });
  return json({ orders: list, summary: await store.summary(env.DB), statuses: STATUS });
}

export async function findOrder(env, code) {
  if (!ORDER_CODE.test(code)) throw new HttpError(404, "Order not found");
  const order = await store.getOrder(env.DB, code);
  if (!order) throw new HttpError(404, "Order not found");
  return order;
}

export async function order({ env, params }) {
  const o = await findOrder(env, params[0]);
  const fb = await env.DB.prepare("SELECT stars, comment, at FROM feedback WHERE order_id = ?1").bind(o.id).first();
  return json({ order: o, events: await store.getEvents(env.DB, o.id), statuses: STATUS, feedback: fb || null });
}

// After money is confirmed: customer totals and loyalty points, closing a table's tab, automatic WhatsApp.
async function afterPaid(c, code, settings) {
  const o = await store.getOrder(c.env.DB, code);
  const stmts = [];
  if (o.customer_phone) stmts.push(...paidCustomerStmts(c.env.DB, o, pointsFor(settings, o.total)));
  if (o.channel === "tab" && o.tab_id) {
    // the table bill only collects money; the food was made round by round
    stmts.push(
      c.env.DB.prepare("UPDATE tabs SET status = 'closed', closed_at = ?1 WHERE id = ?2").bind(new Date().toISOString(), o.tab_id),
      c.env.DB.prepare("UPDATE orders SET status = 'completed' WHERE id = ?1 AND status = 'paid'").bind(o.id),
    );
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  if (o.customer_phone && settings.waApi.enabled && o.source === "online") {
    const token = await store.addOrderLink(c.env.DB, o.id);
    const v = orderVars(o, customerLink(settings, o.code, token));
    c.ctx.waitUntil(sendTemplate(c.env, settings, o.customer_phone, settings.waApi.paidTemplate, [v.name, v.code, v.total, v.link]));
  }
  return store.getOrder(c.env.DB, code); // fresh, with the points just added
}

const customerLink = (settings, code, token) => `${settings.siteUrl.replace(/\/?$/, "/")}order.html#${code}.${token}`;

export async function confirm(c) {
  const { env, params, user } = c;
  const o = await findOrder(env, params[0]);
  const body = await readJson(c.request);
  if (!METHODS.includes(body.method)) throw new HttpError(400, "Choose UPI, cash or card");
  if (!canConfirmPayment(o.status)) throw new HttpError(409, `This order is already "${STATUS[o.status]}"`);
  let utr = null;
  if (body.method === "upi" && (body.utr || !o.utr)) {
    const u = checkUtr(body.utr);
    if (u.error) throw new HttpError(400, u.error);
    utr = u.value;
  }
  const settings = await store.getSettings(env.DB);
  const result = await store.confirmPayment(env.DB, o, { method: body.method, utr, prefix: settings.invoicePrefix, actor: user.name });
  if (result === "taken") throw new HttpError(409, "That UPI reference is already on another order");
  if (result === "stale") throw new HttpError(409, "Someone else just changed this order. Refresh and try again.");
  if (o.status === "expired") {
    // it expired before the money arrived, so its stock, coupon and points were given back: take them again
    await env.DB.batch([
      ...reholdStmts(env.DB, o, await store.getPrices(env.DB)),
      ...reholdCouponStmts(env.DB, o.id),
      env.DB.prepare(`UPDATE customers SET points = MAX(points - (SELECT points_used FROM orders WHERE id = ?1 AND points_held = 0), 0)
        WHERE phone = ?2 AND EXISTS (SELECT 1 FROM orders WHERE id = ?1 AND points_used > 0 AND points_held = 0)`).bind(o.id, o.customer_phone),
      env.DB.prepare("UPDATE orders SET points_held = 1 WHERE id = ?1 AND points_used > 0").bind(o.id),
    ]);
  }
  const paid = await afterPaid(c, o.code, settings);
  await audit(env.DB, user, "confirmed payment", `${o.code} ${paid.invoice_no} ${body.method}`);
  return json({ order: paid });
}

export async function move(c) {
  const { env, params, user } = c;
  const o = await findOrder(env, params[0]);
  const body = await readJson(c.request);
  const to = body.to;
  if (!can(user, "orders") && !(can(user, "kitchen") && KITCHEN_MOVES.includes(to))) throw new HttpError(403, "Your login can't do that. Ask the owner.");
  if (to === "cancelled" && o.invoice_no) throw new HttpError(409, "This order was paid. Use Refund, so the accounts get a credit note.");
  if (!canMove(o.status, to)) throw new HttpError(409, `Can't move from "${STATUS[o.status]}" to "${STATUS[to] || to}"`);
  const note = String(body.note || "").trim().slice(0, 200);
  if (!(await store.moveStatus(env.DB, o, to, note, user.name))) throw new HttpError(409, "Someone else just changed this order. Refresh and try again.");
  if (to === "cancelled") await audit(env.DB, user, "cancelled order", o.code);
  const settings = await store.getSettings(env.DB);
  if (["ready", "out_for_delivery"].includes(to) && o.customer_phone && settings.waApi.enabled && settings.waApi.readyTemplate && o.mode !== "dinein") {
    const v = orderVars(o, "");
    c.ctx.waitUntil(sendTemplate(env, settings, o.customer_phone, settings.waApi.readyTemplate, [v.name, v.code]));
  }
  return json({ order: await store.getOrder(env.DB, o.code) });
}

export async function note({ env, params, request }) {
  const o = await findOrder(env, params[0]);
  const body = await readJson(request);
  await store.setAdminNote(env.DB, o.id, String(body.note || "").trim().slice(0, 500));
  return json({ ok: true });
}

export async function refund({ env, params, request, user }) {
  const o = await findOrder(env, params[0]);
  const body = await readJson(request);
  if (!o.invoice_no) throw new HttpError(409, "Only paid orders can be refunded. Cancel it instead.");
  if (o.credit_note_no) throw new HttpError(409, "Already refunded");
  if (![...METHODS, "store_credit"].includes(body.method)) throw new HttpError(400, "How was the money returned?");
  const ref = String(body.ref || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40);
  const settings = await store.getSettings(env.DB);
  const result = await store.refundOrder(env.DB, o, { method: body.method, ref, prefix: settings.invoicePrefix, actor: user.name, extra: refundCustomerStmts(env.DB, o) });
  if (result === "stale") throw new HttpError(409, "Someone else just changed this order. Refresh and try again.");
  const after = await store.getOrder(env.DB, o.code);
  await audit(env.DB, user, "refunded", `${o.code} ${o.invoice_no} → ${after.credit_note_no} ${body.method}`);
  return json({ order: after });
}

// A WhatsApp message ready to send to the customer (opens the owner's WhatsApp; free).
export async function whatsappLink({ env, params, request, user }) {
  const o = await findOrder(env, params[0]);
  const body = await readJson(request);
  const settings = await store.getSettings(env.DB);
  const template = settings.waTemplates[body.kind];
  if (!template) throw new HttpError(400, "Unknown message");
  if (!/^[6-9]\d{9}$/.test(o.customer_phone)) throw new HttpError(409, "This order has no mobile number");
  const token = await store.addOrderLink(env.DB, o.id);
  const text = fillTemplate(template, orderVars(o, customerLink(settings, o.code, token)));
  await audit(env.DB, user, "whatsapp message", `${o.code} ${body.kind}`);
  return json({ url: waMeLink(o.customer_phone, text), text });
}

/* ---------- counter bills ---------- */
// A bill for a walk-in customer: created already paid, with its invoice number. Coupons and loyalty points work here.
export async function counterSale(c) {
  const { env, request, user } = c;
  const body = await readJson(request);
  // The counter app gives every bill its own id. If the same bill is sent twice (e.g. syncing after
  // the internet came back), we return the bill already saved instead of making a second one.
  const clientRef = body.clientRef === undefined ? null : String(body.clientRef);
  if (clientRef !== null && !/^[A-Za-z0-9-]{8,40}$/.test(clientRef)) throw new HttpError(400, "Bad bill id");
  if (clientRef) {
    const existing = await env.DB.prepare("SELECT code FROM orders WHERE client_ref = ?1").bind(clientRef).first();
    if (existing) return json({ order: await store.getOrder(env.DB, existing.code), duplicate: true });
  }
  const offlineAt = typeof body.offlineAt === "string" && !Number.isNaN(Date.parse(body.offlineAt)) ? new Date(body.offlineAt) : null;
  const settings = await store.getSettings(env.DB);
  const cart = checkCart(body.items);
  if (cart.error) throw new HttpError(400, cart.error);
  if (!METHODS.includes(body.method)) throw new HttpError(400, "Choose UPI, cash or card");
  let utr = null;
  if (body.method === "upi" && body.utr) {
    const u = checkUtr(body.utr);
    if (u.error) throw new HttpError(400, u.error);
    utr = u.value;
  }
  if (utr && (await env.DB.prepare("SELECT 1 FROM orders WHERE utr = ?1").bind(utr).first())) throw new HttpError(409, "That UPI reference is already on another order");
  const gstin = String(body.gstin || "").trim().toUpperCase();
  if (gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) throw new HttpError(400, "Customer GSTIN doesn't look right");
  const phone = String(body.phone || "").replace(/\D/g, "").slice(-10);
  const validPhone = /^[6-9]\d{9}$/.test(phone) ? phone : "";
  const table = String(body.table || "").trim();
  if (table && !TABLE.test(table)) throw new HttpError(400, "Table: up to 10 letters or numbers");

  let coupon = null;
  if (body.coupon) {
    const found = await usableCoupon(env.DB, body.coupon, validPhone);
    if (found.error) throw new HttpError(400, found.error);
    coupon = found.coupon;
  }
  // loyalty points: only staff can spend them (they can see the customer in front of them)
  const points = Number(body.points) || 0;
  if (points) {
    if (!settings.loyalty.enabled) throw new HttpError(400, "Loyalty points are switched off");
    if (!validPhone) throw new HttpError(400, "Add the customer's mobile number to use points");
    if (!Number.isInteger(points) || points < 0) throw new HttpError(400, "Points must be a whole number");
    const cust = await getCustomer(env.DB, validPhone);
    if (!cust || cust.points < points) throw new HttpError(400, `This customer has ${cust ? cust.points : 0} points`);
  }

  const [prices, catalog] = await Promise.all([store.getPrices(env.DB), loadCatalog(env.DB)]);
  const priced = priceOrder(cart.value, orderable(catalog), prices, settings, "counter", {
    ...(coupon ? { coupon: (t) => couponAmount(coupon, t) } : {}),
    points: points * settings.loyalty.pointValue,
  });
  if (priced.error) throw new HttpError(409, priced.error);
  const usedPoints = settings.loyalty.pointValue ? Math.ceil(priced.value.pointsDiscount / settings.loyalty.pointValue) : 0;
  // price check only (the counter app shows the exact amount on the UPI QR before the customer pays)
  if (c.quote) {
    return json({ quote: { total: priced.value.total, subtotal: priced.value.subtotal, discount: priced.value.discount, pointsUsed: usedPoints,
      couponCode: coupon ? coupon.code : "", lines: priced.value.lines.map((l) => ({ id: l.id, name: l.name, qty: l.qty, amount: l.gross })) } });
  }
  const code = `SRN-${randomCode()}`;
  const today = istParts();
  const extra = [
    ...reserveStmts(env.DB, code, priced.value.lines, today.date, prices),
    ...(coupon ? [useCouponStmt(env.DB, coupon.code)] : []),
    ...(usedPoints ? spendPointsStmts(env.DB, validPhone, usedPoints, code) : []),
  ];
  const saved = await store.createOrder(env.DB, {
    code, tokenHash: await sha256hex(randomToken()), source: "counter", status: "awaiting_payment",
    name: String(body.name || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60), phone: validPhone, gstin,
    mode: table ? "dinein" : "counter", table, date: today.date, time: today.time,
    lines: priced.value.lines, subtotal: priced.value.subtotal, discount: priced.value.discount, couponCode: coupon ? coupon.code : "",
    pointsUsed: usedPoints, total: priced.value.total, taxSnapshot: snapshot(settings, priced.value), paymentMethod: body.method,
    optIn: body.optIn === true && Boolean(validPhone), channel: "counter", actor: user.name, clientRef,
    notes: offlineAt ? `Billed offline at ${offlineAt.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}` : "",
    expiresAt: new Date(Date.now() + 30 * 60000).toISOString(), // only matters if confirming below fails
  }, extra);
  if (saved.error === "duplicate") {
    const existing = await env.DB.prepare("SELECT code FROM orders WHERE client_ref = ?1").bind(clientRef).first();
    return json({ order: await store.getOrder(env.DB, existing.code), duplicate: true });
  }
  if (saved.error === "points") throw new HttpError(409, "Not enough points");
  if (saved.error === "coupon") throw new HttpError(409, "That code has just been fully used");
  if (saved.error) throw new HttpError(409, (await shortage(env.DB, priced.value.lines, today.date, prices)) || "Something is sold out");
  const created = await store.getOrder(env.DB, code);
  const result = await store.confirmPayment(env.DB, created, { method: body.method, utr, prefix: settings.invoicePrefix, actor: user.name });
  if (result === "taken") {
    await store.moveStatus(env.DB, created, "cancelled", "UPI reference already used", "system");
    throw new HttpError(409, "That UPI reference is already on another order");
  }
  const paid = await afterPaid(c, code, settings);
  await audit(env.DB, user, "counter bill", `${code} ${paid.invoice_no} ${body.method}${usedPoints ? ` · ${usedPoints} points of ${validPhone}` : ""}`);
  return json({ order: paid }, 201);
}

/* ---------- printouts and kitchen ---------- */
export async function invoice({ env, params, url }, renderHtml) {
  const o = await findOrder(env, params[0]);
  return renderHtml(invoiceHtml(o, { size: url.searchParams.get("size") }));
}

export async function creditNote({ env, params, url }, renderHtml) {
  const o = await findOrder(env, params[0]);
  if (!o.credit_note_no) throw new HttpError(404, "No credit note for this order");
  return renderHtml(invoiceHtml(o, { size: url.searchParams.get("size"), credit: true }));
}

export async function kot({ env, params, url }, renderHtml) {
  const o = await findOrder(env, params[0]);
  // the kitchen screen prints tickets through a hidden frame on the same site
  return renderHtml(kotHtml(o, { autoprint: url.searchParams.get("print") === "1" }), 200, { "X-Frame-Options": "SAMEORIGIN" });
}

// What the kitchen should be making, earliest first.
export async function kitchen({ env }) {
  const list = (await store.listOrders(env.DB, { statuses: [...TO_MAKE, "ready"], limit: 100 })).filter((o) => o.channel !== "tab");
  const sorted = [...list].sort((a, b) => `${a.slot_date} ${a.slot_time}`.localeCompare(`${b.slot_date} ${b.slot_time}`) || a.id - b.id);
  return json({ orders: sorted.map((o) => ({ code: o.code, status: o.status, mode: o.mode, table: o.table_no, name: o.customer_name, date: o.slot_date, time: o.slot_time, notes: o.notes, lines: o.lines.map((l) => ({ name: l.name, qty: l.qty })), createdAt: o.created_at, paid: Boolean(o.invoice_no), tab: o.channel === "table" })), statuses: STATUS });
}
