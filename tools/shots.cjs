// Screenshot each section of the running site: node tools/shots.cjs <outDir> [width] [height]
const puppeteer = require(require("path").join(require("os").homedir(), "node_modules/puppeteer"));
const [out, w = "1440", h = "900"] = process.argv.slice(2);
const stops = ["#hero", "#introTitle", "#bomboloni", "#bomboloni+900", "#cookies", "#illusory-fruit+250", "#entremets+200", "#pastry+150", "#gelato+150", "#chocolates+150", "#kitchen+150", "#kmenu", "#visit", "footer"];
(async () => {
  const b = await puppeteer.launch({ headless: true });
  const p = await b.newPage();
  await p.setViewport({ width: +w, height: +h, isMobile: +w < 600, hasTouch: +w < 600 });
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await p.goto("http://localhost:4321/", { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 2600));
  let i = 0;
  for (const s of stops) {
    const [sel, off] = s.split("+");
    await p.evaluate((sel, off) => {
      const el = document.querySelector(sel);
      const y = el.getBoundingClientRect().top + window.scrollY + Number(off || 0);
      if (window.serenLenis) window.serenLenis.scrollTo(y, { immediate: true, force: true }); else window.scrollTo(0, y);
    }, sel, off);
    await new Promise((r) => setTimeout(r, 1700));
    await p.screenshot({ path: `${out}/${String(i++).padStart(2, "0")}-${sel.replace(/\W/g, "")}${off ? "-" + off : ""}.jpg`, type: "jpeg", quality: 60 });
  }
  console.log("errors:", errs.length ? errs : "none");
  await b.close();
})();
