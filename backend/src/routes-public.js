// What the public website calls: menu, slots, coupons, placing an order, paying, tracking, feedback, tables.
// Every handler gets c = { request, env, ctx, url, params }.
import { HttpError, clientIp, json, readJson } from "./http.js";
import { invoiceHtml } from "./invoice.js";
import { newOrderText, notifyOwner, paidClaimText } from "./notify.js";
import { couponAmount, usableCoupon, useCouponStmt } from "./offers.js";
import { checkCart, priceOrder } from "./pricing.js";
import { imageResponse, loadCatalog, orderable } from "./products.js";
import { checkSlot, needsNotice, slotDays } from "./schedule.js";
import { TABLE, publicSettings } from "./settings.js";
import { STATUS } from "./status.js";
import { leftOn, reserveStmts, shortage } from "./stock.js";
import * as store from "./store.js";
import { addCall, billToken, checkTabPin, mergeLines, openTab, tabForOrder, tabOrders, validTableKey } from "./tables.js";
import { checkUtr, upiLink } from "./upi.js";
import { istParts, randomCode, randomToken, rupees, sha256hex } from "./util.js";
import { ORDER_CODE, TOKEN, checkCustomer } from "./validate.js";

const MAX_UNPAID_PER_HOUR = 150;
const MAX_UNPAID_PER_PHONE = 3;

// IPv6 users can switch addresses inside their /64 block, so count the whole block as one.
export function ipKey(ip) {
  if (!ip.includes(":")) return ip;
  // expand "::" so every IPv6 address of the same /64 gives the same key
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const a = head ? head.split(":") : [];
  const b = ip.includes("::") ? (tail ? tail.split(":") : []) : [];
  const full = ip.includes("::") ? [...a, ...Array(Math.max(8 - a.length - b.length, 0)).fill("0"), ...b] : a;
  return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, "")).join(":");
}

// Shop-wide caps per action (10 minutes), so many addresses together can't flood the shop either.
const GLOBAL = { order: 300, coupon: 400, utr: 300, call: 200, feedback: 200 };

// The shop-wide cap is checked first and only read, so once it is full a flood from new addresses
// costs no database writes at all.
export async function limit(env, request, action, max, windowSeconds) {
  if (GLOBAL[action] && (await store.limitReached(env.DB, `${action}:all`, GLOBAL[action], 600))) {
    throw new HttpError(429, "We're very busy right now. Please try again in a few minutes.");
  }
  const who = await sha256hex(`${env.SESSION_SECRET || "dev"}|${ipKey(clientIp(request))}`);
  if (!(await store.underLimit(env.DB, `${action}:${who.slice(0, 32)}`, max, windowSeconds))) {
    throw new HttpError(429, "Too many tries. Please wait a few minutes and try again.");
  }
  if (GLOBAL[action]) await store.countHit(env.DB, `${action}:all`, 600);
}

/* ---------- menu, slots, photos ---------- */
export async function menu({ env }) {
  const [settings, prices, catalog] = await Promise.all([store.getSettings(env.DB), store.getPrices(env.DB), loadCatalog(env.DB)]);
  const left = await leftOn(env.DB, istParts().date, prices);
  const visible = {};
  for (const c of catalog) {
    const p = prices.get(c.id);
    if (!p || c.hidden) continue;
    visible[c.id] = { price: p.price, unit: p.unit, available: Boolean(p.available), ...(left.has(c.id) ? { left: left.get(c.id) } : {}) };
  }
  // dashboard edits to the website's products, and products added in the dashboard
  const products = catalog.filter((c) => c.custom || c.edited)
    .map((c) => ({ id: c.id, name: c.name, category: c.category, description: c.description, photo: c.photo, veg: c.veg, hidden: c.hidden, custom: c.custom, nameTa: c.nameTa, descriptionTa: c.descriptionTa, options: c.options }));
  return json({ settings: publicSettings(settings), prices: visible, products }, 200, { "Cache-Control": "public, max-age=30" });
}

export async function slots({ env, url }) {
  const settings = await store.getSettings(env.DB);
  return json({ days: slotDays(settings, url.searchParams.get("notice") === "1") });
}

export const image = ({ env, params }) => imageResponse(env.DB, params[0]);

/* ---------- coupons ---------- */
export async function checkCoupon({ request, env }) {
  await limit(env, request, "coupon", 20, 600);
  const body = await readJson(request);
  const found = await usableCoupon(env.DB, body.code, "");
  if (found.error) throw new HttpError(404, found.error);
  const c = found.coupon;
  const total = Number.isInteger(body.itemsTotal) && body.itemsTotal >= 0 ? body.itemsTotal : 0;
  const off = couponAmount(c, total);
  if (!off && c.min_order > total) throw new HttpError(400, `This code works on orders of ${rupees(c.min_order)} or more`);
  return json({ code: c.code, discount: off, label: c.kind === "percent" ? `${c.value}% off` : `${rupees(c.value)} off` });
}

/* ---------- placing an order ---------- */
export async function placeOrder({ request, env, ctx }) {
  await limit(env, request, "order", 20, 600); // guests on the shop Wi-Fi share one address
  const body = await readJson(request);
  const settings = await store.getSettings(env.DB);
  if (!settings.acceptingOrders || !settings.upiId) throw new HttpError(503, "Online orders are paused right now. Please message us instead.");

  const cart = checkCart(body.items);
  if (cart.error) throw new HttpError(400, cart.error);
  const customer = checkCustomer(body, settings);
  if (customer.error) throw new HttpError(400, customer.error);
  const c = customer.value;
  // fake-order floods: a few unpaid orders per phone number, and a high shop-wide brake
  const unpaid = await store.recentUnpaid(env.DB, c.phone);
  if (c.phone && unpaid.phone >= MAX_UNPAID_PER_PHONE) throw new HttpError(429, "You already have orders waiting for payment. Please pay or wait for them to expire.");
  if (unpaid.all >= MAX_UNPAID_PER_HOUR) throw new HttpError(503, "We're very busy right now. Please try again in a few minutes or message us.");

  // pay at the end: only from the real table card (signed link) and when the owner allows it
  const payLater = body.payLater === true;
  if (payLater && !(c.mode === "dinein" && settings.dineInPayLater && (await validTableKey(env, settings, c.table, body.k)))) {
    throw new HttpError(403, "Paying at the end only works from the QR code on your table");
  }

  let coupon = null;
  if (body.coupon && !payLater) {
    const found = await usableCoupon(env.DB, body.coupon, c.phone);
    if (found.error) throw new HttpError(400, found.error);
    coupon = found.coupon;
  }

  const [prices, catalog] = await Promise.all([store.getPrices(env.DB), loadCatalog(env.DB)]);
  const roundSettings = payLater ? { ...settings, charges: { ...settings.charges, roundOff: false } } : settings; // a tab's charges go on its one bill
  const priced = priceOrder(cart.value, orderable(catalog), prices, roundSettings, c.mode, { ...(coupon ? { coupon: (t) => couponAmount(coupon, t) } : {}), ...(payLater ? { service: false } : {}) });
  if (priced.error === "minOrder") throw new HttpError(400, `Delivery orders start at ${rupees(priced.minOrder)}`);
  if (priced.error) throw new HttpError(409, priced.error);
  if (coupon && !priced.value.couponDiscount) throw new HttpError(400, `This code works on orders of ${rupees(coupon.min_order)} or more`);
  // dine-in is for right now (during opening hours, nothing made-to-order); pickup and delivery need a chosen slot
  const notice = needsNotice(priced.value.lines, settings);
  const slot = c.mode === "dinein" ? dineInSlot(settings, notice) : checkSlot(body.date, body.time, settings, notice);
  if (slot.error) throw new HttpError(400, slot.error);

  const tab = payLater ? await tabForOrder(env.DB, c.table, body.pin, store) : null;
  const token = randomToken();
  const code = `SRN-${randomCode()}`;
  const order = {
    code,
    tokenHash: await sha256hex(token),
    source: "online",
    status: payLater ? "on_tab" : "awaiting_payment",
    ...c,
    ...slot.value,
    lines: priced.value.lines,
    subtotal: priced.value.subtotal,
    discount: priced.value.discount,
    couponCode: coupon ? coupon.code : "",
    deliveryFee: priced.value.deliveryFee,
    total: priced.value.total,
    taxSnapshot: snapshot(settings, priced.value),
    optIn: body.optIn === true && Boolean(c.phone),
    channel: payLater ? "table" : body.channel === "whatsapp" ? "whatsapp" : "web",
    tabId: tab ? tab.id : null,
    expiresAt: payLater ? null : new Date(Date.now() + settings.paymentMinutes * 60000).toISOString(),
  };
  const extra = [...reserveStmts(env.DB, code, priced.value.lines, slot.value.date, prices), ...(coupon ? [useCouponStmt(env.DB, coupon.code)] : [])];
  const saved = await store.createOrder(env.DB, order, extra);
  if (saved.error === "tab") throw new HttpError(409, "Your table's bill is being made right now. Please ask us to add this.");
  if (saved.error === "coupon") throw new HttpError(409, "That code has just been fully used");
  if (saved.error) throw new HttpError(409, (await shortage(env.DB, priced.value.lines, slot.value.date, prices)) || "Something just sold out. Please check your box.");
  ctx.waitUntil(notifyOwner(env, newOrderText(order, adminLink(request, code))));
  return json({
    code, token, total: order.total, discount: order.discount, onTab: payLater, expiresAt: order.expiresAt,
    ...(payLater ? {} : { upi: upiLink(settings, order.total, code), upiId: settings.upiId, upiName: settings.upiName }),
  }, 201);
}

function dineInSlot(settings, notice) {
  if (notice) return { error: "Entremets are made to order, so they can't be ordered at the table. Ask us, or pre-order for pickup." };
  const now = istParts();
  const open = !settings.closedDays.includes(now.weekday) && now.time >= settings.openTime && now.time < settings.closeTime;
  if (!open) return { error: `The kitchen is closed right now. We're open ${settings.openTime}–${settings.closeTime}.` };
  return { value: { date: now.date, time: now.time } };
}

export async function orderPayments(db, orderId) {
  const { results } = await db.prepare("SELECT kind, method, amount, ref, at FROM payments WHERE order_id = ?1 ORDER BY id").bind(orderId).all();
  return results;
}

export function snapshot(settings, priced) {
  const { storeName, legalName, gstin, address, stateName, phone, email, pricesIncludeGst, invoiceNote } = settings;
  return {
    seller: { storeName, legalName, gstin, address, stateName, phone, email, pricesIncludeGst, invoiceNote },
    delivery: priced.delivery,
    charges: priced.charges || [],
    roundOff: priced.roundOff || 0,
    taxSummary: priced.taxSummary,
  };
}

const adminLink = (request, code) => `${new URL(request.url).origin}/admin/#${code}`;

async function ownOrder(env, code, token) {
  if (!ORDER_CODE.test(code) || !TOKEN.test(String(token || ""))) throw new HttpError(404, "Order not found");
  const order = await store.getOrderForToken(env.DB, code, token);
  if (!order) throw new HttpError(404, "Order not found");
  return order;
}

/* ---------- tracking, paying, feedback ---------- */
export async function viewOrder({ env, params, url }) {
  const order = await ownOrder(env, params[0], url.searchParams.get("t"));
  const [settings, events, fb] = await Promise.all([
    store.getSettings(env.DB),
    store.getEvents(env.DB, order.id),
    env.DB.prepare("SELECT stars, comment FROM feedback WHERE order_id = ?1").bind(order.id).first(),
  ]);
  const waiting = order.status === "awaiting_payment" || order.status === "expired";
  return json({
    order: {
      code: order.code,
      status: order.status,
      statusLabel: STATUS[order.status],
      mode: order.mode,
      table: order.table_no,
      date: order.slot_date,
      time: order.slot_time,
      name: order.customer_name,
      lines: order.lines.map((l) => ({ name: l.name, qty: l.qty, unit: l.unit, amount: l.listAmount ?? l.gross })),
      subtotal: order.subtotal,
      discount: order.discount,
      coupon: order.coupon_code,
      deliveryFee: order.delivery_fee,
      total: order.total,
      utr: order.utr,
      invoiceNo: order.invoice_no,
      paid: Boolean(order.invoice_no),
      onTab: order.channel === "table",
      creditNote: order.credit_note_no,
      createdAt: order.created_at,
      expiresAt: order.expires_at,
      events: events.map((e) => ({ status: e.status, label: STATUS[e.status], at: e.at })),
    },
    pay: waiting && settings.upiId ? { upi: upiLink(settings, order.total, order.code), upiId: settings.upiId, upiName: settings.upiName } : null,
    feedback: fb || null,
    canReview: Boolean(order.invoice_no) && order.status !== "cancelled",
    googleReviewUrl: settings.googleReviewUrl,
    contact: { phone: settings.phone, whatsapp: settings.whatsappNumber },
  });
}

export async function submitPayment({ request, env, ctx, params }) {
  const body = await readJson(request);
  if (!TOKEN.test(String(body.t || ""))) throw new HttpError(404, "Order not found");
  await limit(env, request, "utr", 10, 600);
  const order = await ownOrder(env, params[0], body.t);
  const utr = checkUtr(body.utr);
  if (utr.error) throw new HttpError(400, utr.error);
  const result = await store.submitUtr(env.DB, order, utr.value);
  if (result === "taken") throw new HttpError(409, "That UPI reference was already used for another order. Please check the number.");
  if (result === "stale") throw new HttpError(409, order.status === "payment_submitted" ? "We already have your payment reference. We're checking it." : "This order can't take a payment now.");
  ctx.waitUntil(notifyOwner(env, paidClaimText({ code: order.code, total: order.total }, utr.value, adminLink(request, order.code))));
  return json({ status: "payment_submitted", statusLabel: STATUS.payment_submitted });
}

export async function feedback({ request, env, params }) {
  const body = await readJson(request);
  if (!TOKEN.test(String(body.t || ""))) throw new HttpError(404, "Order not found");
  await limit(env, request, "feedback", 10, 600);
  const order = await ownOrder(env, params[0], body.t);
  if (!order.invoice_no || order.status === "cancelled") throw new HttpError(409, "You can rate an order once it's paid");
  const stars = Number(body.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new HttpError(400, "Choose 1 to 5 stars");
  const comment = String(body.comment || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500);
  await env.DB.prepare(`INSERT INTO feedback (order_id, stars, comment, at) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT (order_id) DO UPDATE SET stars = excluded.stars, comment = excluded.comment, at = excluded.at`)
    .bind(order.id, stars, comment, new Date().toISOString()).run();
  const settings = await store.getSettings(env.DB);
  return json({ thanks: true, googleReviewUrl: stars >= 4 ? settings.googleReviewUrl : "" });
}

export async function customerInvoice({ env, params, url }, renderHtml) {
  const token = url.searchParams.get("t");
  const order = await ownOrder(env, params[0], token);
  return renderHtml(invoiceHtml({ ...order, _token: token }, { size: url.searchParams.get("size"), payments: await orderPayments(env.DB, order.id) }));
}

/* ---------- tables (dine-in) ---------- */
async function tableFrom(env, params, k) {
  let table;
  try { table = decodeURIComponent(params[0]); } catch { throw new HttpError(404, "Unknown table"); }
  if (!TABLE.test(table)) throw new HttpError(404, "Unknown table");
  const settings = await store.getSettings(env.DB);
  if (!settings.dineIn || !(await validTableKey(env, settings, table, k))) throw new HttpError(403, "Please scan the QR code on your table again");
  return { table, settings };
}

// What a guest at the table sees: their open tab and, once made, the bill to pay.
export async function tableView({ env, params, url }) {
  const { table, settings } = await tableFrom(env, params, url.searchParams.get("k"));
  const tab = await openTab(env.DB, table);
  if (!tab) return json({ table, payLater: settings.dineInPayLater, open: false, tab: null });
  // the tab and its bill are only shown with the PIN staff gave the guests
  if (!url.searchParams.get("pin")) return json({ table, payLater: settings.dineInPayLater, open: tab.status === "open", needPin: true, tab: null, bill: null });
  await checkTabPin(env.DB, tab, url.searchParams.get("pin"), store);
  const rounds = await tabOrders(env.DB, tab.id);
  const merged = mergeLines(rounds);
  let bill = null;
  if (tab.bill_order_id) {
    const o = await store.getOrderById(env.DB, tab.bill_order_id);
    bill = { code: o.code, token: tab.bill_token || (await billToken(env, o.code)), total: o.total, status: o.status, paid: Boolean(o.invoice_no) };
  }
  return json({
    table, payLater: settings.dineInPayLater, open: tab.status === "open",
    // no names here: anyone at the table can see the tab, so it only shows what was ordered
    tab: { status: tab.status, rounds: rounds.map((r) => ({ code: r.code, status: STATUS[r.status] })), lines: merged.lines.map((l) => ({ name: l.name, qty: l.qty, amount: l.gross })), total: merged.total },
    bill,
  });
}

export async function tableCall({ request, env, ctx, params }) {
  const body = await readJson(request);
  const { table } = await tableFrom(env, params, body.k);
  if (!["waiter", "bill"].includes(body.kind)) throw new HttpError(400, "Unknown request");
  await limit(env, request, "call", 10, 600);
  const added = await addCall(env.DB, table, body.kind);
  if (added) ctx.waitUntil(notifyOwner(env, `Table ${table}: ${body.kind === "bill" ? "asking for the bill" : "calling a waiter"}`));
  return json({ ok: true, already: !added });
}
