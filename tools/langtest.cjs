// Checks the English / Tamil switch: English by default, the switch flips the whole site to Tamil (and back),
// and lists any visible English left over in Tamil mode. Needs the preview on :4321 (built with SEREN_API for the
// checkout part) and the local backend. Usage: node tools/langtest.cjs <outDir>
const path = require("path");
const puppeteer = require(path.join(require("os").homedir(), "node_modules/puppeteer"));
const out = process.argv[2] || ".";
const SITE = "http://localhost:4321/";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  (" + String(detail).slice(0, 600) + ")" : ""}`);

// Visible English words left on the page (brand names and codes are allowed).
const leftovers = (p, root) => p.evaluate((sel) => {
  const OK = /^(SEREN|UPI|GPay|PhonePe|UTR|QR|Ref|No\.|ID|BBQ|EN|English|S|E|R|N|WELCOME10|Kahlúa|Callebaut|@?seren|@SEREN|SRN-[A-Z0-9]{6}|×|·)$/;
  const found = new Set();
  // products the owner added or renamed in the dashboard without typing a Tamil name show their own words: not ours to translate
  const ownerText = new Set(((window.SEREN_SHOP && window.SEREN_SHOP.products) || []).filter((x) => x.edited !== false && !x.nameTa).map((x) => x.id));
  const isOwnerText = (el) => { const card = el.closest("[data-pid]"); return Boolean(card && ownerText.has(card.dataset.pid)); };
  const w = document.createTreeWalker(document.querySelector(sel) || document.body, NodeFilter.SHOW_TEXT);
  let n = w.nextNode();
  while (n) {
    const el = n.parentElement;
    const visible = el && el.offsetParent !== null && getComputedStyle(el).visibility !== "hidden" && !el.closest("[data-no-i18n],script,style,.pal-panel,.pal-btn,[aria-hidden=true] .ch");
    if (visible && !isOwnerText(el)) {
      for (const run of n.data.match(/[A-Za-z][A-Za-z.]*[A-Za-z]|[A-Za-z]/g) || []) {
        if (run.length >= 3 && !OK.test(run)) found.add(n.data.trim().slice(0, 60));
      }
    }
    n = w.nextNode();
  }
  return [...found];
}, root);

const fs = require("fs");
async function ownerSetsTamilName() {
  const API = "http://127.0.0.1:8790";
  const pw = fs.readFileSync(path.join(__dirname, "../backend/.dev.vars"), "utf8").match(/ADMIN_PASSWORD="([^"]+)"/)[1];
  const h = { Origin: API, "X-Seren": "1", "Content-Type": "application/json" };
  const login = await fetch(`${API}/api/admin/login`, { method: "POST", headers: h, body: JSON.stringify({ password: pw }) });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  for (const id of ["bomb-tiramisu", "cookie-biscoff"]) await fetch(`${API}/api/admin/prices/${id}`, { method: "POST", headers: { ...h, Cookie: cookie }, body: JSON.stringify({ price: 18000, unit: "per piece", available: true }) });
  await fetch(`${API}/api/admin/settings`, { method: "POST", headers: { ...h, Cookie: cookie }, body: JSON.stringify({ upiId: "seren@okhdfcbank", acceptingOrders: true, openTime: "00:00", closeTime: "23:59", prepMinutes: 0 }) });
  await fetch(`${API}/api/admin/products/cookie-matcha`, { method: "POST", headers: { ...h, Cookie: cookie }, body: JSON.stringify({ name: "Matcha Cloud", nameTa: "மாட்சா மேகம்", description: "Matcha dough, white chocolate.", descriptionTa: "மாட்சா மாவு, வெள்ளை சாக்லேட்." }) });
}

(async () => {
  await ownerSetsTamilName();
  const b = await puppeteer.launch({ headless: true });
  for (const device of ["iPhone 13", null]) {
    const p = await b.newPage();
    if (device) await p.emulate(puppeteer.KnownDevices[device]); else await p.setViewport({ width: 1440, height: 900 });
    const label = device ? "phone" : "desktop";
    const errs = [];
    p.on("pageerror", (e) => errs.push(e.message));
    await p.goto(SITE, { waitUntil: "networkidle0" });
    await p.evaluate(() => { localStorage.removeItem("seren-lang-v1"); });
    await p.reload({ waitUntil: "networkidle0" });
    await wait(1200);
    const en = await p.evaluate(() => ({ lang: document.documentElement.lang, btn: document.querySelector(".lang-btn")?.textContent, h: document.getElementById("bombTitle").getAttribute("aria-label") }));
    check(`${label}: English by default with a தமிழ் switch`, en.lang === "en" && /தமிழ்/.test(en.btn) && en.h === "Bomboloni", JSON.stringify(en));
    const box = await p.evaluate(() => { const r = document.querySelector(".lang-btn").getBoundingClientRect(); return { x: r.left, w: r.width, vw: innerWidth }; });
    check(`${label}: switch sits inside the top bar`, box.x > 0 && box.x + box.w <= box.vw, JSON.stringify(box));

    await Promise.all([p.waitForNavigation({ waitUntil: "networkidle0" }), p.click(".lang-btn")]);
    await wait(2200);
    const ta = await p.evaluate(() => ({ lang: document.documentElement.lang, btn: document.querySelector(".lang-btn")?.textContent, h: document.getElementById("bombTitle").getAttribute("aria-label"), add: document.querySelector("#cookieGrid .add").textContent, title: document.title }));
    check(`${label}: switch turns the site Tamil`, ta.lang === "ta" && /English/.test(ta.btn) && ta.h === "பொம்பொலோனி" && /சேர்|விரைவில்/.test(ta.add) && /செரென்/.test(ta.title), JSON.stringify(ta));
    const fontsReady = await p.evaluate(async () => { await document.fonts.ready; return document.fonts.check('800 40px "Catamaran"', "அ") && document.fonts.check('16px "Noto Sans Tamil"', "அ"); });
    check(`${label}: Tamil fonts load`, fontsReady);
    await wait(800);
    const owned = await p.evaluate(() => document.querySelector('[data-pid="cookie-matcha"] h3')?.textContent);
    check(`${label}: owner's Tamil product name shows`, owned === "மாட்சா மேகம்", owned);
    const split = await p.evaluate(() => [...document.querySelectorAll(".head h2 .ch")].some((c) => /^[\u0B82\u0BBE-\u0BCD\u0BD7]$/.test(c.textContent)));
    check(`${label}: heading animation keeps Tamil letters whole`, !split);
    const left = await leftovers(p, "main");
    check(`${label}: no English left on the page`, left.length === 0, left.join(" | "));
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    check(`${label}: Tamil page fits the screen`, !overflow);
    await p.screenshot({ path: `${out}/ta-${label}-hero.jpg`, type: "jpeg", quality: 60 });
    for (const id of ["bomboloni", "illusory-fruit", "entremets", "gelato", "kitchen"]) {
      await p.evaluate((s) => window.serenLenis ? window.serenLenis.scrollTo(`#${s}`, { immediate: true, force: true }) : document.getElementById(s).scrollIntoView(), id);
      await wait(900);
      await p.screenshot({ path: `${out}/ta-${label}-${id}.jpg`, type: "jpeg", quality: 55 });
    }

    // the order box and checkout in Tamil
    await p.evaluate(() => { document.querySelector("#bombRail .add").click(); document.getElementById("boxBtn").click(); });
    await wait(900);
    let l2 = await leftovers(p, "#drawer");
    check(`${label}: order box is Tamil`, l2.length === 0, l2.join(" | "));
    const co = await p.$("#checkoutBtn:not([hidden])");
    if (co) {
      await p.evaluate(() => document.getElementById("checkoutBtn").click());
      await p.waitForSelector('#checkout select[name="date"] option', { timeout: 8000 });
      await wait(800);
      l2 = await leftovers(p, "#drawer");
      check(`${label}: checkout form is Tamil`, l2.length === 0, l2.join(" | "));
      const opt = await p.$eval('#checkout select[name="date"]', (s) => s.options[0]?.textContent || "");
      check(`${label}: days shown in Tamil`, /[஀-௿]/.test(opt), opt);
      await p.screenshot({ path: `${out}/ta-${label}-checkout.jpg`, type: "jpeg", quality: 60 });
    }
    check(`${label}: no script errors`, errs.length === 0, errs.join(" | "));

    // back to English
    await p.evaluate(() => document.getElementById("closeBox").click());
    await wait(500);
    await Promise.all([p.waitForNavigation({ waitUntil: "networkidle0" }), p.evaluate(() => document.querySelector(".lang-btn").click())]);
    await wait(1200);
    check(`${label}: switch goes back to English`, await p.evaluate(() => document.documentElement.lang === "en" && document.getElementById("bombTitle").getAttribute("aria-label") === "Bomboloni"));
    await p.evaluate(() => localStorage.setItem("seren-lang-v1", "ta"));
    if (!device) {
      // order page in Tamil
      const saved = await p.evaluate(() => JSON.parse(localStorage.getItem("seren-orders-v1") || "[]")[0]);
      await p.goto(saved ? `${SITE}order.html#${saved.code}.${saved.token}` : `${SITE}order.html`, { waitUntil: "networkidle0" });
      await wait(1500);
      const l3 = await leftovers(p, "main");
      check("order page is Tamil", l3.length === 0, l3.join(" | "));
      check("order page has the switch", Boolean(await p.$(".op-top .lang-btn")));
      await p.screenshot({ path: `${out}/ta-order.jpg`, type: "jpeg", quality: 60, fullPage: true });
    }
    await p.evaluate(() => localStorage.removeItem("seren-lang-v1"));
    await p.close();
  }
  await b.close();
  console.log(results.join("\n"));
})().catch((e) => { console.log(results.join("\n")); console.error("ERROR", e.message); process.exit(1); });
