// Checks the interactive features on desktop and with reduced motion.
// Usage: node tools/fulltest.cjs <outDir>
const puppeteer = require(require("path").join(require("os").homedir(), "node_modules/puppeteer"));
const out = process.argv[2];
const URL = "http://localhost:4321/";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);

async function desktop(b) {
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900 });
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("requestfailed", (r) => errs.push("failed " + r.url()));
  p.on("response", (r) => { if (r.status() >= 400 && !r.url().endsWith("favicon.ico")) errs.push(`${r.status()} ${r.url()}`); });
  await p.goto(URL, { waitUntil: "networkidle0" });
  await wait(2600);

  const broken = await p.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && i.src).map((i) => i.src));
  check("no broken images after load", broken.length === 0, broken.join(", "));

  // cursor grows over an Add button
  const addBox = await p.evaluate(() => { const r = document.querySelector("#cookieGrid .add").getBoundingClientRect(); return { y: r.top + window.scrollY }; });
  await p.evaluate((y) => window.serenLenis.scrollTo(y - 400, { immediate: true, force: true }), addBox.y);
  await wait(1500);
  const r = await p.evaluate(() => { const e = document.querySelector("#cookieGrid .add").getBoundingClientRect(); return { x: e.left + e.width / 2, y: e.top + e.height / 2 }; });
  await p.mouse.move(r.x, r.y, { steps: 5 });
  await wait(400);
  const cur = await p.evaluate(() => ({ big: document.getElementById("cursor").classList.contains("big"), label: document.querySelector("#cursor span").textContent }));
  check("custom cursor grows over Add with a label", cur.big && cur.label === "Add", JSON.stringify(cur));

  // add flies an image to the box
  await p.mouse.click(r.x, r.y);
  await wait(120);
  const flying = await p.evaluate(() => document.querySelectorAll(".fly").length);
  check("adding sends a flying picture to the box", flying === 1);
  await wait(1000);
  check("flying picture cleans itself up", (await p.evaluate(() => document.querySelectorAll(".fly").length)) === 0);

  // drawer: inert when closed, page scroll locked while open
  check("closed box is inert (not tabbable)", await p.evaluate(() => document.getElementById("drawer").inert === true));
  await p.evaluate(() => document.getElementById("boxBtn").click());
  await wait(700);
  const y0 = await p.evaluate(() => window.scrollY);
  await p.mouse.move(1200, 400);
  await p.mouse.wheel({ deltaY: 800 });
  await wait(700);
  const y1 = await p.evaluate(() => window.scrollY);
  check("page behind the open box does not scroll", Math.abs(y1 - y0) < 2, `${y0} -> ${y1}`);
  check("open box is interactive", await p.evaluate(() => document.getElementById("drawer").inert === false));
  await p.screenshot({ path: `${out}/t-box.jpg`, type: "jpeg", quality: 60 });
  await p.keyboard.press("Escape");
  await wait(500);

  // palette switcher changes the colours
  await p.evaluate(() => document.querySelector(".pal-btn").click());
  await wait(400);
  await p.evaluate(() => document.querySelector('[data-pal="Matcha Noir"]').click());
  await wait(300);
  const plum = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--plum").trim());
  check("palette switcher applies the chosen colours", plum.toLowerCase() === "#1f2b22", plum);
  await p.evaluate(() => window.serenLenis.scrollTo(0, { immediate: true, force: true }));
  await wait(1200);
  await p.screenshot({ path: `${out}/t-palette.jpg`, type: "jpeg", quality: 60 });
  await p.evaluate(() => document.querySelector('[data-pal="SEREN Original"]').click());

  // headings never break mid-word
  const split = await p.evaluate(() => [...document.querySelectorAll(".head h2 .wd")].some((w) => w.getClientRects().length > 1));
  check("big headings keep words whole", !split);

  check("no script errors or failed requests", errs.length === 0, errs.slice(0, 4).join(" | "));
  await p.close();
}

async function reducedMotion(b) {
  const p = await b.newPage();
  await p.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await p.setViewport({ width: 1280, height: 800 });
  await p.goto(URL, { waitUntil: "networkidle0" });
  await wait(800);
  const op = await p.evaluate(() => Math.min(...[...document.querySelectorAll(".intro .big, .intro .big *")].map((e) => Number(getComputedStyle(e).opacity))));
  check("intro text fully readable with animations turned off", op === 1, String(op));
  await p.close();
}

(async () => {
  const b = await puppeteer.launch({ headless: true });
  try { await desktop(b); await reducedMotion(b); }
  catch (e) { results.push("ERROR " + e.message); }
  console.log(results.join("\n"));
  await b.close();
})();
