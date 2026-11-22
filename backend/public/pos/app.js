/* SEREN Counter start-up: login (works offline too once you've logged in on this PC), keyboard shortcuts,
   and the offline helper (service worker) that keeps the counter opening without internet. */
window.POSApp = (function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const app = { user: null };
  const USER_KEY = "seren-pos-user";

  function canCount(me) { return me.perms.includes("*") || me.perms.includes("counter"); }

  async function boot() {
    try {
      const me = await POS.api("/me");
      if (!canCount(me)) { showLogin("Your login can't make bills. Ask the owner."); return; }
      try { localStorage.setItem(USER_KEY, JSON.stringify(me.user)); } catch (e) { /* storage blocked */ }
      await POS.refresh();
      showApp(me.user);
    } catch (e) {
      // no internet: keep billing with what this PC remembers
      const remembered = (() => { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch (x) { return null; } })();
      if (e instanceof POS.NetworkError && remembered && POS.catalog) showApp(remembered);
      else showLogin(e instanceof POS.NetworkError ? "No internet. Connect once to log in on this PC." : "");
    }
  }

  function showLogin(hint) {
    $("#app").hidden = true; $("#login").hidden = false;
    $("#loginHint").textContent = hint || "";
    setTimeout(() => $("#who").focus(), 50);
  }

  let started = false;
  function showApp(user) {
    app.user = user;
    $("#login").hidden = true; $("#app").hidden = false;
    $("#whoAmI").textContent = `${user.name}`;
    if (started) { POSUI.renderCats(); POSUI.render(); return; }
    started = true;
    POSUI.start();
    document.querySelectorAll("[data-pay]").forEach((b) => b.addEventListener("click", () => POSPay.start(b.dataset.pay)));
    POS.sync();
    setInterval(() => { if (POS.online && !document.hidden) POS.refresh().then(() => POSUI.render()); }, 120000);
  }

  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button");
    btn.disabled = true; $("#loginErr").textContent = "";
    try {
      await POS.api("/login", { name: $("#who").value.trim(), password: $("#pw").value });
      $("#pw").value = "";
      await boot();
    } catch (ex) { $("#loginErr").textContent = ex.message; }
    finally { btn.disabled = false; }
  });
  $("#logoutBtn").addEventListener("click", async () => {
    if (POS.queue().length && !window.confirm("Some offline bills haven't been sent yet. They stay on this PC and send after the next login. Log out?")) return;
    try { await POS.api("/logout", {}); } catch (e) { /* offline */ }
    try { localStorage.removeItem(USER_KEY); } catch (e) { /* storage blocked */ }
    location.reload();
  });
  POS.on("logout", () => showLogin("Please log in again."));

  // keyboard: F1 cash · F2 UPI · F3 card · F4 hold · F6 held bills · F8 reprint last · / search · Esc clear
  document.addEventListener("keydown", (e) => {
    if ($("#app").hidden) return;
    const open = document.querySelector("dialog[open]");
    const keys = { F1: () => POSPay.start("cash"), F2: () => POSPay.start("upi"), F3: () => POSPay.start("card"), F4: POSUI.hold, F6: POSUI.showHeld,
      F8: () => (window.POSLast ? POSPrint.printReceipt(window.POSLast) : POSUI.toast("No receipt to reprint yet")) };
    if (keys[e.key] && !open) { e.preventDefault(); keys[e.key](); return; }
    if (e.key === "/" && !open && document.activeElement.tagName !== "INPUT") { e.preventDefault(); POSUI.focusSearch(); }
    if (e.key === "Escape" && !open && document.activeElement.tagName !== "INPUT" && POSUI.lines().length && window.confirm("Clear this bill?")) POSUI.clear();
  });

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => { /* offline helper unavailable */ });
  boot();
  return app;
})();
