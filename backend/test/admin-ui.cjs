// Drives the owner dashboard in a headless browser (phone size): login, orders, confirm, counter bill, prices, settings.
// Needs the local backend (npm run dev). Usage: node test/admin-ui.cjs <outDir>
const fs = require("fs");
const path = require("path");
const puppeteer = require(path.join(require("os").homedir(), "node_modules/puppeteer"));
const out = process.argv[2] || ".";
const BASE = "http://127.0.0.1:8790";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  (" + detail + ")" : ""}`);
const pw = fs.readFileSync(path.join(__dirname, "../.dev.vars"), "utf8").match(/ADMIN_PASSWORD="([^"]+)"/)[1];

(async () => {
  // a fresh customer order waiting for payment check
  const day = (await (await fetch(`${BASE}/api/slots`)).json()).days[0];
  const placed = await (await fetch(`${BASE}/api/orders`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:4321" },
    body: JSON.stringify({ name: "Kavya", phone: "9123456780", mode: "pickup", date: day.date, time: day.times[0], notes: "Happy birthday Amma", items: [{ id: "ent-hazelnut", qty: 1 }, { id: "bomb-tiramisu", qty: 4 }].filter((i) => i.id !== "ent-hazelnut") }),
  })).json();
  await fetch(`${BASE}/api/orders/${placed.code}/payment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ t: placed.token, utr: String(Date.now()).slice(-12) }) });

  const b = await puppeteer.launch({ headless: true });
  const p = await b.newPage();
  await p.emulate(puppeteer.KnownDevices["iPhone 13"]);
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/status of 40[0139]/.test(m.text())) errs.push(m.text()); });
  await p.goto(`${BASE}/admin/`, { waitUntil: "networkidle0" });
  check("login screen first", await p.$eval("#login", (e) => !e.hidden));
  await p.type("#pw", "wrong-password");
  await p.click("#loginForm button");
  await wait(600);
  check("wrong password shows an error", (await p.$eval("#loginErr", (e) => e.textContent)).length > 0);
  await p.screenshot({ path: `${out}/a-login.jpg`, type: "jpeg", quality: 60 });
  await p.$eval("#pw", (e) => { e.value = ""; });
  await p.type("#pw", pw);
  await p.click("#loginForm button");
  await p.waitForSelector("#app:not([hidden]) .ocard", { timeout: 8000 });
  await wait(700);
  const card = await p.evaluate((code) => { const c = document.querySelector(`.ocard[data-code="${code}"]`); return c && { check: c.classList.contains("check"), text: c.innerText }; }, placed.code);
  check("paid-claim order is highlighted for checking", card && card.check, JSON.stringify(card));
  await p.screenshot({ path: `${out}/a-orders.jpg`, type: "jpeg", quality: 60 });

  await p.click(`.ocard[data-code="${placed.code}"] .who`);
  await p.waitForSelector("#orderSheet[open] #confirmForm", { timeout: 5000 });
  await wait(500);
  await p.screenshot({ path: `${out}/a-sheet.jpg`, type: "jpeg", quality: 60 });
  await p.click("#confirmForm button[type=submit]");
  await p.waitForFunction(() => document.querySelector("#orderSheet .badge")?.textContent.startsWith("Paid"), { timeout: 5000 });
  check("confirming payment issues a bill number", /SRN\/\d{4}\/\d{5}/.test(await p.$eval("#orderSheet", (e) => e.innerText)));
  await p.click('#orderSheet [data-move="preparing"]');
  await p.waitForFunction(() => document.querySelector("#orderSheet .badge")?.textContent === "Being made", { timeout: 5000 });
  check("status moves from the sheet", true);
  await p.click("#orderSheet [data-close]");
  await wait(300);

  // counter bill
  await p.click('[data-tab="counter"]');
  await wait(300);
  await p.click("#pickList [data-add]");
  await p.click("#pickList [data-add]");
  await p.evaluate(() => { document.querySelector('#billForm input[value="cash"]').click(); });
  const total = await p.$eval("#billTotal", (e) => e.textContent);
  check("counter bill adds up", total === "₹360", total);
  await p.screenshot({ path: `${out}/a-counter.jpg`, type: "jpeg", quality: 60 });
  const popup = new Promise((r) => b.once("targetcreated", (t) => r(t)));
  await p.click('#billForm button[type="submit"]');
  const target = await popup;
  await wait(1500);
  const billPage = await target.page();
  const billText = billPage ? await billPage.evaluate(() => document.body.innerText) : "";
  check("counter bill opens as a receipt", /SRN\/\d{4}\/\d{5}/.test(billText) && /CASH/.test(billText), billText.slice(0, 120));
  if (billPage) await billPage.screenshot({ path: `${out}/a-receipt.jpg`, type: "jpeg", quality: 60, fullPage: true });

  // prices
  await p.bringToFront();
  await p.click('[data-tab="menu"]');
  await wait(300);
  const row = '.prow[data-id="cookie-triple"]';
  await p.$eval(`${row} [name="price"]`, (e) => { e.value = ""; });
  await p.type(`${row} [name="price"]`, "195");
  await p.waitForFunction((r) => document.querySelector(`${r} .st`).textContent === "Saved ✓", { timeout: 5000 }, row);
  const menu = await (await fetch(`${BASE}/api/menu`)).json();
  check("price edit saves by itself", menu.prices["cookie-triple"].price === 19500);
  await p.screenshot({ path: `${out}/a-prices.jpg`, type: "jpeg", quality: 60 });

  // settings
  await p.click('[data-tab="settings"]');
  await wait(300);
  await p.$eval('#settingsForm [name="gstin"]', (e) => { e.value = ""; });
  await p.type('#settingsForm [name="gstin"]', "BADGSTIN");
  await p.click('#settingsForm button[type="submit"]');
  await wait(500);
  check("bad GSTIN explained", /GSTIN/.test(await p.$eval("#setErr", (e) => e.textContent)));
  await p.$eval('#settingsForm [name="gstin"]', (e) => { e.value = ""; });
  await p.type('#settingsForm [name="gstin"]', "33ABCDE1234F1Z5");
  await p.click('#settingsForm button[type="submit"]');
  await wait(600);
  check("settings save", (await p.$eval("#setErr", (e) => e.textContent)) === "");
  await p.screenshot({ path: `${out}/a-settings.jpg`, type: "jpeg", quality: 60 });
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check("dashboard fits a phone screen", !overflow);
  check("no script errors", errs.length === 0, errs.join(" | "));
  await b.close();
  console.log(results.join("\n"));
})().catch((e) => { console.log(results.join("\n")); console.error("ERROR", e.message); process.exit(1); });
