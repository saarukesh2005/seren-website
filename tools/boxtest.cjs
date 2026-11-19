// Adds items to the box, opens the drawer, screenshots it, and checks for page overflow at phone width.
// Usage: node tools/boxtest.cjs <outDir>
const puppeteer = require(require("path").join(require("os").homedir(), "node_modules/puppeteer"));
const out = process.argv[2];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({ headless: true });
  const p = await b.newPage();
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto("http://localhost:4321/", { waitUntil: "networkidle0" });
  await wait(2500);
  await p.screenshot({ path: `${out}/m-0hero.jpg`, type: "jpeg", quality: 60 });
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  await p.evaluate(() => {
    const adds = document.querySelectorAll(".add[data-add]");
    adds[0].click(); adds[0].click(); adds[9].click();
  });
  await wait(400);
  const state = await p.evaluate(() => ({
    count: document.getElementById("boxCount").textContent,
    label: document.querySelector(".add[data-add]").textContent,
  }));
  await p.evaluate(() => document.getElementById("boxBtn").click());
  await wait(800);
  await p.screenshot({ path: `${out}/m-1box.jpg`, type: "jpeg", quality: 60 });
  await p.evaluate(() => document.querySelector('[data-q][data-d="-1"]').click());
  await wait(200);
  const afterMinus = await p.evaluate(() => document.getElementById("boxCount").textContent);
  await p.evaluate(() => document.getElementById("closeBox").click());

  const stops = ["#bomboloni", "#illusory-fruit", "#entremets", "#gelato", "#kitchen"];
  for (const [i, sel] of stops.entries()) {
    await p.evaluate((s) => {
      const y = document.querySelector(s).getBoundingClientRect().top + window.scrollY + 120;
      if (window.serenLenis) window.serenLenis.scrollTo(y, { immediate: true, force: true });
      else window.scrollTo(0, y);
    }, sel);
    await wait(1600);
    await p.screenshot({ path: `${out}/m-${i + 2}${sel.slice(1)}.jpg`, type: "jpeg", quality: 60 });
  }
  console.log(JSON.stringify({ overflow, ...state, afterMinus, errors: errs }));
  await b.close();
})();
