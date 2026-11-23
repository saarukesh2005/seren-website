// Item choices (size, add-ons), packing / service / round-off at checkout, and the dine-in table PIN.
// Needs: site built with SEREN_API=http://127.0.0.1:8790, preview on :4321, backend `npm run dev` in backend/.
// Clear rate limits first (from backend/): npx wrangler d1 execute seren-orders --local --command "DELETE FROM rate_hits"
// Leaves the shop's settings and the Tiramisu's choices as they were found (no choices, no charges).
// Usage: node tools/optionstest.cjs <outDir>
const fs = require("fs");
const path = require("path");
const puppeteer = require(path.join(require("os").homedir(), "node_modules/puppeteer"));
const out = process.argv[2] || ".";
const SITE = "http://localhost:4321/";
const API = "http://127.0.0.1:8790";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  (" + String(detail).slice(0, 500) + ")" : ""}`);

const vars = Object.fromEntries(fs.readFileSync(path.join(__dirname, "../backend/.dev.vars"), "utf8").trim().split("\n").map((l) => {
  const i = l.indexOf("=");
  return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
}));
let cookie = "";
async function owner(method, p, body) {
  for (let attempt = 0; attempt < 8; attempt++) { // the backend reloads while files are saved: try again
    try {
      const res = await fetch(API + p, { method, headers: { Origin: API, "X-Seren": "1", "Content-Type": "application/json", Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      const data = await res.json();
      if (res.status === 429 && /Too many requests/.test(data.error || "")) { await wait(15000); continue; } // others use the dev server too
      return { status: res.status, data };
    } catch (e) { await wait(1500); }
  }
  throw new Error("backend not reachable");
}
const CHARGES_OFF = { packing: 0, servicePercent: 0, roundOff: true };

// visible English left in a part of the page (brand names and codes are allowed)
const leftovers = (p, root) => p.evaluate((sel) => {
  const OK = /^(SEREN|UPI|GPay|PhonePe|UTR|QR|Ref|No\.|ID|EN|English|SRN|seren|okhdfcbank)$/;
  const found = new Set();
  const w = document.createTreeWalker(document.querySelector(sel) || document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const el = n.parentElement;
    if (!el || el.offsetParent === null || el.closest("[data-no-i18n], details:not([open]) ul")) continue;
    for (const run of n.data.replace(/SRN-[A-Z0-9]{6}/g, "").match(/[A-Za-z][A-Za-z.]*[A-Za-z]|[A-Za-z]/g) || []) if (run.length >= 3 && !OK.test(run)) found.add(n.data.trim().slice(0, 60));
  }
  return [...found];
}, root);

async function phone(b, errs) {
  const p = await b.newPage();
  await p.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  p.on("pageerror", (e) => errs.push(e.message));
  await p.setCacheEnabled(false); // the shop's settings are cached for 30 seconds; this test changes them
  return p;
}
const open = async (p, url = SITE) => { await p.goto(url, { waitUntil: "networkidle0" }); await wait(1200); };
const addTiramisu = (p) => p.evaluate(() => document.querySelector('#bombRail [data-pid="bomb-tiramisu"] .add').click());
const pick = (p, text) => p.evaluate((t) => { const l = [...document.querySelectorAll(".optsheet[open] .os-c")].find((x) => x.querySelector(".os-n").textContent.trim() === t); l.querySelector("input").click(); }, text);

(async () => {
  // ---- the owner sets up a Tiramisu with choices, and charges
  const login = await owner("POST", "/api/admin/login", { password: vars.ADMIN_PASSWORD });
  if (login.status !== 200) throw new Error("owner login failed: " + JSON.stringify(login.data));
  await owner("POST", "/api/admin/prices/bomb-tiramisu", { price: 18000, unit: "per piece", available: true });
  await owner("POST", "/api/admin/prices/cookie-biscoff", { price: 18050, unit: "per piece", available: true });
  const opt = await owner("POST", "/api/admin/products/bomb-tiramisu", { options: [
    { name: "Size", pick: "one", required: true, choices: [{ name: "Regular", price: 0 }, { name: "Large", price: 5000 }] },
    { name: "Add-ons", pick: "many", choices: [{ name: "Nutella", price: 3000 }] }] });
  check("owner can set choices on the Tiramisu", opt.status === 200, JSON.stringify(opt.data));
  const settings = (charges, extra = {}) => owner("POST", "/api/admin/settings", { upiId: "seren@okhdfcbank", acceptingOrders: true, openTime: "00:00", closeTime: "23:59", prepMinutes: 0, minOrder: 0, deliveryFee: 4000, freeDeliveryAbove: 100000, dineIn: true, dineInTables: "", dineInPayLater: true, charges, ...extra });
  await settings({ packing: 1000, servicePercent: 0, roundOff: true });
  // a product the owner adds in the dashboard (its id starts with x-)
  const made = await owner("POST", "/api/admin/products", { name: "Test Brownie Box", category: "cookies", description: "Made in the dashboard." });
  const customId = made.data.id || (made.data.product && made.data.product.id);
  check("owner can add a new product", made.status < 300 && /^x-/.test(customId || ""), JSON.stringify(made.data));
  await owner("POST", `/api/admin/prices/${customId}`, { price: 12000, unit: "per box", available: true });

  const errs = [];
  const b = await puppeteer.launch({ headless: true });
  const p = await phone(b, errs);
  await open(p);
  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: "networkidle0" });
  await wait(1200);

  // ---- the choices sheet
  const label = await p.$eval('#bombRail [data-pid="bomb-tiramisu"] .add', (e) => e.textContent);
  check("a product with choices shows 'from' its base price", /^\+ Add · from ₹180$/.test(label), label);
  await addTiramisu(p);
  await p.waitForSelector(".optsheet[open] .os-c", { timeout: 4000 });
  const sheet = await p.evaluate(() => ({
    title: document.querySelector(".optsheet h2").textContent,
    groups: [...document.querySelectorAll(".optsheet fieldset")].map((f) => ({ legend: f.querySelector("legend").textContent.replace(/\s+/g, " ").trim(), types: [...new Set([...f.querySelectorAll("input")].map((i) => i.type))].join(), n: f.querySelectorAll("input").length })),
    extras: [...document.querySelectorAll(".os-p")].map((e) => e.textContent),
    go: document.querySelector(".os-go").textContent,
    modal: document.querySelector(".optsheet").matches(":modal"),
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
    focusInside: document.querySelector(".optsheet").contains(document.activeElement),
  }));
  check("sheet: Size is a required pick-one list (radio), Add-ons a pick-any list (checkbox)", sheet.groups.length === 2 && /Size.*Required/.test(sheet.groups[0].legend) && sheet.groups[0].types === "radio" && sheet.groups[0].n === 2 && /Add-ons/.test(sheet.groups[1].legend) && sheet.groups[1].types === "checkbox", JSON.stringify(sheet.groups));
  check("sheet shows extra prices and the live item price", sheet.extras.join() === "+₹50,+₹30" && sheet.go === "Add to box · ₹180", JSON.stringify(sheet));
  check("sheet is a modal dialog with focus inside, and fits 375px", sheet.modal && sheet.focusInside && !sheet.overflow, JSON.stringify(sheet));
  await wait(700); await p.screenshot({ path: `${out}/x-sheet.jpg`, type: "jpeg", quality: 60 });
  await p.evaluate(() => document.querySelector(".os-go").click());
  await wait(200);
  check("a required choice can't be skipped", /Please choose: Size/.test(await p.$eval(".optsheet .err", (e) => e.textContent)) && (await p.$eval("#boxCount", (e) => e.textContent)) === "0");
  await pick(p, "Large"); await pick(p, "Nutella");
  check("live price updates with the choices", (await p.$eval(".os-go", (e) => e.textContent)) === "Add to box · ₹260");
  await p.evaluate(() => document.querySelector(".os-go").click());
  await wait(400);
  check("sheet closes and the item is in the box with its choices", (await p.evaluate(() => !document.querySelector(".optsheet").open && document.getElementById("boxCount").textContent)) === "1");
  // same product, other choices: a separate line
  await addTiramisu(p); await p.waitForSelector(".optsheet[open] .os-c");
  await pick(p, "Regular");
  await p.evaluate(() => document.querySelector(".os-go").click());
  await wait(300);
  // Escape closes without adding
  await addTiramisu(p); await p.waitForSelector(".optsheet[open] .os-c");
  await p.keyboard.press("Escape"); await wait(300);
  check("Escape closes the sheet without adding", await p.evaluate(() => !document.querySelector(".optsheet").open && document.getElementById("boxCount").textContent === "2"));
  const stored = await p.evaluate(() => JSON.parse(localStorage.getItem("seren-box-v1")));
  const keys = Object.keys(stored);
  check("bag stores the choices; same product with different choices = two lines", keys.length === 2 && stored[keys.find((k) => /nutella/.test(k))].opts.join() === "add-ons-nutella,size-large", JSON.stringify(keys));
  await p.evaluate(() => document.getElementById("boxBtn").click());
  await wait(700);
  const bag = await p.evaluate(() => [...document.querySelectorAll("#boxList li")].map((li) => ({ n: li.querySelector(".n").childNodes[0].textContent, ch: [...li.querySelectorAll(".ch span")].map((s) => s.textContent).join("+"), price: li.querySelector(".n small:last-child").textContent })));
  check("box lines show the choices and base + extras price", bag.length === 2 && bag.some((l) => l.ch === "Large+Nutella" && /₹260/.test(l.price)) && bag.some((l) => l.ch === "Regular" && /₹180/.test(l.price)), JSON.stringify(bag));
  await p.screenshot({ path: `${out}/x-bag.jpg`, type: "jpeg", quality: 60 });
  // remove the Regular line with its own minus button
  await p.evaluate(() => { const li = [...document.querySelectorAll("#boxList li")].find((l) => l.querySelector(".ch span").textContent === "Regular"); li.querySelector('[data-d="-1"]').click(); });
  await wait(300);
  const after = await p.evaluate(() => [...document.querySelectorAll("#boxList li .ch")].map((e) => e.textContent));
  check("minus on one line leaves the other line alone", after.join() === "LargeNutella" || after.join() === "Large · Nutella" || (after.length === 1 && /Large/.test(after[0])), JSON.stringify(after));
  await p.evaluate(() => document.getElementById("closeBox").click());
  await wait(400);

  // ---- bag survives a reload, including a dashboard-made product (x-…) before the shop answers
  await p.evaluate((id) => document.querySelector(`[data-pid="${id}"] .add`).click(), customId);
  await wait(300);
  await p.evaluate(() => { const b = JSON.parse(localStorage.getItem("seren-box-v1")); b["x-ghost-cake"] = { id: "x-ghost-cake", name: "Ghost cake", qty: 1, opts: [] }; b.hax = { id: "bomb-vanilla", qty: 1, opts: ["<img src=x onerror=alert(1)>"] }; localStorage.setItem("seren-box-v1", JSON.stringify(b)); });
  await p.reload({ waitUntil: "networkidle0" });
  await wait(1500);
  const kept = await p.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("seren-box-v1"))));
  check("reload keeps the choices line and the dashboard-made product", kept.length === 2 && kept.some((k) => /^bomb-tiramisu\|/.test(k)) && kept.includes(customId), JSON.stringify(kept));
  check("unknown dashboard ids and malformed choices are dropped", !kept.includes("x-ghost-cake") && !kept.includes("hax") && !kept.some((k) => k.includes("<")), JSON.stringify(kept));

  // ---- checkout (pickup): estimate with packing and round-off, then the server's real total
  await p.evaluate((id) => { const b = JSON.parse(localStorage.getItem("seren-box-v1")); delete b[id]; localStorage.setItem("seren-box-v1", JSON.stringify(b)); }, customId);
  await p.reload({ waitUntil: "networkidle0" });
  await wait(1200);
  await p.evaluate(() => document.querySelector('#cookieGrid [data-pid="cookie-biscoff"] .add').click());
  await wait(200);
  await p.evaluate(() => document.getElementById("boxBtn").click());
  await wait(700);
  const sub = await p.$eval("#boxSum", (e) => e.textContent);
  check("box subtotal counts the extras (260 + 180.50)", /₹440\.50/.test(sub), sub);
  await p.evaluate(() => document.getElementById("checkoutBtn").click());
  await p.waitForSelector('#checkout select[name="date"] option[value]:not([value=""])', { timeout: 8000 });
  await p.type('#checkout input[name="name"]', "Asha Raman");
  await p.type('#checkout input[name="phone"]', `9${Math.floor(Math.random() * 1e9)}`.padEnd(10, "0").slice(0, 10)); // a fresh number each run (a number can only have a few unpaid orders)
  await wait(200);
  const est = await p.evaluate(() => ({
    rows: [...document.querySelectorAll("#checkout .co-break li")].map((l) => l.textContent),
    total: document.querySelector("#checkout .co-total b").textContent,
    label: document.querySelector("#checkout .co-total span").textContent,
    hint: !document.querySelector("#checkout .est-hint").hidden,
  }));
  // 18000+5000+3000 + 18050 + 1000 packing = 45050 -> 45100 (rounded to the rupee)
  check("checkout shows packing, round-off and an estimated total (rounded)", est.rows.some((r) => /Packing₹10/.test(r)) && est.rows.some((r) => /Round-off\+₹0\.50/.test(r)) && est.total === "₹451" && est.label === "Estimated total" && est.hint, JSON.stringify(est));
  await p.screenshot({ path: `${out}/x-checkout.jpg`, type: "jpeg", quality: 60 });
  await p.evaluate(() => document.querySelector("#checkout .co-form").requestSubmit());
  await p.waitForSelector("#checkout .pay-qr", { timeout: 10000 }).catch(async () => { throw new Error("order not placed: " + (await p.$eval("#checkout .err", (e) => e.textContent).catch(() => "?"))); });
  const pay = await p.$eval(".pay-amt", (e) => e.textContent);
  check("after placing, the server's total is shown", /451/.test(pay), pay);
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem("seren-orders-v1"))[0]);
  const order = await (await fetch(`${API}/api/orders/${saved.code}?t=${saved.token}`)).json();
  const names = order.order.lines.map((l) => l.name);
  check("server total = items + extras + packing, rounded (₹451)", order.order.total === 45100, String(order.order.total));
  check("the order records the choices on the line", names.some((n) => /Bombolone al Tiramisù \(Large, Nutella\)/.test(n)), JSON.stringify(names));
  await p.goto(`${SITE}order.html#${saved.code}.${saved.token}`, { waitUntil: "networkidle0" });
  await wait(1200);
  const op = await p.evaluate(() => ({ lines: document.querySelector(".op-lines").textContent, overflow: document.documentElement.scrollWidth > innerWidth + 1 }));
  check("order page shows the choices, the charges row and the total", /\(Large, Nutella\)/.test(op.lines) && /Packing, service charge & round-off/.test(op.lines) && /₹451/.test(op.lines) && !op.overflow, op.lines);
  await p.screenshot({ path: `${out}/x-order.jpg`, type: "jpeg", quality: 60, fullPage: true });

  // ---- Tamil: the choices sheet, the bag and the order page leave no English
  await p.evaluate(() => localStorage.setItem("seren-lang-v1", "ta"));
  await open(p);
  await addTiramisu(p); await p.waitForSelector(".optsheet[open] .os-c");
  await pick(p, "பெரியது");
  await wait(200);
  let left = await leftovers(p, ".optsheet");
  check("Tamil: choices sheet has no English", left.length === 0, left.join(" | "));
  await p.evaluate(() => document.querySelector(".os-go").click());
  await wait(300);
  const taErr = await p.$eval(".optsheet[open] .err, .optsheet .err", (e) => e.textContent).catch(() => "");
  check("Tamil: required-choice message is Tamil", taErr === "" || /[஀-௿]/.test(taErr), taErr);
  if (await p.evaluate(() => document.querySelector(".optsheet").open)) await p.keyboard.press("Escape");
  await p.evaluate(() => localStorage.setItem("seren-box-v1", JSON.stringify({ "bomb-tiramisu|add-ons-nutella,size-large": { id: "bomb-tiramisu", qty: 1, opts: ["add-ons-nutella", "size-large"], labels: ["Large", "Nutella"] } })));
  await p.reload({ waitUntil: "networkidle0" });
  await wait(1500);
  await p.evaluate(() => document.getElementById("boxBtn").click());
  await wait(700);
  left = await leftovers(p, "#drawer");
  check("Tamil: box with choices has no English", left.length === 0, left.join(" | "));
  await p.evaluate(() => document.getElementById("checkoutBtn").click());
  await p.waitForSelector('#checkout select[name="date"] option', { timeout: 8000 });
  await wait(600);
  left = await leftovers(p, "#drawer");
  check("Tamil: checkout with packing / round-off has no English", left.length === 0, left.join(" | "));
  await p.screenshot({ path: `${out}/x-ta-checkout.jpg`, type: "jpeg", quality: 60 });
  await p.goto(`${SITE}order.html#${saved.code}.${saved.token}`, { waitUntil: "networkidle0" });
  await wait(1500);
  left = await leftovers(p, "main");
  check("Tamil: order page with choices and charges has no English", left.length === 0, left.join(" | "));
  await p.evaluate(() => localStorage.removeItem("seren-lang-v1"));

  // ---- dine-in: service charge, the table PIN
  // a table name nobody has used: a table that is still open from an older run could have no PIN
  const tableName = `P${Date.now().toString().slice(-5)}`;
  await settings({ packing: 1000, servicePercent: 5, roundOff: true }, { dineInTables: tableName });
  const links = (await owner("GET", "/api/admin/table-links")).data.links;
  const t3 = new URL(links.find((l) => l.table === tableName).url);
  const seat = await owner("POST", `/api/admin/tables/${tableName}/open`, {});
  const pin = seat.data.pin;
  check("staff seating a table gives a 4-digit PIN", /^\d{4}$/.test(pin || ""), JSON.stringify(seat.data));
  const wrongPin = pin === "0000" ? "1111" : "0000";
  const g = await phone(b, errs);
  await open(g, SITE + t3.search);
  await g.evaluate(() => localStorage.clear());
  await g.evaluate(() => document.querySelector('#cookieGrid [data-pid="cookie-biscoff"] .add').click());
  await g.evaluate(() => document.getElementById("boxBtn").click());
  await wait(600);
  await g.evaluate(() => document.getElementById("checkoutBtn").click());
  await g.waitForSelector("#checkout .paywhen", { timeout: 8000 });
  await g.type('#checkout input[name="name"]', "Lakshmi");
  const dine = await g.evaluate(() => ({
    pinShown: !document.querySelector("#checkout .pin").hidden,
    type: document.querySelector('#checkout input[name="pin"]').inputMode + "/" + document.querySelector('#checkout input[name="pin"]').maxLength,
    hint: document.querySelector("#checkout .pin .hint").textContent,
    btn: document.querySelector('#checkout button[type="submit"]').textContent,
    rows: [...document.querySelectorAll("#checkout .co-break li")].map((l) => l.textContent),
  }));
  check("pay at the end asks for the table PIN (numeric, 4 digits)", dine.pinShown && dine.type === "numeric/4" && /4-digit table PIN our staff gave you/.test(dine.hint) && dine.btn === "Send to the kitchen", JSON.stringify(dine));
  check("pay-at-the-end estimate leaves the service charge for the final bill", dine.rows.some((r) => /Service charge 5% \(optional — ask staff to remove\)on your final bill/.test(r)), JSON.stringify(dine.rows));
  await g.screenshot({ path: `${out}/x-pin-form.jpg`, type: "jpeg", quality: 60 });
  // no PIN typed
  await g.evaluate(() => document.querySelector("#checkout .co-form").requestSubmit());
  await wait(200);
  check("empty PIN gets a friendly message", /4-digit table PIN/.test(await g.$eval("#checkout .err", (e) => e.textContent)));
  // wrong PIN
  await g.type('#checkout input[name="pin"]', wrongPin);
  await g.evaluate(() => document.querySelector("#checkout .co-form").requestSubmit());
  await g.waitForFunction(() => /4-digit table PIN our staff gave you/.test(document.querySelector("#checkout .err").textContent) && !document.querySelector("#checkout button[type=submit]").disabled, { timeout: 6000 });
  check("wrong PIN (403) shows the server's friendly message and keeps the form", Boolean(await g.$("#checkout .co-form")));
  // right PIN
  await g.$eval('#checkout input[name="pin"]', (e) => { e.value = ""; });
  await g.type('#checkout input[name="pin"]', pin);
  await g.evaluate(() => document.querySelector("#checkout .co-form").requestSubmit());
  await g.waitForSelector("#checkout .done", { timeout: 8000 });
  check("right PIN sends the order to the kitchen", /kitchen/.test(await g.$eval("#checkout .done", (e) => e.textContent)));
  check("PIN is remembered for the visit (sessionStorage)", (await g.evaluate((k) => sessionStorage.getItem(k), `seren-pin-v1:${tableName.toLowerCase()}`)) === pin);
  await g.evaluate(() => document.getElementById("closeBox").click());
  await wait(500);
  await g.evaluate(() => document.querySelector(".tablebar [data-tab]").click());
  await g.waitForSelector(".tabsheet[open] .ts-lines", { timeout: 8000 });
  check("tab opens straight away with the remembered PIN", /Total so far/.test(await g.$eval(".tabsheet", (e) => e.textContent)));

  // a second phone at the same table, with no PIN yet: the tab asks for it
  const h = await phone(b, errs);
  await open(h, SITE + t3.search);
  await h.evaluate(() => document.querySelector(".tablebar [data-tab]").click());
  await h.waitForSelector(".tabsheet[open] .pin-form", { timeout: 8000 });
  const ask = await h.evaluate(() => ({ type: document.querySelector("#tabPin").inputMode + "/" + document.querySelector("#tabPin").maxLength, text: document.querySelector(".tabsheet").textContent, noTab: !document.querySelector(".ts-lines") }));
  check("tab without a PIN asks for it and shows nothing", ask.type === "numeric/4" && /4-digit table PIN/.test(ask.text) && ask.noTab, JSON.stringify(ask));
  await wait(700); await h.screenshot({ path: `${out}/x-pin-sheet.jpg`, type: "jpeg", quality: 60 });
  await h.type("#tabPin", wrongPin);
  await h.evaluate(() => document.querySelector(".pin-form").requestSubmit());
  await h.waitForFunction(() => /4-digit table PIN our staff gave you/.test(document.querySelector(".pin-form .err")?.textContent || ""), { timeout: 6000 });
  check("wrong PIN on the tab sheet shows a friendly message", true);
  await h.type("#tabPin", pin);
  await h.evaluate(() => document.querySelector(".pin-form").requestSubmit());
  await h.waitForSelector(".tabsheet[open] .ts-lines", { timeout: 8000 });
  check("right PIN shows the tab", /Total so far/.test(await h.$eval(".tabsheet", (e) => e.textContent)));
  check("tab PIN is remembered too", (await h.evaluate((k) => sessionStorage.getItem(k), `seren-pin-v1:${tableName.toLowerCase()}`)) === pin);
  await h.evaluate(() => { sessionStorage.clear(); });
  // too many wrong PINs (429), pretended: the page shows the message
  await h.setRequestInterception(true);
  h.on("request", (r) => (new RegExp(`/api/tables/${tableName}\\?`).test(r.url()) && /pin=/.test(r.url())
    ? r.respond({ status: 429, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ error: "Too many wrong PINs. Please ask our staff." }) })
    : r.continue()));
  await h.evaluate(() => { document.querySelector(".tabsheet").close(); });
  await h.evaluate(() => document.querySelector(".tablebar [data-tab]").click());
  await h.waitForSelector(".pin-form", { timeout: 6000 });
  await h.type("#tabPin", wrongPin);
  await h.evaluate(() => document.querySelector(".pin-form").requestSubmit());
  await h.waitForFunction(() => /Too many wrong PINs/.test(document.querySelector(".tabsheet").textContent), { timeout: 6000 });
  check("too many wrong PINs (429) shows the friendly message", true);

  // ---- Tamil at the table: service charge row, PIN field, PIN prompt on the tab sheet
  const k = await phone(b, errs);
  await open(k, SITE + t3.search);
  await k.evaluate(() => { localStorage.clear(); localStorage.setItem("seren-lang-v1", "ta"); });
  await open(k, SITE + t3.search);
  await k.evaluate(() => document.querySelector('#cookieGrid [data-pid="cookie-biscoff"] .add').click());
  await k.evaluate(() => document.getElementById("boxBtn").click());
  await wait(600);
  await k.evaluate(() => document.getElementById("checkoutBtn").click());
  await k.waitForSelector("#checkout .paywhen", { timeout: 8000 });
  await k.evaluate(() => document.querySelector('#checkout input[name="when"][value="now"]').click());
  await wait(300);
  const svc = await k.evaluate(() => [...document.querySelectorAll("#checkout .co-break li")].map((l) => l.textContent));
  check("dine-in 'pay now' estimate adds the service charge (5% of ₹180.50 = ₹9.03) and rounds", svc.some((r) => /5%.*₹9\.03/.test(r)) && svc.some((r) => /\+₹0\.47/.test(r)), JSON.stringify(svc));
  left = await leftovers(k, "#drawer");
  check("Tamil: dine-in checkout (service charge, round-off) has no English", left.length === 0, left.join(" | "));
  await k.evaluate(() => document.querySelector('#checkout input[name="when"][value="later"]').click());
  await wait(300);
  left = await leftovers(k, "#drawer");
  check("Tamil: pay-at-the-end form with the PIN field has no English", left.length === 0, left.join(" | "));
  await k.screenshot({ path: `${out}/x-ta-pin-form.jpg`, type: "jpeg", quality: 60 });
  await k.evaluate(() => document.getElementById("closeBox").click());
  await wait(500);
  await k.evaluate(() => document.querySelector(".tablebar [data-tab]").click());
  await k.waitForSelector(".tabsheet[open] .pin-form", { timeout: 8000 });
  left = await leftovers(k, ".tabsheet");
  check("Tamil: PIN prompt on the tab sheet has no English", left.length === 0, left.join(" | "));
  await wait(700); await k.screenshot({ path: `${out}/x-ta-pin-sheet.jpg`, type: "jpeg", quality: 60 });
  await k.evaluate(() => localStorage.removeItem("seren-lang-v1"));

  // ---- tidy up: leave the shop as found
  await owner("POST", "/api/admin/products/bomb-tiramisu", { options: [] });
  await owner("POST", `/api/admin/products/${customId}`, { hidden: true });
  await settings(CHARGES_OFF, { dineInTables: "" });
  check("no script errors", errs.length === 0, errs.join(" | "));
  await b.close();
  console.log(results.join("\n"));
  console.log(`${results.filter((r) => r.startsWith("PASS")).length} PASS, ${results.filter((r) => r.startsWith("FAIL")).length} FAIL`);
})().catch(async (e) => {
  try { await owner("POST", "/api/admin/products/bomb-tiramisu", { options: [] }); await owner("POST", "/api/admin/settings", { charges: CHARGES_OFF }); } catch (x) { /* best effort */ }
  console.log(results.join("\n")); console.error("ERROR", e.message); process.exit(1);
});
