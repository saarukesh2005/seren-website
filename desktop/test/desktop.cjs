// Runs the real SEREN Counter app (Electron) on this computer and drives it:
// first-time setup, login, a cash bill, silent receipt printing (saved as PDF in test mode),
// the customer screen window, and that web pages can't open the app's setup page.
// Needs the local backend (backend: npm run dev). Usage: node test/desktop.cjs <outDir>
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require(path.join(os.homedir(), "node_modules/puppeteer"));
const out = path.resolve(process.argv[2] || ".");
const SERVER = "http://127.0.0.1:8790";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? "  (" + String(detail).slice(0, 300) + ")" : ""}`);
const pw = fs.readFileSync(path.join(__dirname, "../../backend/.dev.vars"), "utf8").match(/ADMIN_PASSWORD="([^"]+)"/)[1];

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "seren-counter-"));
  const pdfDir = fs.mkdtempSync(path.join(os.tmpdir(), "seren-pdf-"));
  const electron = require(path.join(__dirname, "../node_modules/electron"));
  const proc = spawn(electron, [path.join(__dirname, ".."), "--remote-debugging-port=9333"], { env: { ...process.env, SEREN_USER_DATA: userData, SEREN_PRINT_TO_PDF: pdfDir }, stdio: "ignore" });
  let b;
  try {
    for (let i = 0; i < 40 && !b; i++) { try { b = await puppeteer.connect({ browserURL: "http://127.0.0.1:9333", defaultViewport: null }); } catch { await wait(500); } }
    const page = async (re) => { for (let i = 0; i < 40; i++) { const p = (await b.pages()).find((x) => re.test(x.url())); if (p) return p; await wait(300); } return null; };

    // first run: the setup screen asks for the shop server
    const setup = await page(/setup\.html/);
    check("first run asks for the shop server", Boolean(setup));
    await setup.type("#url", "https://not-a-real-seren-server.invalid");
    await setup.click("#go");
    await setup.waitForFunction(() => document.getElementById("err").textContent.length > 0, { timeout: 15000 });
    check("a wrong address is explained", /Couldn't reach/.test(await setup.$eval("#err", (e) => e.textContent)));
    await setup.$eval("#url", (e) => { e.value = ""; });
    await setup.type("#url", SERVER);
    await setup.click("#go");
    const pos = await page(/\/pos\/$/);
    check("after setup the counter opens", Boolean(pos));
    await pos.waitForSelector("#pw", { timeout: 10000 });
    check("the app's printing bridge is there", await pos.evaluate(() => typeof window.serenNative === "object" && typeof window.serenSetup === "undefined"));
    await pos.type("#pw", pw);
    await pos.evaluate(() => document.getElementById("loginForm").requestSubmit());
    await pos.waitForSelector("#app:not([hidden]) .tile", { timeout: 10000 });
    const printers = await pos.evaluate(() => window.serenNative.printers());
    check("printer list comes from the computer", Array.isArray(printers), JSON.stringify(printers).slice(0, 100));

    // a cash bill prints silently (saved as a PDF in test mode)
    await pos.evaluate(() => { document.querySelector('[data-cat="all"]').click(); document.querySelector(".tile[data-add]").click(); });
    await pos.keyboard.press("F1");
    await pos.waitForSelector("#payDlg[open] #tendered", { timeout: 5000 });
    await pos.keyboard.press("Enter");
    let pdfs = [];
    for (let i = 0; i < 30 && !pdfs.length; i++) { await wait(400); pdfs = fs.readdirSync(pdfDir); }
    check("receipt prints with no print window", pdfs.length === 1 && fs.statSync(path.join(pdfDir, pdfs[0])).size > 2000, pdfs.join(","));
    if (pdfs[0]) fs.copyFileSync(path.join(pdfDir, pdfs[0]), path.join(out, "desktop-receipt.pdf"));
    await pos.screenshot({ path: path.join(out, "desktop-counter.jpg"), type: "jpeg", quality: 60 });

    // customer screen opens in its own window
    await pos.evaluate(() => document.getElementById("displayBtn").click());
    check("customer screen opens in its own window", Boolean(await page(/\/pos\/display/)));

    // a web page can't jump to the app's setup page (it could change the server address)
    const setupUrl = `file://${path.join(__dirname, "..", "setup.html")}`;
    await pos.evaluate((u) => { location.href = u; }, setupUrl).catch(() => {});
    await wait(1200);
    check("web pages can't open the setup page", !(await b.pages()).some((p) => /setup\.html/.test(p.url())));
    const cfg = JSON.parse(fs.readFileSync(path.join(userData, "config.json"), "utf8"));
    check("server address remembered", cfg.server === SERVER);
  } catch (e) {
    results.push("ERROR " + e.message);
  } finally {
    if (b) b.disconnect();
    proc.kill();
  }
  console.log(results.join("\n"));
  console.log(`\n${results.filter((l) => l.startsWith("PASS")).length}/${results.length} passed`);
})();
