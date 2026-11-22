// Drives SEREN Counter (/pos/) in a headless browser: login, billing, cash change, UPI with a coupon (exact amount),
// hold / bring back, the customer screen, going offline (bill queued, slip printed) and syncing back online.
// Needs the local backend (npm run dev). Usage: node test/pos-ui.cjs <outDir>
const fs = require("fs");
const path = require("path");
const puppeteer = require(path.join(require("os").homedir(), "node_modules/puppeteer"));
const out = process.argv[2] || ".";
const BASE = "http://127.0.0.1:8790";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  (" + String(detail).slice(0, 400) + ")" : ""}`);
const pw = fs.readFileSync(path.join(__dirname, "../.dev.vars"), "utf8").match(/ADMIN_PASSWORD="([^"]+)"/)[1];
const sfx = Date.now().toString(36).slice(-4).toUpperCase();

async function setup() {
  const h = { Origin: BASE, "X-Seren": "1", "Content-Type": "application/json" };
  const login = await fetch(`${BASE}/api/admin/login`, { method: "POST", headers: h, body: JSON.stringify({ password: pw }) });
  const H = { ...h, Cookie: (login.headers.get("set-cookie") || "").split(";")[0] };
  const post = (p, b) => fetch(BASE + p, { method: "POST", headers: H, body: JSON.stringify(b) }).then((r) => r.json());
  await post("/api/admin/settings", { upiId: "seren@okhdfcbank", acceptingOrders: true, loyalty: { enabled: true, earnEvery: 10000, pointValue: 100 } });
  for (const [id, price] of [["bomb-vanilla", 18000], ["bomb-tiramisu", 20000], ["cookie-biscoff", 15000], ["tiramisu", 32000]]) await post(`/api/admin/prices/${id}`, { price, unit: "per piece", available: true });
  await post("/api/admin/coupons", { code: `POS${sfx}`, kind: "flat", value: 5000 });
  return post;
}

(async () => {
  const post = await setup();
  const b = await puppeteer.launch({ headless: true });
  const p = await b.newPage();
  await p.setViewport({ width: 1366, height: 820 });
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/status of 40[0-9]|ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(m.text())) errs.push(m.text()); });
  await p.goto(`${BASE}/pos/`, { waitUntil: "networkidle0" });
  check("login screen first", await p.$eval("#login", (e) => !e.hidden));
  await p.type("#pw", pw);
  await p.evaluate(() => document.getElementById("loginForm").requestSubmit());
  await p.waitForSelector("#app:not([hidden]) .tile", { timeout: 8000 });
  // capture receipts instead of opening the print window
  await p.evaluate(() => { window.__printed = []; POSPrint.printHtml = async (html) => { window.__printed.push(html); return { ok: true }; }; });
  check("counter opens with product tiles", (await p.$$eval(".tile", (t) => t.length)) >= 4);
  check("shows online", /Online/.test(await p.$eval("#status", (e) => e.textContent)));

  // customer screen
  const disp = await b.newPage();
  await disp.goto(`${BASE}/pos/display`, { waitUntil: "networkidle0" });
  await p.bringToFront(); // background tabs are paused by the headless browser

  // add 2 vanilla + 1 biscoff
  const tap = (id) => p.evaluate((x) => document.querySelector(`.tile[data-add="${x}"]`).click(), id);
  await p.evaluate(() => document.querySelector('[data-cat="all"]').click());
  await tap("bomb-vanilla"); await tap("bomb-vanilla"); await tap("cookie-biscoff");
  await wait(300);
  check("bill adds up", (await p.$eval("#total", (e) => e.textContent)) === "₹510");
  check("tile shows how many are in the bill", (await p.$eval('.tile[data-add="bomb-vanilla"] .q', (e) => e.textContent)) === "2");
  await wait(300);
  check("customer screen mirrors the bill", (await disp.$eval("#total", (e) => e.textContent)) === "₹510" && (await disp.$$eval("#lines li", (l) => l.length)) === 2);
  await p.screenshot({ path: `${out}/pos-bill.jpg`, type: "jpeg", quality: 60 });

  // cash with change
  await p.keyboard.press("F1");
  await p.waitForSelector("#payDlg[open] #tendered", { timeout: 5000 });
  await p.$eval("#tendered", (e) => { e.value = ""; });
  await p.type("#tendered", "1000");
  await wait(200);
  check("change due is worked out", (await p.$eval("#change", (e) => e.textContent)) === "₹490");
  await p.screenshot({ path: `${out}/pos-cash.jpg`, type: "jpeg", quality: 60 });
  await p.keyboard.press("Enter");
  await p.waitForFunction(() => window.__printed.length === 1, { timeout: 8000 });
  const r1 = await p.evaluate(() => window.__printed[0]);
  check("cash bill saved with a bill number and receipt printed", /SRN\/\d{4}\/\d{5}/.test(r1) && /Change/.test(r1) && /₹490/.test(r1), r1.slice(0, 300));
  check("counter clears for the next customer", (await p.$eval("#total", (e) => e.textContent)) === "₹0");
  await wait(300);
  check("customer screen says thank you with the change", /490/.test(await disp.$eval("#changeLine", (e) => e.textContent)));

  // UPI with a coupon: the QR has the exact discounted amount
  await tap("tiramisu");
  await p.evaluate(() => { document.getElementById("extras").open = true; });
  await p.type("#coupon", `pos${sfx}`.toLowerCase());
  await p.keyboard.press("F2");
  await p.waitForSelector("#payDlg[open] #qr svg", { timeout: 8000 });
  const due = await p.$eval("#payDlg .due b", (e) => e.textContent);
  check("UPI amount includes the coupon (₹320 − ₹50)", due === "₹270", due);
  await wait(300);
  check("customer screen shows the UPI QR and amount", !(await disp.$eval("#upi", (e) => e.hidden)) && (await disp.$eval("#upiTotal", (e) => e.textContent)) === "₹270");
  await disp.screenshot({ path: `${out}/pos-display-upi.jpg`, type: "jpeg", quality: 60 });
  await p.screenshot({ path: `${out}/pos-upi.jpg`, type: "jpeg", quality: 60 });
  await p.evaluate(() => document.querySelector("#payDlg form").requestSubmit());
  await p.waitForFunction(() => window.__printed.length === 2, { timeout: 8000 });
  check("UPI bill saved with the discount", /Discount/.test(await p.evaluate(() => window.__printed[1])));

  // hold and bring back
  await tap("bomb-tiramisu");
  await p.keyboard.press("F4");
  await wait(300);
  check("hold clears the screen and counts the held bill", (await p.$eval("#total", (e) => e.textContent)) === "₹0" && (await p.$eval("#heldCount", (e) => e.textContent)) === "1");
  await p.keyboard.press("F6");
  await p.waitForSelector("#heldDlg[open] [data-unhold]");
  await p.evaluate(() => document.querySelector("[data-unhold]").click());
  await wait(300);
  check("held bill comes back", (await p.$eval("#total", (e) => e.textContent)) === "₹200");

  // offline: the bill waits on this PC and a slip prints; back online it's sent once
  await p.setOfflineMode(true);
  await p.keyboard.press("F3");
  await p.waitForSelector("#payDlg[open]", { timeout: 5000 });
  await p.evaluate(() => document.querySelector("#payDlg form").requestSubmit());
  await p.waitForFunction(() => window.__printed.length === 3, { timeout: 8000 });
  const slip = await p.evaluate(() => window.__printed[2]);
  check("offline bill prints an order slip (not a tax invoice)", /ORDER SLIP/.test(slip) && /NOT A TAX INVOICE/.test(slip));
  check("offline status and 1 bill waiting", /Offline · 1 bill waiting/.test(await p.$eval("#status", (e) => e.textContent)), await p.$eval("#status", (e) => e.textContent));
  await p.screenshot({ path: `${out}/pos-offline.jpg`, type: "jpeg", quality: 60 });
  await p.setOfflineMode(false);
  await p.evaluate(() => window.dispatchEvent(new Event("online")));
  await p.waitForFunction(() => POS.queue().length === 0, { timeout: 15000 });
  check("back online, the waiting bill is sent", /Online/.test(await p.$eval("#status", (e) => e.textContent)));
  const ref = await p.evaluate(() => window.__printed[2].match(/POS-[A-Z0-9-]+/)[0]);
  const again = await post("/api/admin/counter", { clientRef: ref, items: [{ id: "bomb-tiramisu", qty: 1 }], method: "card" });
  check("the same bill sent twice is saved only once", again.duplicate === true && /SRN\/\d{4}\/\d{5}/.test(again.order.invoice_no) && /offline/.test(again.order.notes), JSON.stringify(again).slice(0, 200));

  // installable + offline helper
  const pwa = await p.evaluate(async () => ({ manifest: Boolean(document.querySelector('link[rel="manifest"]')), sw: Boolean(await navigator.serviceWorker.getRegistration()) }));
  check("installable app with offline helper", pwa.manifest && pwa.sw, JSON.stringify(pwa));
  // restart with no internet: the counter still opens and can bill (offline helper + remembered products)
  await p.setOfflineMode(true);
  await p.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await p.waitForSelector("#app:not([hidden]) .tile", { timeout: 10000 }).catch(() => {});
  const off = await p.evaluate(() => ({ app: !document.getElementById("app").hidden, tiles: document.querySelectorAll(".tile").length, status: document.getElementById("status").textContent }));
  check("restarted with no internet, the counter still opens", off.app && off.tiles >= 4 && /Offline/.test(off.status), JSON.stringify(off));
  await p.setOfflineMode(false);
  await p.reload({ waitUntil: "networkidle0" });
  await p.waitForSelector("#app:not([hidden]) .tile", { timeout: 10000 });
  await p.setViewport({ width: 820, height: 1180 });
  await wait(400);
  check("works on a tablet in portrait", await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await p.screenshot({ path: `${out}/pos-tablet.jpg`, type: "jpeg", quality: 60 });
  check("no script errors", errs.length === 0, errs.join(" | "));
  await b.close();
  console.log(results.join("\n"));
  console.log(`\n${results.filter((l) => l.startsWith("PASS")).length}/${results.length} passed`);
})().catch((e) => { console.log(results.join("\n")); console.error("ERROR", e.message); process.exit(1); });
