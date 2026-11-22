// Drives the new dashboard screens in a headless browser: tables & calls, menu editor, customers & coupons,
// reports, staff & activity, kitchen screen, and what a cashier login can see.
// Needs the local backend (npm run dev) with data from test/api.mjs and test/upgrade.mjs. Usage: node test/admin-ui2.cjs <outDir>
const fs = require("fs");
const path = require("path");
const puppeteer = require(path.join(require("os").homedir(), "node_modules/puppeteer"));
const out = process.argv[2] || ".";
const BASE = "http://127.0.0.1:8790";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  (" + String(detail).slice(0, 300) + ")" : ""}`);
const pw = fs.readFileSync(path.join(__dirname, "../.dev.vars"), "utf8").match(/ADMIN_PASSWORD="([^"]+)"/)[1];
const sfx = Date.now().toString(36).slice(-4);

async function login(b, name, password, device = "iPhone 13") {
  const p = await b.newPage();
  if (device) await p.emulate(puppeteer.KnownDevices[device]); else await p.setViewport({ width: 1280, height: 900 });
  p.errs = [];
  p.on("pageerror", (e) => p.errs.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/status of 40[0-9]/.test(m.text())) p.errs.push(m.text()); });
  await p.goto(`${BASE}/admin/`, { waitUntil: "networkidle0" });
  if (name) await p.type("#who", name);
  await p.type("#pw", password);
  await p.evaluate(() => document.getElementById("loginForm").requestSubmit());
  await wait(1500);
  return p;
}
const tab = async (p, name) => { await p.evaluate((n) => document.querySelector(`[data-tab="${n}"]`).click(), name); await wait(900); };

(async () => {
  await require("./setup-shop.cjs")(); // every product priced, shop open
  const b = await puppeteer.launch({ headless: true });
  const o = await login(b, "", pw);

  // a guest at a fresh table calls a waiter (through the real signed link)
  const T = `X${sfx}`;
  await o.evaluate(async (t) => fetch("/api/admin/settings", { method: "POST", headers: { "X-Seren": "1", "Content-Type": "application/json" }, body: JSON.stringify({ dineIn: true, dineInPayLater: true, dineInTables: `1, 2, ${t}` }) }), T);
  const links = await o.evaluate(async () => (await (await fetch("/api/admin/table-links", { headers: { "X-Seren": "1" } })).json()).links);
  const t2 = new URL(links.find((l) => l.table === T).url);
  await o.evaluate(async (t) => fetch(`/api/admin/tables/${t}/open`, { method: "POST", headers: { "X-Seren": "1", "Content-Type": "application/json" }, body: "{}" }), T);
  await fetch(`${BASE}/api/tables/${T}/call`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:4321" }, body: JSON.stringify({ k: t2.searchParams.get("k"), kind: "waiter" }) });
  await fetch(`${BASE}/api/orders`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:4321" }, body: JSON.stringify({ name: "Kiran", mode: "dinein", table: T, payLater: true, k: t2.searchParams.get("k"), items: [{ id: "bomb-tiramisu", qty: 2 }] }) });

  await tab(o, "tables");
  check("tables tab shows the waiter call", (await o.$eval("#callList", (e) => e.textContent)).includes(`Table ${T}`));
  check("tables tab shows the table's open tab", (await o.$eval("#tabGrid", (e) => e.textContent)).includes(`Table ${T}`));
  await o.screenshot({ path: `${out}/u-tables.jpg`, type: "jpeg", quality: 60 });
  await o.evaluate(() => document.querySelector("#callList [data-done]").click());
  await wait(800);
  await o.evaluate((t) => [...document.querySelectorAll("[data-bill]")].find((b) => b.dataset.bill === t).click(), T);
  await wait(1000);
  check("staff make the table bill from the card", /waiting for payment/.test(await o.$eval("#tabGrid", (e) => e.textContent)));

  // menu: edit a product and add a new one
  await tab(o, "menu");
  await o.evaluate(() => document.querySelector('[data-edit="cookie-seasalt"]').click());
  await o.waitForSelector("#editSheet[open] #productForm", { timeout: 5000 });
  await o.$eval('#productForm [name="description"]', (e) => { e.value = "Flaky sea salt over dark chocolate chunks"; });
  await o.screenshot({ path: `${out}/u-edit.jpg`, type: "jpeg", quality: 60 });
  await o.evaluate(() => document.querySelector("#productForm").requestSubmit());
  await wait(1200);
  const menu = await (await fetch(`${BASE}/api/menu`)).json();
  check("product description edit reaches the website", menu.products.some((p) => p.id === "cookie-seasalt" && /Flaky sea salt/.test(p.description)));
  await o.evaluate(() => document.getElementById("addProduct").click());
  await o.waitForSelector("#editSheet[open] #productForm", { timeout: 5000 });
  await o.type('#productForm [name="name"]', `Rose Pistachio Eclair ${sfx}`);
  await o.select('#productForm [name="category"]', "pastry");
  await o.evaluate(() => document.querySelector("#productForm").requestSubmit());
  await wait(1500);
  check("new product appears in the menu list", (await o.$eval("#priceGroups", (e) => e.textContent)).includes(`Rose Pistachio Eclair ${sfx}`));
  await o.screenshot({ path: `${out}/u-menu.jpg`, type: "jpeg", quality: 60 });

  // customers, coupons, offers, feedback
  await tab(o, "customers");
  check("customer list shows customers", (await o.$$eval("#custTable tbody tr", (r) => r.length)) > 0);
  await o.screenshot({ path: `${out}/u-customers.jpg`, type: "jpeg", quality: 60 });
  await o.evaluate(() => document.querySelector('#custTabs [data-sub="coupons"]').click());
  await wait(800);
  await o.type('#couponForm [name="code"]', `ui${sfx}`);
  await o.type('#couponForm [name="value"]', "15");
  await o.evaluate(() => document.querySelector("#couponForm").requestSubmit());
  await wait(1000);
  check("coupon created from the form", (await o.$eval("#custBody", (e) => e.textContent)).includes(`UI${sfx.toUpperCase()}`));
  await o.screenshot({ path: `${out}/u-coupons.jpg`, type: "jpeg", quality: 60 });
  await o.evaluate(() => document.querySelector('#custTabs [data-sub="broadcast"]').click());
  await wait(500);
  await o.type("#bcForm textarea", "Hi {name}! New eclairs today.");
  await o.evaluate(() => document.querySelector("#bcForm").requestSubmit());
  await wait(1000);
  check("offer message links prepared", /customer/.test(await o.$eval("#bcList", (e) => e.textContent)));
  await o.evaluate(() => document.querySelector('#custTabs [data-sub="feedback"]').click());
  await wait(800);
  check("feedback list shows ratings", /Average rating/.test(await o.$eval("#custBody", (e) => e.textContent)));

  // reports
  await tab(o, "reports");
  await wait(600);
  check("reports show sales and charts", (await o.$$eval("#repBody .bar", (b) => b.length)) > 0 && /Best sellers/.test(await o.$eval("#repBody", (e) => e.textContent)));
  const bar = await o.$("#repBody .bar");
  await bar.hover();
  await wait(200);
  check("chart bars show a tooltip", !(await o.$eval("#tip", (e) => e.hidden)) && /₹|bill/.test(await o.$eval("#tip", (e) => e.textContent)));
  check("CSV link follows the period", /export\.csv\?from=\d{4}-\d{2}-\d{2}&to=/.test(await o.$eval("#csvBtn", (e) => e.getAttribute("href"))));
  await o.screenshot({ path: `${out}/u-reports.jpg`, type: "jpeg", quality: 60, fullPage: true });

  // settings: staff, activity, backup
  await tab(o, "settings");
  await wait(800);
  await o.type('#addStaff [name="name"]', `Sam${sfx}`);
  await o.select('#addStaff [name="role"]', "cashier");
  await o.type('#addStaff [name="password"]', "counter-pass-9");
  await o.evaluate(() => document.querySelector("#addStaff").requestSubmit());
  await wait(1200);
  check("owner adds staff from settings", (await o.$eval("#staffBox", (e) => e.textContent)).includes(`Sam${sfx}`));
  check("activity log is shown", /logged in/.test(await o.$eval("#staffBox .activity", (e) => e.textContent)));
  await o.screenshot({ path: `${out}/u-settings.jpg`, type: "jpeg", quality: 60, fullPage: true });
  const overflow = await o.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check("dashboard fits a phone screen", !overflow);
  check("no script errors (owner)", o.errs.length === 0, o.errs.join(" | "));

  // cashier sees only what they need
  const ctx = await b.createBrowserContext(); // separate cookies from the owner's
  const c = await login(ctx, `Sam${sfx}`, "counter-pass-9");
  const visible = await c.$$eval(".tabs [data-tab]", (els) => els.filter((e) => !e.hidden).map((e) => e.dataset.tab));
  check("cashier sees orders, tables and new bill only", JSON.stringify(visible) === JSON.stringify(["orders", "tables", "counter"]), JSON.stringify(visible));
  check("no script errors (cashier)", c.errs.length === 0, c.errs.join(" | "));

  // kitchen screen on a tablet
  const k = await b.newPage();
  await k.setViewport({ width: 1180, height: 820 });
  await k.goto(`${BASE}/admin/kitchen.html`, { waitUntil: "networkidle0" });
  await wait(800);
  const todo = await k.$$eval("#todo .k-card", (x) => x.length);
  check("kitchen screen lists orders to make", todo > 0);
  await k.evaluate(() => document.querySelector('#todo [data-move="preparing"]').click());
  await wait(1200);
  check("kitchen taps Start and it moves across", (await k.$$eval("#doing .k-card", (x) => x.length)) > 0);
  await k.screenshot({ path: `${out}/u-kitchen.jpg`, type: "jpeg", quality: 60 });
  const kot = await (await k.evaluate(async () => { const a = document.querySelector("#doing .k-btn"); const r = await fetch(a.href); return { s: r.status, x: r.headers.get("x-frame-options") }; }));
  check("kitchen ticket can be printed from the screen", kot.s === 200 && kot.x === "SAMEORIGIN", JSON.stringify(kot));

  await b.close();
  console.log(results.join("\n"));
  console.log(`\n${results.filter((l) => l.startsWith("PASS")).length}/${results.length} passed`);
})().catch((e) => { console.log(results.join("\n")); console.error("ERROR", e.message); process.exit(1); });
