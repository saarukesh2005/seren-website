// Dashboard API: logging in, orders, payments, refunds, WhatsApp messages, counter bills, kitchen.
// Every handler gets c = { request, env, ctx, url, params, user }.
import { ROLE_NAMES, PERMS, approval, can, checkLogin, clearCookie, endSession, sessionCookie } from "./auth.js";
import { notifyOwner } from "./notify.js";
import { HttpError, clientIp, json, readJson } from "./http.js";
import { crossedLow, ingredientsOfOrder, lowStockText, useStockStmts } from "./inventory.js";
import { invoiceHtml } from "./invoice.js";
import { kotHtml } from "./kot.js";
import { getCustomer, paidCustomerStmts, pointsFor, refundCustomerStmts, reholdCouponStmts } from "./offers.js";
import { audit } from "./staff.js";
import { KITCHEN_MOVES, NEEDS_MANAGER_TO_CANCEL, STATUS, TO_MAKE, canConfirmPayment, canMove } from "./status.js";
import { reholdStmts } from "./stock.js";
import * as store from "./store.js";
import { checkUtr } from "./upi.js";
import { addDays, istParts, rupees, sha256hex } from "./util.js";
import { ipKey, orderPayments } from "./routes-public.js";
import { stationFor } from "./settings.js";
import { ORDER_CODE } from "./validate.js";
import { fillTemplate, orderVars, sendTemplate, waMeLink } from "./whatsapp.js";

export const METHODS = ["upi", "cash", "card"];
const STATUSES = Object.keys(STATUS);

/* ---------- login ---------- */
const ACCOUNT_FAILS = 30; // wrong passwords for one name from ALL addresses together, per hour

export async function login({ request, env, ctx }) {
  const body = await readJson(request);
  const ip = ipKey(clientIp(request));
  const name = String(body.name || "owner").trim().toLowerCase().slice(0, 30) || "owner";
  const mine = `loginfail:${(await sha256hex(`${name}|${ip}`)).slice(0, 32)}`;
  const device = `loginfail:${(await sha256hex(`ip|${ip}`)).slice(0, 32)}`;
  const account = `loginfail:acct:${(await sha256hex(name)).slice(0, 32)}`;
  // Many wrong passwords for this name from everywhere: only devices that already got it wrong are stopped,
  // so a stranger can't lock the real owner out by guessing on purpose.
  if ((await store.limitReached(env.DB, account, ACCOUNT_FAILS, 3600)) && (await store.limitReached(env.DB, mine, 1, 900))) {
    throw new HttpError(429, "Too many wrong passwords for this login. Wait an hour, or use another device. The owner has been told.");
  }
  // every try is counted before the password is checked, so a burst of guesses can't slip past the limit;
  // a correct login takes its own try back, so staff starting a shift never lock each other out
  if ((await store.attemptOver(env.DB, mine, 5, 900)) | (await store.attemptOver(env.DB, device, 20, 900))) {
    throw new HttpError(429, "Too many wrong tries. Wait 15 minutes.");
  }
  const user = await checkLogin(env, env.DB, body.name, body.password);
  if (!user) {
    await store.countHit(env.DB, account, 3600);
    await audit(env.DB, null, "login failed", name);
    if (await store.limitReached(env.DB, account, ACCOUNT_FAILS, 3600)) {
      ctx.waitUntil(notifyOwner(env, `SEREN security: the login "${name}" got ${ACCOUNT_FAILS} wrong passwords in an hour. If this wasn't your staff, someone is guessing passwords.`));
    }
    throw new HttpError(401, "Wrong name or password");
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE rate_hits SET n = MAX(n - 1, 0) WHERE key = ?1").bind(mine),
    env.DB.prepare("UPDATE rate_hits SET n = MAX(n - 1, 0) WHERE key = ?1").bind(device),
  ]);
  await audit(env.DB, user, "logged in");
  return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env, env.DB, user) });
}

export async function logout({ request, env }) {
  await endSession(request, env.DB);
  return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
}

export const me = ({ user }) => json({
  user: { name: user.name, role: user.role, roleName: ROLE_NAMES[user.role] },
  perms: user.role === "owner" ? ["*"] : PERMS[user.role],
});

/* ---------- orders ---------- */
const RECENT_HOURS = 48; // cashiers and kitchen see recent orders only (customer details stay private)

export async function orders({ env, url, user }) {
  const p = url.searchParams;
  const since = can(user, "customers") ? undefined : new Date(Date.now() - RECENT_HOURS * 3600000).toISOString();
  const status = p.get("status") || "";
  if (status && status !== "active" && !STATUSES.includes(status)) throw new HttpError(400, "Unknown status");
  const list = await store.listOrders(env.DB, {
    status,
    q: (p.get("q") || "").slice(0, 40),
    before: Number(p.get("before")) || undefined,
    limit: Math.min(Number(p.get("limit")) || 50, 200),
    since,
  });
  return json({ orders: list, summary: await store.summary(env.DB), statuses: STATUS });
}

export async function findOrder(env, code) {
  if (!ORDER_CODE.test(code)) throw new HttpError(404, "Order not found");
  const order = await store.getOrder(env.DB, code);
  if (!order) throw new HttpError(404, "Order not found");
  return order;
}

// Cashiers and kitchen staff only open recent or still-open orders (older customer details stay private).
export function recentOnly(user, o) {
  if (can(user, "customers")) return o;
  const open = ["booked", "paid", "on_tab", "preparing", "ready", "out_for_delivery", "payment_submitted", "awaiting_payment"].includes(o.status);
  if (!open && o.created_at < new Date(Date.now() - RECENT_HOURS * 3600000).toISOString()) throw new HttpError(403, "Older orders are only shown to managers");
  return o;
}

export async function order({ env, params, user }) {
  const o = recentOnly(user, await findOrder(env, params[0]));
  const fb = await env.DB.prepare("SELECT stars, comment, at FROM feedback WHERE order_id = ?1").bind(o.id).first();
  const { results: payments } = await env.DB.prepare("SELECT kind, method, amount, ref, at, actor FROM payments WHERE order_id = ?1 ORDER BY id").bind(o.id).all();
  return json({ order: o, events: await store.getEvents(env.DB, o.id), statuses: STATUS, feedback: fb || null, payments });
}

// After money is confirmed: customer totals and loyalty points, closing a table's tab, automatic WhatsApp.
export async function afterPaid(c, code, settings) {
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
  // raw materials leave stock once per paid bill (see inventory.js); remember levels first to alert when one runs low
  const before = settings.lowStockAlerts ? await ingredientsOfOrder(c.env.DB, o) : null;
  stmts.push(...useStockStmts(c.env.DB, o));
  await c.env.DB.batch(stmts);
  if (before && before.size) {
    const crossed = crossedLow(before, await ingredientsOfOrder(c.env.DB, o));
    if (crossed.length) c.ctx.waitUntil(notifyOwner(c.env, lowStockText(crossed)));
  }
  if (o.customer_phone && settings.waApi.enabled && o.source === "online") {
    const token = await store.addOrderLink(c.env.DB, o.id);
    const v = orderVars(o, customerLink(settings, o.code, token));
    c.ctx.waitUntil(sendTemplate(c.env, settings, o.customer_phone, settings.waApi.paidTemplate, [v.name, v.code, v.total, v.link]));
  }
  return store.getOrder(c.env.DB, code); // fresh, with the points just added
}

const customerLink = (settings, code, token) => `${settings.siteUrl.replace(/\/?$/, "/")}order.html#${code}.${token}`;

// Checks a split payment: [{ method, amount, ref }] adding up to exactly what is due.
export function checkSplit(raw, due) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) throw new HttpError(400, "Split into 1 to 4 payments");
  const parts = raw.map((p) => ({ method: p?.method, amount: Number(p?.amount), ref: String(p?.ref || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 40) }));
  if (parts.some((p) => !METHODS.includes(p.method) || !Number.isInteger(p.amount) || p.amount <= 0)) throw new HttpError(400, "Each part needs cash, UPI or card and an amount");
  if (parts.reduce((n, p) => n + p.amount, 0) !== due) throw new HttpError(400, `The parts must add up to ${rupees(due)}`);
  return parts;
}
const mainMethod = (parts) => [...parts].sort((a, b) => b.amount - a.amount)[0].method;

export async function confirm(c) {
  const { env, params, user } = c;
  const o = await findOrder(env, params[0]);
  const body = await readJson(c.request);
  if (!canConfirmPayment(o.status)) throw new HttpError(409, `This order is already "${STATUS[o.status]}"`);
  const due = Math.max(o.total - (o.advance || 0), 0);
  const parts = body.split ? checkSplit(body.split, due) : null;
  const method = parts ? mainMethod(parts) : body.method;
  if (!METHODS.includes(method)) throw new HttpError(400, "Choose UPI, cash or card");
  // an online order marked as cash/card has no bank proof: a manager must agree
  let approvedBy = "";
  if (o.source === "online" && (parts ? parts.some((p) => p.method !== "upi") : method !== "upi")) {
    approvedBy = await approval(env, env.DB, user, body, "Marking an online order as paid in cash or card", store);
  }
  let utr = null;
  const upiPart = parts ? parts.find((p) => p.method === "upi") : null;
  if ((!parts && method === "upi" && (body.utr || !o.utr)) || (upiPart && upiPart.ref)) {
    const u = checkUtr(parts ? upiPart.ref : body.utr);
    if (u.error) throw new HttpError(400, u.error);
    utr = u.value;
  }
  const settings = await store.getSettings(env.DB);
  const result = await store.confirmPayment(env.DB, o, { method, utr, prefix: settings.invoicePrefix, actor: user.name, payments: parts });
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
  await audit(env.DB, user, "confirmed payment", `${o.code} ${paid.invoice_no} ${parts ? parts.map((p) => p.method).join("+") : method}${approvedBy && approvedBy !== user.name ? ` · OK by ${approvedBy}` : ""}`, env);
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
  let approvedBy = "";
  if (to === "cancelled" && NEEDS_MANAGER_TO_CANCEL.includes(o.status)) approvedBy = await approval(env, env.DB, user, body, "Cancelling food already sent to the kitchen", store);
  // giving back a cake advance: how the money went back
  const advanceBack = to === "cancelled" && o.advance > 0;
  if (advanceBack && ![...METHODS, "store_credit"].includes(body.refundMethod)) throw new HttpError(400, `How was the advance of ${rupees(o.advance)} given back?`);
  if (!(await store.moveStatus(env.DB, o, to, note, user.name))) throw new HttpError(409, "Someone else just changed this order. Refresh and try again.");
  if (advanceBack) {
    await env.DB.prepare("INSERT INTO payments (order_id, kind, method, amount, ref, at, actor, shift_id) VALUES (?1, 'refund', ?2, ?3, '', ?4, ?5, (SELECT id FROM shifts WHERE closed_at IS NULL))")
      .bind(o.id, body.refundMethod, o.advance, new Date().toISOString(), user.name).run();
  }
  if (to === "cancelled") await audit(env.DB, user, "cancelled order", `${o.code}${note ? ` (${note})` : ""}${advanceBack ? ` · advance ${rupees(o.advance)} back by ${body.refundMethod}` : ""}${approvedBy && approvedBy !== user.name ? ` · OK by ${approvedBy}` : ""}`, env);
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
  if (![...METHODS, "store_credit", "platform"].includes(body.method)) throw new HttpError(400, "How was the money returned?");
  const ref = String(body.ref || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40);
  const settings = await store.getSettings(env.DB);
  // points this bill earned that the customer has already spent can't be taken back: don't refund them as money too
  if (o.points_earned > 0 && o.customer_phone) {
    const cust = await getCustomer(env.DB, o.customer_phone);
    const spent = Math.max(o.points_earned - (cust ? cust.points : 0), 0);
    if (spent && !(user.role === "owner" && body.pointsOk === true)) {
      throw new HttpError(409, `The customer already used ${spent} points earned on this bill (worth ${rupees(spent * settings.loyalty.pointValue)}). Give back that much less, then the owner can finish the refund.`, { pointsSpent: spent });
    }
  }
  const result = await store.refundOrder(env.DB, o, { method: body.method, ref, prefix: settings.invoicePrefix, actor: user.name, extra: refundCustomerStmts(env.DB, o) });
  if (result === "stale") throw new HttpError(409, "Someone else just changed this order. Refresh and try again.");
  const after = await store.getOrder(env.DB, o.code);
  await audit(env.DB, user, "refunded", `${o.code} ${o.invoice_no} → ${after.credit_note_no} ${body.method}`, env);
  return json({ order: after });
}

// A WhatsApp message ready to send to the customer (opens the owner's WhatsApp; free).
export async function whatsappLink({ env, params, request, user }) {
  const o = recentOnly(user, await findOrder(env, params[0]));
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

/* ---------- printouts and kitchen ---------- */
export async function invoice({ env, params, url, user }, renderHtml) {
  const o = recentOnly(user, await findOrder(env, params[0]));
  return renderHtml(invoiceHtml(o, { size: url.searchParams.get("size"), payments: await orderPayments(env.DB, o.id) }));
}

// The advance receipt of a cake / advance order.
export async function advanceReceipt({ env, params, url, user }, renderHtml) {
  const o = recentOnly(user, await findOrder(env, params[0]));
  if (!o.receipt_no) throw new HttpError(404, "No advance on this order");
  return renderHtml(invoiceHtml(o, { size: url.searchParams.get("size") || "80mm", advance: true, payments: await orderPayments(env.DB, o.id) }));
}

export async function creditNote({ env, params, url, user }, renderHtml) {
  const o = recentOnly(user, await findOrder(env, params[0]));
  if (!o.credit_note_no) throw new HttpError(404, "No credit note for this order");
  return renderHtml(invoiceHtml(o, { size: url.searchParams.get("size"), credit: true, payments: await orderPayments(env.DB, o.id) }));
}

export async function kot({ env, params, url, user }, renderHtml) {
  const o = recentOnly(user, await findOrder(env, params[0]));
  // the kitchen screen prints tickets through a hidden frame on the same site
  const settings = await store.getSettings(env.DB);
  const station = settings.stations.list.includes(url.searchParams.get("station")) ? url.searchParams.get("station") : "";
  return renderHtml(kotHtml(o, { autoprint: url.searchParams.get("print") === "1", station, stationOf: (l) => stationFor(settings, l.category) }), 200, { "X-Frame-Options": "SAMEORIGIN" });
}

// What the kitchen should be making, earliest first. Each line says which station makes it;
// cake / advance bookings show from the day before they are due.
export async function kitchen({ env }) {
  const settings = await store.getSettings(env.DB);
  const tomorrow = addDays(istParts().date, 1);
  const list = (await store.listOrders(env.DB, { statuses: [...TO_MAKE, "ready", "booked"], limit: 150 }))
    .filter((o) => o.channel !== "tab" && (o.status !== "booked" || o.slot_date <= tomorrow));
  const sorted = [...list].sort((a, b) => `${a.slot_date} ${a.slot_time}`.localeCompare(`${b.slot_date} ${b.slot_time}`) || a.id - b.id);
  return json({
    stations: settings.stations.list,
    orders: sorted.map((o) => ({
      code: o.code, status: o.status, mode: o.mode, table: o.table_no, name: o.customer_name, date: o.slot_date, time: o.slot_time, notes: o.notes,
      cakeMessage: o.cake_message, app: o.tax_snapshot.platform ? o.tax_snapshot.platform.name : "", appOrder: o.external_id || "",
      lines: o.lines.map((l) => ({ name: l.name, qty: l.qty, station: stationFor(settings, l.category) })),
      createdAt: o.created_at, paid: Boolean(o.invoice_no), tab: o.channel === "table",
    })),
    statuses: STATUS,
  });
}
