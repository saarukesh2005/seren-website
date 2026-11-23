// Cash drawer shifts, expenses and the GST pack, against a running local backend (npm run dev, port 8790).
// Clear rate limits first:  npx wrangler d1 execute seren-orders --local --command "DELETE FROM rate_hits"
// Usage: node test/money.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";

const BASE = process.env.API || "http://127.0.0.1:8790";
const pw = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/ADMIN_PASSWORD="([^"]+)"/)[1];
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${String(detail).slice(0, 300)})`}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const sfx = Date.now().toString(36).slice(-4);

function session() {
  let cookie = "";
  return async (method, path, body) => {
    const headers = { Origin: BASE, "X-Seren": "1" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (cookie) headers.Cookie = cookie;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
        const set = res.headers.get("set-cookie");
        if (set && set.startsWith("seren_admin=")) cookie = set.split(";")[0];
        const type = res.headers.get("content-type") || "";
        return { status: res.status, data: type.includes("json") ? await res.json() : await res.text(), headers: res.headers };
      } catch (e) {
        if (attempt >= 8) throw e; // the dev server restarts when files are saved: wait and retry
        await sleep(1500);
      }
    }
  };
}

const owner = session();
const cashier = session();
const manager = session();
const kitchen = session();
const csvOf = (text) => text.split("\r\n").map((l) => l.split(","));

async function bill(who, body) {
  const r = await who("POST", "/api/admin/counter", body);
  if (r.status !== 201) throw new Error(`bill failed ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data.order;
}
// Another test may give this product a required size: if so, pick the plain "Regular" one (no extra price).
let OPTS = [];
const cart = (qty) => [{ id: "bomb-tiramisu", qty, ...(OPTS.length ? { opts: OPTS } : {}) }];
const quote = async (items) => {
  const r = await owner("POST", "/api/admin/counter/quote", { items });
  if (!r.data.quote) throw new Error(`quote failed ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data.quote.total;
};
const gst = async (day = todayIST()) => (await owner("GET", `/api/admin/gst?from=${day}&to=${day}`)).data.report;

async function main() {
  let r = await owner("POST", "/api/admin/login", { password: pw });
  check("owner logs in", r.status === 200, JSON.stringify(r.data));
  r = await owner("POST", "/api/admin/prices/bomb-tiramisu", { price: 18000, unit: "per piece", available: true });
  check("tiramisu priced", r.status === 200, JSON.stringify(r.data));

  for (const [name, role] of [[`Cash${sfx}`, "cashier"], [`Mgr${sfx}`, "manager"], [`Kit${sfx}`, "kitchen"]]) {
    r = await owner("POST", "/api/admin/staff", { name, role, password: "tea-and-cake-1" });
    check(`owner adds a ${role}`, r.status === 201, JSON.stringify(r.data));
  }
  check("cashier logs in", (await cashier("POST", "/api/admin/login", { name: `Cash${sfx}`, password: "tea-and-cake-1" })).status === 200);
  check("manager logs in", (await manager("POST", "/api/admin/login", { name: `Mgr${sfx}`, password: "tea-and-cake-1" })).status === 200);
  check("kitchen logs in", (await kitchen("POST", "/api/admin/login", { name: `Kit${sfx}`, password: "tea-and-cake-1" })).status === 200);

  // leave no drawer open from an earlier run
  r = await owner("GET", "/api/admin/shift");
  if (r.data.shift) await owner("POST", "/api/admin/shift/close", { counted: 0, note: "closed by test setup" });
  check("setup: no drawer is open", (await owner("GET", "/api/admin/shift")).data.shift === null);

  /* permissions */
  check("cashier gets 403 on /gst", (await cashier("GET", "/api/admin/gst")).status === 403);
  check("cashier gets 403 on /gst.csv", (await cashier("GET", "/api/admin/gst.csv?part=b2b")).status === 403);
  check("cashier gets 403 on expenses", (await cashier("GET", "/api/admin/expenses")).status === 403);
  check("cashier gets 403 on past drawers", (await cashier("GET", "/api/admin/shifts")).status === 403);
  check("kitchen gets 403 on the drawer", (await kitchen("GET", "/api/admin/shift")).status === 403);
  check("cash out with no open drawer is refused", (await cashier("POST", "/api/admin/shift/cash", { kind: "out", amount: 100, reason: "tea" })).status === 409);
  check("closing with no open drawer is refused", (await cashier("POST", "/api/admin/shift/close", { counted: 0 })).status === 409);

  /* the numbers before this test's bills */
  const before = await gst();

  /* open the drawer */
  const FLOAT = 200000;
  r = await cashier("POST", "/api/admin/shift/open", { float: -5 });
  check("a negative float is refused", r.status === 400);
  r = await cashier("POST", "/api/admin/shift/open", { float: FLOAT });
  check("cashier opens the drawer", r.status === 201, JSON.stringify(r.data));
  r = await owner("POST", "/api/admin/shift/open", { float: 100 });
  check("a second open while one is open is 409", r.status === 409 && /already open/.test(r.data.error), JSON.stringify(r.data));

  /* bills */
  const probe = await owner("POST", "/api/admin/counter/quote", { items: cart(1) });
  if (probe.status === 409 && /choose a size/.test(probe.data.error || "")) OPTS = ["size-regular"];
  const one = cart(1);
  const two = cart(2);
  const t1 = await quote(one);
  const t2 = await quote(two);
  const cashBill = await bill(cashier, { items: one, method: "cash" });
  check("cash bill total matches the quote", cashBill.total === t1, `${cashBill.total} vs ${t1}`);
  const cashPart = Math.floor(t2 / 2);
  const upiPart = t2 - cashPart;
  const splitBill = await bill(cashier, { items: two, split: [{ method: "cash", amount: cashPart }, { method: "upi", amount: upiPart }] });
  const upiBill = await bill(cashier, { items: one, method: "upi" });
  const injected = await bill(cashier, { items: one, method: "card", name: "=HYPERLINK(\"http://x\")" });
  const b2bBill = await bill(cashier, { items: one, method: "upi", gstin: "33AABCU9603R1ZX", name: "Test Traders" });
  const appCode = `T${sfx}${Date.now().toString(36)}`.toUpperCase();
  r = await cashier("POST", "/api/admin/counter/app-order", { platform: "swiggy", externalId: appCode, items: one });
  check("a delivery-app order is saved", r.status === 201, JSON.stringify(r.data).slice(0, 200));
  const appBill = r.data.order;
  check("app order is on the platform", appBill.platform === "swiggy" && appBill.total === t1);

  r = await cashier("GET", "/api/admin/shift");
  check("cashier sees the open drawer", r.status === 200 && r.data.shift && r.data.shift.float === FLOAT);
  check("cashier's view is blind (no expected cash, no cash totals)", r.data.blind === true && !("expected" in r.data.shift) && !("byMethod" in r.data.shift), JSON.stringify(r.data));
  check("bills this shift are counted", r.data.shift.bills === 6, `bills=${r.data.shift && r.data.shift.bills}`);
  r = await owner("GET", "/api/admin/shift");
  const cashRow = (r.data.shift.byMethod || []).find((m) => m.method === "cash");
  check("owner sees cash taken by method", cashRow && cashRow.received >= t1 + cashPart, JSON.stringify(r.data.shift.byMethod));

  /* cash in / out */
  r = await cashier("POST", "/api/admin/shift/cash", { kind: "out", amount: 30000, reason: "expense", category: "Milk & dairy", note: "morning milk" });
  check("cash out as an expense", r.status === 201 && r.data.expense === true, JSON.stringify(r.data));
  r = await cashier("POST", "/api/admin/shift/cash", { kind: "in", amount: 10000, reason: "change from the bank" });
  check("cash in", r.status === 201, JSON.stringify(r.data));
  r = await cashier("POST", "/api/admin/shift/cash", { kind: "out", amount: 0, reason: "x" });
  check("a zero amount is refused", r.status === 400);
  r = await cashier("POST", "/api/admin/shift/cash", { kind: "out", amount: 100 });
  check("a reason is needed", r.status === 400);
  r = await owner("GET", `/api/admin/expenses?from=${todayIST()}&to=${todayIST()}`);
  const milk = (r.data.expenses || []).find((e) => e.category === "Milk & dairy" && e.amount === 30000 && e.method === "cash");
  check("the cash-out expense is in the expense list", Boolean(milk), JSON.stringify(r.data).slice(0, 300));

  /* a cash refund lowers the expected cash */
  r = await owner("POST", `/api/admin/orders/${cashBill.code}/refund`, { method: "cash" });
  check("cash bill refunded in cash", r.status === 200 && r.data.order.credit_note_no, JSON.stringify(r.data).slice(0, 200));
  const creditNo = r.data.order.credit_note_no;

  /* close with a short count (blind) */
  // the drawer's own tally (other people may ring cash bills on this shared test database, which only adds to it)
  r = await owner("GET", "/api/admin/shift");
  const liveCash = (r.data.shift.byMethod || []).find((m) => m.method === "cash");
  const expected = FLOAT + liveCash.received - liveCash.refunded + r.data.shift.cashIn - r.data.shift.cashOut;
  check("cash received less refunds covers my bills", liveCash.received - liveCash.refunded >= cashPart && liveCash.refunded === t1 && r.data.shift.cashIn === 10000 && r.data.shift.cashOut === 30000,
    JSON.stringify(r.data.shift));
  const counted = expected - 500;
  r = await cashier("POST", "/api/admin/shift/close", { counted: -1 });
  check("a negative count is refused", r.status === 400);
  r = await cashier("POST", "/api/admin/shift/close", { counted, note: "test close" });
  check("cashier closes the drawer", r.status === 200, JSON.stringify(r.data));
  check("expected cash is right", r.data.shift.expected === expected, `${r.data.shift.expected} vs ${expected}`);
  check("variance is counted minus expected (short 500)", r.data.shift.variance === -500 && r.data.verdict === "short", JSON.stringify(r.data));
  check("closing twice is refused", (await cashier("POST", "/api/admin/shift/close", { counted })).status === 409);
  check("the drawer shows closed", (await cashier("GET", "/api/admin/shift")).data.shift === null);
  r = await owner("GET", "/api/admin/shifts?limit=5");
  check("history lists it with the variance", r.status === 200 && r.data.shifts[0].variance === -500 && r.data.shifts[0].counted === counted, JSON.stringify(r.data).slice(0, 300));
  r = await owner("GET", "/api/admin/activity");
  const acts = JSON.stringify(r.data);
  check("activity logs 'shift closed' and 'cash taken out'", acts.includes("shift closed") && acts.includes("cash taken out"));

  /* a bill rung with no drawer open is not counted in any drawer */
  const lateBill = await bill(cashier, { items: one, method: "cash" });
  r = await owner("GET", "/api/admin/shifts?limit=1");
  check("a bill after closing doesn't change the closed drawer", r.data.shifts[0].expected === expected && lateBill.total === t1);

  /* expenses */
  r = await owner("POST", "/api/admin/expenses", { category: "Gas", amount: 120000, method: "upi", note: "cylinder" });
  check("owner adds an expense", r.status === 201, JSON.stringify(r.data));
  const expId = r.data.id;
  check("bad category refused", (await owner("POST", "/api/admin/expenses", { category: "Yacht", amount: 100, method: "cash" })).status === 400);
  check("bad method refused", (await owner("POST", "/api/admin/expenses", { category: "Gas", amount: 100, method: "bitcoin" })).status === 400);
  check("zero amount refused", (await owner("POST", "/api/admin/expenses", { category: "Gas", amount: 0, method: "cash" })).status === 400);
  check("a future date is refused", (await owner("POST", "/api/admin/expenses", { day: "2999-01-01", category: "Gas", amount: 100, method: "cash" })).status === 400);
  r = await owner("GET", `/api/admin/expenses?from=${todayIST()}&to=${todayIST()}`);
  check("expense list has it, with totals by category", r.data.expenses.some((e) => e.id === expId) && r.data.byCategory.some((c) => c.k === "Gas"));
  check("cashier can't delete an expense", (await cashier("POST", `/api/admin/expenses/${expId}/delete`, {})).status === 403);
  check("manager deletes it the same day", (await manager("POST", `/api/admin/expenses/${expId}/delete`, {})).status === 200);
  r = await owner("GET", `/api/admin/expenses?from=${todayIST()}&to=${todayIST()}`);
  check("it is gone from the list", !r.data.expenses.some((e) => e.id === expId));
  check("deleting a missing expense is 404", (await owner("POST", `/api/admin/expenses/${expId}/delete`, {})).status === 404);
  check("expense range over 366 days is refused", (await owner("GET", "/api/admin/expenses?from=2020-01-01&to=2026-12-31")).status === 400);

  /* GST report */
  const after = await gst();
  const madeTotal = t1 + t2 + t1 + t1 + t1 + t1 + t1; // cash, split, upi, card (injected), b2b, app, late cash
  check("GST invoice total moved by the sum of the bills made", after.totals.invoices.value - before.totals.invoices.value === madeTotal,
    `${after.totals.invoices.value - before.totals.invoices.value} vs ${madeTotal}`);
  check("GST invoice count moved by 7", after.totals.invoices.n - before.totals.invoices.n === 7, String(after.totals.invoices.n - before.totals.invoices.n));
  check("credit notes moved by the refund", after.totals.creditNotes.value - before.totals.creditNotes.value === t1 && after.totals.creditNotes.n - before.totals.creditNotes.n === 1);
  check("B2B + B2C + app values add up to all invoices", after.totals.b2bValue + after.totals.b2csValue + after.totals.ecoValue === after.totals.invoices.value,
    JSON.stringify(after.totals));
  check("the GSTIN bill is in B2B", after.b2b.rows.some((x) => x.invoiceNo === b2bBill.invoice_no && x.gstin === "33AABCU9603R1ZX" && x.value === t1));
  check("B2B value moved by that one bill", after.totals.b2bValue - before.totals.b2bValue === t1);
  check("app order is in ECO, not in B2C", after.eco.rows.some((x) => x.platform === "swiggy") && after.totals.ecoValue - before.totals.ecoValue === t1
    && after.totals.b2csValue - before.totals.b2csValue === madeTotal - t1 - t1);
  check("documents issued has the invoice and credit note series", after.docs.rows.some((d) => /Invoices/.test(d.nature) && d.total >= 7) && after.docs.rows.some((d) => /Credit/.test(d.nature)));
  check("turnover this year is reported", typeof after.turnover.net === "number" && after.turnover.fyStart < after.turnover.fyEnd);
  check("HSN summary has rows", after.hsn.rows.length > 0);
  check("GST range over 366 days is refused", (await owner("GET", "/api/admin/gst?from=2020-01-01&to=2026-12-31")).status === 400);
  check("manager can read the GST report", (await manager("GET", `/api/admin/gst?from=${todayIST()}&to=${todayIST()}`)).status === 200);

  /* CSV */
  for (const part of ["b2b", "b2cs", "hsn", "cdnr", "eco", "docs"]) {
    r = await owner("GET", `/api/admin/gst.csv?from=${todayIST()}&to=${todayIST()}&part=${part}`);
    check(`gst.csv part ${part}`, r.status === 200 && /text\/csv/.test(r.headers.get("content-type")) && r.data.split("\r\n").length >= 2, `${r.status} ${String(r.data).slice(0, 100)}`);
  }
  check("an unknown CSV part is 400", (await owner("GET", "/api/admin/gst.csv?part=nope")).status === 400);
  r = await owner("GET", `/api/admin/gst.csv?from=${todayIST()}&to=${todayIST()}&part=b2b`);
  check("B2B CSV has the GSTIN and bill number", r.data.includes("33AABCU9603R1ZX") && r.data.includes(b2bBill.invoice_no));
  r = await owner("GET", `/api/admin/gst.csv?from=${todayIST()}&to=${todayIST()}&part=cdnr`);
  check("credit-note CSV has the credit note, no ' before numbers", r.data.includes(creditNo) && !/'-?\d/.test(r.data));
  r = await owner("GET", `/api/admin/export.csv?from=${todayIST()}&to=${todayIST()}`);
  const lines = String(r.data).split("\r\n");
  const cnLine = lines.find((l) => l.includes(creditNo)) || "";
  const cnCells = csvOf(cnLine);
  check("accounts export: credit-note amount stays a plain negative number", cnLine.includes(`,-${(t1 / 100).toFixed(2)}`) && !cnLine.includes("'-"), cnLine.slice(0, 300));
  check("accounts export: no ' before any negative number", !/'-\d/.test(r.data));
  check("accounts export: formula-looking names are still guarded", r.data.includes("'=HYPERLINK") && injected.total === t1, r.data.slice(0, 200));
  check("accounts export: cnLine parsed", cnCells.length > 0);
  check("accounts export range over 366 days is 400", (await owner("GET", "/api/admin/export.csv?from=2000-01-01&to=2999-12-31")).status === 400);
  check("accounts export with no dates still works", (await owner("GET", "/api/admin/export.csv")).status === 200);

  /* reports and day close */
  r = await owner("GET", `/api/admin/reports?from=${todayIST()}&to=${todayIST()}`);
  const rep = r.data.report;
  check("report: byMethod comes from payments (cash, upi, card and apps)", ["cash", "upi", "card", "platform"].every((m) => rep.byMethod.some((x) => x.k === m)), JSON.stringify(rep.byMethod));
  const sw = (rep.byPlatform || []).find((x) => x.k === "swiggy");
  check("report: byPlatform has the app with commission and what it pays", sw && sw.commission >= 0 && sw.appPays === sw.revenue - sw.commissionAmount && sw.revenue >= t1, JSON.stringify(rep.byPlatform));
  r = await owner("GET", "/day-close");
  check("day close prints with money in, drawers and apps",
    r.status === 200 && /Money in/.test(r.data) && /Cash drawer/.test(r.data) && /Delivery apps/.test(r.data), String(r.data).slice(0, 200));
  check("day close shows the short count", /Short/.test(r.data));
  check("manager can print the day close", (await manager("GET", "/day-close")).status === 200);
  check("cashier can't print the day close", (await cashier("GET", "/day-close")).status === 403);

  await browserCheck();
}

/* One real click-through of the Cash tab in a headless browser. */
async function browserCheck() {
  let puppeteer;
  try {
    puppeteer = createRequire(import.meta.url)(`${homedir()}/node_modules/puppeteer`);
  } catch {
    check("browser: puppeteer is available (SKIPPED)", true);
    return;
  }
  const errors = [];
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 420, height: 900 });
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));
    for (let attempt = 1; ; attempt++) { // the login limiter is shared with other people testing: wait and try again if it says "too many"
      await page.goto(`${BASE}/admin/`, { waitUntil: "networkidle0" });
      await page.type("#pw", pw);
      await page.keyboard.press("Enter");
      try {
        await page.waitForSelector('[data-tab="cash"]', { visible: true, timeout: 8000 });
        break;
      } catch (e) {
        if (attempt >= 6) throw e;
        await sleep(15000);
      }
    }
    errors.length = 0; // the 401 from the logged-out check before login is normal
    await page.click('[data-tab="cash"]');
    await page.waitForSelector("#cashOpenForm", { timeout: 10000 });
    check("browser: Cash tab shows the closed drawer with an open form", true);

    await page.type('#cashOpenForm [name="float"]', "1000");
    await page.click('#cashOpenForm button[type="submit"]');
    await page.waitForSelector("#cashCloseForm", { timeout: 10000 });
    let text = await page.$eval("#tab-cash", (el) => el.innerText);
    check("browser: drawer is open and does not reveal the expected cash", /Drawer is open/i.test(text) && !/should have been|expected/i.test(text), text.slice(0, 300));

    await page.click('[data-cash-move="in"]');
    await page.waitForSelector("#cashMoveForm", { timeout: 5000 });
    await page.type('#cashMoveForm [name="amount"]', "50");
    await page.type('#cashMoveForm [name="reason"]', "extra change");
    await page.click('#cashMoveForm button[type="submit"]');
    await page.waitForFunction(() => /extra change/.test(document.querySelector("#tab-cash").innerText), { timeout: 10000 });
    check("browser: cash in shows up in the list", true);

    await sleep(2600); // let the "Cash put in" message fade so it isn't in the way of the button
    await page.type('#cashCloseForm [name="counted"]', "1040");
    await page.click("#cashCloseBtn");
    text = await page.$eval("#cashCloseBtn", (el) => el.innerText);
    check("browser: first tap on Close asks to confirm", /Tap again/.test(text), text);
    await page.click("#cashCloseBtn");
    await page.waitForFunction(() => /drawer closed/i.test(document.querySelector("#tab-cash").innerText), { timeout: 10000 });
    text = await page.$eval("#tab-cash", (el) => el.innerText);
    check("browser: after closing it says how much was over or short", /(Short|Over) by ₹/.test(text) && /should have been/i.test(text), text.slice(0, 300));

    await page.waitForSelector("#expForm", { timeout: 10000 });
    await page.type('#expForm [name="amount"]', "75");
    await page.click('#expForm button[type="submit"]');
    await page.waitForFunction(() => /₹75/.test(document.querySelector("#cashExp").innerText), { timeout: 10000 });
    check("browser: an expense is added and listed", true);

    await page.click('[data-tab="reports"]');
    await page.waitForFunction(() => document.querySelector("#gstBox") && /bills issued/i.test(document.querySelector("#gstBox").innerText), { timeout: 15000 });
    const links = await page.$$eval("#gstBox .gst-links a", (as) => as.map((a) => a.getAttribute("href")));
    check("browser: Reports shows the GST block with six downloads", links.length === 6 && links.every((h) => /\/api\/admin\/gst\.csv\?from=.*part=/.test(h)), JSON.stringify(links));
    check("browser: no console or page errors", errors.length === 0, errors.join(" | "));
  } catch (e) {
    check("browser: Cash tab click-through", false, `${e.message} ${errors.join(" | ")}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => { check("test run completed", false, e.stack || e.message); }).finally(() => {
  console.log(results.join("\n"));
  const failed = results.filter((x) => x.startsWith("FAIL")).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
