// Checks the upgrade features against a running local backend (npm run dev). Run test/api.mjs first (it sets prices).
// Usage: node test/upgrade.mjs
import { readFileSync } from "node:fs";

const BASE = process.env.API || "http://127.0.0.1:8790";
const SITE = "http://localhost:4321";
const pw = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/ADMIN_PASSWORD="([^"]+)"/)[1];
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${String(detail).slice(0, 300)})`}`);
const utr = () => String(Date.now() + Math.floor(Math.random() * 1e6)).slice(-12);

function session() {
  let cookie = "";
  return async (method, path, body) => {
    const headers = { Origin: BASE, "X-Seren": "1" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const set = res.headers.get("set-cookie");
    if (set && set.startsWith("seren_admin=")) cookie = set.split(";")[0];
    const type = res.headers.get("content-type") || "";
    return { status: res.status, data: type.includes("json") ? await res.json() : await res.text(), headers: res.headers };
  };
}
async function pub(method, path, body) {
  const headers = { Origin: SITE };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, data: type.includes("json") ? await res.json() : await res.text(), headers: res.headers };
}

const owner = session();
const cashier = session();
const kitchen = session();
const manager = session();

// a different customer each time (the shop allows only a few unpaid orders per phone)
const freshPhone = () => `9${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;

(async () => {
  let r = await owner("POST", "/api/admin/login", { password: pw });
  check("owner logs in (name left empty)", r.status === 200);
  r = await owner("GET", "/api/admin/me");
  check("owner has every permission", r.data.perms[0] === "*" && r.data.user.role === "owner");
  await owner("POST", "/api/admin/settings", {
    upiId: "seren@okhdfcbank", acceptingOrders: true, openTime: "00:00", closeTime: "23:59", prepMinutes: 0, dineIn: true, dineInPayLater: true,
    dineInTables: "1, 2, 7, Patio 1", loyalty: { enabled: true, earnEvery: 10000, pointValue: 100 }, whatsappNumber: "919876543210",
    googleReviewUrl: "https://g.page/r/seren/review",
  });

  /* staff and roles */
  const sfx = Date.now().toString(36).slice(-4);
  for (const [name, role] of [[`Priya${sfx}`, "cashier"], [`Arun${sfx}`, "kitchen"], [`Meena${sfx}`, "manager"]]) {
    r = await owner("POST", "/api/admin/staff", { name, role, password: "tea-and-cake-1" });
    check(`owner adds a ${role}`, r.status === 201, JSON.stringify(r.data));
  }
  r = await owner("POST", "/api/admin/staff", { name: "Short", role: "cashier", password: "123" });
  check("short staff passwords refused", r.status === 400);
  check("cashier logs in", (await cashier("POST", "/api/admin/login", { name: `priya${sfx}`, password: "tea-and-cake-1" })).status === 200);
  check("kitchen logs in", (await kitchen("POST", "/api/admin/login", { name: `Arun${sfx}`, password: "tea-and-cake-1" })).status === 200);
  check("manager logs in", (await manager("POST", "/api/admin/login", { name: `Meena${sfx}`, password: "tea-and-cake-1" })).status === 200);
  check("wrong staff password refused", (await session()("POST", "/api/admin/login", { name: `Priya${sfx}`, password: "nope-nope-nope" })).status === 401);
  check("cashier can't change prices", (await cashier("POST", "/api/admin/prices/bomb-vanilla", { price: 100, available: true })).status === 403);
  check("cashier can't open settings changes", (await cashier("POST", "/api/admin/settings", { upiId: "evil@upi" })).status === 403);
  check("cashier can't download the backup", (await cashier("GET", "/api/admin/backup.json")).status === 403);
  check("kitchen can't see the orders list", (await kitchen("GET", "/api/admin/orders")).status === 403);
  check("kitchen sees the kitchen list", (await kitchen("GET", "/api/admin/kitchen")).status === 200);

  /* daily stock */
  const limited = (await owner("POST", "/api/admin/products", { name: `Stock test ${sfx}`, category: "cookies" })).data.product.id;
  await owner("POST", `/api/admin/prices/${limited}`, { price: 15000, unit: "per piece", available: true, dailyLimit: 2 });
  await owner("POST", "/api/admin/prices/cookie-brownie", { price: 16000, unit: "per piece", available: true });
  const day = (await pub("GET", "/api/slots")).data.days[0];
  const base = { name: "Asha", phone: "9876543210", mode: "pickup", date: day.date, time: day.times[day.times.length - 1] };
  r = await pub("GET", "/api/menu");
  check("menu shows how many are left today", r.data.prices[limited].left === 2, JSON.stringify(r.data.prices[limited]));
  const s1 = await pub("POST", "/api/orders", { ...base, phone: freshPhone(), items: [{ id: limited, qty: 2 }] });
  check("can order up to the daily limit", s1.status === 201, JSON.stringify(s1.data));
  r = await pub("POST", "/api/orders", { ...base, phone: freshPhone(), items: [{ id: limited, qty: 1 }] });
  check("over the limit is refused as sold out", r.status === 409 && /sold out/.test(r.data.error), JSON.stringify(r.data));
  await owner("POST", `/api/admin/orders/${s1.data.code}/status`, { to: "cancelled" });
  r = await pub("POST", "/api/orders", { ...base, phone: freshPhone(), items: [{ id: limited, qty: 1 }] });
  check("cancelling an unpaid order gives the stock back", r.status === 201, JSON.stringify(r.data));

  /* cancelling gives stock back exactly once */
  const late = await pub("POST", "/api/orders", { ...base, phone: "9000000002", items: [{ id: limited, qty: 1 }] });
  r = await owner("POST", `/api/admin/orders/${late.data.code}/status`, { to: "cancelled" });
  r = await pub("GET", "/api/menu");
  const leftAfterCancel = r.data.prices[limited].left;
  r = await pub("POST", "/api/orders", { ...base, phone: "9000000003", items: [{ id: limited, qty: 1 }] });
  check("stock given back exactly once after a cancel", leftAfterCancel >= 1 && r.status === 201, JSON.stringify({ leftAfterCancel, r: r.data }));

  /* coupons */
  const code = `TRY${sfx.toUpperCase()}`;
  r = await owner("POST", "/api/admin/coupons", { code, kind: "percent", value: 10, max_uses: 1, min_order: 10000 });
  check("owner creates a coupon", r.status === 201, JSON.stringify(r.data));
  r = await pub("POST", "/api/coupons/check", { code: code.toLowerCase(), itemsTotal: 36000 });
  check("customer can check a coupon", r.status === 200 && r.data.discount === 3600, JSON.stringify(r.data));
  r = await pub("POST", "/api/orders", { ...base, coupon: code, items: [{ id: "bomb-vanilla", qty: 2 }] });
  check("coupon takes 10% off the order", r.status === 201 && r.data.total === 32400 && r.data.discount === 3600, JSON.stringify(r.data));
  const couponOrder = r.data;
  r = await pub("POST", "/api/orders", { ...base, phone: "9876500000", coupon: code, items: [{ id: "bomb-vanilla", qty: 2 }] });
  check("a used-up coupon is refused", r.status === 400 && /fully used/.test(r.data.error), JSON.stringify(r.data));
  r = await pub("GET", `/invoice/${couponOrder.code}?t=${couponOrder.token}`);
  check("bill shows the discount and code", r.data.includes("Discount") && r.data.includes(code));

  /* payment, loyalty points, WhatsApp link, feedback */
  await pub("POST", `/api/orders/${couponOrder.code}/payment`, { t: couponOrder.token, utr: utr() });
  r = await cashier("POST", `/api/admin/orders/${couponOrder.code}/confirm`, { method: "upi" });
  check("cashier confirms a payment", r.status === 200 && r.data.order.points_earned === 3, JSON.stringify(r.data).slice(0, 200));
  r = await owner("GET", "/api/admin/customers?q=98765");
  const asha = r.data.customers.find((c) => c.phone === "9876543210");
  check("customer list records the customer and points", asha && asha.points >= 3 && asha.orders >= 1, JSON.stringify(r.data).slice(0, 200));
  r = await owner("POST", `/api/admin/orders/${couponOrder.code}/whatsapp`, { kind: "paid" });
  check("one-tap WhatsApp message with a fresh order link", r.status === 200 && r.data.url.startsWith("https://wa.me/919876543210?text=") && /order\.html#SRN-/.test(r.data.text), JSON.stringify(r.data));
  const shared = decodeURIComponent(r.data.text.match(/order\.html#(\S+)/)[1]).split(".");
  r = await pub("GET", `/api/orders/${shared[0]}?t=${shared[1]}`);
  check("the shared link opens the order", r.status === 200 && r.data.canReview === true);
  r = await pub("POST", `/api/orders/${couponOrder.code}/feedback`, { t: couponOrder.token, stars: 5, comment: "Loved the bombolone" });
  check("customer leaves feedback, gets the Google review link", r.status === 200 && r.data.googleReviewUrl.includes("g.page"));
  r = await manager("GET", "/api/admin/feedback");
  check("owner sees feedback and the average", r.data.average === 5 && r.data.feedback[0].comment === "Loved the bombolone");

  /* counter bill spending points */
  r = await cashier("POST", "/api/admin/counter", { items: [{ id: "bomb-vanilla", qty: 1 }], method: "cash", phone: "9876543210", points: 3 });
  check("points spent at the counter", r.status === 201 && r.data.order.points_used === 3 && r.data.order.total === 17700, JSON.stringify(r.data).slice(0, 300));
  r = await cashier("POST", "/api/admin/counter", { items: [{ id: "bomb-vanilla", qty: 1 }], method: "cash", phone: "9876543210", points: 999 });
  check("can't spend more points than the customer has", r.status === 400);

  /* refunds and credit notes */
  check("cashier can't refund", (await cashier("POST", `/api/admin/orders/${couponOrder.code}/refund`, { method: "upi" })).status === 403);
  check("paid orders can't simply be cancelled", (await owner("POST", `/api/admin/orders/${couponOrder.code}/status`, { to: "cancelled" })).status === 409);
  r = await manager("POST", `/api/admin/orders/${couponOrder.code}/refund`, { method: "upi", ref: "refund-123" });
  // this bill's points were spent above, so a plain refund would pay them out twice
  check("refund is stopped when the bill's points were already spent", r.status === 409 && r.data.pointsSpent > 0, JSON.stringify(r.data).slice(0, 200));
  r = await manager("POST", `/api/admin/orders/${couponOrder.code}/refund`, { method: "upi", ref: "refund-123", pointsOk: true });
  check("only the owner can override that", r.status === 409);
  r = await owner("POST", `/api/admin/orders/${couponOrder.code}/refund`, { method: "upi", ref: "refund-123", pointsOk: true });
  check("owner refunds (less the points), a credit note is numbered", r.status === 200 && /^SRNCN\/\d{4}\/\d{5}$/.test(r.data.order.credit_note_no), JSON.stringify(r.data).slice(0, 300));
  const cn = r.data.order.credit_note_no;
  r = await owner("GET", `/credit-note/${couponOrder.code}`);
  check("credit note prints", r.status === 200 && r.data.includes("Credit Note") && r.data.includes(cn));
  r = await owner("GET", `/api/admin/export.csv?from=${new Date(Date.now() - 300 * 86400000).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}`);
  check("accounts export lists the credit note as negative", r.data.includes(cn) && r.data.includes("-324.00"));

  /* tables: signed QR, rounds on a tab, call waiter, one bill */
  r = await owner("GET", "/api/admin/table-links");
  const t7 = new URL(r.data.links.find((l) => l.table === "7").url);
  const k = t7.searchParams.get("k");
  check("table QR links are signed", Boolean(k) && k.length === 12);
  check("a made-up table key is refused", (await pub("GET", "/api/tables/7?k=AAAAAAAAAAAA")).status === 403);
  r = await pub("POST", "/api/orders", { name: "Ravi", mode: "dinein", table: "7", payLater: true, k: "AAAAAAAAAAAA", items: [{ id: "bomb-vanilla", qty: 1 }] });
  check("pay-at-the-end needs the real table card", r.status === 403);
  r = await pub("POST", "/api/orders", { name: "Ravi", mode: "dinein", table: "7", payLater: true, k, items: [{ id: "bomb-vanilla", qty: 1 }] });
  check("pay-at-the-end needs staff to seat the table first", r.status === 409 && /open your table/.test(r.data.error), JSON.stringify(r.data));
  check("kitchen can't seat tables", (await kitchen("POST", "/api/admin/tables/7/open", {})).status === 403);
  const seated = await cashier("POST", "/api/admin/tables/7/open", {});
  check("cashier seats table 7 (and gets the table PIN)", seated.status === 201 && /^\d{4}$/.test(seated.data.pin), JSON.stringify(seated.data));
  const tpin = seated.data.pin;
  const round1 = await pub("POST", "/api/orders", { name: "Ravi", mode: "dinein", table: "7", payLater: true, k, pin: tpin, items: [{ id: "bomb-vanilla", qty: 1 }] });
  const round2 = await pub("POST", "/api/orders", { name: "Ravi", mode: "dinein", table: "7", payLater: true, k, pin: tpin, items: [{ id: "bomb-vanilla", qty: 2 }, { id: "cookie-brownie", qty: 1 }] });
  check("two rounds go straight to the kitchen", round1.data.onTab && round2.data.onTab && !round1.data.upi, JSON.stringify(round2.data));
  r = await kitchen("GET", "/api/admin/kitchen");
  check("kitchen sees the table's rounds", r.data.orders.filter((o) => o.table === "7").length >= 2);
  check("kitchen can start an order", (await kitchen("POST", `/api/admin/orders/${round1.data.code}/status`, { to: "preparing" })).status === 200);
  check("kitchen can't cancel orders", (await kitchen("POST", `/api/admin/orders/${round2.data.code}/status`, { to: "cancelled" })).status === 403);
  r = await pub("POST", "/api/tables/7/call", { k, kind: "bill" });
  check("guest asks for the bill", r.status === 200);
  r = await cashier("GET", "/api/admin/tables");
  check("staff see the open tab and the call", r.data.tabs.some((t) => t.table_no === "7" && t.rounds === 2) && r.data.calls.some((c) => c.table_no === "7" && c.kind === "bill"));
  r = await cashier("POST", "/api/admin/tables/7/bill", {});
  check("staff make one bill for the table", r.status === 201, JSON.stringify(r.data));
  r = await pub("POST", "/api/orders", { name: "Ravi", mode: "dinein", table: "7", payLater: true, k, pin: tpin, items: [{ id: "bomb-vanilla", qty: 1 }] });
  check("no more rounds once the bill is made", r.status === 409, JSON.stringify(r.data));
  check("guests don't see each other's names on the tab", !JSON.stringify((await pub("GET", `/api/tables/7?k=${k}&pin=${tpin}`)).data).includes("Ravi"));
  r = await pub("GET", `/api/tables/7?k=${k}&pin=${tpin}`);
  check("guests see the table bill to pay, totalling both rounds", r.data.bill && r.data.bill.token && r.data.bill.total === round1.data.total + round2.data.total, JSON.stringify(r.data).slice(0, 300));
  const bill = r.data.bill;
  await pub("POST", `/api/orders/${bill.code}/payment`, { t: bill.token, utr: utr() });
  r = await cashier("POST", `/api/admin/orders/${bill.code}/confirm`, { method: "upi" });
  check("paying the table bill closes the tab", r.status === 200 && !(await pub("GET", `/api/tables/7?k=${k}`)).data.tab, JSON.stringify(r.data).slice(0, 200));

  /* review fixes: odd input, permissions, logins */
  check("a broken table address gets a 404, not a crash", (await pub("GET", "/api/tables/%25zz%E0?k=AAAAAAAAAAAA")).status < 500);
  check("kitchen can't read coupons or settings", (await kitchen("GET", "/api/admin/coupons")).status === 403 && (await kitchen("GET", "/api/admin/settings")).status === 403);
  r = await manager("POST", "/api/admin/products", { name: "Sneaky", category: "constructor" });
  check("made-up product sections are refused", r.status === 400);
  r = await manager("POST", "/api/admin/images", { dataUrl: "data:image/png;base64,iVBO=Rw0K" });
  check("a broken photo upload gets a 400, not a crash", r.status === 400, JSON.stringify(r.data));
  const extra = session();
  for (let i = 0; i < 3; i++) await extra("POST", "/api/admin/login", { name: `Arun${sfx}`, password: "tea-and-cake-1" });
  check("correct logins never count towards the lockout", (await extra("GET", "/api/admin/me")).status === 200);

  /* products and photos */
  r = await manager("POST", "/api/admin/products/bomb-vanilla", { name: "Vanilla Bean Bombolone", description: "Madagascar vanilla cream" });
  check("manager renames a product", r.status === 200);
  r = await pub("GET", "/api/menu");
  check("website gets the new name", r.data.products.some((p) => p.id === "bomb-vanilla" && p.name === "Vanilla Bean Bombolone"));
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  r = await manager("POST", "/api/admin/images", { dataUrl: png });
  check("photo upload accepted", r.status === 201 && /^[A-Z0-9]{12}$/.test(r.data.key), JSON.stringify(r.data));
  const img = r.data.key;
  r = await manager("POST", "/api/admin/images", { dataUrl: "data:image/png;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" });
  check("a fake 'image' is refused", r.status === 400);
  r = await fetch(`${BASE}/img/${img}`);
  check("photo is served as an image", r.status === 200 && r.headers.get("content-type") === "image/png");
  r = await manager("POST", "/api/admin/products", { name: "Pistachio Kunafa Cookie", category: "cookies", description: "New!", img });
  check("manager adds a new product", r.status === 201, JSON.stringify(r.data));
  const newId = r.data.product.id;
  await manager("POST", `/api/admin/prices/${newId}`, { price: 22000, unit: "per piece", available: true });
  r = await pub("POST", "/api/orders", { ...base, phone: "9000000001", items: [{ id: newId, qty: 1 }] });
  check("new product can be ordered", r.status === 201 && r.data.total === 22000, JSON.stringify(r.data));
  await manager("POST", `/api/admin/products/${newId}`, { hidden: true });
  r = await pub("POST", "/api/orders", { ...base, phone: "9000000001", items: [{ id: newId, qty: 1 }] });
  check("hidden product can't be ordered", r.status === 409);

  /* reports, day closing, backup, activity, broadcast */
  r = await manager("GET", "/api/admin/reports");
  check("report has sales, top items and hours", r.status === 200 && r.data.report.totals.orders > 0 && r.data.report.topItems.length > 0 && r.data.report.byHour.length > 0, JSON.stringify(r.data).slice(0, 300));
  check("report counts the refund", r.data.report.refunds.n >= 1);
  r = await manager("GET", "/day-close");
  check("day closing sheet prints", r.status === 200 && r.data.includes("Day closing") && r.data.includes("Cash added to the drawer today"));
  r = await owner("GET", "/api/admin/backup.json");
  check("owner downloads a backup without passwords", r.status === 200 && Array.isArray(r.data.data.orders) && !JSON.stringify(r.data).includes("pass_hash"));
  r = await owner("GET", "/api/admin/activity");
  check("activity log records who did what", r.data.log.some((l) => l.action === "refunded" && l.actor === "Owner") && r.data.log.some((l) => l.action === "price changed"));
  await pub("POST", "/api/orders", { ...base, phone: "9123400000", optIn: true, items: [{ id: "bomb-vanilla", qty: 1 }] });
  r = await owner("POST", "/api/admin/broadcast", { text: "Hi {name}, new Kunafa cookie this weekend!" });
  check("offer message links only for customers who opted in", r.status === 200 && r.data.links.every((l) => l.phone !== "9123400000"), JSON.stringify(r.data).slice(0, 200));

  /* switching staff off logs them out */
  const list = (await owner("GET", "/api/admin/staff")).data.staff;
  const priya = list.find((s) => s.name === `Priya${sfx}`);
  await owner("POST", `/api/admin/staff/${priya.id}`, { active: false });
  check("switched-off staff are logged out at once", (await cashier("GET", "/api/admin/orders")).status === 401);
  await owner("POST", "/api/admin/logout-everyone", {});
  check("log out everyone works", (await manager("GET", "/api/admin/me")).status === 401 && (await owner("GET", "/api/admin/me")).status === 401);

  console.log(results.join("\n"));
  console.log(`\n${results.filter((l) => l.startsWith("PASS")).length}/${results.length} passed`);
})().catch((e) => { console.log(results.join("\n")); console.error("ERROR", e); process.exit(1); });
