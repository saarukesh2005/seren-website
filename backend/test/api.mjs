// End-to-end check of the order API against a running local backend (npm run dev).
// Usage: node test/api.mjs   (reads the local admin password from .dev.vars)
import { readFileSync } from "node:fs";

const BASE = process.env.API || "http://127.0.0.1:8790";
const SITE = "http://localhost:4321";
const vars = Object.fromEntries(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => {
  const i = l.indexOf("=");
  return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
}));
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
let cookie = "";

async function call(method, path, body, { owner = false, origin = SITE } = {}) {
  const headers = { Origin: owner ? BASE : origin };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (owner) { headers["X-Seren"] = "1"; if (cookie) headers.Cookie = cookie; }
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const set = res.headers.get("set-cookie");
  if (set && set.startsWith("seren_admin=")) cookie = set.split(";")[0];
  const type = res.headers.get("content-type") || "";
  return { status: res.status, headers: res.headers, data: type.includes("json") ? await res.json() : await res.text() };
}

const ymdIST = (days) => new Date(Date.now() + 330 * 60000 + days * 86400000).toISOString().slice(0, 10);

(async () => {
  // owner area is locked
  check("dashboard API needs login", (await call("GET", "/api/admin/orders", undefined, { owner: true })).status === 401);
  check("wrong password refused", (await call("POST", "/api/admin/login", { password: "nope" }, { owner: true })).status === 401);
  check("cross-site dashboard calls blocked", (await call("POST", "/api/admin/login", { password: vars.ADMIN_PASSWORD })).status === 403);
  const login = await call("POST", "/api/admin/login", { password: vars.ADMIN_PASSWORD }, { owner: true });
  check("owner can log in", login.status === 200 && cookie.startsWith("seren_admin="));
  check("session cookie is HttpOnly + SameSite", /HttpOnly/.test(login.headers.get("set-cookie")) && /SameSite=Strict/.test(login.headers.get("set-cookie")));

  // closed until set up
  let r = await call("POST", "/api/orders", { items: [{ id: "bomb-vanilla", qty: 1 }] });
  check("orders refused while the shop is not set up", r.status === 503);

  // settings + prices
  r = await call("POST", "/api/admin/settings", { upiId: "bad upi" }, { owner: true });
  check("bad UPI ID rejected", r.status === 400);
  r = await call("POST", "/api/admin/settings", {
    upiId: "seren@okhdfcbank", acceptingOrders: true, deliveryFee: 4000, freeDeliveryAbove: 100000, minOrder: 20000,
    openTime: "00:00", closeTime: "23:59", prepMinutes: 0, slotMinutes: 30, closedDays: [], preorderNoticeDays: 2,
    gstin: "33ABCDE1234F1Z5", legalName: "Seren Foods", stateName: "Tamil Nadu",
    tax: { bomboloni: { hsn: "1905", rate: 5 }, entremets: { hsn: "1905", rate: 5 } }, deliveryTax: { hsn: "996813", rate: 18 },
  }, { owner: true });
  check("owner saves settings", r.status === 200 && r.data.settings.upiId === "seren@okhdfcbank", JSON.stringify(r.data));
  for (const [id, price] of [["bomb-vanilla", 18000], ["ent-hazelnut", 210000]]) {
    await call("POST", `/api/admin/prices/${id}`, { price, unit: "per piece", available: true }, { owner: true });
  }
  r = await call("POST", "/api/admin/prices/bomb-vanilla", { price: -5, available: true }, { owner: true });
  check("negative price rejected", r.status === 400);

  r = await call("GET", "/api/menu");
  check("menu shows prices but not the UPI ID/GSTIN", r.data.prices["bomb-vanilla"].price === 18000 && !JSON.stringify(r.data).includes("okhdfcbank") && !JSON.stringify(r.data).includes("33ABCDE"));
  check("website origin gets CORS", r.headers.get("access-control-allow-origin") === SITE);
  r = await call("GET", "/api/menu", undefined, { origin: "https://evil.example" });
  check("other websites get no CORS", !r.headers.get("access-control-allow-origin"));

  // placing orders
  const slotsR = await call("GET", "/api/slots?notice=0");
  const day = slotsR.data.days[0];
  check("time slots available", Boolean(day && day.times.length));
  const base = { name: "Asha", phone: "9876543210", mode: "pickup", date: day.date, time: day.times[day.times.length - 1] };
  r = await call("POST", "/api/orders", { ...base, items: [{ id: "bomb-vanilla", qty: 2, price: 1 }] });
  check("order placed with server prices", r.status === 201 && r.data.total === 36000, JSON.stringify(r.data));
  const { code, token } = r.data;
  check("UPI link has amount + order number", r.data.upi.includes("am=360.00") && r.data.upi.includes(code));

  r = await call("POST", "/api/orders", { ...base, items: [{ id: "ent-hazelnut", qty: 1 }] });
  check("cakes need notice days", r.status === 400 && /notice/.test(r.data.error), JSON.stringify(r.data));
  r = await call("POST", "/api/orders", { ...base, mode: "delivery", address: "12 Long Street, Chennai", pincode: "600001", items: [{ id: "bomb-vanilla", qty: 1 }] });
  check("delivery minimum order enforced", r.status === 400 && /start at/.test(r.data.error));
  r = await call("POST", "/api/orders", { ...base, items: [{ id: "cookie-brownie", qty: 1 }] });
  check("unpriced product refused", r.status === 409);

  // dine-in from a table: no time slot, no phone needed
  r = await call("POST", "/api/orders", { name: "Ravi", mode: "dinein", table: "7", items: [{ id: "bomb-vanilla", qty: 1 }] });
  check("dine-in order placed without a time slot", r.status === 201 && r.data.total === 18000, JSON.stringify(r.data));
  const dine = r.data;
  r = await call("GET", `/api/orders/${dine.code}?t=${dine.token}`);
  check("dine-in order shows its table", r.data.order.mode === "dinein" && r.data.order.table === "7");
  r = await call("POST", "/api/orders", { name: "Ravi", mode: "dinein", items: [{ id: "bomb-vanilla", qty: 1 }] });
  check("dine-in needs a table", r.status === 400 && /table/.test(r.data.error));
  r = await call("POST", "/api/orders", { name: "Ravi", mode: "dinein", table: "7", items: [{ id: "ent-hazelnut", qty: 1 }] });
  check("made-to-order cakes can't be ordered at the table", r.status === 400 && /made to order/.test(r.data.error));
  r = await call("POST", "/api/orders", null);
  check("an empty request gets a clear 400, not a crash", r.status === 400, JSON.stringify(r.data));

  // tracking + paying
  r = await call("GET", `/api/orders/${code}?t=${token}`);
  check("customer sees their order", r.status === 200 && r.data.order.status === "awaiting_payment" && r.data.pay.upiId === "seren@okhdfcbank");
  r = await call("GET", `/api/orders/${code}?t=${"x".repeat(32)}`);
  check("wrong link token can't see the order", r.status === 404);
  r = await call("POST", `/api/orders/${code}/payment`, { t: token, utr: "123" });
  check("short UPI ref rejected", r.status === 400);
  r = await call("POST", `/api/orders/${code}/payment`, { t: token, utr: "412345678901" });
  check("customer submits UPI ref", r.status === 200 && r.data.status === "payment_submitted");
  r = await call("POST", `/api/orders/${code}/payment`, { t: token, utr: "412345678901" });
  check("can't submit twice", r.status === 409);

  r = await call("GET", "/api/admin/orders?status=payment_submitted", undefined, { owner: true });
  check("owner sees it waiting to be checked", r.data.orders.some((o) => o.code === code) && r.data.summary.toCheck >= 1);
  r = await call("POST", `/api/admin/orders/${code}/status`, { to: "paid" }, { owner: true });
  check("can't skip payment confirmation", r.status === 409);
  r = await call("POST", `/api/admin/orders/${code}/confirm`, { method: "upi" }, { owner: true });
  check("owner confirms payment, invoice number issued", r.status === 200 && /^SRN\/\d{4}\/\d{5}$/.test(r.data.order.invoice_no), JSON.stringify(r.data));
  const inv1 = r.data.order.invoice_no;
  r = await call("POST", `/api/admin/orders/${code}/confirm`, { method: "upi" }, { owner: true });
  check("confirming twice is refused", r.status === 409);
  for (const to of ["preparing", "ready", "completed"]) r = await call("POST", `/api/admin/orders/${code}/status`, { to }, { owner: true });
  check("order moves to completed", r.data.order.status === "completed");

  r = await call("GET", `/invoice/${code}?t=${token}`);
  check("customer invoice is a GST tax invoice", r.status === 200 && r.data.includes("Tax Invoice") && r.data.includes(inv1) && r.data.includes("33ABCDE1234F1Z5"));
  check("invoice has a strict content policy", /default-src 'none'/.test(r.headers.get("content-security-policy") || ""));

  // counter bill
  r = await call("POST", "/api/admin/counter", { items: [{ id: "bomb-vanilla", qty: 1 }], method: "cash", table: "4" }, { owner: true });
  check("counter bill can be for a dine-in table", r.status === 201 && r.data.order.mode === "dinein" && r.data.order.table_no === "4", JSON.stringify(r.data));
  r = await call("POST", "/api/admin/counter", { items: [{ id: "bomb-vanilla", qty: 3 }], method: "cash", name: "Walk-in" }, { owner: true });
  check("counter bill created paid with the next invoice number", r.status === 201 && r.data.order.status === "paid" && r.data.order.invoice_no > inv1, JSON.stringify(r.data));
  r = await call("POST", "/api/admin/counter", { items: [{ id: "bomb-vanilla", qty: 1 }], method: "upi", utr: "412345678901" }, { owner: true });
  check("a UPI ref can't be reused on another bill", r.status === 409);

  r = await call("GET", `/api/admin/export.csv?from=${ymdIST(-1)}&to=${ymdIST(0)}`, undefined, { owner: true });
  check("bills export as CSV", typeof r.data === "string" && r.data.split("\r\n").length >= 3 && r.data.includes(inv1));
  check("CSV has only bills, by bill date", !r.data.includes("awaiting_payment"));

  // XSS: a name with HTML is escaped on the invoice
  r = await call("POST", "/api/orders", { ...base, name: `<img src=x onerror=alert(1)>`, items: [{ id: "bomb-vanilla", qty: 1 }] });
  const x = r.data;
  r = await call("GET", `/invoice/${x.code}?t=${x.token}`);
  check("names are escaped on bills", !r.data.includes("<img src=x") && r.data.includes("&lt;img"));

  // rate limit on placing orders (20 per 10 min per address)
  let limited = false;
  for (let i = 0; i < 25 && !limited; i++) limited = (await call("POST", "/api/orders", { ...base, items: [{ id: "bomb-vanilla", qty: 1 }] })).status === 429;
  check("too many orders from one address are slowed down", limited);

  console.log(results.join("\n"));
  console.log(`\n${results.filter((l) => l.startsWith("PASS")).length}/${results.length} passed`);
})().catch((e) => { console.log(results.join("\n")); console.error("ERROR", e); process.exit(1); });
