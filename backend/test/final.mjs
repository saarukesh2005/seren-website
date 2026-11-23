// Checks the "final product" features against a running local backend (npm run dev):
// item options, packing / round-off, manager approval, split payments, cake advances, delivery-app orders,
// table PINs / moving tables / waiter orders, and the security fixes (sessions, CSP nonce, size limit, backups).
// Usage: node test/final.mjs
import { readFileSync } from "node:fs";

const BASE = process.env.API || "http://127.0.0.1:8790";
const SITE = "http://localhost:4321";
const pw = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/ADMIN_PASSWORD="([^"]+)"/)[1];
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${String(detail).slice(0, 300)})`}`);
const sfx = Date.now().toString(36).slice(-5);
const phone = () => `9${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
const tomorrow = new Date(Date.now() + 330 * 60000 + 86400000).toISOString().slice(0, 10);

function session() {
  let cookie = "";
  const call = async (method, path, body, extraHeaders = {}) => {
    const headers = { Origin: BASE, "X-Seren": "1", ...extraHeaders };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const set = res.headers.get("set-cookie");
    if (set && set.startsWith("seren_admin=")) cookie = set.split(";")[0];
    const type = res.headers.get("content-type") || "";
    return { status: res.status, data: type.includes("json") ? await res.json() : await res.text(), headers: res.headers };
  };
  call.cookie = () => cookie;
  call.setCookie = (c) => { cookie = c; };
  return call;
}
async function pub(method, path, body, headers = {}) {
  const h = { Origin: SITE, ...headers };
  if (body !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, data: type.includes("json") ? await res.json() : await res.text(), headers: res.headers };
}

const owner = session();
const cashier = session();
const manager = session();

(async () => {
  let r = await owner("POST", "/api/admin/login", { password: pw });
  check("owner logs in", r.status === 200);
  r = await owner("POST", "/api/admin/settings", {
    upiId: "seren@okhdfcbank", acceptingOrders: true, openTime: "00:00", closeTime: "23:59", prepMinutes: 0, dineIn: true, dineInPayLater: true,
    dineInTables: "", charges: { packing: 1000, servicePercent: 5, roundOff: true, hsn: "996331" }, approvals: { discountPercent: 10, points: 100, counterUpiNeedsRef: false },
  });
  check("owner saves charges and staff limits", r.status === 200 && r.data.settings.charges.packing === 1000, JSON.stringify(r.data).slice(0, 200));
  const settings = r.data.settings;

  /* staff with an approval PIN */
  const mgr = `Kavin${sfx}`;
  r = await owner("POST", "/api/admin/staff", { name: mgr, role: "manager", password: "cake-and-tea-9" });
  r = await owner("POST", "/api/admin/staff", { name: `Devi${sfx}`, role: "cashier", password: "cake-and-tea-9" });
  const staff = (await owner("GET", "/api/admin/staff")).data.staff;
  const mgrRow = staff.find((s) => s.name === mgr);
  r = await owner("POST", `/api/admin/staff/${mgrRow.id}`, { pin: "1234" });
  check("short PINs refused (6–8 digits)", r.status === 400);
  r = await owner("POST", `/api/admin/staff/${mgrRow.id}`, { pin: "123456" });
  check("too-easy PINs refused", r.status === 400);
  r = await owner("POST", `/api/admin/staff/${mgrRow.id}`, { pin: "482613" });
  check("owner sets a manager's approval PIN", r.status === 200, JSON.stringify(r.data));
  check("cashier logs in", (await cashier("POST", "/api/admin/login", { name: `Devi${sfx}`, password: "cake-and-tea-9" })).status === 200);
  check("manager logs in", (await manager("POST", "/api/admin/login", { name: mgr, password: "cake-and-tea-9" })).status === 200);

  /* item options */
  r = await owner("POST", "/api/admin/products", { name: `Test Cake ${sfx}`, category: "pastry", description: "test" });
  const cake = r.data.product.id;
  r = await owner("POST", `/api/admin/products/${cake}`, { options: [
    { name: "Size", pick: "one", required: true, choices: [{ name: "Regular", price: 0 }, { name: "Large", price: 5000 }] },
    { name: "Add-ons", pick: "many", choices: [{ name: "Gold leaf", price: 2500 }, { name: "Candles", price: 0 }] },
  ] });
  check("owner adds sizes and add-ons", r.status === 200, JSON.stringify(r.data));
  await owner("POST", `/api/admin/prices/${cake}`, { price: 45050, unit: "per cake", available: true });
  r = await cashier("POST", "/api/admin/counter/quote", { items: [{ id: cake, qty: 1 }] });
  check("a required size must be chosen", r.status === 409 && /size/i.test(r.data.error), JSON.stringify(r.data));
  r = await cashier("POST", "/api/admin/counter/quote", { items: [{ id: cake, qty: 1, opts: ["size-large", "size-regular"] }] });
  check("only one size at a time", r.status === 409, JSON.stringify(r.data));
  r = await cashier("POST", "/api/admin/counter/quote", { items: [{ id: cake, qty: 1, opts: ["size-mega"] }] });
  check("unknown choices refused", r.status === 409, JSON.stringify(r.data));
  r = await cashier("POST", "/api/admin/counter/quote", { items: [{ id: cake, qty: 1, opts: ["size-large", "add-ons-gold-leaf"] }, { id: cake, qty: 2, opts: ["size-regular"] }] });
  const q = r.data.quote;
  check("options add their price and show on the line", r.status === 200 && q.lines.length === 2 && q.lines.some((l) => l.amount === 52550 && /Large, Gold leaf/.test(l.name)) && q.lines.some((l) => l.amount === 90100), JSON.stringify(r.data).slice(0, 300));
  check("the quote carries the shop's UPI ID from the server", q.upi && q.upi.id === "seren@okhdfcbank");

  /* packing and round-off */
  r = await cashier("POST", "/api/admin/counter/quote", { items: [{ id: cake, qty: 1, opts: ["size-large"] }], packing: true });
  check("takeaway packing and round-off to the rupee", r.data.quote && r.data.quote.total === 51100 && r.data.quote.roundOff === 50 && r.data.quote.charges[0].amount === 1000, JSON.stringify(r.data).slice(0, 300));

  /* manager approval */
  r = await cashier("POST", "/api/admin/counter/quote", { items: [{ id: cake, qty: 1, opts: ["size-regular"] }], discount: { percent: 20 } });
  check("a big discount needs a manager", r.status === 403 && r.data.needApproval === true, JSON.stringify(r.data));
  r = await cashier("POST", "/api/admin/counter/quote", { items: [{ id: cake, qty: 1, opts: ["size-regular"] }], discount: { percent: 20 }, approval: { name: mgr, pin: "135792" } });
  check("a wrong PIN is refused", r.status === 403 && /Wrong/.test(r.data.error), JSON.stringify(r.data));
  r = await cashier("POST", "/api/admin/counter/quote", { items: [{ id: cake, qty: 1, opts: ["size-regular"] }], discount: { percent: 20 }, approval: { name: mgr, pin: "482613" } });
  check("the manager's PIN approves it", r.status === 200 && r.data.quote.discount === 9010, JSON.stringify(r.data).slice(0, 200));
  r = await cashier("POST", "/api/admin/counter/quote", { items: [{ id: cake, qty: 1, opts: ["size-regular"] }], discount: { percent: 5 } });
  check("a small discount needs no manager", r.status === 200);
  r = await manager("POST", "/api/admin/counter/quote", { items: [{ id: cake, qty: 1, opts: ["size-regular"] }], discount: { percent: 30 } });
  check("a manager gives big discounts directly", r.status === 200);

  /* split payment */
  const items = [{ id: cake, qty: 1, opts: ["size-large"] }];
  const total = (await cashier("POST", "/api/admin/counter/quote", { items })).data.quote.total;
  r = await cashier("POST", "/api/admin/counter", { items, split: [{ method: "cash", amount: 20000 }, { method: "upi", amount: total - 20000 }] });
  check("one bill paid part cash, part UPI", r.status === 201 && /SRN\/\d{4}\/\d{5}/.test(r.data.order.invoice_no), JSON.stringify(r.data).slice(0, 200));
  const splitCode = r.data.order && r.data.order.code;
  r = await owner("GET", `/api/admin/orders/${splitCode}`);
  check("both parts are recorded", r.data.payments && r.data.payments.length === 2 && r.data.payments.reduce((n, p) => n + p.amount, 0) === total, JSON.stringify(r.data.payments));
  r = await cashier("POST", "/api/admin/counter", { items, split: [{ method: "cash", amount: 100 }, { method: "upi", amount: 100 }] });
  check("parts that don't add up are refused", r.status === 400, JSON.stringify(r.data));

  /* UPI reference rule, idempotent bills */
  await owner("POST", "/api/admin/settings", { approvals: { ...settings.approvals, counterUpiNeedsRef: true } });
  r = await cashier("POST", "/api/admin/counter", { items, method: "upi" });
  check("counter UPI bills can require the UPI reference", r.status === 400 && /reference/i.test(r.data.error), JSON.stringify(r.data));
  await owner("POST", "/api/admin/settings", { approvals: { ...settings.approvals, counterUpiNeedsRef: false } });
  const ref = `POS-${sfx}-TEST`.toUpperCase();
  r = await cashier("POST", "/api/admin/counter", { clientRef: ref, items, method: "cash" });
  r = await cashier("POST", "/api/admin/counter", { clientRef: ref, items: [{ id: cake, qty: 2, opts: ["size-large"] }], method: "cash" });
  check("a reused bill id with different items is refused", r.status === 409, JSON.stringify(r.data));

  /* coupons */
  const code = `ONCE${sfx}`.toUpperCase().slice(0, 20);
  await owner("POST", "/api/admin/coupons", { code, kind: "flat", value: 5000, once_per_phone: true, active: true });
  r = await cashier("POST", "/api/admin/counter/quote", { items, coupon: code });
  check("a one-per-person coupon needs the customer's mobile", r.status === 400 && /mobile/.test(r.data.error), JSON.stringify(r.data));
  check("cashiers can't list all coupon codes", (await cashier("GET", "/api/admin/coupons")).status === 403);

  /* cake / advance order */
  const custPhone = phone();
  r = await cashier("POST", "/api/admin/counter/advance", { items, name: "Lakshmi", phone: custPhone, date: tomorrow, time: "17:30", cakeMessage: "Happy 60th Appa", advance: { method: "cash", amount: 20000 } });
  const booked = r.data.order || {};
  check("cake order booked with an advance receipt", r.status === 201 && booked.status === "booked" && /RV\/\d{4}\/\d{5}/.test(booked.receipt_no) && booked.advance === 20000, JSON.stringify(r.data).slice(0, 300));
  r = await owner("GET", `/receipt/${booked.code}`);
  check("advance receipt prints", r.status === 200 && /Advance Receipt/.test(r.data) && /Happy 60th Appa/.test(r.data));
  r = await cashier("GET", "/api/admin/kitchen");
  check("the kitchen sees tomorrow's cake with its message", r.data.orders.some((o) => o.code === booked.code && o.cakeMessage === "Happy 60th Appa"));
  r = await cashier("POST", `/api/admin/orders/${booked.code}/confirm`, { method: "upi", utr: String(Date.now()).slice(-12) });
  check("balance taken at pickup makes the bill", r.status === 200 && /SRN\/\d{4}\/\d{5}/.test(r.data.order.invoice_no), JSON.stringify(r.data).slice(0, 200));
  r = await owner("GET", `/api/admin/orders/${booked.code}`);
  check("advance + balance = the bill", r.data.payments.length === 2 && r.data.payments[0].kind === "advance" && r.data.payments.reduce((n, p) => n + p.amount, 0) === booked.total, JSON.stringify(r.data.payments));
  r = await cashier("POST", "/api/admin/counter/advance", { items, name: "Ravi", phone: phone(), date: tomorrow, time: "18:00", advance: { method: "upi", amount: 10000 } });
  const second = r.data.order;
  r = await cashier("POST", `/api/admin/orders/${second.code}/status`, { to: "cancelled", refundMethod: "cash" });
  check("cancelling a booking needs a manager", r.status === 403 && r.data.needApproval, JSON.stringify(r.data));
  r = await cashier("POST", `/api/admin/orders/${second.code}/status`, { to: "cancelled", refundMethod: "cash", approval: { name: mgr, pin: "482613" } });
  r = await owner("GET", `/api/admin/orders/${second.code}`);
  check("cancelled booking records the advance given back", r.data.order.status === "cancelled" && r.data.payments.some((p) => p.kind === "refund" && p.amount === 10000), JSON.stringify(r.data.payments));

  /* Swiggy / Zomato / ONDC */
  const ext = `SWG${sfx}`.toUpperCase();
  r = await cashier("POST", "/api/admin/counter/app-order", { platform: "swiggy", externalId: ext, items: [{ id: cake, qty: 1, opts: ["size-regular"] }], notes: "no candles" });
  const app = r.data.order || {};
  check("Swiggy order entered at the counter", r.status === 201 && app.platform === "swiggy" && app.external_id === ext && app.tax_snapshot.platform.name === "Swiggy", JSON.stringify(r.data).slice(0, 300));
  check("app orders carry no GST (the app pays it, section 9(5))", app.tax_snapshot && app.tax_snapshot.taxSummary.every((t) => t.tax === 0) && app.total === 45050, JSON.stringify(app.tax_snapshot && app.tax_snapshot.taxSummary));
  r = await cashier("POST", "/api/admin/counter/app-order", { platform: "swiggy", externalId: ext, items: [{ id: cake, qty: 1, opts: ["size-regular"] }] });
  check("the same app order can't be entered twice", r.status === 200 && r.data.duplicate === true && r.data.order.code === app.code);
  r = await cashier("GET", "/api/admin/kitchen");
  check("app orders show on the kitchen screen", r.data.orders.some((o) => o.code === app.code && o.app === "Swiggy"));
  r = await pub("POST", "/api/hooks/orders", { platform: "zomato", externalId: "Z1", items: [] }, { Authorization: "Bearer nope" });
  check("the automatic app connector is closed without its secret", r.status === 401);

  /* tables: PIN, waiter order, move / join, service charge */
  const t1 = `T${sfx}`.slice(0, 8);
  const t2 = `U${sfx}`.slice(0, 8);
  const t3 = `V${sfx}`.slice(0, 8);
  const links = (await owner("GET", "/api/admin/table-links")).data.links;
  check("table links are signed", Array.isArray(links));
  r = await cashier("POST", `/api/admin/tables/${t1}/open`, {});
  const pin = r.data.pin;
  check("seating a table gives a 4-digit PIN", r.status === 201 && /^\d{4}$/.test(pin), JSON.stringify(r.data));
  // the guest's table key comes from the signed card link; the owner's link list only covers named tables, so make one
  await owner("POST", "/api/admin/settings", { dineInTables: `${t1}, ${t2}, ${t3}` });
  const keyOf = async (t) => new URL((await owner("GET", "/api/admin/table-links")).data.links.find((l) => l.table === t).url).searchParams.get("k");
  const k1 = await keyOf(t1);
  r = await pub("POST", "/api/orders", { name: "Guest", phone: "", mode: "dinein", table: t1, k: k1, payLater: true, items: [{ id: cake, qty: 1, opts: ["size-regular"] }] });
  check("pay-at-the-end needs the table PIN", r.status === 403 && r.data.needPin === true, JSON.stringify(r.data));
  r = await pub("POST", "/api/orders", { name: "Guest", phone: "", mode: "dinein", table: t1, k: k1, payLater: true, pin, items: [{ id: cake, qty: 1, opts: ["size-regular"] }] });
  check("with the PIN the round goes to the kitchen", r.status === 201 && r.data.onTab === true, JSON.stringify(r.data));
  r = await pub("GET", `/api/tables/${t1}?k=${k1}`);
  check("the tab is hidden without the PIN", r.status === 200 && r.data.needPin === true && r.data.tab === null, JSON.stringify(r.data));
  r = await pub("GET", `/api/tables/${t1}?k=${k1}&pin=${pin}`);
  check("with the PIN guests see their tab", r.status === 200 && r.data.tab && r.data.tab.lines.length === 1, JSON.stringify(r.data).slice(0, 200));
  r = await cashier("POST", `/api/admin/tables/${t1}/order`, { items: [{ id: cake, qty: 1, opts: ["size-large"] }], notes: "extra plates" });
  check("a waiter adds a round from the phone", r.status === 201 && /^SRN-/.test(r.data.code), JSON.stringify(r.data));
  r = await cashier("POST", `/api/admin/tables/${t1}/move`, { to: t2 });
  check("guests move to another table", r.status === 200 && r.data.how === "moved", JSON.stringify(r.data));
  await cashier("POST", `/api/admin/tables/${t3}/open`, {});
  r = await cashier("POST", `/api/admin/tables/${t2}/move`, { to: t3 });
  check("two tables join into one bill", r.status === 200 && r.data.how === "merged", JSON.stringify(r.data));
  r = await cashier("POST", `/api/admin/tables/${t3}/bill`, { service: true });
  const bill = (await owner("GET", `/api/admin/orders/${r.data.code}`)).data.order;
  const food = bill.lines.reduce((n, l) => n + l.gross, 0);
  const svc = Math.round((food * 5) / 100);
  check("table bill adds the optional service charge and rounds", bill.total === Math.round((food + svc) / 100) * 100 && bill.tax_snapshot.charges.some((c) => /Service/.test(c.name)), JSON.stringify({ total: bill.total, food, svc }));
  r = await owner("GET", "/api/admin/backup.json");
  const backup = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
  check("backups leave out table PINs and bill links", backup.data.tabs.every((t) => !("pin" in t) && !("bill_token" in t)) && Array.isArray(backup.data.payments));
  // the locked backup (as sent to Telegram) opens with the backup password, inside Cloudflare's own engine
  r = await owner("GET", "/api/admin/backup.json?locked=1");
  const box = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
  const from64 = (x) => Uint8Array.from(Buffer.from(x, "base64"));
  const bpw = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/BACKUP_PASSWORD="([^"]+)"/)[1];
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(bpw), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: from64(box.salt), iterations: box.iterations, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plain = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: from64(box.iv) }, key, from64(box.data))));
  check("locked backup works and opens with the backup password", r.status === 200 && box.locked && plain.app === "seren-orders" && Array.isArray(plain.data.orders), JSON.stringify(box).slice(0, 120));

  /* sessions and other security fixes */
  const s2 = session();
  await s2("POST", "/api/admin/login", { password: pw });
  const stolen = s2.cookie();
  await s2("POST", "/api/admin/logout", {});
  const thief = session(); thief.setCookie(stolen);
  check("after logout a copied cookie stops working", (await thief("GET", "/api/admin/me")).status === 401);
  r = await owner("GET", `/invoice/${splitCode}`);
  const csp = r.headers.get("content-security-policy") || "";
  check("bill pages only run their own scripts (nonce)", /script-src 'nonce-[A-Za-z0-9+/=]+'/.test(csp) && !/unsafe-inline'; base/.test(csp.split("script-src")[1] || "") && /<script nonce="/.test(r.data), csp);
  r = await pub("POST", "/api/orders", JSON.stringify({ items: [], pad: "x".repeat(20000) }));
  check("oversized requests are refused", r.status === 413, JSON.stringify(r.data));
  r = await pub("GET", "/api/menu");
  check("the website sees item options", r.data.products.some((p) => p.id === cake && p.options.length === 2));

  // a burst of guesses at the same moment: each one is counted before it's checked (runs last: it locks this manager's approvals for an hour)
  const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => cashier("POST", "/api/admin/counter/quote", { items: [{ id: cake, qty: 1, opts: ["size-regular"] }], discount: { percent: 20 }, approval: { name: mgr, pin: String(200000 + i) } })));
  check("a burst of PIN guesses is cut off", burst.filter((x) => x.status === 403).length <= 5 && burst.some((x) => x.status === 429), JSON.stringify(burst.map((x) => x.status)));

  console.log(results.join("\n"));
  const failed = results.filter((x) => x.startsWith("FAIL")).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log(results.join("\n")); console.error("ERROR", e.stack || e.message); process.exit(1); });
