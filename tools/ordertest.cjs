// Full online-order journey on a phone-sized screen: box -> checkout -> UPI pay -> owner confirms -> bill.
// Needs: site built with SEREN_API=http://127.0.0.1:8790, preview on :4321, backend `npm run dev` in backend/.
// Usage: node tools/ordertest.cjs <outDir>
const fs = require("fs");
const path = require("path");
const puppeteer = require(path.join(require("os").homedir(), "node_modules/puppeteer"));
const out = process.argv[2] || ".";
const SITE = "http://localhost:4321/";
const API = "http://127.0.0.1:8790";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  (" + detail + ")" : ""}`);

const vars = Object.fromEntries(fs.readFileSync(path.join(__dirname, "../backend/.dev.vars"), "utf8").trim().split("\n").map((l) => {
  const i = l.indexOf("=");
  return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
}));
let cookie = "";
async function owner(method, p, body) {
  const res = await fetch(API + p, {
    method,
    headers: { Origin: API, "X-Seren": "1", "Content-Type": "application/json", Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return { status: res.status, data: await res.json() };
}

(async () => {
  // the owner prices everything and opens the shop
  const login = await owner("POST", "/api/admin/login", { password: vars.ADMIN_PASSWORD });
  if (login.status !== 200) throw new Error("owner login failed: " + JSON.stringify(login.data));
  const cat = await owner("GET", "/api/admin/catalog");
  for (const it of cat.data.items) await owner("POST", `/api/admin/prices/${it.id}`, { price: it.category === "entremets" ? 210000 : 18000, unit: it.category === "entremets" ? "6-inch cake" : "per piece", available: it.id !== "cookie-matcha" });
  await owner("POST", "/api/admin/settings", { upiId: "seren@okhdfcbank", acceptingOrders: true, openTime: "00:00", closeTime: "23:59", prepMinutes: 0, minOrder: 0, deliveryFee: 4000, freeDeliveryAbove: 100000,
    dineIn: true, dineInTables: "", dineInPayLater: true, whatsappNumber: "919876543210" });
  const couponCode = `SAVE${Date.now().toString(36).slice(-4).toUpperCase()}`;
  await owner("POST", "/api/admin/coupons", { code: couponCode, kind: "flat", value: 5000 });
  const links = (await owner("GET", "/api/admin/table-links")).data.links;
  const t3 = new URL(links.find((l) => l.table === "3").url);
  await owner("POST", "/api/admin/tables/3/close", {}).catch(() => {});
  await owner("POST", "/api/admin/tables/3/open", {}); // staff seat table 3 so it can pay at the end

  const b = await puppeteer.launch({ headless: true });
  const p = await b.newPage();
  await p.emulate(puppeteer.KnownDevices["iPhone 13"]);
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(SITE, { waitUntil: "networkidle0" });
  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: "networkidle0" });
  await wait(1500);

  const labels = await p.evaluate(() => ({
    priced: document.querySelector("#cookieGrid .add").textContent,
    sold: [...document.querySelectorAll("#cookieGrid .add")].map((b) => b.textContent).find((t) => t === "Sold out"),
  }));
  check("Add buttons show prices", /₹180/.test(labels.priced), labels.priced);
  check("unavailable product shows Sold out", labels.sold === "Sold out");

  // add two cookies + a bombolone
  await p.evaluate(() => { const a = document.querySelector("#cookieGrid .add"); a.click(); a.click(); document.querySelector("#bombRail .add").click(); });
  await wait(300);
  await p.evaluate(() => document.getElementById("boxBtn").click());
  await wait(800);
  const foot = await p.evaluate(() => ({ sum: document.getElementById("boxSum").textContent, btn: document.getElementById("checkoutBtn").textContent, hidden: document.getElementById("checkoutBtn").hidden, line: document.querySelector("#boxList li .n small")?.textContent }));
  check("box shows line prices and subtotal", /₹540/.test(foot.sum) && /₹360/.test(foot.line || ""), JSON.stringify(foot));
  check("checkout button visible with total", !foot.hidden && /₹540/.test(foot.btn), JSON.stringify(foot));
  await p.screenshot({ path: `${out}/o-box.jpg`, type: "jpeg", quality: 60 });

  await p.evaluate(() => document.getElementById("checkoutBtn").click());
  await p.waitForFunction(() => document.querySelector('#checkout select[name="date"] option[value]:not([value=""])'), { timeout: 8000 });
  // submit empty -> friendly error
  await p.evaluate(() => document.querySelector("#checkout .co-form").requestSubmit());
  await wait(200);
  check("empty form shows a friendly error", (await p.$eval("#checkout .err", (e) => e.textContent)).includes("name"));
  await p.type('#checkout input[name="name"]', "Asha Raman");
  await p.type('#checkout input[name="phone"]', "98765 43210");
  await p.evaluate(() => document.querySelector('#checkout input[value="delivery"]').click());
  await p.type('#checkout textarea[name="address"]', "12 Long Street, Mylapore, Chennai");
  await p.type('#checkout input[name="pincode"]', "600004");
  await wait(200);
  const tot = await p.$eval("#checkout .co-total b", (e) => e.textContent);
  check("total includes delivery fee", /₹580/.test(tot), tot);
  await p.screenshot({ path: `${out}/o-form.jpg`, type: "jpeg", quality: 60 });
  await p.evaluate(() => document.querySelector("#checkout .co-form").requestSubmit());
  await p.waitForSelector("#checkout .pay-qr svg", { timeout: 10000 });
  const pay = await p.evaluate(() => ({
    title: document.getElementById("drawerTitle").textContent,
    amt: document.querySelector(".pay-amt").textContent,
    app: document.querySelector(".pay-app")?.getAttribute("href"),
    boxCount: document.getElementById("boxCount").textContent,
    saved: JSON.parse(localStorage.getItem("seren-orders-v1") || "[]").length,
  }));
  check("pay screen shows amount, QR and UPI app button", /580/.test(pay.amt) && /^upi:\/\/pay\?/.test(pay.app || ""), JSON.stringify(pay));
  check("box emptied and order remembered", pay.boxCount === "0" && pay.saved === 1, JSON.stringify(pay));
  await p.screenshot({ path: `${out}/o-pay.jpg`, type: "jpeg", quality: 60 });

  await p.type(".utr input", String(Date.now()).slice(-12)); // a fresh ref each run (refs can only be used once)
  await p.evaluate(() => document.querySelector(".utr").requestSubmit());
  await p.waitForSelector("#checkout .done", { timeout: 8000 });
  check("thank-you screen after sending the UPI ref", true);
  const track = await p.$eval("#checkout .done a", (a) => a.getAttribute("href"));
  await p.screenshot({ path: `${out}/o-done.jpg`, type: "jpeg", quality: 60 });

  // owner confirms
  const code = decodeURIComponent(track.split("#")[1]).split(".")[0];
  const conf = await owner("POST", `/api/admin/orders/${code}/confirm`, { method: "upi" });
  check("owner confirms the payment", conf.status === 200 && conf.data.order.status === "paid", JSON.stringify(conf.data));
  await owner("POST", `/api/admin/orders/${code}/status`, { to: "preparing" });

  // order page
  await p.goto(SITE + track, { waitUntil: "networkidle0" });
  await p.waitForSelector(".op-card h1", { timeout: 8000 });
  await wait(900);
  const op = await p.evaluate(() => ({
    h: document.querySelector(".op-card h1").textContent,
    bill: document.querySelector('.op-card a[href*="/invoice/"]')?.href,
    now: document.querySelector(".steps .now")?.textContent,
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
  check("order page shows the live status", op.h === "Being made" && op.now === "Being made", JSON.stringify(op));
  check("order page links to the bill", Boolean(op.bill));
  check("order page fits the phone screen", !op.overflow);
  await p.screenshot({ path: `${out}/o-track.jpg`, type: "jpeg", quality: 60, fullPage: true });

  const bill = await b.newPage();
  await bill.goto(op.bill, { waitUntil: "networkidle0" });
  const billText = await bill.evaluate(() => document.body.innerText);
  check("bill opens with invoice number and total", /SRN\/\d{4}\/\d{5}/.test(billText) && /580/.test(billText), billText.slice(0, 200));
  await bill.screenshot({ path: `${out}/o-bill.jpg`, type: "jpeg", quality: 60, fullPage: true });

  // dine-in: a guest scans the QR on table 5
  const t = await b.newPage();
  await t.emulate(puppeteer.KnownDevices["iPhone 13"]);
  t.on("pageerror", (e) => errs.push(e.message));
  await t.goto(SITE + "?table=5", { waitUntil: "networkidle0" });
  await wait(1200);
  check("table guests see which table they're ordering for", (await t.$eval("#boxStatus", (e) => e.textContent)) === "Ordering for table 5");
  await t.evaluate(() => { document.querySelector("#bombRail .add").click(); document.getElementById("boxBtn").click(); });
  await wait(700);
  await t.evaluate(() => document.getElementById("checkoutBtn").click());
  await t.waitForSelector('#checkout input[name="table"]', { timeout: 8000 });
  await wait(300);
  const dine = await t.evaluate(() => ({
    mode: document.querySelector('#checkout [name="mode"]:checked').value,
    table: document.querySelector('#checkout input[name="table"]').value,
    locked: document.querySelector('#checkout input[name="table"]').readOnly,
    whenHidden: document.querySelector("#checkout .when").hidden,
    btn: document.querySelector('#checkout button[type="submit"]').textContent,
  }));
  check("dine-in is picked with the table filled in", dine.mode === "dinein" && dine.table === "5" && dine.locked && dine.whenHidden, JSON.stringify(dine));
  await t.type('#checkout input[name="name"]', "Ravi");
  await t.screenshot({ path: `${out}/o-dine-form.jpg`, type: "jpeg", quality: 60 });
  await t.evaluate(() => document.querySelector("#checkout .co-form").requestSubmit());
  await t.waitForSelector("#checkout .pay-qr", { timeout: 10000 });
  const dineTrack = await t.$eval('#checkout a.linkish[href*="order.html"]', (a) => a.getAttribute("href"));
  await t.goto(SITE + dineTrack, { waitUntil: "networkidle0" });
  await t.waitForSelector(".op-when", { timeout: 8000 });
  check("dine-in order page shows the table", /Table 5/.test(await t.$eval(".op-when", (e) => e.textContent)));
  await t.screenshot({ path: `${out}/o-dine-track.jpg`, type: "jpeg", quality: 60 });

  // coupon at checkout
  await p.bringToFront();
  await p.goto(SITE, { waitUntil: "networkidle0" });
  await p.evaluate(() => { localStorage.removeItem("seren-box-v1"); });
  await p.reload({ waitUntil: "networkidle0" });
  await wait(1200);
  await p.evaluate(() => { document.querySelector("#bombRail .add").click(); document.getElementById("boxBtn").click(); });
  await wait(600);
  await p.evaluate(() => document.getElementById("checkoutBtn").click());
  await p.waitForSelector('#checkout input[name="coupon"]', { timeout: 8000 });
  await p.type('#checkout input[name="coupon"]', couponCode.toLowerCase());
  await p.evaluate(() => document.querySelector("#checkout .apply").click());
  await p.waitForFunction(() => document.querySelector("#checkout .coupon-note").textContent.trim(), { timeout: 5000 });
  const cnote = await p.$eval("#checkout .coupon-note", (e) => e.textContent);
  check("coupon is accepted", /−/.test(cnote), cnote);
  const ctot = await p.$eval("#checkout .co-total b", (e) => e.textContent);
  check("coupon code takes money off at checkout", /₹130/.test(ctot), ctot);
  check("WhatsApp order button offered", Boolean(await p.$("#checkout [data-wa]")));
  check("offers opt-in tick box offered", Boolean(await p.$('#checkout input[name="optIn"]')));
  await p.screenshot({ path: `${out}/o-coupon.jpg`, type: "jpeg", quality: 60 });

  // pay at the end from the real table card, then call for the bill
  const g = await b.newPage();
  await g.emulate(puppeteer.KnownDevices["iPhone 13"]);
  g.on("pageerror", (e) => errs.push(e.message));
  await g.bringToFront();
  await g.goto(SITE + t3.search, { waitUntil: "networkidle0" });
  await wait(1200);
  check("table guests get the call-waiter bar", Boolean(await g.$(".tablebar [data-call=waiter]")));
  await g.evaluate(() => { document.querySelector("#bombRail .add").click(); document.getElementById("boxBtn").click(); });
  await wait(600);
  await g.evaluate(() => document.getElementById("checkoutBtn").click());
  await g.waitForSelector("#checkout .paywhen", { timeout: 8000 });
  await g.type('#checkout input[name="name"]', "Lakshmi");
  const lbl = await g.$eval('#checkout button[type="submit"]', (e) => e.textContent);
  check("pay-at-the-end is the default at a table", lbl === "Send to the kitchen", lbl);
  await g.screenshot({ path: `${out}/o-paylater.jpg`, type: "jpeg", quality: 60 });
  await g.evaluate(() => document.querySelector("#checkout .co-form").requestSubmit());
  await g.waitForSelector("#checkout .done", { timeout: 8000 });
  check("order goes to the kitchen without paying", /kitchen/.test(await g.$eval("#checkout .done", (e) => e.textContent)));
  await g.evaluate(() => document.getElementById("closeBox").click());
  await wait(500);
  await g.evaluate(() => document.querySelector(".tablebar [data-call=bill]").click());
  await wait(800);
  check("guest asks for the bill from the bar", /bill|already know/i.test(await g.$eval("#toast", (e) => e.textContent)));
  await g.evaluate(() => document.querySelector(".tablebar [data-tab]").click());
  await g.waitForSelector(".tabsheet[open] .ts-lines", { timeout: 8000 });
  check("guest sees the table's tab", /Total so far/.test(await g.$eval(".tabsheet", (e) => e.textContent)));
  await g.screenshot({ path: `${out}/o-tab.jpg`, type: "jpeg", quality: 60 });

  check("no script errors", errs.length === 0, errs.join(" | "));
  await b.close();
  console.log(results.join("\n"));
})().catch((e) => { console.log(results.join("\n")); console.error("ERROR", e.message); process.exit(1); });
